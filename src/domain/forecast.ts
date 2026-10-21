import type { Ctx } from "./access";
import { addDays, addMonths, compareDates, diffDays, isValidISODate, type ISODate } from "./dates";
import { invoiceView } from "./documents";
import { ValidationError } from "./errors";
import { divRound, sumCents, type Cents } from "./money";
import { purchaseView } from "./purchases";
import { normalizeText, significantTokens } from "./text";
import { accountBalance, allocatedCents, cashPosition, signedCents } from "./transactions";
import type { Direction, Id, Ledger, RecurringItem } from "./types";

export type ScenarioKey = "prudent" | "central" | "favorable";
export type EventConfidence = "confirmed" | "expected" | "uncertain";
export type EventKind = "sales_invoice" | "purchase_invoice" | "expense" | "recurring" | "declared_payment" | "scheduled_transaction" | "assumption";

export interface ForecastEvent {
  id: string;
  date: ISODate;
  /** Signé : positif = entrée, négatif = sortie. */
  amountCents: Cents;
  direction: Direction;
  kind: EventKind;
  sourceId?: Id;
  label: string;
  confidence: EventConfidence;
  accountId: Id | null;
  /** Pourquoi cet événement est là, à cette date. */
  explanation: string;
  counterpartyId?: Id;
  counterpartyName?: string;
  simulated?: boolean;
}

export type Assumption =
  | { type: "delay_invoice"; invoiceId: Id; days: number }
  | { type: "one_off_expense"; date: ISODate; amountCents: Cents; label: string }
  | { type: "extra_sale"; date: ISODate; amountCents: Cents; label: string }
  | { type: "investment"; date: ISODate; amountCents: Cents; label: string }
  | { type: "cost_increase"; pctBp: number; fromDate: ISODate }
  | { type: "advance_supplier_payment"; purchaseInvoiceId: Id; date: ISODate };

export interface ForecastOptions {
  horizonDays: 7 | 30 | 60 | 90 | number;
  scenario?: ScenarioKey;
  assumptions?: Assumption[];
  /** Vue par compte : restreint solde de départ et événements à ce compte. */
  accountId?: Id;
}

export interface DayPoint {
  date: ISODate;
  balanceCents: Cents;
  /** Solde si seuls les événements "confirmés" se réalisent (engagements certains). */
  balanceConfirmedOnlyCents: Cents;
  inCents: Cents;
  outCents: Cents;
}

export type AlertKind = "negative_cash" | "below_threshold" | "customer_concentration" | "large_due" | "incomplete_data";
export interface ForecastAlert {
  id: string;
  kind: AlertKind;
  severity: "critical" | "warning" | "info";
  title: string;
  message: string;
  date?: ISODate;
  evidence: { label: string; date: ISODate; amountCents: Cents }[];
}

export interface ForecastResult {
  asOf: ISODate;
  horizonDays: number;
  scenario: ScenarioKey;
  accountId: Id | null;
  startingCashCents: Cents;
  events: ForecastEvent[];
  excluded: { label: string; reason: string; sourceId?: Id }[];
  series: DayPoint[];
  minBalance: { date: ISODate; cents: Cents };
  endBalanceCents: Cents;
  endBalanceConfirmedOnlyCents: Cents;
  totalInCents: Cents;
  totalOutCents: Cents;
  alerts: ForecastAlert[];
  assumptions: string[];
  warnings: string[];
  completeness: { isComplete: boolean; warnings: string[] };
  simulated: boolean;
}

