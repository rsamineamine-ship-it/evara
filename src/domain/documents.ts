import { requirePermission, scoped, type Ctx } from "./access";
import { addDays, compareDates, diffDays, endOfMonth, isValidISODate, type ISODate } from "./dates";
import { ConflictError, DomainError, ValidationError } from "./errors";
import { logAudit, newId } from "./ledger";
import { sumCents, type Cents, type CurrencyCode } from "./money";
import { allocateNumber } from "./numbering";
import { computeTotals, validateLines } from "./totals";
import type {
  CreditNote,
  DocumentLine,
  Id,
  Ledger,
  OrgSettings,
  PaymentTerms,
  Quote,
  QuoteStatus,
  SalesInvoice,
} from "./types";

export function orgSettings(ledger: Ledger, ctx: Ctx): OrgSettings {
  const s = ledger.organizations.find((o) => o.orgId === ctx.orgId);
  if (!s) throw new DomainError("Entreprise introuvable", "NOT_FOUND");
  return s;
}

export function computeDueDate(issueDate: ISODate, terms: PaymentTerms): ISODate {
  switch (terms.kind) {
    case "on_receipt":
      return issueDate;
    case "net":
      return addDays(issueDate, terms.days);
    case "end_of_month":
      return endOfMonth(addDays(issueDate, terms.days));
  }
}

export function newLine(partial: Partial<DocumentLine> & { description: string }): DocumentLine {
  return {
    id: newId("ln"),
    quantity: 1,
    unitPriceCents: 0,
    vatRateBp: 2000,
    discountBp: 0,
    ...partial,
  };
}

/* ================================== DEVIS ================================== */

export interface QuoteInput {
  customerId: Id;
  issueDate: ISODate;
  validUntil: ISODate;
  lines: DocumentLine[];
  documentDiscountBp?: number;
  paymentTerms?: PaymentTerms;
  notes?: string;
  currency?: CurrencyCode;
}

function checkDocInput(ledger: Ledger, ctx: Ctx, input: { customerId: Id; issueDate: ISODate; lines: DocumentLine[]; documentDiscountBp?: number }) {
  const settings = orgSettings(ledger, ctx);
  scoped(ledger.customers, ctx, input.customerId, "Client");
  const issues = validateLines(input.lines, settings.vatRatesBp);
  if (!isValidISODate(input.issueDate)) issues.push("Date d'émission invalide.");
  const d = input.documentDiscountBp ?? 0;
  if (!Number.isInteger(d) || d < 0 || d > 10_000) issues.push("Remise globale invalide.");
  if (issues.length) throw new ValidationError("Document invalide", issues);
  return settings;
}

export function createQuote(ledger: Ledger, ctx: Ctx, input: QuoteInput): Quote {
  requirePermission(ctx, "write");
  const settings = checkDocInput(ledger, ctx, input);
  if (!isValidISODate(input.validUntil) || compareDates(input.validUntil, input.issueDate) < 0) {
    throw new ValidationError("La date de validité doit être postérieure à la date d'émission.");
  }
  const customer = scoped(ledger.customers, ctx, input.customerId, "Client");
  const quote: Quote = {
    id: newId("qt"),
    orgId: ctx.orgId,
    customerId: input.customerId,
    number: null,
    status: "draft",
    currency: input.currency ?? settings.currency,
    issueDate: input.issueDate,
    validUntil: input.validUntil,
    lines: input.lines.map((l) => ({ ...l })),
    documentDiscountBp: input.documentDiscountBp ?? 0,
    paymentTerms: input.paymentTerms ?? customer.defaultPaymentTerms,
    ...(input.notes ? { notes: input.notes } : {}),
    totals: computeTotals(input.lines, input.documentDiscountBp ?? 0),
    convertedInvoiceId: null,
    createdAt: ctx.nowIso,
  };
  ledger.quotes.push(quote);
  logAudit(ledger, ctx, "quote.created", "quote", quote.id);
  return quote;
}

export function updateQuoteDraft(ledger: Ledger, ctx: Ctx, id: Id, input: QuoteInput): Quote {
  requirePermission(ctx, "write");
  const quote = scoped(ledger.quotes, ctx, id, "Devis");
  if (quote.status !== "draft") throw new ConflictError("Seul un brouillon de devis peut être modifié.", "NOT_DRAFT");
  checkDocInput(ledger, ctx, input);
  if (compareDates(input.validUntil, input.issueDate) < 0) throw new ValidationError("La date de validité doit être postérieure à la date d'émission.");
  Object.assign(quote, {
    customerId: input.customerId,
    issueDate: input.issueDate,
    validUntil: input.validUntil,
    lines: input.lines.map((l) => ({ ...l })),
    documentDiscountBp: input.documentDiscountBp ?? 0,
    paymentTerms: input.paymentTerms ?? quote.paymentTerms,
    totals: computeTotals(input.lines, input.documentDiscountBp ?? 0),
  });
  if (input.notes !== undefined) quote.notes = input.notes;
  logAudit(ledger, ctx, "quote.updated", "quote", quote.id);
  return quote;
}

