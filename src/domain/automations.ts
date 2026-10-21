import { requirePermission, scoped, type Ctx } from "./access";
import { diffDays } from "./dates";
import { invoiceView } from "./documents";
import { buildActions } from "./dashboard";
import { newId, logAudit } from "./ledger";
import { automationAllowed, PLANS, type PlanId } from "./plans";
import { prepareReminder } from "./reminders";
import { detectRecurringCandidates } from "./recurring";
import { purchaseView } from "./purchases";
import { takeForecastSnapshot } from "./reports";
import { reconciliationStatus } from "./transactions";
import type { AutomationKey, AutomationRule, AutomationRun, Id, Ledger } from "./types";

export const MAX_ATTEMPTS = 3;

type RuleSpec = Omit<AutomationRule, "id" | "orgId" | "enabled">;

export const DEFAULT_RULES: RuleSpec[] = [
  { key: "detect_overdue_invoices", name: "Détecter les factures en retard", description: "Repère les factures non soldées dont l'échéance est dépassée et crée une alerte.", trigger: "Chaque jour", conditions: "Facture émise, reste dû > 0, échéance < aujourd'hui", action: "Créer une notification", requiresHumanApproval: false, minPlan: "discovery" },
  { key: "prepare_reminders", name: "Préparer des relances", description: "Rédige un brouillon de relance pour chaque facture en retard. Rien n'est envoyé automatiquement.", trigger: "Chaque jour", conditions: "Facture en retard sans relance préparée depuis 7 jours", action: "Créer un brouillon de relance", requiresHumanApproval: true, minPlan: "pro" },
  { key: "notify_channel", name: "Envoyer les notifications par email", description: "Transmet vos alertes par email lorsque l'intégration email est configurée.", trigger: "À chaque nouvelle alerte", conditions: "Canal email configuré et testé", action: "Envoyer un email récapitulatif", requiresHumanApproval: false, channel: "email", minPlan: "business" },
  { key: "supplier_due_alerts", name: "Prévenir des échéances fournisseurs", description: "Alerte 3 jours avant l'échéance d'une facture fournisseur à payer, ou si elle est en retard.", trigger: "Chaque jour", conditions: "Facture fournisseur non soldée, échéance ≤ J+3, non contestée", action: "Créer une notification", requiresHumanApproval: false, minPlan: "discovery" },
  { key: "flag_unmatched_transactions", name: "Signaler les transactions non rapprochées", description: "Rappelle les mouvements bancaires qui ne sont liés à aucun document.", trigger: "Chaque jour", conditions: "Au moins une transaction non rapprochée", action: "Créer une notification", requiresHumanApproval: false, minPlan: "pro" },
  { key: "detect_missing_receipts", name: "Détecter les justificatifs manquants", description: "Liste les dépenses sans pièce justificative.", trigger: "Chaque jour", conditions: "Dépense sans justificatif ni facture fournisseur", action: "Créer une notification", requiresHumanApproval: false, minPlan: "pro" },
  { key: "detect_recurring_expenses", name: "Identifier les dépenses récurrentes potentielles", description: "Propose (sans l'activer) des charges récurrentes détectées dans vos mouvements : minimum 3 occurrences régulières.", trigger: "Chaque semaine", conditions: "≥ 3 opérations similaires à intervalle régulier", action: "Suggérer l'ajout aux charges récurrentes", requiresHumanApproval: true, minPlan: "business" },
  { key: "periodic_report", name: "Générer un rapport financier périodique", description: "Prépare un récapitulatif de trésorerie (encaissé, décaissé, prévision à 30 jours).", trigger: "Chaque semaine", conditions: "—", action: "Créer une notification récapitulative", requiresHumanApproval: false, minPlan: "business" },
  { key: "refresh_forecast", name: "Actualiser les prévisions", description: "Enregistre la prévision du jour pour mesurer plus tard l'écart avec le réalisé.", trigger: "Après chaque changement financier, une fois par jour", conditions: "—", action: "Mémoriser la projection à 30 jours", requiresHumanApproval: false, minPlan: "pro" },
  { key: "flag_anomalies", name: "Signaler les anomalies possibles", description: "Repère les dépenses inhabituelles et les paiements fournisseurs en double potentiels.", trigger: "Chaque jour", conditions: "Dépense ≥ 2,5 × médiane de sa catégorie ; même montant, même fournisseur, même jour", action: "Créer une notification", requiresHumanApproval: false, minPlan: "business" },
];

export function ensureAutomationRules(ledger: Ledger, orgId: Id): void {
  for (const spec of DEFAULT_RULES) {
    if (!ledger.automationRules.some((r) => r.orgId === orgId && r.key === spec.key)) {
      ledger.automationRules.push({ id: newId("rule"), orgId, enabled: true, ...spec });
    }
  }
}

export function toggleRule(ledger: Ledger, ctx: Ctx, ruleId: Id, enabled: boolean): AutomationRule {
  requirePermission(ctx, "settings");
  const rule = scoped(ledger.automationRules, ctx, ruleId, "Automatisation");
  rule.enabled = enabled;
  logAudit(ledger, ctx, enabled ? "automation.enabled" : "automation.disabled", "automation", ruleId);
  return rule;
}

