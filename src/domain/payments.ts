import { requirePermission, scoped, type Ctx } from "./access";
import { isValidISODate, type ISODate } from "./dates";
import { invoiceView } from "./documents";
import { ConflictError, ValidationError } from "./errors";
import { logAudit, newId } from "./ledger";
import { type Cents } from "./money";
import { purchaseView } from "./purchases";
import { addTransaction, allocatedCents } from "./transactions";
import type { Id, Ledger, Payment, Transaction, TransactionMatch } from "./types";

export interface PaymentInput {
  documentType: Payment["documentType"];
  documentId: Id;
  amountCents: Cents;
  date: ISODate;
  method: Payment["method"];
  isDeposit?: boolean;
  /** Crée EN MÊME TEMPS le mouvement d'argent sur ce compte (encaissement/décaissement effectif). */
  accountId?: Id;
  /** Rattache le paiement à une transaction existante (import bancaire) : aucune transaction n'est créée. */
  transactionId?: Id;
  note?: string;
  /** Autorise un paiement identique à un paiement déjà déclaré (sinon : garde anti-doublon). */
  allowDuplicate?: boolean;
  origin?: TransactionMatch["origin"];
}

function documentBalance(ledger: Ledger, ctx: Ctx, type: Payment["documentType"], id: Id): { balance: Cents; label: string; counterparty: string } {
  if (type === "sales_invoice") {
    const inv = scoped(ledger.invoices, ctx, id, "Facture");
    if (inv.status === "draft") throw new ConflictError("Émettez la facture avant d'enregistrer un paiement.", "NOT_ISSUED");
    if (inv.status === "cancelled") throw new ConflictError("Cette facture est annulée.", "CANCELLED");
    const view = invoiceView(ledger, inv, ctx.today);
    const customer = ledger.customers.find((c) => c.id === inv.customerId);
    return { balance: view.balanceCents, label: inv.number ?? "facture", counterparty: customer?.company ?? customer?.name ?? "" };
  }
  const p = scoped(ledger.purchaseInvoices, ctx, id, "Facture fournisseur");
  if (p.status === "disputed") throw new ConflictError("Facture contestée : levez la contestation avant de la payer.", "DISPUTED");
  const view = purchaseView(ledger, p, ctx.today);
  const supplier = ledger.suppliers.find((s) => s.id === p.supplierId);
  return { balance: view.balanceCents, label: p.reference, counterparty: supplier?.company ?? supplier?.name ?? "" };
}

/**
 * Enregistre un paiement. Le paiement (opération distincte) fait baisser le reste dû ; la trésorerie réelle
 * ne bouge que s'il est adossé à un mouvement d'argent (créé ici ou rattaché). Un paiement "déclaré" sans
 * mouvement reste visible dans le centre d'actions jusqu'à son rapprochement.
 */
