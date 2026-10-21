import { buildCtx, type Ctx } from "../src/domain/access";
import { newLine } from "../src/domain/documents";
import { emptyLedger } from "../src/domain/ledger";
import type { Cents } from "../src/domain/money";
import type { DocumentLine, Ledger } from "../src/domain/types";

export const TODAY = "2026-06-15";

/** Petit monde de test : 2 entreprises isolées, 1 compte chacune, 2 clients, 1 fournisseur. */
export function world(): { ledger: Ledger; ctx: Ctx; ctxB: Ctx } {
  const ledger = emptyLedger();
  for (const [orgId, userId] of [["orgA", "userA"], ["orgB", "userB"]] as const) {
    ledger.organizations.push({
      orgId, name: `Société ${orgId}`, currency: "EUR", locale: "fr-FR", timeZone: "Europe/Paris", vatRatesBp: [2000, 1000, 550, 0],
      defaultPaymentTerms: { kind: "net", days: 30 }, minimumCashThresholdCents: 100_000, legalMentions: "Mentions de test",
      documentPrefixes: { quote: "DEV", invoice: "FAC", credit_note: "AV" }, plan: "business",
    });
    ledger.members.push({ orgId, userId, role: "owner" });
    ledger.accounts.push({ id: `acc_${orgId}`, orgId, name: "Compte", type: "bank", currency: "EUR", openingBalanceCents: 1_000_000, openingDate: "2026-01-01", openingSource: "user_entered" });
    for (const [cid, name, company] of [["c1", "Alice Martin", "Acme Conseil"], ["c2", "Bob Durand", "Durand SARL"]] as const) {
      ledger.customers.push({ id: `${cid}_${orgId}`, orgId, name, company, email: `${cid}@example.test`, defaultPaymentTerms: { kind: "net", days: 30 }, createdAt: "2026-01-01T00:00:00Z" });
    }
    ledger.suppliers.push({ id: `s1_${orgId}`, orgId, name: "Fournisseur", company: "Nuage SAS", defaultPaymentTerms: { kind: "net", days: 30 }, createdAt: "2026-01-01T00:00:00Z" });
  }
  const ctx = buildCtx(ledger, "userA", "orgA", TODAY, `${TODAY}T10:00:00.000Z`);
  const ctxB = buildCtx(ledger, "userB", "orgB", TODAY, `${TODAY}T10:00:00.000Z`);
  return { ledger, ctx, ctxB };
}

export const line = (description: string, quantity: number, unitEuros: number, vatRateBp = 2000, discountBp = 0): DocumentLine =>
  newLine({ description, quantity, unitPriceCents: Math.round(unitEuros * 100), vatRateBp, discountBp });

export const eur = (n: number): Cents => Math.round(n * 100);
