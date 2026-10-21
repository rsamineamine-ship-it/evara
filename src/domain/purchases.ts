import { requirePermission, scoped, type Ctx } from "./access";
import { compareDates, diffDays, isValidISODate, type ISODate } from "./dates";
import { ConflictError, ValidationError } from "./errors";
import { logAudit, newId } from "./ledger";
import { sumCents, type Cents } from "./money";
import { orgSettings } from "./documents";
import type { Expense, Id, Ledger, PurchaseInvoice } from "./types";

/* ========================= FACTURES FOURNISSEURS ========================= */

export interface PurchaseInput {
  supplierId: Id;
  reference: string;
  issueDate: ISODate;
  dueDate: ISODate;
  netHtCents: Cents;
  vatCents: Cents;
  categoryId?: Id | null;
  attachmentId?: Id | null;
  accountId?: Id | null;
}

function checkPurchase(ledger: Ledger, ctx: Ctx, input: PurchaseInput, selfId?: Id) {
  scoped(ledger.suppliers, ctx, input.supplierId, "Fournisseur");
  const issues: string[] = [];
  if (!input.reference.trim()) issues.push("La référence de la facture est obligatoire.");
  if (!isValidISODate(input.issueDate)) issues.push("Date de facture invalide.");
  if (!isValidISODate(input.dueDate)) issues.push("Échéance invalide.");
  else if (isValidISODate(input.issueDate) && compareDates(input.dueDate, input.issueDate) < 0) issues.push("L'échéance ne peut pas précéder la date de facture.");
  if (!Number.isSafeInteger(input.netHtCents) || input.netHtCents < 0) issues.push("Montant HT invalide.");
  if (!Number.isSafeInteger(input.vatCents) || input.vatCents < 0) issues.push("TVA invalide.");
  if (input.netHtCents + input.vatCents <= 0) issues.push("Le total TTC doit être positif.");
  if (input.attachmentId) scoped(ledger.attachments, ctx, input.attachmentId, "Justificatif");
  if (input.accountId) scoped(ledger.accounts, ctx, input.accountId, "Compte");
  if (issues.length) throw new ValidationError("Facture fournisseur invalide", issues);
  const dup = ledger.purchaseInvoices.find(
    (p) => p.orgId === ctx.orgId && p.id !== selfId && p.supplierId === input.supplierId && p.reference.trim().toLowerCase() === input.reference.trim().toLowerCase(),
  );
  if (dup) throw new ConflictError(`Une facture "${input.reference}" existe déjà pour ce fournisseur (doublon probable).`, "DUPLICATE_REFERENCE");
}

export function createPurchaseInvoice(ledger: Ledger, ctx: Ctx, input: PurchaseInput): PurchaseInvoice {
  requirePermission(ctx, "write");
  checkPurchase(ledger, ctx, input);
  const p: PurchaseInvoice = {
    id: newId("pur"),
    orgId: ctx.orgId,
    supplierId: input.supplierId,
    reference: input.reference.trim(),
    status: "to_review",
    currency: orgSettings(ledger, ctx).currency,
    issueDate: input.issueDate,
    dueDate: input.dueDate,
    netHtCents: input.netHtCents,
    vatCents: input.vatCents,
    totalTtcCents: input.netHtCents + input.vatCents,
    categoryId: input.categoryId ?? null,
    attachmentId: input.attachmentId ?? null,
    accountId: input.accountId ?? null,
    createdAt: ctx.nowIso,
  };
  ledger.purchaseInvoices.push(p);
  logAudit(ledger, ctx, "purchase_invoice.created", "purchase_invoice", p.id);
  return p;
}

export function updatePurchaseInvoice(ledger: Ledger, ctx: Ctx, id: Id, input: PurchaseInput): PurchaseInvoice {
  requirePermission(ctx, "write");
  const p = scoped(ledger.purchaseInvoices, ctx, id, "Facture fournisseur");
  const hasPayments = ledger.payments.some((x) => x.documentType === "purchase_invoice" && x.documentId === id && !x.voidedAt);
  if (hasPayments && input.netHtCents + input.vatCents !== p.totalTtcCents) {
    throw new ConflictError("Des paiements existent : le montant ne peut plus être modifié.", "HAS_PAYMENTS");
  }
  checkPurchase(ledger, ctx, input, id);
  Object.assign(p, {
    supplierId: input.supplierId,
    reference: input.reference.trim(),
    issueDate: input.issueDate,
    dueDate: input.dueDate,
    netHtCents: input.netHtCents,
    vatCents: input.vatCents,
    totalTtcCents: input.netHtCents + input.vatCents,
    categoryId: input.categoryId ?? null,
    attachmentId: input.attachmentId ?? null,
    accountId: input.accountId ?? null,
  });
  logAudit(ledger, ctx, "purchase_invoice.updated", "purchase_invoice", id);
  return p;
}