export function recordPayment(ledger: Ledger, ctx: Ctx, input: PaymentInput): { payment: Payment; transaction: Transaction | null; match: TransactionMatch | null } {
  requirePermission(ctx, "write");
  const issues: string[] = [];
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) issues.push("Le montant du paiement doit être positif.");
  if (!isValidISODate(input.date)) issues.push("Date de paiement invalide.");
  if (input.accountId && input.transactionId) issues.push("Choisissez soit un compte (nouveau mouvement), soit une transaction existante.");
  if (issues.length) throw new ValidationError("Paiement invalide", issues);

  const doc = documentBalance(ledger, ctx, input.documentType, input.documentId);
  if (doc.balance <= 0) throw new ConflictError("Ce document est déjà soldé.", "ALREADY_SETTLED");
  if (input.amountCents > doc.balance) {
    throw new ConflictError("Le paiement dépasse le reste dû. Saisissez le montant restant ou enregistrez l'excédent séparément.", "OVERPAYMENT");
  }
  if (!input.allowDuplicate) {
    const dup = ledger.payments.find(
      (p) => p.orgId === ctx.orgId && !p.voidedAt && p.documentType === input.documentType && p.documentId === input.documentId && p.amountCents === input.amountCents && p.date === input.date && p.transactionId === null && !input.transactionId,
    );
    if (dup) throw new ConflictError("Un paiement identique (même montant, même date) est déjà enregistré pour ce document.", "DUPLICATE_PAYMENT");
  }

  const wantedDirection = input.documentType === "sales_invoice" ? "in" : "out";
  let transaction: Transaction | null = null;
  if (input.transactionId) {
    transaction = scoped(ledger.transactions, ctx, input.transactionId, "Transaction");
    if (transaction.voidedAt) throw new ConflictError("Transaction annulée.", "VOIDED");
    if (transaction.direction !== wantedDirection) throw new ConflictError("Le sens de la transaction ne correspond pas au type de document.", "WRONG_DIRECTION");
    const free = transaction.amountCents - allocatedCents(ledger, transaction.id);
    if (input.amountCents > free) throw new ConflictError("Cette transaction est déjà (en partie) affectée : le montant dépasse la part disponible.", "DOUBLE_ALLOCATION");
  }

  // Toutes les validations sont passées : à partir d'ici on écrit (cohérence "tout ou rien").
  let createdTx = false;
  if (input.accountId) {
    transaction = addTransaction(ledger, ctx, {
      accountId: input.accountId,
      date: input.date,
      label: `${input.documentType === "sales_invoice" ? "Encaissement" : "Paiement"} ${doc.label}`,
      amountCents: input.amountCents,
      direction: wantedDirection,
      counterparty: doc.counterparty,
      source: "payment",
    });
    createdTx = true;
  }

  const payment: Payment = {
    id: newId("pay"),
    orgId: ctx.orgId,
    documentType: input.documentType,
    documentId: input.documentId,
    amountCents: input.amountCents,
    date: input.date,
    method: input.method,
    isDeposit: input.isDeposit ?? false,
    transactionId: transaction?.id ?? null,
    ...(input.note ? { note: input.note } : {}),
    createdAt: ctx.nowIso,
  };
  ledger.payments.push(payment);

  let match: TransactionMatch | null = null;
  if (transaction) {
    match = {
      id: newId("mt"),
      orgId: ctx.orgId,
      transactionId: transaction.id,
      documentType: input.documentType,
      documentId: input.documentId,
      paymentId: payment.id,
      amountCents: input.amountCents,
      origin: createdTx ? "auto_payment" : input.origin ?? "manual",
      createdPayment: true,
      confirmedBy: ctx.userId,
      confirmedAt: ctx.nowIso,
    };
    ledger.matches.push(match);
  }
  logAudit(ledger, ctx, "payment.recorded", input.documentType, input.documentId, {
    paymentId: payment.id,
    amountCents: payment.amountCents,
    transactionId: transaction?.id ?? null,
  });
  return { payment, transaction, match };
}

/** Annulation d'un paiement (traçable, jamais supprimé). Le reste dû est recalculé automatiquement. */
export function voidPayment(ledger: Ledger, ctx: Ctx, paymentId: Id, reason: string): Payment {
  requirePermission(ctx, "write");
  const payment = scoped(ledger.payments, ctx, paymentId, "Paiement");
  if (payment.voidedAt) throw new ConflictError("Paiement déjà annulé.", "ALREADY_VOID");
  if (!reason.trim()) throw new ValidationError("Motif obligatoire.");
  payment.voidedAt = ctx.nowIso;
  payment.voidReason = reason.trim();
  for (const m of ledger.matches) {
    if (m.paymentId === payment.id && !m.voidedAt) {
      m.voidedAt = ctx.nowIso;
      const tx = ledger.transactions.find((t) => t.id === m.transactionId);
      // Mouvement créé uniquement pour ce paiement : il disparaît des soldes avec lui.
      if (tx && tx.source === "payment" && m.origin === "auto_payment" && !tx.voidedAt) tx.voidedAt = ctx.nowIso;
    }
  }
  logAudit(ledger, ctx, "payment.voided", payment.documentType, payment.documentId, { paymentId, reason });
  return payment;
}

export interface MatchInput {
  transactionId: Id;
  documentType: TransactionMatch["documentType"];
  documentId: Id;
  /** Montant à affecter ; par défaut min(part libre de la transaction, reste dû). */
  amountCents?: Cents;
  /** Rattache la transaction à un paiement déjà déclaré (évite de compter le paiement deux fois). */
  paymentId?: Id;
  origin?: "suggested" | "manual";
}

