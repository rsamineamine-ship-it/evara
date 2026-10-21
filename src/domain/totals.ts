import { allocateProportionally, assertCents, divRound, sumCents, type Cents } from "./money";
import type { DocumentLine, Totals, VatBreakdown } from "./types";

/** Brut d'une ligne = quantité (3 décimales max) × prix unitaire, arrondi au centime. */
export function lineGross(line: DocumentLine): Cents {
  const qtyMilli = Math.round(line.quantity * 1000);
  return divRound(qtyMilli * line.unitPriceCents, 1000);
}

export function validateLines(lines: readonly DocumentLine[], allowedVatRatesBp?: readonly number[]): string[] {
  const issues: string[] = [];
  if (lines.length === 0) issues.push("Le document doit contenir au moins une ligne.");
  lines.forEach((l, i) => {
    const n = i + 1;
    if (!l.description.trim()) issues.push(`Ligne ${n} : description manquante.`);
    if (!(l.quantity > 0)) issues.push(`Ligne ${n} : la quantité doit être supérieure à 0.`);
    if (Math.abs(l.quantity * 1000 - Math.round(l.quantity * 1000)) > 1e-6) issues.push(`Ligne ${n} : 3 décimales maximum pour la quantité.`);
    if (!Number.isSafeInteger(l.unitPriceCents) || l.unitPriceCents < 0) issues.push(`Ligne ${n} : prix unitaire invalide.`);
    if (!Number.isInteger(l.vatRateBp) || l.vatRateBp < 0 || l.vatRateBp > 10_000) issues.push(`Ligne ${n} : taux de TVA invalide.`);
    else if (allowedVatRatesBp && !allowedVatRatesBp.includes(l.vatRateBp)) issues.push(`Ligne ${n} : taux de TVA non autorisé pour cette entreprise.`);
    if (!Number.isInteger(l.discountBp) || l.discountBp < 0 || l.discountBp > 10_000) issues.push(`Ligne ${n} : remise invalide (0 à 100 %).`);
  });
  return issues;
}

/**
 * Totaux d'un document. Ordre de calcul :
 *  1. brut de ligne, 2. remise de ligne, 3. remise globale répartie au prorata (sans perdre un centime),
 *  4. base HT par taux de TVA, 5. TVA = arrondi(base × taux) par taux, 6. TTC = HT + TVA.
 * Garantit : netHt + vat = totalTtc, et Σ bases par taux = netHt.
 */
export function computeTotals(lines: readonly DocumentLine[], documentDiscountBp = 0): Totals {
  if (!Number.isInteger(documentDiscountBp) || documentDiscountBp < 0 || documentDiscountBp > 10_000) {
    throw new RangeError("Remise globale invalide");
  }
  const gross = lines.map(lineGross);
  const lineDiscounts = lines.map((l, i) => divRound((gross[i] ?? 0) * l.discountBp, 10_000));
  const lineNets = gross.map((g, i) => g - (lineDiscounts[i] ?? 0));
  const sumNet = sumCents(lineNets);
  const docDiscount = divRound(sumNet * documentDiscountBp, 10_000);
  const shares = docDiscount > 0 && sumNet > 0 ? allocateProportionally(docDiscount, lineNets) : lineNets.map(() => 0);

  const bases = new Map<number, Cents>();
  lines.forEach((l, i) => {
    const net = (lineNets[i] ?? 0) - (shares[i] ?? 0);
    bases.set(l.vatRateBp, (bases.get(l.vatRateBp) ?? 0) + net);
  });
  const vatByRate: VatBreakdown[] = [...bases.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([rateBp, baseCents]) => ({ rateBp, baseCents, vatCents: divRound(baseCents * rateBp, 10_000) }));

  const netHtCents = sumCents(vatByRate.map((v) => v.baseCents));
  const vatCents = sumCents(vatByRate.map((v) => v.vatCents));
  const totals: Totals = {
    grossCents: sumCents(gross),
    discountCents: sumCents(lineDiscounts) + docDiscount,
    netHtCents,
    vatByRate,
    vatCents,
    totalTtcCents: netHtCents + vatCents,
  };
  assertCents(totals.totalTtcCents, "total TTC");
  return totals;
}