const SCENARIO_RULES: Record<ScenarioKey, string[]> = {
  prudent: [
    "Les factures clients sont encaissées au plus tard : échéance + 30 jours (ou le retard habituel du client + 15 jours si plus long).",
    "Les factures clients en retard de plus de 60 jours sont exclues (encaissement jugé trop incertain).",
    "Les revenus récurrents non contractuels sont exclus.",
    "Les factures fournisseurs, même contestées, sont payées à l'échéance.",
  ],
  central: [
    "Les factures clients sont encaissées à l'échéance + le retard moyen constaté pour ce client (5 jours par défaut sans historique).",
    "Les factures clients en retard sont attendues dans les 14 jours.",
    "Seuls les revenus récurrents attendus ou confirmés sont inclus.",
    "Les factures fournisseurs contestées sont exclues tant que la contestation n'est pas levée.",
  ],
  favorable: [
    "Les factures clients sont encaissées à leur échéance (3 jours pour une facture déjà en retard).",
    "Tous les revenus récurrents, même incertains, sont inclus.",
    "Les factures fournisseurs contestées sont exclues.",
  ],
};

const DEFAULT_DELAY = 5;

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : divRound((s[mid - 1] as number) + (s[mid] as number), 2);
}

/** Retard moyen de paiement observé par client (jours après l'échéance, jamais négatif), à partir des factures soldées. */
export function customerPaymentDelays(ledger: Ledger, ctx: Ctx): Map<Id, { medianDelayDays: number; samples: number }> {
  const byCustomer = new Map<Id, number[]>();
  for (const inv of ledger.invoices.filter((i) => i.orgId === ctx.orgId && i.status !== "draft" && i.status !== "cancelled")) {
    const view = invoiceView(ledger, inv, ctx.today);
    if (view.paymentState !== "paid") continue;
    const pays = ledger.payments.filter((p) => p.documentType === "sales_invoice" && p.documentId === inv.id && !p.voidedAt).map((p) => p.date).sort();
    const last = pays[pays.length - 1];
    if (!last) continue;
    const list = byCustomer.get(inv.customerId) ?? [];
    list.push(Math.max(0, diffDays(last, inv.dueDate)));
    byCustomer.set(inv.customerId, list);
  }
  return new Map([...byCustomer].map(([id, d]) => [id, { medianDelayDays: median(d), samples: d.length }]));
}

/** Une transaction bancaire non rapprochée qui ressemble au document : on évite de le compter une 2e fois dans le futur. */
function probableCounterpart(ledger: Ledger, ctx: Ctx, direction: Direction, amount: Cents, notBefore: ISODate) {
  return ledger.transactions.find(
    (t) =>
      t.orgId === ctx.orgId && !t.voidedAt && !t.reconciliationIgnored && t.direction === direction && t.amountCents === amount &&
      compareDates(t.date, notBefore) >= 0 && compareDates(t.date, ctx.today) <= 0 && allocatedCents(ledger, t.id) === 0,
  );
}

function occurrences(item: RecurringItem, from: ISODate, to: ISODate): ISODate[] {
  const dates: ISODate[] = [];
  let d = item.nextDate;
  let guard = 0;
  const step = (x: ISODate): ISODate => {
    switch (item.interval) {
      case "weekly": return addDays(x, 7);
      case "monthly": return addMonths(x, 1);
      case "quarterly": return addMonths(x, 3);
      case "yearly": return addMonths(x, 12);
    }
  };
  while (compareDates(d, to) <= 0 && guard++ < 400) {
    if (compareDates(d, from) >= 0 && (!item.endDate || compareDates(d, item.endDate) <= 0)) dates.push(d);
    d = step(d);
  }
  return dates;
}

function validateAssumptions(assumptions: Assumption[]): void {
  const issues: string[] = [];
  for (const a of assumptions) {
    switch (a.type) {
      case "delay_invoice":
        if (!Number.isInteger(a.days) || a.days < -90 || a.days > 365) issues.push("Retard de facture invalide.");
        break;
      case "one_off_expense":
      case "extra_sale":
      case "investment":
        if (!isValidISODate(a.date)) issues.push(`Date invalide pour « ${a.label} ».`);
        if (!Number.isSafeInteger(a.amountCents) || a.amountCents <= 0) issues.push(`Montant invalide pour « ${a.label} ».`);
        break;
      case "cost_increase":
        if (!Number.isInteger(a.pctBp) || a.pctBp <= 0 || a.pctBp > 100_000) issues.push("Hausse des charges invalide.");
        if (!isValidISODate(a.fromDate)) issues.push("Date de début de hausse invalide.");
        break;
      case "advance_supplier_payment":
        if (!isValidISODate(a.date)) issues.push("Date de paiement anticipé invalide.");
        break;
    }
  }
  if (issues.length) throw new ValidationError("Hypothèse invalide", issues);
}