/** Confirme un rapprochement. Jamais appelé automatiquement : les suggestions doivent être validées par un humain. */
export function confirmMatch(ledger: Ledger, ctx: Ctx, input: MatchInput): TransactionMatch {
  requirePermission(ctx, "write");
  const tx = scoped(ledger.transactions, ctx, input.transactionId, "Transaction");
  if (tx.voidedAt) throw new ConflictError("Transaction annulée.", "VOIDED");
  if (tx.reconciliationIgnored) throw new ConflictError("Cette transaction est marquée comme ignorée.", "IGNORED");
  const free = tx.amountCents - allocatedCents(ledger, tx.id);
  if (free <= 0) throw new ConflictError("Cette transaction est déjà entièrement rapprochée.", "DOUBLE_ALLOCATION");
  const origin = input.origin ?? "manual";

  if (input.documentType === "expense") {
    const expense = scoped(ledger.expenses, ctx, input.documentId, "Dépense");
    if (expense.purchaseInvoiceId) throw new ConflictError("Cette dépense est portée par une facture fournisseur : rapprochez la facture.", "COVERED_BY_INVOICE");
    if (expense.paidTransactionId) throw new ConflictError("Cette dépense est déjà rattachée à une sortie d'argent.", "ALREADY_PAID");
    if (tx.direction !== "out") throw new ConflictError("Une dépense se rapproche d'une sortie d'argent.", "WRONG_DIRECTION");
    if (expense.amountCents > free) throw new ConflictError("Le montant de la transaction est inférieur à la dépense.", "AMOUNT_MISMATCH");
    expense.paidTransactionId = tx.id;
    const m: TransactionMatch = {
      id: newId("mt"), orgId: ctx.orgId, transactionId: tx.id, documentType: "expense", documentId: expense.id, paymentId: null,
      amountCents: expense.amountCents, origin, createdPayment: false, confirmedBy: ctx.userId, confirmedAt: ctx.nowIso,
    };
    ledger.matches.push(m);
    logAudit(ledger, ctx, "match.confirmed", "transaction", tx.id, { documentType: "expense", documentId: expense.id });
    return m;
  }

  const doc = documentBalance(ledger, ctx, input.documentType, input.documentId);
  const wantedDirection = input.documentType === "sales_invoice" ? "in" : "out";
  if (tx.direction !== wantedDirection) throw new ConflictError("Le sens de la transaction ne correspond pas au document.", "WRONG_DIRECTION");

  if (input.paymentId) {
    const payment = scoped(ledger.payments, ctx, input.paymentId, "Paiement");
    if (payment.voidedAt || payment.documentId !== input.documentId || payment.documentType !== input.documentType) {
      throw new ConflictError("Ce paiement ne correspond pas au document.", "PAYMENT_MISMATCH");
    }
    if (payment.transactionId) throw new ConflictError("Ce paiement est déjà rattaché à un mouvement d'argent.", "ALREADY_ATTACHED");
    if (payment.amountCents > free) throw new ConflictError("La transaction est inférieure au paiement déclaré.", "AMOUNT_MISMATCH");
    payment.transactionId = tx.id;
    const m: TransactionMatch = {
      id: newId("mt"), orgId: ctx.orgId, transactionId: tx.id, documentType: input.documentType, documentId: input.documentId, paymentId: payment.id,
      amountCents: payment.amountCents, origin, createdPayment: false, confirmedBy: ctx.userId, confirmedAt: ctx.nowIso,
    };
    ledger.matches.push(m);
    logAudit(ledger, ctx, "match.confirmed", "transaction", tx.id, { documentType: input.documentType, documentId: input.documentId, paymentId: payment.id, attached: true });
    return m;
  }

  const amount = input.amountCents ?? Math.min(free, doc.balance);
  const { match } = recordPayment(ledger, ctx, {
    documentType: input.documentType,
    documentId: input.documentId,
    amountCents: amount,
    date: tx.date,
    method: "transfer",
    transactionId: tx.id,
    origin,
    note: `Rapprochement de la transaction « ${tx.label} »`,
  });
  if (!match) throw new ConflictError("Rapprochement impossible.", "MATCH_FAILED");
  logAudit(ledger, ctx, "match.confirmed", "transaction", tx.id, { documentType: input.documentType, documentId: input.documentId, amountCents: amount });
  return match;
}

/** Défait un rapprochement. Si le paiement a été créé par lui, il est annulé : les statuts se recalculent. */
export function undoMatch(ledger: Ledger, ctx: Ctx, matchId: Id): void {
  requirePermission(ctx, "write");
  const m = scoped(ledger.matches, ctx, matchId, "Rapprochement");
  if (m.voidedAt) throw new ConflictError("Rapprochement déjà défait.", "ALREADY_VOID");
  if (m.documentType === "expense") {
    const e = ledger.expenses.find((x) => x.id === m.documentId);
    if (e && e.paidTransactionId === m.transactionId) e.paidTransactionId = null;
    m.voidedAt = ctx.nowIso;
  } else if (m.paymentId) {
    const p = ledger.payments.find((x) => x.id === m.paymentId);
    if (p) {
      if (m.createdPayment) {
        p.voidedAt = ctx.nowIso;
        p.voidReason = "Rapprochement défait";
      } else p.transactionId = null;
    }
    m.voidedAt = ctx.nowIso;
  }
  logAudit(ledger, ctx, "match.undone", "transaction", m.transactionId, { matchId });
}

/** Paiements déclarés mais non adossés à un mouvement d'argent : ils n'ont PAS encore affecté la trésorerie réelle. */
export function declaredPaymentsWithoutMovement(ledger: Ledger, orgId: Id): Payment[] {
  return ledger.payments.filter((p) => p.orgId === orgId && !p.voidedAt && p.transactionId === null);
}
