import type { Ctx } from "./access";
import { addDays, compareDates, type ISODate } from "./dates";
import { invoiceView, quoteDisplayStatus } from "./documents";
import { forecastCash, type ForecastEvent, type ForecastResult } from "./forecast";
import { sumCents, divRound, type Cents } from "./money";
import { purchaseView, expenseState } from "./purchases";
import { allocatedCents, cashPosition, reconciliationStatus, type CashPosition } from "./transactions";
import { declaredPaymentsWithoutMovement } from "./payments";
import { diffDays } from "./dates";
import type { Id, Ledger } from "./types";

export interface DashboardData {
  asOf: ISODate;
  period: { from: ISODate; to: ISODate };
  cash: CashPosition;
  /** Entrées / sorties d'argent ENREGISTRÉES sur la période (mouvements réels, pas des factures). */
  receivedCents: Cents;
  spentCents: Cents;
  receivablesCents: Cents;
  receivablesOverdueCents: Cents;
  overdueInvoiceCount: number;
  payablesCents: Cents;
  payablesOverdueCents: Cents;
  forecast30: ForecastResult;
  forecast30Prudent: ForecastResult;
  forecast30Favorable: ForecastResult;
  nextImportantDue: ForecastEvent | null;
  provenance: string;
}

export function buildDashboard(ledger: Ledger, ctx: Ctx, period?: { from: ISODate; to: ISODate }): DashboardData {
  const p = period ?? { from: addDays(ctx.today, -30), to: ctx.today };
  const cash = cashPosition(ledger, ctx, ctx.today);
  const inPeriod = ledger.transactions.filter((t) => t.orgId === ctx.orgId && !t.voidedAt && compareDates(t.date, p.from) >= 0 && compareDates(t.date, p.to) <= 0);
  const views = ledger.invoices.filter((i) => i.orgId === ctx.orgId && i.status !== "draft" && i.status !== "cancelled").map((i) => invoiceView(ledger, i, ctx.today));
  const open = views.filter((v) => v.balanceCents > 0);
  const overdue = open.filter((v) => v.isOverdue);
  const purchases = ledger.purchaseInvoices.filter((x) => x.orgId === ctx.orgId).map((x) => purchaseView(ledger, x, ctx.today));
  const payOpen = purchases.filter((v) => v.balanceCents > 0);
  const forecast30 = forecastCash(ledger, ctx, { horizonDays: 30, scenario: "central" });
  const nextImportant =
    forecast30.events.filter((e) => e.amountCents < 0 && e.kind !== "assumption").sort((a, b) => a.amountCents - b.amountCents).slice(0, 3).sort((a, b) => a.date.localeCompare(b.date))[0] ?? null;
  const last = cash.accounts.map((a) => a.lastMovementDate).filter((d): d is ISODate => !!d).sort().pop();
  return {
    asOf: ctx.today,
    period: p,
    cash,
    receivedCents: sumCents(inPeriod.filter((t) => t.direction === "in").map((t) => t.amountCents)),
    spentCents: sumCents(inPeriod.filter((t) => t.direction === "out").map((t) => t.amountCents)),
    receivablesCents: sumCents(open.map((v) => v.balanceCents)),
    receivablesOverdueCents: sumCents(overdue.map((v) => v.balanceCents)),
    overdueInvoiceCount: overdue.length,
    payablesCents: sumCents(payOpen.map((v) => v.balanceCents)),
    payablesOverdueCents: sumCents(payOpen.filter((v) => v.isOverdue).map((v) => v.balanceCents)),
    forecast30,
    forecast30Prudent: forecastCash(ledger, ctx, { horizonDays: 30, scenario: "prudent" }),
    forecast30Favorable: forecastCash(ledger, ctx, { horizonDays: 30, scenario: "favorable" }),
    nextImportantDue: nextImportant,
    provenance: last ? `Solde calculé depuis les mouvements enregistrés (dernier mouvement le ${last}) — ce n'est pas une synchronisation bancaire.` : "Aucun mouvement enregistré : le solde correspond au solde d'ouverture saisi.",
  };
}

