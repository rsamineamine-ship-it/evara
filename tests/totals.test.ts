import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeTotals } from "../src/domain/totals";
import { parseLocaleAmount, formatMoneyPlain, allocateProportionally } from "../src/domain/money";
import { addDays, endOfMonth, diffDays } from "../src/domain/dates";
import { line } from "./helpers";

describe("Montants et totaux (règles 13 et 14)", () => {
  it("HT + TVA = TTC et la somme des bases par taux = HT", () => {
    const t = computeTotals([line("A", 3, 33.33, 2000), line("B", 1, 100.01, 1000), line("C", 2, 9.99, 550)]);
    assert.equal(t.netHtCents + t.vatCents, t.totalTtcCents);
    assert.equal(t.vatByRate.reduce((s, v) => s + v.baseCents, 0), t.netHtCents);
    assert.equal(t.vatByRate.reduce((s, v) => s + v.vatCents, 0), t.vatCents);
  });
  it("évite les erreurs de flottants : 3 × 0,10 € = 0,30 €", () => {
    assert.equal(computeTotals([line("x", 3, 0.1, 0)]).totalTtcCents, 30);
  });
  it("applique remise de ligne et remise globale sans perdre un centime", () => {
    const t = computeTotals([line("A", 1, 1000, 2000, 1000), line("B", 1, 500, 1000, 0)], 500);
    assert.equal(t.grossCents, 150_000);
    assert.equal(t.netHtCents, 133_000); // (900 + 500) = 1 400 €, remise globale 5 % → 1 330 €
    assert.equal(t.discountCents, 17_000);
    assert.equal(t.netHtCents + t.vatCents, t.totalTtcCents);
  });
  it("répartit un total au centime près (allocation proportionnelle)", () => {
    const parts = allocateProportionally(100, [1, 1, 1]);
    assert.equal(parts.reduce((a, b) => a + b, 0), 100);
  });
  it("lit les montants bancaires et refuse les cas ambigus", () => {
    assert.deepEqual(parseLocaleAmount("1 234,56"), { ok: true, cents: 123_456 });
    assert.deepEqual(parseLocaleAmount("-1.234,56"), { ok: true, cents: -123_456 });
    assert.deepEqual(parseLocaleAmount("(12,00)"), { ok: true, cents: -1200 });
    assert.equal(parseLocaleAmount("1,234").ok, false);
    assert.equal(parseLocaleAmount("abc").ok, false);
  });
  it("formate en euros avec espaces normaux (PDF/CSV)", () => {
    assert.equal(formatMoneyPlain(123_456), "1 234,56 €");
  });
  it("calcule les dates (fin de mois, écarts)", () => {
    assert.equal(addDays("2026-01-31", 1), "2026-02-01");
    assert.equal(endOfMonth("2026-02-10"), "2026-02-28");
    assert.equal(diffDays("2026-03-01", "2026-02-01"), 28);
  });
});