export function approvePurchaseInvoice(ledger: Ledger, ctx: Ctx, id: Id): PurchaseInvoice {
  requirePermission(ctx, "write");
  const p = scoped(ledger.purchaseInvoices, ctx, id, "Facture fournisseur");
  if (p.status === "approved") return p;
  p.status = "approved";
  delete p.disputedReason;
  logAudit(ledger, ctx, "purchase_invoice.approved", "purchase_invoice", id);
  return p;
}

export function disputePurchaseInvoice(ledger: Ledger, ctx: Ctx, id: Id, reason: string): PurchaseInvoice {
  requirePermission(ctx, "write");
  if (!reason.trim()) throw new ValidationError("Indiquez le motif de la contestation.");
  const p = scoped(ledger.purchaseInvoices, ctx, id, "Facture fournisseur");
  p.status = "disputed";
  p.disputedReason = reason.trim();
  logAudit(ledger, ctx, "purchase_invoice.disputed", "purchase_invoice", id, { reason: p.disputedReason });
  return p;
}

export type PurchaseDisplayStatus = "to_review" | "to_pay" | "partially_paid" | "paid" | "overdue" | "disputed";

export interface PurchaseView {
  invoice: PurchaseInvoice;
  paidCents: Cents;
  balanceCents: Cents;
  overpaidCents: Cents;
  isOverdue: boolean;
  daysOverdue: number;
  displayStatus: PurchaseDisplayStatus;
}

export function purchaseView(ledger: Ledger, p: PurchaseInvoice, today: ISODate): PurchaseView {
  const paid = sumCents(ledger.payments.filter((x) => x.documentType === "purchase_invoice" && x.documentId === p.id && !x.voidedAt).map((x) => x.amountCents));
  const raw = p.totalTtcCents - paid;
  const balance = Math.max(0, raw);
  const isOverdue = balance > 0 && compareDates(p.dueDate, today) < 0;
  let displayStatus: PurchaseDisplayStatus;
  if (balance === 0) displayStatus = "paid";
  else if (p.status === "disputed") displayStatus = "disputed";
  else if (p.status === "to_review") displayStatus = "to_review";
  else if (isOverdue) displayStatus = "overdue";
  else if (paid > 0) displayStatus = "partially_paid";
  else displayStatus = "to_pay";
  return { invoice: p, paidCents: paid, balanceCents: balance, overpaidCents: Math.max(0, -raw), isOverdue, daysOverdue: isOverdue ? diffDays(today, p.dueDate) : 0, displayStatus };
}

/* ================================ DÉPENSES ================================ */

export interface ExpenseInput {
  date: ISODate;
  label: string;
  amountCents: Cents;
  vatCents?: Cents;
  categoryId?: Id | null;
  supplierId?: Id | null;
  paymentMethod: Expense["paymentMethod"];
  receiptAttachmentId?: Id | null;
  purchaseInvoiceId?: Id | null;
  notes?: string;
}

export function createExpense(ledger: Ledger, ctx: Ctx, input: ExpenseInput): Expense {
  requirePermission(ctx, "write");
  const issues: string[] = [];
  if (!isValidISODate(input.date)) issues.push("Date invalide.");
  if (!input.label.trim()) issues.push("Libellé obligatoire.");
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) issues.push("Montant invalide.");
  if ((input.vatCents ?? 0) < 0 || (input.vatCents ?? 0) > input.amountCents) issues.push("TVA incohérente avec le montant.");
  if (input.supplierId) scoped(ledger.suppliers, ctx, input.supplierId, "Fournisseur");
  if (input.categoryId) scoped(ledger.categories, ctx, input.categoryId, "Catégorie");
  if (input.receiptAttachmentId) scoped(ledger.attachments, ctx, input.receiptAttachmentId, "Justificatif");
  if (input.purchaseInvoiceId) scoped(ledger.purchaseInvoices, ctx, input.purchaseInvoiceId, "Facture fournisseur");
  if (issues.length) throw new ValidationError("Dépense invalide", issues);
  const e: Expense = {
    id: newId("exp"),
    orgId: ctx.orgId,
    date: input.date,
    label: input.label.trim(),
    amountCents: input.amountCents,
    vatCents: input.vatCents ?? 0,
    categoryId: input.categoryId ?? null,
    supplierId: input.supplierId ?? null,
    paymentMethod: input.paymentMethod,
    receiptAttachmentId: input.receiptAttachmentId ?? null,
    paidTransactionId: null,
    purchaseInvoiceId: input.purchaseInvoiceId ?? null,
    ...(input.notes ? { notes: input.notes } : {}),
    createdAt: ctx.nowIso,
  };
  ledger.expenses.push(e);
  logAudit(ledger, ctx, "expense.created", "expense", e.id);
  return e;
}

export type ExpenseState = "committed" | "paid" | "covered_by_invoice";

/**
 * Distingue : dépense engagée (aucun décaissement), payée (rattachée à une sortie d'argent),
 * ou portée par une facture fournisseur (comptée via la facture : pas de double comptage).
 */
export function expenseState(e: Expense): ExpenseState {
  if (e.purchaseInvoiceId) return "covered_by_invoice";
  return e.paidTransactionId ? "paid" : "committed";
}
