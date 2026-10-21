import type { Ctx } from "./access";
import { compareDates, diffDays, isBetween, type ISODate } from "./dates";
import { invoiceView, quoteDisplayStatus } from "./documents";
import { forecastCash, compareForecastToActual } from "./forecast";
import { divRound, sumCents, type Cents } from "./money";
import { purchaseView } from "./purchases";
import { toCsv } from "./csv";
import { cashPosition, reconciliationStatus } from "./transactions";
import { newId } from "./ledger";
import type { Id, Ledger, Transaction } from "./types";

export interface Period {
  from: ISODate;
  to: ISODate;
}

const txIn = (ledger: Ledger, ctx: Ctx, p: Period, dir: "in" | "out"): Transaction[] =>
  ledger.transactions.filter((t) => t.orgId === ctx.orgId && !t.voidedAt && t.direction === dir && isBetween(t.date, p.from, p.to));

function categoryName(ledger: Ledger, id: Id | null): string {
  return (id && ledger.categories.find((c) => c.id === id)?.name) || "Non catégorisé";
}

export function monthKey(d: ISODate): string {
  return d.slice(0, 7);
}

/** Encaissements / décaissements RÉELS (mouvements d'argent) — indicateurs de trésorerie. */
export function cashMovementsReport(ledger: Ledger, ctx: Ctx, p: Period, dir: "in" | "out") {
  const rows = txIn(ledger, ctx, p, dir).sort((a, b) => a.date.localeCompare(b.date));
  const byMonth = new Map<string, Cents>();
  const byCategory = new Map<string, Cents>();
  for (const t of rows) {
    byMonth.set(monthKey(t.date), (byMonth.get(monthKey(t.date)) ?? 0) + t.amountCents);
    const c = categoryName(ledger, t.categoryId);
    byCategory.set(c, (byCategory.get(c) ?? 0) + t.amountCents);
  }
  return {
    period: p,
    totalCents: sumCents(rows.map((r) => r.amountCents)),
    rows,
    byMonth: [...byMonth].sort((a, b) => a[0].localeCompare(b[0])).map(([month, cents]) => ({ month, cents })),
    byCategory: [...byCategory].sort((a, b) => b[1] - a[1]).map(([category, cents]) => ({ category, cents })),
  };
}

/**
 * Dépenses par catégorie, avec les DEUX lectures : engagé (dépenses + factures fournisseurs datées dans la période,
 * sans double comptage des dépenses portées par une facture) et décaissé (sorties d'argent réelles).
 */
export function expensesByCategoryReport(ledger: Ledger, ctx: Ctx, p: Period) {
  const committed = new Map<string, Cents>();
  const add = (m: Map<string, Cents>, k: string, v: Cents) => m.set(k, (m.get(k) ?? 0) + v);
  for (const e of ledger.expenses.filter((x) => x.orgId === ctx.orgId && !x.purchaseInvoiceId && isBetween(x.date, p.from, p.to))) add(committed, categoryName(ledger, e.categoryId), e.amountCents);
  for (const pi of ledger.purchaseInvoices.filter((x) => x.orgId === ctx.orgId && isBetween(x.issueDate, p.from, p.to))) add(committed, categoryName(ledger, pi.categoryId), pi.totalTtcCents);
  const paid = new Map<string, Cents>();
  for (const t of txIn(ledger, ctx, p, "out")) add(paid, categoryName(ledger, t.categoryId), t.amountCents);
  const keys = new Set([...committed.keys(), ...paid.keys()]);
  const rows = [...keys].map((category) => ({ category, committedCents: committed.get(category) ?? 0, paidCents: paid.get(category) ?? 0 })).sort((a, b) => b.committedCents + b.paidCents - (a.committedCents + a.paidCents));
  return { period: p, rows, totalCommittedCents: sumCents(rows.map((r) => r.committedCents)), totalPaidCents: sumCents(rows.map((r) => r.paidCents)) };
}