export function buildForecastEvents(ledger: Ledger, ctx: Ctx, scenario: ScenarioKey, horizonEnd: ISODate, assumptions: Assumption[] = []) {
  const today = ctx.today;
  const tomorrow = addDays(today, 1);
  const events: ForecastEvent[] = [];
  const excluded: ForecastResult["excluded"] = [];
  const warnings: string[] = [];
  const defaultAccount = ledger.accounts.find((a) => a.orgId === ctx.orgId)?.id ?? null;
  const delays = customerPaymentDelays(ledger, ctx);
  const later = (d: ISODate) => (compareDates(d, tomorrow) < 0 ? tomorrow : d);

  /* --- Factures clients : seul le RESTE DÛ compte (paiements partiels déjà déduits ; une facture soldée n'apparaît plus) --- */
  for (const inv of ledger.invoices.filter((i) => i.orgId === ctx.orgId)) {
    if (inv.status === "draft" || inv.status === "cancelled") continue;
    const view = invoiceView(ledger, inv, today);
    if (view.balanceCents <= 0) continue;
    const customer = ledger.customers.find((c) => c.id === inv.customerId);
    const name = customer?.company ?? customer?.name ?? "Client";
    const label = `${inv.number ?? "Facture"} — ${name}`;
    const counterpart = probableCounterpart(ledger, ctx, "in", view.balanceCents, inv.issueDate);
    if (counterpart) {
      excluded.push({ label, sourceId: inv.id, reason: `Une entrée bancaire identique (« ${counterpart.label} », ${counterpart.date}) n'est pas encore rapprochée : rapprochez-la pour éviter un double comptage.` });
      continue;
    }
    const hist = delays.get(inv.customerId);
    const histDelay = hist && hist.samples >= 2 ? hist.medianDelayDays : DEFAULT_DELAY;
    let date: ISODate;
    let why: string;
    let confidence: EventConfidence = "expected";
    if (view.isOverdue) {
      confidence = "uncertain";
      if (scenario === "prudent") {
        if (view.daysOverdue > 60) {
          excluded.push({ label, sourceId: inv.id, reason: `En retard de ${view.daysOverdue} jours : exclue du scénario prudent.` });
          continue;
        }
        date = addDays(today, 30);
        why = `Facture en retard de ${view.daysOverdue} jours : encaissement supposé dans 30 jours (scénario prudent).`;
      } else if (scenario === "central") {
        date = addDays(today, 14);
        why = `Facture en retard de ${view.daysOverdue} jours : encaissement supposé dans 14 jours (scénario central).`;
      } else {
        date = addDays(today, 3);
        why = `Facture en retard de ${view.daysOverdue} jours : encaissement supposé sous 3 jours (scénario favorable).`;
      }
    } else if (scenario === "prudent") {
      const delay = Math.max(30, histDelay + 15);
      date = addDays(inv.dueDate, delay);
      why = `Échéance ${inv.dueDate} + ${delay} jours de marge (scénario prudent).`;
    } else if (scenario === "central") {
      date = addDays(inv.dueDate, histDelay);
      why = `Échéance ${inv.dueDate} + ${histDelay} jours${hist && hist.samples >= 2 ? ` (retard habituel du client sur ${hist.samples} factures)` : " (délai par défaut, historique insuffisant)"}.`;
    } else {
      date = inv.dueDate;
      why = `À l'échéance ${inv.dueDate} (scénario favorable).`;
    }
    if (view.paidCents > 0) why += ` Reste dû après paiements partiels : seul le solde est prévu.`;
    date = later(date);
    events.push({
      id: `sales_invoice:${inv.id}:${date}`, date, amountCents: view.balanceCents, direction: "in", kind: "sales_invoice", sourceId: inv.id,
      label, confidence, accountId: defaultAccount, explanation: why, counterpartyId: inv.customerId, counterpartyName: name,
    });
  }

  /* --- Factures fournisseurs --- */
  for (const p of ledger.purchaseInvoices.filter((x) => x.orgId === ctx.orgId)) {
    const view = purchaseView(ledger, p, today);
    if (view.balanceCents <= 0) continue;
    const supplier = ledger.suppliers.find((s) => s.id === p.supplierId);
    const name = supplier?.company ?? supplier?.name ?? "Fournisseur";
    const label = `${p.reference} — ${name}`;
    if (p.status === "disputed" && scenario !== "prudent") {
      excluded.push({ label, sourceId: p.id, reason: "Facture contestée : exclue tant que la contestation n'est pas levée." });
      continue;
    }
    const counterpart = probableCounterpart(ledger, ctx, "out", view.balanceCents, p.issueDate);
    if (counterpart) {
      excluded.push({ label, sourceId: p.id, reason: `Une sortie bancaire identique (« ${counterpart.label} », ${counterpart.date}) n'est pas encore rapprochée : rapprochez-la pour éviter un double comptage.` });
      continue;
    }
    const date = later(p.dueDate);
    events.push({
      id: `purchase_invoice:${p.id}:${date}`, date, amountCents: -view.balanceCents, direction: "out", kind: "purchase_invoice", sourceId: p.id, label,
      confidence: "confirmed", accountId: p.accountId ?? defaultAccount,
      explanation: view.isOverdue ? `Facture fournisseur en retard de ${view.daysOverdue} jours : paiement supposé demain.` : `Échéance fournisseur ${p.dueDate}.`,
      counterpartyId: p.supplierId, counterpartyName: name,
    });
  }

  /* --- Dépenses engagées non payées (hors celles portées par une facture fournisseur : pas de double comptage) --- */
  for (const e of ledger.expenses.filter((x) => x.orgId === ctx.orgId && !x.paidTransactionId && !x.purchaseInvoiceId)) {
    const counterpart = probableCounterpart(ledger, ctx, "out", e.amountCents, addDays(e.date, -5));
    if (counterpart) {
      excluded.push({ label: e.label, sourceId: e.id, reason: `Une sortie bancaire identique (« ${counterpart.label} ») existe déjà : rapprochez-la de la dépense.` });
      continue;
    }
    const date = later(e.date);
    events.push({ id: `expense:${e.id}:${date}`, date, amountCents: -e.amountCents, direction: "out", kind: "expense", sourceId: e.id, label: e.label, confidence: "confirmed", accountId: defaultAccount, explanation: "Dépense enregistrée, pas encore décaissée." });
  }

  /* --- Paiements déclarés mais pas encore adossés à un mouvement bancaire : argent « en transit » --- */
  for (const pm of ledger.payments.filter((x) => x.orgId === ctx.orgId && !x.voidedAt && x.transactionId === null)) {
    const date = later(pm.date);
    const sales = pm.documentType === "sales_invoice";
    events.push({
      id: `declared_payment:${pm.id}:${date}`, date, amountCents: sales ? pm.amountCents : -pm.amountCents, direction: sales ? "in" : "out", kind: "declared_payment", sourceId: pm.id,
      label: `Paiement déclaré (${sales ? "encaissement" : "décaissement"})`, confidence: "expected", accountId: defaultAccount,
      explanation: "Paiement saisi mais non rattaché à un mouvement bancaire : il sera compté jusqu'à son rapprochement.",
    });
  }

  /* --- Transactions déjà saisies avec une date future --- */
  for (const t of ledger.transactions.filter((x) => x.orgId === ctx.orgId && !x.voidedAt && compareDates(x.date, today) > 0)) {
    events.push({
      id: `scheduled_transaction:${t.id}:${t.date}`, date: t.date, amountCents: signedCents(t), direction: t.direction, kind: "scheduled_transaction", sourceId: t.id, label: t.label,
      confidence: "confirmed", accountId: t.accountId, explanation: "Mouvement enregistré avec une date future.",
    });
  }

  /* --- Récurrences --- */
  const unpaidPurchases = ledger.purchaseInvoices.filter((p) => p.orgId === ctx.orgId && purchaseView(ledger, p, today).balanceCents > 0);
  for (const item of ledger.recurring.filter((r) => r.orgId === ctx.orgId)) {
    if (item.direction === "in") {
      if (scenario === "prudent" && item.confidence !== "confirmed") continue;
      if (scenario === "central" && item.confidence === "uncertain") continue;
    }
    for (const date of occurrences(item, tomorrow, horizonEnd)) {
      if (item.direction === "out") {
        const covered = unpaidPurchases.find((p) => {
          const supplier = ledger.suppliers.find((s) => s.id === p.supplierId);
          const names = [supplier?.company, supplier?.name].filter((x): x is string => !!x);
          const hay = normalizeText(item.label);
          const sameParty = names.some((n) => significantTokens(n).some((t) => hay.includes(t))) || (!!item.categoryId && item.categoryId === p.categoryId);
          return sameParty && Math.abs(diffDays(p.dueDate, date)) <= 7 && Math.abs(p.totalTtcCents - item.amountCents) <= item.amountCents * 0.05;
        });
        if (covered) {
          excluded.push({ label: `${item.label} (${date})`, sourceId: item.id, reason: `Déjà prévue via la facture fournisseur ${covered.reference} : occurrence ignorée pour ne pas la compter deux fois.` });
          continue;
        }
      }
      events.push({
        id: `recurring:${item.id}:${date}`, date, amountCents: item.direction === "in" ? item.amountCents : -item.amountCents, direction: item.direction, kind: "recurring", sourceId: item.id,
        label: item.label, confidence: item.direction === "out" ? "confirmed" : item.confidence, accountId: item.accountId ?? defaultAccount,
        explanation: `Opération récurrente (${{ weekly: "hebdomadaire", monthly: "mensuelle", quarterly: "trimestrielle", yearly: "annuelle" }[item.interval]}).`,
      });
    }
  }

  /* --- Hypothèses du dirigeant (simulation) --- */
  for (const a of assumptions) {
    switch (a.type) {
      case "delay_invoice": {
        const ev = events.find((e) => e.kind === "sales_invoice" && e.sourceId === a.invoiceId);
        if (!ev) warnings.push("Le retard demandé ne s'applique à aucune facture attendue (déjà soldée, annulée ou exclue).");
        else {
          ev.date = later(addDays(ev.date, a.days));
          ev.id = `sales_invoice:${a.invoiceId}:${ev.date}`;
          ev.simulated = true;
          ev.confidence = "uncertain";
          ev.explanation += ` Simulation : décalée de ${a.days} jours.`;
        }
        break;
      }
      case "advance_supplier_payment": {
        const ev = events.find((e) => e.kind === "purchase_invoice" && e.sourceId === a.purchaseInvoiceId);
        if (!ev) warnings.push("Le paiement anticipé ne s'applique à aucune facture fournisseur à payer.");
        else {
          ev.date = later(a.date);
          ev.id = `purchase_invoice:${a.purchaseInvoiceId}:${ev.date}`;
          ev.simulated = true;
          ev.explanation += ` Simulation : payée le ${ev.date}.`;
        }
        break;
      }
      case "one_off_expense":
      case "investment":
        events.push({ id: `assumption:${a.type}:${a.date}:${a.label}`, date: later(a.date), amountCents: -a.amountCents, direction: "out", kind: "assumption", label: a.label, confidence: "uncertain", accountId: defaultAccount, explanation: "Hypothèse du dirigeant (simulation).", simulated: true });
        break;
      case "extra_sale":
        events.push({ id: `assumption:extra_sale:${a.date}:${a.label}`, date: later(a.date), amountCents: a.amountCents, direction: "in", kind: "assumption", label: a.label, confidence: "uncertain", accountId: defaultAccount, explanation: "Hypothèse du dirigeant (simulation).", simulated: true });
        break;
      case "cost_increase": {
        const extra: ForecastEvent[] = [];
        for (const e of events) {
          if (e.kind === "recurring" && e.direction === "out" && compareDates(e.date, a.fromDate) >= 0) {
            const add = divRound(Math.abs(e.amountCents) * a.pctBp, 10_000);
            if (add > 0) extra.push({ ...e, id: `assumption:cost_increase:${e.id}`, amountCents: -add, kind: "assumption", label: `Hausse des charges — ${e.label}`, confidence: "uncertain", explanation: `Simulation : +${a.pctBp / 100} % sur cette charge récurrente.`, simulated: true });
          }
        }
        events.push(...extra);
        break;
      }
    }
  }
  return { events, excluded, warnings };
}

