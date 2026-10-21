import { requirePermission, type Ctx } from "./access";
import { invoiceView, quoteDisplayStatus } from "./documents";
import { forecastCash, simulate } from "./forecast";
import { formatMoneyPlain, sumCents, type Cents } from "./money";
import { buildDashboard } from "./dashboard";
import { overdueInvoicesReport, expensesByCategoryReport, type Period } from "./reports";
import { prepareReminder } from "./reminders";
import { normalizeText } from "./text";
import { newId } from "./ledger";
import { addDays } from "./dates";
import type { Id, Ledger } from "./types";

/**
 * Assistant EVARA — MODE DÉMONSTRATION.
 * Aucun modèle d'IA n'est connecté : les intentions sont reconnues par règles et les chiffres proviennent
 * exclusivement des services métier (jamais d'un calcul libre). Chaque réponse est marquée `simulated: true`.
 * Un fournisseur d'IA réel se branche derrière la même interface (AIProvider) en ne recevant que ces services.
 */
export interface ProposedAction {
  id: Id;
  type: "prepare_reminder";
  title: string;
  affectedData: string[];
  consequences: string[];
  status: "pending" | "confirmed" | "cancelled";
  payload: { invoiceId: Id };
}

export interface AssistantReply {
  /** Toujours vrai tant qu'aucun fournisseur d'IA n'est configuré. */
  simulated: true;
  intent: string;
  text: string;
  /** Services métier interrogés : traçabilité de l'origine des chiffres. */
  sources: string[];
  proposal?: ProposedAction;
}

const eur = (c: Cents) => formatMoneyPlain(c, "EUR");

export const SUGGESTED_QUESTIONS = [
  "Combien mes clients me doivent-ils ?",
  "Quelles factures sont en retard ?",
  "Quels paiements arrivent la semaine prochaine ?",
  "Pourquoi ma trésorerie devrait-elle baisser ?",
  "Quelles dépenses ont augmenté ce mois-ci ?",
  "Quels devis n'ont pas encore été acceptés ?",
  "Prépare une relance pour la facture la plus en retard.",
  "Simule un retard de paiement de 15 jours.",
];