/* =============================== Centre d'actions =============================== */

export type ActionKind =
  | "overdue_invoice"
  | "supplier_due"
  | "unmatched_transactions"
  | "missing_receipts"
  | "cash_risk"
  | "quote_follow_up"
  | "unusual_expense"
  | "declared_payment_unattached";

export interface ActionItem {
  id: string;
  kind: ActionKind;
  severity: "critical" | "warning" | "info";
  title: string;
  detail: string;
  nextStep: string;
  target: { type: "invoice" | "purchase_invoice" | "quote" | "expense" | "transaction" | "transactions_unmatched" | "expenses_missing_receipt" | "forecast" | "payment"; id?: Id };
  amountCents?: Cents;
  date?: ISODate;
}

const SEV = { critical: 0, warning: 1, info: 2 } as const;

export function buildActions(ledger: Ledger, ctx: Ctx): ActionItem[] {
  const out: ActionItem[] = [];
  const today = ctx.today;

  for (const inv of ledger.invoices.filter((i) => i.orgId === ctx.orgId)) {
    const v = invoiceView(ledger, inv, today);
    if (!v.isOverdue) continue;
    const c = ledger.customers.find((x) => x.id === inv.customerId);
    out.push({
      id: `overdue:${inv.id}`, kind: "overdue_invoice", severity: v.daysOverdue > 30 ? "critical" : "warning",
      title: `${inv.number} en retard de ${v.daysOverdue} jour${v.daysOverdue > 1 ? "s" : ""}`,
      detail: `${c?.company ?? c?.name ?? "Client"} — reste dû ${(v.balanceCents / 100).toFixed(2).replace(".", ",")} €, échéance ${inv.dueDate}.`,
      nextStep: "Préparer une relance", target: { type: "invoice", id: inv.id }, amountCents: v.balanceCents, date: inv.dueDate,
    });
  }

  for (const p of ledger.purchaseInvoices.filter((x) => x.orgId === ctx.orgId)) {
    const v = purchaseView(ledger, p, today);
    if (v.balanceCents <= 0 || p.status === "disputed") continue;
    const d = diffDays(p.dueDate, today);
    if (d > 7) continue;
    const s = ledger.suppliers.find((x) => x.id === p.supplierId);
    out.push({
      id: `supplier_due:${p.id}`, kind: "supplier_due", severity: v.isOverdue ? "critical" : "warning",
      title: v.isOverdue ? `Facture fournisseur ${p.reference} en retard` : `Échéance fournisseur dans ${d} jour${d > 1 ? "s" : ""}`,
      detail: `${s?.company ?? s?.name ?? "Fournisseur"} — ${(v.balanceCents / 100).toFixed(2).replace(".", ",")} € à payer (échéance ${p.dueDate}).`,
      nextStep: p.status === "to_review" ? "Vérifier puis planifier le paiement" : "Planifier le paiement", target: { type: "purchase_invoice", id: p.id }, amountCents: v.balanceCents, date: p.dueDate,
    });
  }

  const unmatched = ledger.transactions.filter((t) => t.orgId === ctx.orgId && !t.voidedAt && reconciliationStatus(ledger, t) === "unmatched");
  if (unmatched.length) {
    out.push({
      id: "unmatched", kind: "unmatched_transactions", severity: "info",
      title: `${unmatched.length} transaction${unmatched.length > 1 ? "s" : ""} non rapprochée${unmatched.length > 1 ? "s" : ""}`,
      detail: "Rapprocher ces mouvements avec vos factures garde vos statuts de paiement exacts.",
      nextStep: "Examiner les propositions de rapprochement", target: { type: "transactions_unmatched" },
      amountCents: sumCents(unmatched.map((t) => t.amountCents)),
    });
  }

  const noReceipt = ledger.expenses.filter((e) => e.orgId === ctx.orgId && !e.receiptAttachmentId && !e.purchaseInvoiceId);
  if (noReceipt.length) {
    out.push({
      id: "missing_receipts", kind: "missing_receipts", severity: "info", title: `${noReceipt.length} justificatif${noReceipt.length > 1 ? "s" : ""} manquant${noReceipt.length > 1 ? "s" : ""}`,
      detail: "Des dépenses n'ont aucun justificatif attaché.", nextStep: "Ajouter les justificatifs", target: { type: "expenses_missing_receipt" },
    });
  }

  const f = forecastCash(ledger, ctx, { horizonDays: 30, scenario: "central" });
  for (const a of f.alerts.filter((x) => x.kind === "negative_cash" || x.kind === "below_threshold")) {
    out.push({
      id: `cash:${a.id}`, kind: "cash_risk", severity: a.severity, title: a.title, detail: a.message,
      nextStep: "Ouvrir la prévision et tester une simulation", target: { type: "forecast" }, ...(a.date ? { date: a.date } : {}),
    });
  }

  for (const q of ledger.quotes.filter((x) => x.orgId === ctx.orgId)) {
    const st = quoteDisplayStatus(q, today);
    if (st !== "sent" && st !== "viewed") continue;
    const sentDays = q.sentAt ? diffDays(today, q.sentAt.slice(0, 10)) : 0;
    const expiresIn = diffDays(q.validUntil, today);
    if (sentDays >= 7 || expiresIn <= 7) {
      const c = ledger.customers.find((x) => x.id === q.customerId);
      out.push({
        id: `quote:${q.id}`, kind: "quote_follow_up", severity: "info", title: `Devis ${q.number ?? ""} à relancer`,
        detail: `${c?.company ?? c?.name ?? "Client"} — envoyé il y a ${sentDays} jours, valable jusqu'au ${q.validUntil}.`,
        nextStep: "Relancer le client ou prolonger la validité", target: { type: "quote", id: q.id }, amountCents: q.totals.totalTtcCents, date: q.validUntil,
      });
    }
  }

  // Dépense inhabituelle : ≥ 2,5 × la médiane de sa catégorie (≥ 3 dépenses antérieures) et ≥ 100 €.
  for (const e of ledger.expenses.filter((x) => x.orgId === ctx.orgId && x.categoryId)) {
    const history = ledger.expenses.filter((x) => x.orgId === ctx.orgId && x.categoryId === e.categoryId && x.id !== e.id && compareDates(x.date, e.date) < 0).map((x) => x.amountCents).sort((a, b) => a - b);
    if (history.length < 3 || e.amountCents < 10_000) continue;
    const mid = Math.floor(history.length / 2);
    const med = history.length % 2 ? (history[mid] as number) : divRound((history[mid - 1] as number) + (history[mid] as number), 2);
    if (e.amountCents >= med * 2.5 && diffDays(today, e.date) <= 45) {
      out.push({
        id: `unusual:${e.id}`, kind: "unusual_expense", severity: "warning", title: `Dépense inhabituelle : ${e.label}`,
        detail: `${(e.amountCents / 100).toFixed(2).replace(".", ",")} € contre une médiane de ${(med / 100).toFixed(2).replace(".", ",")} € dans cette catégorie.`,
        nextStep: "Vérifier la dépense", target: { type: "expense", id: e.id }, amountCents: e.amountCents, date: e.date,
      });
    }
  }

  for (const pm of declaredPaymentsWithoutMovement(ledger, ctx.orgId)) {
    out.push({
      id: `declared:${pm.id}`, kind: "declared_payment_unattached", severity: "info", title: "Paiement déclaré sans mouvement bancaire",
      detail: "Ce paiement réduit le reste dû mais n'a pas encore modifié la trésorerie réelle.", nextStep: "Rapprocher avec la transaction bancaire", target: { type: "payment", id: pm.id }, amountCents: pm.amountCents, date: pm.date,
    });
  }

  return out.sort((a, b) => SEV[a.severity] - SEV[b.severity] || (a.date ?? "9999").localeCompare(b.date ?? "9999"));
}

/** Part non affectée d'une transaction (utilitaire d'interface). */
export function unallocatedCents(ledger: Ledger, txId: Id, amount: Cents): Cents {
  return amount - allocatedCents(ledger, txId);
}

export { expenseState };
