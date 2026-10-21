import { addDays, addMonths, diffDays, type ISODate } from "./dates";
import { divRound, type Cents } from "./money";
import { normalizeText } from "./text";
import type { Direction, Ledger, RecurringItem, Transaction } from "./types";

export interface RecurringCandidate {
  key: string;
  label: string;
  direction: Direction;
  interval: RecurringItem["interval"];
  medianAmountCents: Cents;
  amountStable: boolean;
  occurrences: number;
  lastDate: ISODate;
  nextDate: ISODate;
  confidence: "high" | "medium" | "low";
  explanation: string;
}

/** Clé de regroupement : libellé sans chiffres ni références variables, 3 premiers mots. */
export function recurringKey(label: string): string {
  return normalizeText(label.replace(/\d+/g, " "))
    .split(" ")
    .filter((w) => w.length > 1)
    .slice(0, 3)
    .join(" ");
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : divRound((s[mid - 1] as number) + (s[mid] as number), 2);
}

function classify(gaps: number[]): RecurringItem["interval"] | null {
  const med = median(gaps);
  const within = (lo: number, hi: number) => gaps.every((g) => g >= lo && g <= hi);
  if (med >= 6 && med <= 8 && within(5, 9)) return "weekly";
  if (med >= 28 && med <= 32 && within(26, 35)) return "monthly";
  if (med >= 88 && med <= 93 && within(84, 97)) return "quarterly";
  if (med >= 360 && med <= 370 && within(355, 375)) return "yearly";
  return null;
}

function nextOccurrence(last: ISODate, interval: RecurringItem["interval"]): ISODate {
  switch (interval) {
    case "weekly":
      return addDays(last, 7);
    case "monthly":
      return addMonths(last, 1);
    case "quarterly":
      return addMonths(last, 3);
    case "yearly":
      return addMonths(last, 12);
  }
}

/**
 * Détecte des opérations récurrentes POTENTIELLES. Une seule occurrence ne produit jamais de candidat ;
 * il en faut au moins 3 (2 pour un rythme annuel, en confiance faible). Aucune suggestion n'est activée automatiquement.
 */
export function detectRecurringCandidates(ledger: Ledger, orgId: string): RecurringCandidate[] {
  const txs = ledger.transactions.filter((t) => t.orgId === orgId && !t.voidedAt);
  const known = new Set(ledger.recurring.filter((r) => r.orgId === orgId).map((r) => `${r.direction}|${recurringKey(r.label)}`));
  const groups = new Map<string, Transaction[]>();
  for (const t of txs) {
    const k = recurringKey(t.label);
    if (!k) continue;
    const gk = `${t.direction}|${k}`;
    (groups.get(gk) ?? groups.set(gk, []).get(gk))!.push(t);
  }
  const out: RecurringCandidate[] = [];
  for (const [gk, list] of groups) {
    if (list.length < 2 || known.has(gk)) continue;
    const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date));
    const gaps = sorted.slice(1).map((t, i) => diffDays(t.date, (sorted[i] as Transaction).date));
    const interval = classify(gaps);
    if (!interval) continue;
    if (sorted.length < 3 && interval !== "yearly") continue;
    const amounts = sorted.map((t) => t.amountCents);
    const med = median(amounts);
    const stable = amounts.every((a) => Math.abs(a - med) <= med * 0.15);
    const last = sorted[sorted.length - 1] as Transaction;
    let confidence: RecurringCandidate["confidence"] = sorted.length >= 4 && stable ? "high" : sorted.length >= 3 ? "medium" : "low";
    if (!stable && confidence === "high") confidence = "medium";
    out.push({
      key: gk,
      label: last.label,
      direction: last.direction,
      interval,
      medianAmountCents: med,
      amountStable: stable,
      occurrences: sorted.length,
      lastDate: last.date,
      nextDate: nextOccurrence(last.date, interval),
      confidence,
      explanation: `${sorted.length} opérations similaires espacées de ${median(gaps)} jours en moyenne${stable ? ", pour des montants proches" : ", mais avec des montants variables"}.`,
    });
  }
  return out.sort((a, b) => b.occurrences - a.occurrences);
}