function buildAlerts(events: ForecastEvent[], series: DayPoint[], ctx: Ctx, thresholdCents: Cents, start: Cents, scenario: ScenarioKey): ForecastAlert[] {
  const alerts: ForecastAlert[] = [];
  const firstNegative = series.find((p) => p.balanceCents < 0);
  const topOutflowsBefore = (date: ISODate) =>
    events.filter((e) => e.amountCents < 0 && compareDates(e.date, date) <= 0).sort((a, b) => a.amountCents - b.amountCents).slice(0, 5).map((e) => ({ label: e.label, date: e.date, amountCents: e.amountCents }));
  if (firstNegative) {
    alerts.push({
      id: "negative_cash", kind: "negative_cash", severity: "critical", date: firstNegative.date,
      title: "Risque de trésorerie négative",
      message: `Dans le scénario ${scenario}, la trésorerie passerait sous zéro le ${firstNegative.date} (${(firstNegative.balanceCents / 100).toFixed(2).replace(".", ",")} €). Ce n'est pas un solde bancaire : c'est une projection fondée sur les échéances connues.`,
      evidence: topOutflowsBefore(firstNegative.date),
    });
  } else {
    const below = series.find((p) => p.balanceCents < thresholdCents);
    if (below && thresholdCents > 0) {
      alerts.push({
        id: "below_threshold", kind: "below_threshold", severity: "warning", date: below.date,
        title: "Seuil minimal de trésorerie atteint",
        message: `La trésorerie prévue passerait sous votre seuil de ${(thresholdCents / 100).toFixed(2).replace(".", ",")} € le ${below.date}.`,
        evidence: topOutflowsBefore(below.date),
      });
    }
  }

  const inflows = events.filter((e) => e.kind === "sales_invoice" && e.counterpartyId);
  const totalIn = sumCents(inflows.map((e) => e.amountCents));
  if (totalIn >= 100_000) {
    const byCustomer = new Map<string, { name: string; cents: Cents }>();
    for (const e of inflows) {
      const cur = byCustomer.get(e.counterpartyId as string) ?? { name: e.counterpartyName ?? "Client", cents: 0 };
      cur.cents += e.amountCents;
      byCustomer.set(e.counterpartyId as string, cur);
    }
    const top = [...byCustomer.values()].sort((a, b) => b.cents - a.cents)[0];
    if (top && byCustomer.size > 1 && top.cents / totalIn >= 0.5) {
      alerts.push({
        id: "customer_concentration", kind: "customer_concentration", severity: "warning",
        title: "Encaissements concentrés sur un client",
        message: `${Math.round((top.cents / totalIn) * 100)} % des encaissements attendus proviennent de ${top.name}. Un retard de ce client aurait un impact majeur.`,
        evidence: inflows.filter((e) => e.counterpartyName === top.name).map((e) => ({ label: e.label, date: e.date, amountCents: e.amountCents })),
      });
    }
  }

  const soon = addDays(ctx.today, 7);
  const large = events.filter((e) => e.amountCents < 0 && e.kind !== "assumption" && compareDates(e.date, soon) <= 0 && (-e.amountCents >= Math.max(thresholdCents, 0) * 0.5 || -e.amountCents >= start * 0.2) && -e.amountCents >= 50_000);
  if (large.length) {
    alerts.push({
      id: "large_due", kind: "large_due", severity: "info", title: "Échéances importantes cette semaine",
      message: `${large.length} paiement(s) important(s) sont prévus dans les 7 prochains jours.`,
      evidence: large.map((e) => ({ label: e.label, date: e.date, amountCents: e.amountCents })),
    });
  }
  return alerts;
}