/** Statut affiché : "expiré" est dérivé de la date de validité tant que le devis n'a pas été accepté/refusé/converti. */
export function quoteDisplayStatus(q: Pick<Quote, "status" | "validUntil">, today: ISODate): QuoteStatus {
  if ((q.status === "sent" || q.status === "viewed") && compareDates(q.validUntil, today) < 0) return "expired";
  return q.status;
}

/**
 * Marque un devis comme envoyé. L'application n'envoie PAS d'email sans intégration configurée :
 * l'utilisateur doit confirmer que l'envoi a réellement eu lieu (`confirmedByUser`).
 */
export function markQuoteSent(ledger: Ledger, ctx: Ctx, id: Id, opts: { confirmedByUser: boolean; via: "manual" | "email_integration" }): Quote {
  requirePermission(ctx, "issue");
  const quote = scoped(ledger.quotes, ctx, id, "Devis");
  if (!opts.confirmedByUser) throw new ValidationError("Confirmez que le devis a réellement été transmis au client.");
  if (quote.status !== "draft") throw new ConflictError("Ce devis a déjà été envoyé.", "ALREADY_SENT");
  const settings = orgSettings(ledger, ctx);
  quote.number = allocateNumber(ledger, settings, "quote", quote.issueDate);
  quote.status = "sent";
  quote.sentAt = ctx.nowIso;
  logAudit(ledger, ctx, "quote.sent", "quote", quote.id, { via: opts.via, number: quote.number });
  return quote;
}

export function decideQuote(ledger: Ledger, ctx: Ctx, id: Id, decision: "accepted" | "declined"): Quote {
  requirePermission(ctx, "write");
  const quote = scoped(ledger.quotes, ctx, id, "Devis");
  if (quote.status !== "sent" && quote.status !== "viewed") {
    throw new ConflictError("Seul un devis envoyé peut être accepté ou refusé.", "BAD_STATE");
  }
  quote.status = decision;
  if (decision === "accepted") quote.acceptedAt = ctx.nowIso;
  else quote.declinedAt = ctx.nowIso;
  logAudit(ledger, ctx, `quote.${decision}`, "quote", quote.id);
  return quote;
}

/** Un devis accepté n'est PAS une facture : la conversion crée un brouillon de facture lié, sans paiement. */
export function convertQuoteToInvoice(ledger: Ledger, ctx: Ctx, quoteId: Id): SalesInvoice {
  requirePermission(ctx, "write");
  const quote = scoped(ledger.quotes, ctx, quoteId, "Devis");
  if (quote.convertedInvoiceId) throw new ConflictError("Ce devis a déjà été converti en facture.", "ALREADY_CONVERTED");
  if (quote.status !== "accepted") throw new ConflictError("Seul un devis accepté peut être converti en facture.", "NOT_ACCEPTED");
  const issueDate = ctx.today;
  const invoice: SalesInvoice = {
    id: newId("inv"),
    orgId: ctx.orgId,
    customerId: quote.customerId,
    number: null,
    status: "draft",
    currency: quote.currency,
    issueDate,
    dueDate: computeDueDate(issueDate, quote.paymentTerms),
    lines: quote.lines.map((l) => ({ ...l, id: newId("ln") })),
    documentDiscountBp: quote.documentDiscountBp,
    paymentTerms: quote.paymentTerms,
    ...(quote.notes ? { notes: quote.notes } : {}),
    totals: computeTotals(quote.lines, quote.documentDiscountBp),
    quoteId: quote.id,
    replacesInvoiceId: null,
    createdAt: ctx.nowIso,
  };
  ledger.invoices.push(invoice);
  quote.status = "converted";
  quote.convertedInvoiceId = invoice.id;
  logAudit(ledger, ctx, "quote.converted", "quote", quote.id, { invoiceId: invoice.id });
  logAudit(ledger, ctx, "invoice.created_from_quote", "invoice", invoice.id, { quoteId: quote.id });
  return invoice;
}