export function overdueInvoicesReport(ledger: Ledger, ctx: Ctx) {
  const rows = ledger.invoices
    .filter((i) => i.orgId === ctx.orgId)
    .map((i) => invoiceView(ledger, i, ctx.today))
    .filter((v) => v.isOverdue)
    .map((v) => ({ invoice: v.invoice, customer: ledger.customers.find((c) => c.id === v.invoice.customerId)?.company ?? ledger.customers.find((c) => c.id === v.invoice.customerId)?.name ?? "", balanceCents: v.balanceCents, daysOverdue: v.daysOverdue }))
    .sort((a, b) => b.daysOverdue - a.daysOverdue);
  return { rows, totalCents: sumCents(rows.map((r) => r.balanceCents)) };
}

export function supplierDueReport(ledger: Ledger, ctx: Ctx, p: Period) {
  const rows = ledger.purchaseInvoices
    .filter((x) => x.orgId === ctx.orgId && isBetween(x.dueDate, p.from, p.to))
    .map((x) => purchaseView(ledger, x, ctx.today))
    .filter((v) => v.balanceCents > 0)
    .map((v) => ({ invoice: v.invoice, supplier: ledger.suppliers.find((s) => s.id === v.invoice.supplierId)?.company ?? "", balanceCents: v.balanceCents, isOverdue: v.isOverdue }))
    .sort((a, b) => a.invoice.dueDate.localeCompare(b.invoice.dueDate));
  return { rows, totalCents: sumCents(rows.map((r) => r.balanceCents)) };
}

export function quotesReport(ledger: Ledger, ctx: Ctx, p: Period) {
  const quotes = ledger.quotes.filter((q) => q.orgId === ctx.orgId && isBetween(q.issueDate, p.from, p.to) && q.status !== "draft");
  const counts = { sent: 0, accepted: 0, declined: 0, expired: 0, converted: 0 } as Record<string, number>;
  const amounts = { accepted: 0, declined: 0 };
  for (const q of quotes) {
    const st = quoteDisplayStatus(q, ctx.today);
    const key = st === "viewed" ? "sent" : st;
    counts[key] = (counts[key] ?? 0) + 1;
    if (st === "accepted" || st === "converted") amounts.accepted += q.totals.totalTtcCents;
    if (st === "declined") amounts.declined += q.totals.totalTtcCents;
  }
  const decided = (counts.accepted ?? 0) + (counts.converted ?? 0) + (counts.declined ?? 0) + (counts.expired ?? 0);
  return { counts, amounts, acceptanceRate: decided ? ((counts.accepted ?? 0) + (counts.converted ?? 0)) / decided : null, total: quotes.length };
}

/** Délai d'encaissement : jours entre l'émission et le dernier paiement, sur les factures soldées de la période. */
export function collectionDelayReport(ledger: Ledger, ctx: Ctx, p: Period) {
  const samples: { number: string; days: number; lateDays: number }[] = [];
  for (const inv of ledger.invoices.filter((i) => i.orgId === ctx.orgId && i.status !== "draft" && i.status !== "cancelled" && isBetween(i.issueDate, p.from, p.to))) {
    const v = invoiceView(ledger, inv, ctx.today);
    if (v.paymentState !== "paid") continue;
    const last = ledger.payments.filter((x) => x.documentType === "sales_invoice" && x.documentId === inv.id && !x.voidedAt).map((x) => x.date).sort().pop();
    if (!last) continue;
    samples.push({ number: inv.number ?? "", days: diffDays(last, inv.issueDate), lateDays: Math.max(0, diffDays(last, inv.dueDate)) });
  }
  const avg = (xs: number[]) => (xs.length ? divRound(sumCents(xs) * 10, xs.length) / 10 : null);
  return { samples, averageDays: avg(samples.map((s) => s.days)), averageLateDays: avg(samples.map((s) => s.lateDays)) };
}