/**
 * Prévision explicable : solde de départ confirmé + événements datés (chacun avec sa source, sa confiance
 * et son explication). Fonction PURE : ni le registre ni les données réelles ne sont modifiés,
 * y compris lorsque des hypothèses de simulation sont fournies.
 */
export function forecastCash(ledger: Ledger, ctx: Ctx, options: ForecastOptions): ForecastResult {
  const scenario = options.scenario ?? "central";
  const horizon = options.horizonDays;
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > 366) throw new ValidationError("Horizon invalide (1 à 366 jours).");
  const assumptions = options.assumptions ?? [];
  validateAssumptions(assumptions);
  const settings = ledger.organizations.find((o) => o.orgId === ctx.orgId);
  const threshold = settings?.minimumCashThresholdCents ?? 0;
  const today = ctx.today;
  const end = addDays(today, horizon);

  const scopedAccount = options.accountId ? ledger.accounts.find((a) => a.id === options.accountId && a.orgId === ctx.orgId) : undefined;
  if (options.accountId && !scopedAccount) throw new ValidationError("Compte inconnu.");
  const startingCash = scopedAccount ? accountBalance(ledger, scopedAccount, today) : cashPosition(ledger, ctx, today).totalCents;

  const built = buildForecastEvents(ledger, ctx, scenario, end, assumptions);
  let events = built.events.filter((e) => compareDates(e.date, end) <= 0);
  if (scopedAccount) events = events.filter((e) => e.accountId === scopedAccount.id);
  events.sort((a, b) => a.date.localeCompare(b.date) || a.amountCents - b.amountCents);

  const series: DayPoint[] = [];
  let bal = startingCash;
  let balConfirmed = startingCash;
  for (let i = 0; i <= horizon; i++) {
    const date = addDays(today, i);
    const day = events.filter((e) => e.date === date);
    const inC = sumCents(day.filter((e) => e.amountCents > 0).map((e) => e.amountCents));
    const outC = sumCents(day.filter((e) => e.amountCents < 0).map((e) => -e.amountCents));
    bal += inC - outC;
    balConfirmed += sumCents(day.filter((e) => e.confidence === "confirmed").map((e) => e.amountCents));
    series.push({ date, balanceCents: bal, balanceConfirmedOnlyCents: balConfirmed, inCents: inC, outCents: outC });
  }
  const min = series.reduce((m, p) => (p.balanceCents < m.balanceCents ? p : m), series[0] as DayPoint);

  // Complétude : une prévision doit dire quand elle manque de données.
  const incompleteWarnings: string[] = [];
  const accounts = ledger.accounts.filter((a) => a.orgId === ctx.orgId);
  if (accounts.length === 0) incompleteWarnings.push("Aucun compte financier : renseignez un solde initial pour obtenir une prévision fiable.");
  const lastMove = ledger.transactions.filter((t) => t.orgId === ctx.orgId && !t.voidedAt && compareDates(t.date, today) <= 0).map((t) => t.date).sort().pop();
  if (accounts.length && (!lastMove || diffDays(today, lastMove) > 30)) incompleteWarnings.push("Aucun mouvement récent : le solde de départ est peut-être obsolète (importez vos dernières transactions).");
  if (!ledger.recurring.some((r) => r.orgId === ctx.orgId && r.direction === "out")) incompleteWarnings.push("Aucune charge récurrente renseignée : les dépenses futures sont probablement sous-estimées.");
  if (!events.some((e) => e.kind === "sales_invoice" || e.kind === "purchase_invoice")) incompleteWarnings.push("Aucune échéance client ou fournisseur à venir : la prévision se limite au solde actuel et aux récurrences.");

  const alerts = buildAlerts(events, series, ctx, threshold, startingCash, scenario);
  return {
    asOf: today,
    horizonDays: horizon,
    scenario,
    accountId: scopedAccount?.id ?? null,
    startingCashCents: startingCash,
    events,
    excluded: built.excluded,
    series,
    minBalance: { date: min.date, cents: min.balanceCents },
    endBalanceCents: (series[series.length - 1] as DayPoint).balanceCents,
    endBalanceConfirmedOnlyCents: (series[series.length - 1] as DayPoint).balanceConfirmedOnlyCents,
    totalInCents: sumCents(events.filter((e) => e.amountCents > 0).map((e) => e.amountCents)),
    totalOutCents: sumCents(events.filter((e) => e.amountCents < 0).map((e) => -e.amountCents)),
    alerts,
    assumptions: [
      `Solde de départ : ${scopedAccount ? `compte « ${scopedAccount.name} »` : "tous les comptes"} au ${today}, calculé depuis les mouvements enregistrés.`,
      ...SCENARIO_RULES[scenario],
      ...(assumptions.length ? [`${assumptions.length} hypothèse(s) de simulation appliquée(s) — aucune donnée réelle n'est modifiée.`] : []),
    ],
    warnings: built.warnings,
    completeness: { isComplete: incompleteWarnings.length === 0, warnings: incompleteWarnings },
    simulated: assumptions.length > 0,
  };
}