/* =============================== FACTURES =============================== */

export interface InvoiceInput {
  customerId: Id;
  issueDate: ISODate;
  lines: DocumentLine[];
  documentDiscountBp?: number;
  paymentTerms?: PaymentTerms;
  /** Échéance saisie explicitement ; sinon calculée depuis les conditions de paiement. */
  dueDate?: ISODate;
  notes?: string;
}

export function createInvoiceDraft(ledger: Ledger, ctx: Ctx, input: InvoiceInput, extra: { quoteId?: Id | null; replacesInvoiceId?: Id | null } = {}): SalesInvoice {
  requirePermission(ctx, "write");
  const settings = checkDocInput(ledger, ctx, input);
  const customer = scoped(ledger.customers, ctx, input.customerId, "Client");
  const terms = input.paymentTerms ?? customer.defaultPaymentTerms;
  const dueDate = input.dueDate ?? computeDueDate(input.issueDate, terms);
  if (compareDates(dueDate, input.issueDate) < 0) throw new ValidationError("L'échéance ne peut pas précéder la date d'émission.");
  const invoice: SalesInvoice = {
    id: newId("inv"),
    orgId: ctx.orgId,
    customerId: input.customerId,
    number: null,
    status: "draft",
    currency: settings.currency,
    issueDate: input.issueDate,
    dueDate,
    lines: input.lines.map((l) => ({ ...l })),
    documentDiscountBp: input.documentDiscountBp ?? 0,
    paymentTerms: terms,
    ...(input.notes ? { notes: input.notes } : {}),
    totals: computeTotals(input.lines, input.documentDiscountBp ?? 0),
    quoteId: extra.quoteId ?? null,
    replacesInvoiceId: extra.replacesInvoiceId ?? null,
    createdAt: ctx.nowIso,
  };
  ledger.invoices.push(invoice);
  logAudit(ledger, ctx, "invoice.created", "invoice", invoice.id);
  return invoice;
}

export function updateInvoiceDraft(ledger: Ledger, ctx: Ctx, id: Id, input: InvoiceInput): SalesInvoice {
  requirePermission(ctx, "write");
  const invoice = scoped(ledger.invoices, ctx, id, "Facture");
  if (invoice.status !== "draft") {
    throw new ConflictError("Une facture émise ne peut plus être modifiée : émettez un avoir puis une facture corrigée.", "ISSUED_IMMUTABLE");
  }
  checkDocInput(ledger, ctx, input);
  const terms = input.paymentTerms ?? invoice.paymentTerms;
  Object.assign(invoice, {
    customerId: input.customerId,
    issueDate: input.issueDate,
    dueDate: input.dueDate ?? computeDueDate(input.issueDate, terms),
    lines: input.lines.map((l) => ({ ...l })),
    documentDiscountBp: input.documentDiscountBp ?? 0,
    paymentTerms: terms,
    totals: computeTotals(input.lines, input.documentDiscountBp ?? 0),
  });
  if (input.notes !== undefined) invoice.notes = input.notes;
  logAudit(ledger, ctx, "invoice.updated", "invoice", invoice.id);
  return invoice;
}

/** Émission : attribue le numéro définitif et fige le document. */
export function issueInvoice(ledger: Ledger, ctx: Ctx, id: Id): SalesInvoice {
  requirePermission(ctx, "issue");
  const invoice = scoped(ledger.invoices, ctx, id, "Facture");
  if (invoice.status !== "draft") throw new ConflictError("Cette facture est déjà émise.", "ALREADY_ISSUED");
  const settings = orgSettings(ledger, ctx);
  const issues = validateLines(invoice.lines, settings.vatRatesBp);
  if (invoice.totals.totalTtcCents <= 0) issues.push("Le total de la facture doit être positif.");
  if (issues.length) throw new ValidationError("Facture non émissible", issues);
  invoice.number = allocateNumber(ledger, settings, "invoice", invoice.issueDate);
  invoice.status = "issued";
  invoice.issuedAt = ctx.nowIso;
  logAudit(ledger, ctx, "invoice.issued", "invoice", invoice.id, { number: invoice.number });
  return invoice;
}

