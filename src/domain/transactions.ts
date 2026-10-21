import { requirePermission, scoped, type Ctx } from "./access";
import { compareDates, isValidISODate, type ISODate } from "./dates";
import { ConflictError, ValidationError } from "./errors";
import { logAudit, newId } from "./ledger";
import { sumCents, type Cents } from "./money";
import { orgSettings } from "./documents";
import type { Direction, FinancialAccount, Id, Ledger, Transaction } from "./types";

export function activeTransactions(ledger: Ledger, orgId: Id): Transaction[] {
  return ledger.transactions.filter((t) => t.orgId === orgId && !t.voidedAt);
}

export function signedCents(t: Pick<Transaction, "amountCents" | "direction">): Cents {
  return t.direction === "in" ? t.amountCents : -t.amountCents;
}

/**
 * Solde d'un compte à une date : solde d'ouverture (au début du jour d'ouverture) + mouvements
 * actifs dont la date est comprise entre la date d'ouverture et `asOf`. Les mouvements antérieurs
 * à l'ouverture sont réputés déjà inclus dans le solde saisi.
 */
export function accountBalance(ledger: Ledger, account: FinancialAccount, asOf: ISODate): Cents {
  const flows = ledger.transactions.filter(
    (t) => t.orgId === account.orgId && t.accountId === account.id && !t.voidedAt && compareDates(t.date, account.openingDate) >= 0 && compareDates(t.date, asOf) <= 0,
  );
  return account.openingBalanceCents + sumCents(flows.map(signedCents));
}

export interface CashPosition {
  asOf: ISODate;
  totalCents: Cents;
  accounts: { account: FinancialAccount; balanceCents: Cents; lastMovementDate: ISODate | null; provenance: string }[];
  /** Vrai si au moins un compte n'a aucun solde d'ouverture confirmé : le solde affiché est alors partiel. */
  incomplete: boolean;
}

export function cashPosition(ledger: Ledger, ctx: Ctx, asOf: ISODate = ctx.today): CashPosition {
  const accounts = ledger.accounts.filter((a) => a.orgId === ctx.orgId);
  const rows = accounts.map((account) => {
    const mv = ledger.transactions
      .filter((t) => t.orgId === ctx.orgId && t.accountId === account.id && !t.voidedAt && compareDates(t.date, asOf) <= 0)
      .map((t) => t.date)
      .sort();
    const src = account.openingSource === "imported" ? "solde d'ouverture importé" : "solde d'ouverture saisi manuellement";
    return {
      account,
      balanceCents: accountBalance(ledger, account, asOf),
      lastMovementDate: mv.length ? (mv[mv.length - 1] as ISODate) : null,
      provenance: `${src} au ${account.openingDate} + mouvements enregistrés`,
    };
  });
  return { asOf, totalCents: sumCents(rows.map((r) => r.balanceCents)), accounts: rows, incomplete: accounts.length === 0 };
}

export interface TransactionInput {
  accountId: Id;
  date: ISODate;
  label: string;
  amountCents: Cents;
  direction: Direction;
  categoryId?: Id | null;
  counterparty?: string;
  externalRef?: string;
  source?: Transaction["source"];
  importId?: Id;
}

export function addTransaction(ledger: Ledger, ctx: Ctx, input: TransactionInput): Transaction {
  requirePermission(ctx, "write");
  const account = scoped(ledger.accounts, ctx, input.accountId, "Compte");
  const issues: string[] = [];
  if (!isValidISODate(input.date)) issues.push("Date invalide.");
  if (!input.label.trim()) issues.push("Libellé obligatoire.");
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) issues.push("Le montant doit être un entier positif (le sens porte le signe).");
  if (input.direction !== "in" && input.direction !== "out") issues.push("Sens invalide.");
  if (input.categoryId) scoped(ledger.categories, ctx, input.categoryId, "Catégorie");
  if (issues.length) throw new ValidationError("Transaction invalide", issues);
  const t: Transaction = {
    id: newId("tx"),
    orgId: ctx.orgId,
    accountId: account.id,
    date: input.date,
    label: input.label.trim(),
    amountCents: input.amountCents,
    direction: input.direction,
    currency: account.currency,
    categoryId: input.categoryId ?? null,
    ...(input.counterparty ? { counterparty: input.counterparty } : {}),
    source: input.source ?? "manual",
    ...(input.externalRef ? { externalRef: input.externalRef } : {}),
    ...(input.importId ? { importId: input.importId } : {}),
    createdAt: ctx.nowIso,
  };
  ledger.transactions.push(t);
  logAudit(ledger, ctx, "transaction.created", "transaction", t.id, { source: t.source });
  return t;
}