/** Facturé (indicateur comptable) vs encaissé (indicateur de trésorerie) : deux notions distinctes, jamais confondues. */
export function invoicedVsCashedReport(ledger: Ledger, ctx: Ctx, p: Period) {
  const invoices = ledger.invoices.filter((i) => i.orgId === ctx.orgId && i.status !== "draft" && i.status !== "cancelled" && isBetween(i.issueDate, p.from, p.to));
  const credits = ledger.creditNotes.filter((c) => c.orgId === ctx.orgId && isBetween(c.issueDate, p.from, p.to));
  const invoicedHt = sumCents(invoices.map((i) => i.totals.netHtCents)) - sumCents(credits.map((c) => c.totals.netHtCents));
  const received = sumCents(txIn(ledger, ctx, p, "in").map((t) => t.amountCents));
  return {
    invoicedHtCents: invoicedHt,
    cashReceivedCents: received,
    note: "« Facturé » est un indicateur comptable (hors trésorerie). « Encaissé » provient des mouvements d'argent enregistrés. Ni l'un ni l'autre n'est un bénéfice.",
  };
}

export function unmatchedTransactionsReport(ledger: Ledger, ctx: Ctx) {
  const rows = ledger.transactions.filter((t) => t.orgId === ctx.orgId && !t.voidedAt && reconciliationStatus(ledger, t) === "unmatched").sort((a, b) => b.date.localeCompare(a.date));
  return { rows, totalCents: sumCents(rows.map((r) => (r.direction === "in" ? r.amountCents : -r.amountCents))) };
}

/* ---------------- Prévision vs réalisé ---------------- */

/** Mémorise la projection à 30 jours du jour (une seule fois par jour et par scénario). */
export function takeForecastSnapshot(ledger: Ledger, ctx: Ctx, scenario: "prudent" | "central" | "favorable" = "central"): void {
  if (ledger.forecastSnapshots.some((s) => s.orgId === ctx.orgId && s.takenOn === ctx.today && s.scenario === scenario)) return;
  const f = forecastCash(ledger, ctx, { horizonDays: 30, scenario });
  const target = f.series[f.series.length - 1]!.date;
  ledger.forecastSnapshots.push({ id: newId("fs"), orgId: ctx.orgId, takenOn: ctx.today, targetDate: target, scenario, forecastCents: f.endBalanceCents });
}

export function forecastAccuracyReport(ledger: Ledger, ctx: Ctx) {
  const rows = ledger.forecastSnapshots
    .filter((s) => s.orgId === ctx.orgId && compareDates(s.targetDate, ctx.today) <= 0)
    .map((s) => {
      const actual = cashPosition(ledger, ctx, s.targetDate).totalCents;
      return { snapshot: s, actualCents: actual, ...compareForecastToActual(s.forecastCents, actual) };
    })
    .sort((a, b) => b.snapshot.targetDate.localeCompare(a.snapshot.targetDate));
  return { rows };
}

/** Variation entre deux périodes (pour les comparaisons). */
export function comparePeriods(current: Cents, previous: Cents) {
  const delta = current - previous;
  return { currentCents: current, previousCents: previous, deltaCents: delta, deltaPct: previous === 0 ? null : delta / Math.abs(previous) };
}

export function previousPeriod(p: Period): Period {
  const len = diffDays(p.to, p.from) + 1;
  const to = new Date(Date.parse(`${p.from}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const from = new Date(Date.parse(`${to}T00:00:00Z`) - (len - 1) * 86_400_000).toISOString().slice(0, 10);
  return { from, to };
}

/* ---------------- Exports ---------------- */

const eur = (c: Cents) => (c / 100).toFixed(2).replace(".", ",");

export function transactionsCsv(ledger: Ledger, ctx: Ctx, txs: Transaction[]): string {
  const rows: (string | number)[][] = [["Date", "Libellé", "Sens", "Montant (EUR)", "Compte", "Catégorie", "Contrepartie", "Statut de rapprochement", "Source", "Référence externe"]];
  for (const t of txs) {
    rows.push([t.date, t.label, t.direction === "in" ? "Entrée" : "Sortie", (t.direction === "in" ? "" : "-") + eur(t.amountCents), ledger.accounts.find((a) => a.id === t.accountId)?.name ?? "", categoryName(ledger, t.categoryId), t.counterparty ?? "", reconciliationStatus(ledger, t), t.source, t.externalRef ?? ""]);
  }
  return toCsv(rows);
}

export { toCsv };