/** "Envoyée" n'est enregistré que sur confirmation explicite de l'utilisateur (aucun email n'est émis ici). */
export function markInvoiceSent(ledger: Ledger, ctx: Ctx, id: Id, opts: { confirmedByUser: boolean; via: "manual" | "email_integration" }): SalesInvoice {
  requirePermission(ctx, "issue");
  const invoice = scoped(ledger.invoices, ctx, id, "Facture");
  if (!opts.confirmedByUser) throw new ValidationError("Confirmez que la facture a réellement été transmise au client.");
  if (invoice.status !== "issued") throw new ConflictError("Seule une facture émise (non encore envoyée) peut être marquée comme envoyée.", "BAD_STATE");
  invoice.status = "sent";
  invoice.sentAt = ctx.nowIso;
  logAudit(ledger, ctx, "invoice.sent", "invoice", invoice.id, { via: opts.via });
  return invoice;
}

export function creditedCents(ledger: Ledger, invoiceId: Id): Cents {
  return sumCents(ledger.creditNotes.filter((c) => c.invoiceId === invoiceId).map((c) => c.totals.totalTtcCents));
}

export function createCreditNote(
  ledger: Ledger,
  ctx: Ctx,
  invoiceId: Id,
  input: { reason: string; lines: DocumentLine[]; documentDiscountBp?: number; issueDate?: ISODate },
): CreditNote {
  requirePermission(ctx, "issue");
  const invoice = scoped(ledger.invoices, ctx, invoiceId, "Facture");
  if (invoice.status === "draft") throw new ConflictError("Un brouillon se supprime ou se modifie ; un avoir ne concerne qu'une facture émise.", "NOT_ISSUED");
  if (!input.reason.trim()) throw new ValidationError("Le motif de l'avoir est obligatoire.");
  const settings = orgSettings(ledger, ctx);
  const issues = validateLines(input.lines, settings.vatRatesBp);
  if (issues.length) throw new ValidationError("Avoir invalide", issues);
  const totals = computeTotals(input.lines, input.documentDiscountBp ?? 0);
  const alreadyCredited = creditedCents(ledger, invoice.id);
  if (alreadyCredited + totals.totalTtcCents > invoice.totals.totalTtcCents) {
    throw new ValidationError("Le total des avoirs ne peut pas dépasser le montant de la facture d'origine.");
  }
  const issueDate = input.issueDate ?? ctx.today;
  const note: CreditNote = {
    id: newId("cn"),
    orgId: ctx.orgId,
    invoiceId: invoice.id,
    number: allocateNumber(ledger, settings, "credit_note", issueDate),
    issueDate,
    reason: input.reason.trim(),
    currency: invoice.currency,
    lines: input.lines.map((l) => ({ ...l })),
    documentDiscountBp: input.documentDiscountBp ?? 0,
    totals,
    createdAt: ctx.nowIso,
  };
  ledger.creditNotes.push(note);
  logAudit(ledger, ctx, "credit_note.issued", "credit_note", note.id, { invoiceId: invoice.id, number: note.number, totalTtcCents: totals.totalTtcCents });
  return note;
}

/** Avoir total reprenant exactement les lignes de la facture. */
function fullCreditLines(invoice: SalesInvoice): DocumentLine[] {
  return invoice.lines.map((l) => ({ ...l, id: newId("ln") }));
}

/** Annulation = avoir total. Refusée si des paiements actifs existent (il faut d'abord les traiter). */
export function cancelInvoice(ledger: Ledger, ctx: Ctx, id: Id, reason: string): CreditNote {
  requirePermission(ctx, "issue");
  const invoice = scoped(ledger.invoices, ctx, id, "Facture");
  if (invoice.status === "draft") throw new ConflictError("Un brouillon n'est pas annulé : supprimez-le.", "IS_DRAFT");
  if (invoice.status === "cancelled") throw new ConflictError("Facture déjà annulée.", "ALREADY_CANCELLED");
  const hasPayments = ledger.payments.some((p) => p.documentType === "sales_invoice" && p.documentId === invoice.id && !p.voidedAt);
  if (hasPayments) throw new ConflictError("Des paiements sont enregistrés : annulez-les ou émettez un avoir partiel.", "HAS_PAYMENTS");
  if (creditedCents(ledger, invoice.id) > 0) throw new ConflictError("Des avoirs existent déjà sur cette facture.", "HAS_CREDITS");
  const note = createCreditNote(ledger, ctx, id, { reason, lines: fullCreditLines(invoice), documentDiscountBp: invoice.documentDiscountBp });
  invoice.status = "cancelled";
  logAudit(ledger, ctx, "invoice.cancelled", "invoice", invoice.id, { creditNoteId: note.id });
  return note;
}