/** Montant déjà affecté à des documents (source unique : les rapprochements actifs). */
export function allocatedCents(ledger: Ledger, transactionId: Id): Cents {
  return sumCents(ledger.matches.filter((m) => m.transactionId === transactionId && !m.voidedAt).map((m) => m.amountCents));
}

export type ReconciliationStatus = "unmatched" | "partial" | "matched" | "ignored";

export function reconciliationStatus(ledger: Ledger, t: Transaction): ReconciliationStatus {
  if (t.reconciliationIgnored) return "ignored";
  const allocated = allocatedCents(ledger, t.id);
  if (allocated === 0) return "unmatched";
  return allocated >= t.amountCents ? "matched" : "partial";
}

export function updateTransaction(
  ledger: Ledger,
  ctx: Ctx,
  id: Id,
  patch: Partial<Pick<Transaction, "label" | "date" | "amountCents" | "categoryId" | "counterparty">>,
): Transaction {
  requirePermission(ctx, "write");
  const t = scoped(ledger.transactions, ctx, id, "Transaction");
  if (t.voidedAt) throw new ConflictError("Transaction annulée.", "VOIDED");
  const allocated = allocatedCents(ledger, id);
  if (patch.amountCents !== undefined) {
    if (!Number.isSafeInteger(patch.amountCents) || patch.amountCents <= 0) throw new ValidationError("Montant invalide.");
    if (patch.amountCents < allocated) {
      throw new ConflictError("Le montant ne peut pas être inférieur à la part déjà rapprochée : défaites d'abord le rapprochement.", "BELOW_ALLOCATED");
    }
  }
  if (patch.date !== undefined && !isValidISODate(patch.date)) throw new ValidationError("Date invalide.");
  const before = { label: t.label, date: t.date, amountCents: t.amountCents };
  Object.assign(t, patch);
  logAudit(ledger, ctx, "transaction.updated", "transaction", id, { before, patch });
  return t;
}

/** Annulation (jamais de suppression physique). Refusée tant qu'un rapprochement actif existe. */
export function voidTransaction(ledger: Ledger, ctx: Ctx, id: Id, reason: string): Transaction {
  requirePermission(ctx, "write");
  const t = scoped(ledger.transactions, ctx, id, "Transaction");
  if (allocatedCents(ledger, id) > 0) throw new ConflictError("Cette transaction est rapprochée : défaites d'abord le rapprochement.", "IS_MATCHED");
  if (!reason.trim()) throw new ValidationError("Motif obligatoire.");
  t.voidedAt = ctx.nowIso;
  logAudit(ledger, ctx, "transaction.voided", "transaction", id, { reason });
  return t;
}

export function setReconciliationIgnored(ledger: Ledger, ctx: Ctx, id: Id, ignored: boolean): Transaction {
  requirePermission(ctx, "write");
  const t = scoped(ledger.transactions, ctx, id, "Transaction");
  if (ignored && allocatedCents(ledger, id) > 0) throw new ConflictError("Transaction déjà rapprochée.", "IS_MATCHED");
  t.reconciliationIgnored = ignored;
  logAudit(ledger, ctx, ignored ? "transaction.reconciliation_ignored" : "transaction.reconciliation_restored", "transaction", id);
  return t;
}

export function defaultAccount(ledger: Ledger, ctx: Ctx): FinancialAccount | undefined {
  return ledger.accounts.find((a) => a.orgId === ctx.orgId);
}

export { orgSettings };