export function answerQuestion(ledger: Ledger, ctx: Ctx, question: string): AssistantReply {
  requirePermission(ctx, "read");
  const q = normalizeText(question);
  const base = { simulated: true as const };

  if (/\b(relance|relancer)\b/.test(q)) {
    const overdue = overdueInvoicesReport(ledger, ctx).rows;
    const numberMatch = /(fac|inv)[ -]?\d{4}[ -]?\d{3,4}/.exec(q);
    const target = (numberMatch && overdue.find((r) => normalizeText(r.invoice.number ?? "").replace(/ /g, "") === numberMatch[0].replace(/[ -]/g, ""))) || overdue[0];
    if (!target) return { ...base, intent: "prepare_reminder", text: "Aucune facture n'est en retard : il n'y a rien à relancer.", sources: ["overdueInvoicesReport"] };
    const proposal: ProposedAction = {
      id: newId("prop"),
      type: "prepare_reminder",
      title: `Préparer une relance pour ${target.invoice.number}`,
      affectedData: [`Facture ${target.invoice.number} — ${target.customer}`, `Reste dû : ${eur(target.balanceCents)}`, `Retard : ${target.daysOverdue} jours`],
      consequences: ["Un brouillon de relance est créé dans Automatisations.", "Aucun email n'est envoyé : vous relisez et envoyez vous-même.", "Aucune donnée financière n'est modifiée."],
      status: "pending",
      payload: { invoiceId: target.invoice.id },
    };
    return { ...base, intent: "prepare_reminder", text: `La facture la plus en retard est ${target.invoice.number} (${target.customer}, ${target.daysOverdue} jours, ${eur(target.balanceCents)}). Je peux préparer un brouillon de relance : confirmez l'action ci-dessous.`, sources: ["overdueInvoicesReport"], proposal };
  }

  if (/simul/.test(q)) {
    const days = Number(/(\d{1,3})\s*jours?/.exec(q)?.[1] ?? 15);
    const top = forecastCash(ledger, ctx, { horizonDays: 30, scenario: "central" }).events.filter((e) => e.kind === "sales_invoice").sort((a, b) => b.amountCents - a.amountCents)[0];
    if (!top || !top.sourceId) return { ...base, intent: "simulate", text: "Aucune facture client n'est attendue dans les 30 prochains jours : il n'y a rien à décaler.", sources: ["forecastCash"] };
    const sim = simulate(ledger, ctx, { horizonDays: 30, scenario: "central", assumptions: [{ type: "delay_invoice", invoiceId: top.sourceId, days }] });
    return {
      ...base,
      intent: "simulate",
      text: `Simulation (aucune donnée n'est modifiée) : si « ${top.label} » (${eur(top.amountCents)}) est payée avec ${days} jours de retard, la trésorerie la plus basse sur 30 jours serait de ${eur(sim.simulated.minBalance.cents)} le ${sim.simulated.minBalance.date} (contre ${eur(sim.baseline.minBalance.cents)} sans retard).${sim.newlyNegative ? " Attention : elle passerait sous zéro." : ""}`,
      sources: ["simulate", "forecastCash"],
    };
  }

  if (/(doivent|doit|creance|a recevoir)/.test(q)) {
    const d = buildDashboard(ledger, ctx);
    return { ...base, intent: "receivables", text: `Vos clients vous doivent ${eur(d.receivablesCents)} au total, dont ${eur(d.receivablesOverdueCents)} en retard (${d.overdueInvoiceCount} facture${d.overdueInvoiceCount > 1 ? "s" : ""}). Ces montants ne sont pas de l'argent disponible tant qu'ils ne sont pas encaissés.`, sources: ["buildDashboard"] };
  }

  if (/retard/.test(q)) {
    const r = overdueInvoicesReport(ledger, ctx);
    if (!r.rows.length) return { ...base, intent: "overdue", text: "Aucune facture client n'est en retard.", sources: ["overdueInvoicesReport"] };
    return { ...base, intent: "overdue", text: `${r.rows.length} facture(s) en retard pour ${eur(r.totalCents)} : ${r.rows.map((x) => `${x.invoice.number} (${x.customer}, ${x.daysOverdue} j, ${eur(x.balanceCents)})`).join(" ; ")}.`, sources: ["overdueInvoicesReport"] };
  }

  if (/(semaine prochaine|arrivent|prochains paiements|a venir)/.test(q)) {
    const f = forecastCash(ledger, ctx, { horizonDays: 14, scenario: "central" });
    const from = addDays(ctx.today, 7);
    const week = f.events.filter((e) => e.date >= from);
    const next = f.events.filter((e) => e.date < from);
    const line = (list: typeof week) => (list.length ? list.map((e) => `${e.date} : ${e.amountCents > 0 ? "+" : ""}${eur(e.amountCents)} — ${e.label}`).join(" ; ") : "aucun mouvement attendu");
    return { ...base, intent: "upcoming", text: `Dans les 7 prochains jours (scénario central, estimations) : ${line(next)}. Semaine suivante : ${line(week)}. Ce sont des prévisions, pas des soldes bancaires.`, sources: ["forecastCash"] };
  }

  if (/(pourquoi|baisser|baisse|diminu)/.test(q)) {
    const f = forecastCash(ledger, ctx, { horizonDays: 30, scenario: "central" });
    const outflows = f.events.filter((e) => e.amountCents < 0).sort((a, b) => a.amountCents - b.amountCents).slice(0, 3);
    return {
      ...base, intent: "why_cash",
      text: `Solde actuel ${eur(f.startingCashCents)} → ${eur(f.endBalanceCents)} prévu dans 30 jours (point bas ${eur(f.minBalance.cents)} le ${f.minBalance.date}). Entrées prévues ${eur(f.totalInCents)}, sorties prévues ${eur(f.totalOutCents)}. Principales sorties : ${outflows.map((e) => `${e.label} (${eur(-e.amountCents)}, ${e.date})`).join(" ; ") || "aucune"}.`,
      sources: ["forecastCash"],
    };
  }

  if (/(depenses?).*(augment|hausse)|augment/.test(q)) {
    const t = ctx.today;
    const cur: Period = { from: `${t.slice(0, 7)}-01`, to: t };
    const prevEnd = addDays(cur.from, -1);
    const prev: Period = { from: `${prevEnd.slice(0, 7)}-01`, to: prevEnd };
    const a = expensesByCategoryReport(ledger, ctx, cur);
    const b = expensesByCategoryReport(ledger, ctx, prev);
    const diffs = a.rows.map((r) => ({ category: r.category, delta: r.committedCents - (b.rows.find((x) => x.category === r.category)?.committedCents ?? 0) })).filter((d) => d.delta > 0).sort((x, y) => y.delta - x.delta).slice(0, 3);
    return { ...base, intent: "expenses_up", text: diffs.length ? `Par rapport au mois précédent, les dépenses engagées augmentent surtout en : ${diffs.map((d) => `${d.category} (+${eur(d.delta)})`).join(", ")}. Le mois en cours n'est pas terminé : la comparaison est partielle.` : "Aucune catégorie de dépenses n'augmente par rapport au mois précédent (comparaison partielle : mois en cours).", sources: ["expensesByCategoryReport"] };
  }

  if (/devis/.test(q)) {
    const open = ledger.quotes.filter((x) => x.orgId === ctx.orgId && ["sent", "viewed"].includes(quoteDisplayStatus(x, ctx.today)));
    return { ...base, intent: "quotes", text: open.length ? `${open.length} devis en attente de réponse pour ${eur(sumCents(open.map((x) => x.totals.totalTtcCents)))} TTC : ${open.map((x) => `${x.number} (valable jusqu'au ${x.validUntil})`).join(", ")}.` : "Aucun devis n'est en attente de réponse.", sources: ["quotes"] };
  }

  return { ...base, intent: "help", text: "Je peux répondre à ces questions à partir de vos données (mode démonstration, réponses simulées) :\n" + SUGGESTED_QUESTIONS.map((s) => `• ${s}`).join("\n"), sources: [] };
}

/** Exécute une action proposée UNIQUEMENT après confirmation explicite de l'utilisateur. */
export function confirmProposal(ledger: Ledger, ctx: Ctx, proposal: ProposedAction, confirmation: { confirmedByUser: true }): { reminderId: Id } {
  if (!confirmation || confirmation.confirmedByUser !== true) throw new Error("Confirmation explicite requise");
  if (proposal.status !== "pending") throw new Error("Cette proposition n'est plus en attente.");
  const draft = prepareReminder(ledger, ctx, proposal.payload.invoiceId);
  proposal.status = "confirmed";
  return { reminderId: draft.id };
}

export function cancelProposal(proposal: ProposedAction): void {
  proposal.status = "cancelled";
}

export { invoiceView };