/** Correction d'une facture émise : avoir total + nouveau brouillon lié (replacesInvoiceId). Historique intact. */
export function correctInvoice(ledger: Ledger, ctx: Ctx, id: Id, reason: string): { creditNote: CreditNote; draft: SalesInvoice } {
  const invoice = scoped(ledger.invoices, ctx, id, "Facture");
  const creditNote = cancelInvoice(ledger, ctx, id, reason);
  const draft = createInvoiceDraft(
    ledger,
    ctx,
    {
      customerId: invoice.customerId,
      issueDate: ctx.today,
      lines: invoice.lines.map((l) => ({ ...l, id: newId("ln") })),
      documentDiscountBp: invoice.documentDiscountBp,
      paymentTerms: invoice.paymentTerms,
      ...(invoice.notes ? { notes: invoice.notes } : {}),
    },
    { replacesInvoiceId: invoice.id },
  );
  logAudit(ledger, ctx, "invoice.correction_started", "invoice", invoice.id, { draftId: draft.id });
  return { creditNote, draft };
}

/** Suppression : uniquement les brouillons jamais numérotés. Un document émis n'est jamais supprimé. */
export function deleteDraftInvoice(ledger: Ledger, ctx: Ctx, id: Id): void {
  requirePermission(ctx, "write");
  const invoice = scoped(ledger.invoices, ctx, id, "Facture");
  if (invoice.status !== "draft" || invoice.number) throw new ConflictError("Un document émis ne peut pas être supprimé.", "ISSUED_IMMUTABLE");
  ledger.invoices.splice(ledger.invoices.indexOf(invoice), 1);
  logAudit(ledger, ctx, "invoice.draft_deleted", "invoice", id);
}

/* ============================ VUE DÉRIVÉE ============================ */

export type InvoiceDisplayStatus = "draft" | "issued" | "sent" | "partially_paid" | "paid" | "overdue" | "credited" | "cancelled";
export type PaymentState = "unpaid" | "partial" | "paid" | "credited";

export interface InvoiceView {
  invoice: SalesInvoice;
  totalCents: Cents;
  creditedCents: Cents;
  paidCents: Cents;
  /** Reste dû = total − avoirs − paiements actifs (jamais négatif ici ; voir overpaidCents). */
  balanceCents: Cents;
  overpaidCents: Cents;
  paymentState: PaymentState;
  isOverdue: boolean;
  daysOverdue: number;
  displayStatus: InvoiceDisplayStatus;
}

export function activePaymentsFor(ledger: Ledger, documentType: "sales_invoice" | "purchase_invoice", documentId: Id) {
  return ledger.payments.filter((p) => p.documentType === documentType && p.documentId === documentId && !p.voidedAt);
}

/**
 * Le statut de paiement n'est JAMAIS stocké : il est recalculé à partir des paiements et avoirs,
 * ce qui évite toute incohérence quand une transaction est modifiée, rapprochée ou annulée.
 */
export function invoiceView(ledger: Ledger, invoice: SalesInvoice, today: ISODate): InvoiceView {
  const credited = creditedCents(ledger, invoice.id);
  const paid = sumCents(activePaymentsFor(ledger, "sales_invoice", invoice.id).map((p) => p.amountCents));
  const due = invoice.totals.totalTtcCents - credited;
  const raw = due - paid;
  const balance = Math.max(0, raw);
  const overpaid = Math.max(0, -raw);
  const issued = invoice.status !== "draft";

  let paymentState: PaymentState;
  if (due <= 0 && paid === 0) paymentState = "credited";
  else if (balance === 0) paymentState = "paid";
  else if (paid > 0) paymentState = "partial";
  else paymentState = "unpaid";

  const isOverdue = issued && invoice.status !== "cancelled" && balance > 0 && compareDates(invoice.dueDate, today) < 0;
  const daysOverdue = isOverdue ? diffDays(today, invoice.dueDate) : 0;

  let displayStatus: InvoiceDisplayStatus;
  if (invoice.status === "draft") displayStatus = "draft";
  else if (invoice.status === "cancelled") displayStatus = "cancelled";
  else if (paymentState === "credited") displayStatus = "credited";
  else if (paymentState === "paid") displayStatus = "paid";
  else if (isOverdue) displayStatus = "overdue";
  else if (paymentState === "partial") displayStatus = "partially_paid";
  else displayStatus = invoice.status === "sent" ? "sent" : "issued";

  return {
    invoice,
    totalCents: invoice.totals.totalTtcCents,
    creditedCents: credited,
    paidCents: paid,
    balanceCents: invoice.status === "cancelled" ? 0 : balance,
    overpaidCents: overpaid,
    paymentState,
    isOverdue,
    daysOverdue,
    displayStatus,
  };
}
