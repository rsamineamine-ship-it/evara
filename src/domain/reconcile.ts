import type { Ctx } from "./access";
import { diffDays } from "./dates";
import { invoiceView } from "./documents";
import { purchaseView } from "./purchases";
import type { Cents } from "./money";
import { compactRef, normalizeText, significantTokens } from "./text";
import { allocatedCents } from "./transactions";
import type { Id, Ledger, Transaction, TransactionMatch } from "./types";

export type MatchConfidence = "high" | "medium" | "low";

export interface MatchSuggestion {
  documentType: TransactionMatch["documentType"];
  documentId: Id;
  documentLabel: string;
  counterparty: string;
  /** Si défini : rattacher la transaction à ce paiement déjà déclaré plutôt que d'en créer un second. */
  paymentId?: Id;
  score: number;
  confidence: MatchConfidence;
  reasons: string[];
  warnings: string[];
  proposedAmountCents: Cents;
  /** Conséquences si l'utilisateur confirme. */
  balanceAfterCents: Cents;
  resultingStatus: "paid" | "partially_paid" | "expense_paid";
  transactionUnallocatedAfterCents: Cents;
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
const level = (s: number): MatchConfidence => (s >= 75 ? "high" : s >= 50 ? "medium" : "low");

function partyScore(partyNames: string[], tx: Transaction): { points: number; reason?: string } {
  const haystack = normalizeText(`${tx.label} ${tx.counterparty ?? ""}`);
  let best = 0;
  let bestName = "";
  for (const name of partyNames) {
    const tokens = significantTokens(name);
    if (!tokens.length) continue;
    const hits = tokens.filter((t) => haystack.includes(t)).length;
    const ratio = hits / tokens.length;
    if (ratio > best) {
      best = ratio;
      bestName = name;
    }
  }
  if (best === 0) return { points: 0 };
  return { points: best === 1 ? 25 : 12, reason: best === 1 ? `Le nom « ${bestName} » apparaît dans le libellé.` : `Une partie du nom « ${bestName} » apparaît dans le libellé.` };
}

/**
 * Propose des rapprochements pour une transaction. Fonction pure : ne modifie jamais le registre.
 * Les propositions doivent être confirmées explicitement (voir confirmMatch).
 */
export function suggestMatches(ledger: Ledger, ctx: Ctx, tx: Transaction, limit = 5): MatchSuggestion[] {
  if (tx.orgId !== ctx.orgId || tx.voidedAt || tx.reconciliationIgnored) return [];
  const free = tx.amountCents - allocatedCents(ledger, tx.id);
  if (free <= 0) return [];
  const labelCompact = compactRef(`${tx.label} ${tx.externalRef ?? ""}`);
  const out: MatchSuggestion[] = [];

  const amountPoints = (balance: Cents): { points: number; reasons: string[]; warnings: string[]; proposed: Cents } => {
    if (free === balance) return { points: 45, reasons: ["Montant identique au reste dû."], warnings: [], proposed: balance };
    if (free < balance) {
      return { points: 20, reasons: ["Montant inférieur au reste dû : paiement partiel possible."], warnings: [`Il resterait ${((balance - free) / 100).toFixed(2).replace(".", ",")} € à régler.`], proposed: free };
    }
    const gap = (free - balance) / balance;
    if (gap <= 0.02) return { points: 25, reasons: ["Écart de moins de 2 % avec le reste dû."], warnings: ["Une petite différence restera non affectée."], proposed: balance };
    return { points: 5, reasons: ["Montant supérieur au reste dû."], warnings: ["L'excédent ne sera pas affecté à ce document."], proposed: balance };
  };

  if (tx.direction === "in") {
    for (const inv of ledger.invoices.filter((i) => i.orgId === ctx.orgId)) {
      if (inv.status === "draft" || inv.status === "cancelled") continue;
      const view = invoiceView(ledger, inv, ctx.today);
      // Un paiement déclaré (ex. chèque) peut solder la facture avant que la banque ne l'ait encaissé :
      // le reste dû est alors nul, mais la transaction doit encore pouvoir s'y rattacher.
      const declared = ledger.payments.find(
        (pm) => pm.orgId === ctx.orgId && !pm.voidedAt && pm.documentType === "sales_invoice" && pm.documentId === inv.id && pm.transactionId === null && pm.amountCents <= free,
      );
      if (view.balanceCents <= 0 && !declared) continue;
      const customer = ledger.customers.find((c) => c.id === inv.customerId);
      const names = [customer?.company, customer?.name].filter((x): x is string => !!x);
      const a = amountPoints(view.balanceCents > 0 ? view.balanceCents : (declared as { amountCents: Cents }).amountCents);
      let score = a.points;
      const reasons = [...a.reasons];
      const warnings = [...a.warnings];
      if (inv.number && labelCompact.includes(compactRef(inv.number))) {
        score += 40;
        reasons.push(`Le numéro ${inv.number} figure dans le libellé.`);
      }
      const p = partyScore(names, tx);
      score += p.points;
      if (p.reason) reasons.push(p.reason);
      if (tx.date < inv.issueDate) {
        score -= 20;
        warnings.push("La transaction est antérieure à la date de facture.");
      } else if (Math.abs(diffDays(tx.date, inv.dueDate)) <= 15) {
        score += 10;
        reasons.push("Date proche de l'échéance.");
      }
      let proposed = a.proposed;
      if (declared) {
        proposed = declared.amountCents;
        score += declared.amountCents === free ? 30 : 10;
        reasons.push("Un paiement de ce montant est déjà déclaré : la transaction s'y rattachera sans le compter deux fois.");
      }
      score = clamp(score);
      if (score < 25) continue;
      const balanceAfter = declared ? view.balanceCents : view.balanceCents - proposed;
      out.push({
        documentType: "sales_invoice",
        documentId: inv.id,
        documentLabel: inv.number ?? "Facture",
        counterparty: customer?.company ?? customer?.name ?? "",
        ...(declared ? { paymentId: declared.id } : {}),
        score,
        confidence: level(score),
        reasons,
        warnings,
        proposedAmountCents: proposed,
        balanceAfterCents: balanceAfter,
        resultingStatus: balanceAfter === 0 ? "paid" : "partially_paid",
        transactionUnallocatedAfterCents: free - proposed,
      });
    }
  } else {
    for (const p of ledger.purchaseInvoices.filter((x) => x.orgId === ctx.orgId)) {
      if (p.status === "disputed") continue;
      const view = purchaseView(ledger, p, ctx.today);
      const declared = ledger.payments.find(
        (pm) => pm.orgId === ctx.orgId && !pm.voidedAt && pm.documentType === "purchase_invoice" && pm.documentId === p.id && pm.transactionId === null && pm.amountCents <= free,
      );
      if (view.balanceCents <= 0 && !declared) continue;
      const supplier = ledger.suppliers.find((s) => s.id === p.supplierId);
      const names = [supplier?.company, supplier?.name].filter((x): x is string => !!x);
      const a = amountPoints(view.balanceCents > 0 ? view.balanceCents : (declared as { amountCents: Cents }).amountCents);
      let score = a.points;
      const reasons = [...a.reasons];
      const warnings = [...a.warnings];
      if (labelCompact.includes(compactRef(p.reference)) && compactRef(p.reference).length >= 4) {
        score += 40;
        reasons.push(`La référence ${p.reference} figure dans le libellé.`);
      }
      const ps = partyScore(names, tx);
      score += ps.points;
      if (ps.reason) reasons.push(ps.reason);
      if (Math.abs(diffDays(tx.date, p.dueDate)) <= 15) {
        score += 10;
        reasons.push("Date proche de l'échéance.");
      }
      let proposed = a.proposed;
      if (declared) {
        proposed = declared.amountCents;
        score += declared.amountCents === free ? 30 : 10;
        reasons.push("Un paiement de ce montant est déjà déclaré : la transaction s'y rattachera sans le compter deux fois.");
      }
      score = clamp(score);
      if (score < 25) continue;
      const balanceAfter = declared ? view.balanceCents : view.balanceCents - proposed;
      out.push({
        documentType: "purchase_invoice",
        documentId: p.id,
        documentLabel: p.reference,
        counterparty: supplier?.company ?? supplier?.name ?? "",
        ...(declared ? { paymentId: declared.id } : {}),
        score,
        confidence: level(score),
        reasons,
        warnings,
        proposedAmountCents: proposed,
        balanceAfterCents: balanceAfter,
        resultingStatus: balanceAfter === 0 ? "paid" : "partially_paid",
        transactionUnallocatedAfterCents: free - proposed,
      });
    }
    for (const e of ledger.expenses.filter((x) => x.orgId === ctx.orgId && !x.paidTransactionId && !x.purchaseInvoiceId)) {
      let score = 0;
      const reasons: string[] = [];
      const warnings: string[] = [];
      if (e.amountCents === free) {
        score += 45;
        reasons.push("Montant identique à la dépense.");
      } else continue; // une dépense se rapproche d'un montant exact
      const supplier = ledger.suppliers.find((s) => s.id === e.supplierId);
      const names = [e.label, supplier?.company, supplier?.name].filter((x): x is string => !!x);
      const ps = partyScore(names, tx);
      score += ps.points;
      if (ps.reason) reasons.push(ps.reason);
      if (Math.abs(diffDays(tx.date, e.date)) <= 5) {
        score += 15;
        reasons.push("Date proche de la dépense.");
      }
      score = clamp(score);
      if (score < 40) continue;
      out.push({
        documentType: "expense",
        documentId: e.id,
        documentLabel: e.label,
        counterparty: supplier?.company ?? supplier?.name ?? "",
        score,
        confidence: level(score),
        reasons,
        warnings,
        proposedAmountCents: e.amountCents,
        balanceAfterCents: 0,
        resultingStatus: "expense_paid",
        transactionUnallocatedAfterCents: free - e.amountCents,
      });
    }
  }
  return out.sort((x, y) => y.score - x.score).slice(0, limit);
}