/** Compare le scénario de base et le scénario simulé. Ne modifie rien. */
export function simulate(ledger: Ledger, ctx: Ctx, options: ForecastOptions & { assumptions: Assumption[] }) {
  const baseline = forecastCash(ledger, ctx, { ...options, assumptions: [] });
  const simulated = forecastCash(ledger, ctx, options);
  return {
    baseline,
    simulated,
    deltaEndCents: simulated.endBalanceCents - baseline.endBalanceCents,
    deltaMinCents: simulated.minBalance.cents - baseline.minBalance.cents,
    newlyNegative: simulated.series.some((p) => p.balanceCents < 0) && !baseline.series.some((p) => p.balanceCents < 0),
  };
}

export interface PeriodBucket {
  start: ISODate;
  end: ISODate;
  openingCents: Cents;
  inCents: Cents;
  outCents: Cents;
  closingCents: Cents;
  minCents: Cents;
}

/** Agrège la série quotidienne par semaine (blocs de 7 jours) ou par mois civil. */
export function aggregateSeries(series: DayPoint[], startingCash: Cents, by: "week" | "month"): PeriodBucket[] {
  const buckets: PeriodBucket[] = [];
  let current: PeriodBucket | null = null;
  let currentKey = "";
  series.forEach((p, i) => {
    if (i === 0) return; // le jour 0 est le solde de départ
    const key = by === "month" ? p.date.slice(0, 7) : String(Math.floor((i - 1) / 7));
    if (!current || key !== currentKey) {
      const opening: Cents = current ? current.closingCents : startingCash;
      current = { start: p.date, end: p.date, openingCents: opening, inCents: 0, outCents: 0, closingCents: p.balanceCents, minCents: p.balanceCents };
      currentKey = key;
      buckets.push(current);
    }
    current.end = p.date;
    current.inCents += p.inCents;
    current.outCents += p.outCents;
    current.closingCents = p.balanceCents;
    current.minCents = Math.min(current.minCents, p.balanceCents);
  });
  return buckets;
}

/** Écart entre une prévision antérieure et le solde réellement constaté. Signalé au-delà de 15 % et 500 €. */
export function compareForecastToActual(forecastCents: Cents, actualCents: Cents) {
  const gap = actualCents - forecastCents;
  const base = Math.max(Math.abs(forecastCents), 1);
  const pct = Math.abs(gap) / base;
  return { gapCents: gap, gapPct: pct, flagged: Math.abs(gap) >= 50_000 && pct >= 0.15 };
}