export interface AutomationEnv {
  emailConfigured: boolean;
  /** Envoi réel : fourni uniquement si une intégration email est configurée. */
  sendEmail?: (to: string, subject: string, body: string) => Promise<{ ok: boolean; error?: string }>;
}

interface HandlerResult {
  produced: number;
  result: string;
  status?: AutomationRun["status"];
}

function notify(ledger: Ledger, ctx: Ctx, kind: string, title: string, body: string, target?: { type: string; id: Id }): boolean {
  const dup = ledger.notifications.some((n) => n.orgId === ctx.orgId && n.kind === kind && n.title === title && n.createdAt.slice(0, 10) === ctx.today);
  if (dup) return false;
  ledger.notifications.push({ id: newId("ntf"), orgId: ctx.orgId, kind, title, body, ...(target ? { target } : {}), createdAt: ctx.nowIso });
  return true;
}

const HANDLERS: Record<AutomationKey, (ledger: Ledger, ctx: Ctx, env: AutomationEnv) => Promise<HandlerResult> | HandlerResult> = {
  detect_overdue_invoices(ledger, ctx) {
    let n = 0;
    for (const inv of ledger.invoices.filter((i) => i.orgId === ctx.orgId)) {
      const v = invoiceView(ledger, inv, ctx.today);
      if (v.isOverdue && notify(ledger, ctx, "overdue_invoice", `${inv.number} en retard de ${v.daysOverdue} j`, `Reste dû : ${(v.balanceCents / 100).toFixed(2).replace(".", ",")} €`, { type: "invoice", id: inv.id })) n++;
    }
    return { produced: n, result: n ? `${n} alerte(s) créée(s).` : "Aucune nouvelle facture en retard." };
  },
  prepare_reminders(ledger, ctx) {
    let n = 0;
    for (const inv of ledger.invoices.filter((i) => i.orgId === ctx.orgId)) {
      if (!invoiceView(ledger, inv, ctx.today).isOverdue) continue;
      const recent = ledger.reminders.some((r) => r.orgId === ctx.orgId && r.invoiceId === inv.id && r.status !== "dismissed" && diffDays(ctx.today, r.createdAt.slice(0, 10)) < 7);
      if (recent) continue;
      prepareReminder(ledger, ctx, inv.id);
      n++;
    }
    return { produced: n, result: n ? `${n} brouillon(s) de relance préparé(s) — à vérifier et envoyer vous-même.` : "Aucune relance à préparer." };
  },
  async notify_channel(ledger, ctx, env) {
    if (!env.emailConfigured || !env.sendEmail) {
      return { produced: 0, status: "skipped", result: "Canal email non configuré : aucune notification externe envoyée." };
    }
    const unread = ledger.notifications.filter((x) => x.orgId === ctx.orgId && !x.readAt).slice(0, 10);
    if (!unread.length) return { produced: 0, result: "Aucune alerte à transmettre." };
    const owner = ledger.members.find((m) => m.orgId === ctx.orgId && m.role === "owner");
    const res = await env.sendEmail(owner?.userId ?? "", "EVARA — vos alertes", unread.map((x) => `• ${x.title}\n  ${x.body}`).join("\n"));
    if (!res.ok) throw new Error(res.error ?? "Échec de l'envoi");
    return { produced: unread.length, result: `${unread.length} alerte(s) transmise(s) par email.` };
  },
  supplier_due_alerts(ledger, ctx) {
    let n = 0;
    for (const p of ledger.purchaseInvoices.filter((x) => x.orgId === ctx.orgId && x.status !== "disputed")) {
      const v = purchaseView(ledger, p, ctx.today);
      if (v.balanceCents > 0 && diffDays(p.dueDate, ctx.today) <= 3 && notify(ledger, ctx, "supplier_due", `${p.reference} : échéance ${p.dueDate}`, `${(v.balanceCents / 100).toFixed(2).replace(".", ",")} € à payer`, { type: "purchase_invoice", id: p.id })) n++;
    }
    return { produced: n, result: n ? `${n} alerte(s) créée(s).` : "Aucune échéance fournisseur imminente." };
  },
  flag_unmatched_transactions(ledger, ctx) {
    const c = ledger.transactions.filter((t) => t.orgId === ctx.orgId && !t.voidedAt && reconciliationStatus(ledger, t) === "unmatched").length;
    const created = c > 0 && notify(ledger, ctx, "unmatched", `${c} transaction(s) non rapprochée(s)`, "Rapprochez-les pour garder vos statuts de paiement exacts.");
    return { produced: created ? 1 : 0, result: c ? `${c} transaction(s) à rapprocher.` : "Tout est rapproché." };
  },
  detect_missing_receipts(ledger, ctx) {
    const c = ledger.expenses.filter((e) => e.orgId === ctx.orgId && !e.receiptAttachmentId && !e.purchaseInvoiceId).length;
    const created = c > 0 && notify(ledger, ctx, "missing_receipts", `${c} justificatif(s) manquant(s)`, "Ajoutez les pièces justificatives aux dépenses concernées.");
    return { produced: created ? 1 : 0, result: c ? `${c} justificatif(s) manquant(s).` : "Aucun justificatif manquant." };
  },
  detect_recurring_expenses(ledger, ctx) {
    const c = detectRecurringCandidates(ledger, ctx.orgId).filter((x) => x.direction === "out");
    const created = c.length > 0 && notify(ledger, ctx, "recurring_candidates", `${c.length} charge(s) récurrente(s) potentielle(s)`, "À examiner dans Trésorerie : rien n'est activé sans votre validation.");
    return { produced: created ? 1 : 0, result: c.length ? `${c.length} candidat(s) détecté(s).` : "Aucune récurrence détectée." };
  },
  periodic_report(ledger, ctx) {
    const actions = buildActions(ledger, ctx);
    const created = notify(ledger, ctx, "periodic_report", "Récapitulatif hebdomadaire", `${actions.length} point(s) d'attention dans le centre d'actions.`);
    return { produced: created ? 1 : 0, result: "Récapitulatif préparé." };
  },
  refresh_forecast(ledger, ctx) {
    const before = ledger.forecastSnapshots.length;
    takeForecastSnapshot(ledger, ctx, "central");
    return { produced: ledger.forecastSnapshots.length - before, result: "Prévision du jour mémorisée." };
  },
  flag_anomalies(ledger, ctx) {
    const actions = buildActions(ledger, ctx).filter((a) => a.kind === "unusual_expense");
    let n = 0;
    for (const a of actions) if (notify(ledger, ctx, "anomaly", a.title, a.detail, a.target.id ? { type: a.target.type, id: a.target.id } : undefined)) n++;
    // Doublons potentiels : même fournisseur, même montant, même date.
    const seen = new Map<string, number>();
    for (const e of ledger.expenses.filter((x) => x.orgId === ctx.orgId && x.supplierId)) {
      const k = `${e.supplierId}|${e.amountCents}|${e.date}`;
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    for (const [k, count] of seen) if (count > 1 && notify(ledger, ctx, "anomaly", "Dépense en double possible", `${count} dépenses identiques (même fournisseur, montant et date) : ${k.split("|")[1]} centimes.`)) n++;
    return { produced: n, result: n ? `${n} anomalie(s) signalée(s).` : "Aucune anomalie." };
  },
};

/**
 * Exécute une automatisation de façon idempotente : une même clé (règle + jour) ne réussit qu'une fois ;
 * un échec peut être retenté jusqu'à MAX_ATTEMPTS. Un canal externe non configuré donne un statut "skipped" honnête.
 */
export async function runAutomation(ledger: Ledger, ctx: Ctx, ruleId: Id, plan: PlanId, env: AutomationEnv): Promise<AutomationRun> {
  requirePermission(ctx, "write");
  const rule = scoped(ledger.automationRules, ctx, ruleId, "Automatisation");
  const key = `${rule.key}:${ctx.today}`;
  const existing = ledger.automationRuns.filter((r) => r.orgId === ctx.orgId && r.idempotencyKey === key);
  const done = existing.find((r) => r.status === "succeeded" || r.status === "running" || r.status === "skipped");
  if (done) return done;
  const attempt = existing.length + 1;

  const run: AutomationRun = { id: newId("run"), orgId: ctx.orgId, ruleId, idempotencyKey: key, startedAt: ctx.nowIso, status: "running", attempt, produced: 0 };

  if (attempt > MAX_ATTEMPTS) {
    run.status = "failed";
    run.error = `Abandon après ${MAX_ATTEMPTS} tentatives.`;
    run.finishedAt = ctx.nowIso;
    ledger.automationRuns.push(run);
    return run;
  }
  if (!rule.enabled) {
    run.status = "skipped";
    run.result = "Automatisation désactivée.";
    run.finishedAt = ctx.nowIso;
    ledger.automationRuns.push(run);
    return run;
  }
  if (!automationAllowed(plan, rule.key)) {
    run.status = "skipped";
    run.result = `Non incluse dans l'offre ${PLANS[plan].name}.`;
    run.finishedAt = ctx.nowIso;
    ledger.automationRuns.push(run);
    return run;
  }
  ledger.automationRuns.push(run);
  try {
    const res = await HANDLERS[rule.key](ledger, ctx, env);
    run.status = res.status ?? "succeeded";
    run.result = res.result;
    run.produced = res.produced;
  } catch (e) {
    run.status = "failed";
    run.error = e instanceof Error ? e.message : "Erreur inconnue";
  }
  run.finishedAt = ctx.nowIso;
  logAudit(ledger, ctx, "automation.run", "automation", ruleId, { status: run.status, attempt, produced: run.produced });
  return run;
}

export function lastRun(ledger: Ledger, ruleId: Id): AutomationRun | undefined {
  return [...ledger.automationRuns].filter((r) => r.ruleId === ruleId).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
}
