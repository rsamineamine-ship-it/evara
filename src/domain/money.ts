/**
 * Montants : toujours des entiers en unités mineures (centimes pour l'EUR).
 * Aucun calcul financier en flottant. Arrondi : "half away from zero", appliqué ligne par ligne
 * puis par taux de TVA, comme pratiqué en facturation française.
 */
export type Cents = number;
export type CurrencyCode = string;

export interface CurrencyInfo {
  code: CurrencyCode;
  decimals: number;
}

export const CURRENCIES: Record<string, CurrencyInfo> = {
  EUR: { code: "EUR", decimals: 2 },
  USD: { code: "USD", decimals: 2 },
  GBP: { code: "GBP", decimals: 2 },
  CHF: { code: "CHF", decimals: 2 },
  JPY: { code: "JPY", decimals: 0 },
};

export class MoneyError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "MoneyError";
  }
}

export function currencyInfo(code: CurrencyCode): CurrencyInfo {
  const info = CURRENCIES[code];
  if (!info) throw new MoneyError(`Devise non supportée : ${code}`, "UNSUPPORTED_CURRENCY");
  return info;
}

export function assertCents(value: number, label = "montant"): void {
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`${label} doit être un entier en unités mineures (reçu ${value})`, "NOT_INTEGER");
  }
}

/** Division entière arrondie "half away from zero". den > 0. */
export function divRound(num: number, den: number): number {
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || den <= 0) {
    throw new MoneyError(`divRound : opérandes invalides (${num} / ${den})`, "UNSAFE_ARITHMETIC");
  }
  const sign = num < 0 ? -1 : 1;
  const abs = Math.abs(num);
  const q = Math.floor(abs / den);
  const r = abs - q * den;
  const res = sign * (r * 2 >= den ? q + 1 : q);
  return res === 0 ? 0 : res;
}

export function sumCents(values: readonly Cents[]): Cents {
  let total = 0;
  for (const v of values) {
    assertCents(v);
    total += v;
  }
  if (!Number.isSafeInteger(total)) throw new MoneyError("Dépassement de capacité", "OVERFLOW");
  return total;
}

/** Répartit un montant en parts proportionnelles sans perdre un centime (méthode du plus grand reste). */
export function allocateProportionally(total: Cents, weights: readonly number[]): Cents[] {
  assertCents(total);
  const sumW = weights.reduce((a, b) => a + b, 0);
  if (weights.length === 0) return [];
  if (sumW <= 0) throw new MoneyError("Somme des poids nulle", "BAD_WEIGHTS");
  const raw = weights.map((w) => (total * w) / sumW);
  const floors = raw.map((r) => Math.floor(r));
  let remainder = total - floors.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  const out = [...floors];
  for (const o of order) {
    if (remainder <= 0) break;
    out[o.i] = (out[o.i] ?? 0) + 1;
    remainder -= 1;
  }
  return out;
}

export interface ParseAmountOptions {
  currency?: CurrencyCode;
  /** Séparateur décimal imposé ; "auto" détecte quand c'est non ambigu. */
  decimal?: "," | "." | "auto";
}

export type ParseAmountResult = { ok: true; cents: Cents } | { ok: false; error: string };

/**
 * Lit un montant tel qu'il apparaît dans un export bancaire : "1 234,56", "-1.234,56", "1,234.56", "(12,00)", "12,50 €".
 * Les cas ambigus ("1,234" ou "1.234") sont REFUSÉS sauf si le séparateur décimal est précisé.
 */
export function parseLocaleAmount(raw: string, options: ParseAmountOptions = {}): ParseAmountResult {
  const currency = options.currency ?? "EUR";
  const decimals = currencyInfo(currency).decimals;
  const hint = options.decimal ?? "auto";
  let s = raw.trim();
  if (s === "") return { ok: false, error: "montant vide" };

  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[€$£]|EUR|USD|GBP|CHF/gi, "").replace(/[\s  ]/g, "");
  if (s.startsWith("-") || s.startsWith("−")) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  } else if (s.endsWith("-")) {
    negative = !negative;
    s = s.slice(0, -1);
  }
  if (s === "" || !/^[\d.,]+$/.test(s)) return { ok: false, error: `montant illisible : "${raw}"` };

  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  let decSep: "," | "." | null = null;

  if (hasComma && hasDot) {
    decSep = s.lastIndexOf(",") > s.lastIndexOf(".") ? "," : ".";
  } else if (hasComma || hasDot) {
    const sep = (hasComma ? "," : ".") as "," | ".";
    const count = s.split(sep).length - 1;
    const tail = s.slice(s.lastIndexOf(sep) + 1);
    if (hint !== "auto") {
      decSep = hint === sep ? sep : null; // l'autre séparateur est alors un séparateur de milliers
    } else if (count > 1) {
      decSep = null; // "1.234.567" : milliers
    } else if (tail.length === 3 && decimals !== 3) {
      return { ok: false, error: `montant ambigu : "${raw}" (précisez le séparateur décimal)` };
    } else {
      decSep = sep;
    }
  }

  let intPart: string;
  let fracPart = "";
  if (decSep) {
    const idx = s.lastIndexOf(decSep);
    intPart = s.slice(0, idx).replace(/[.,]/g, "");
    fracPart = s.slice(idx + 1);
  } else {
    intPart = s.replace(/[.,]/g, "");
  }
  if (!/^\d*$/.test(intPart) || !/^\d*$/.test(fracPart)) return { ok: false, error: `montant illisible : "${raw}"` };
  if (intPart === "" && fracPart === "") return { ok: false, error: `montant illisible : "${raw}"` };
  if (fracPart.length > decimals) return { ok: false, error: `trop de décimales : "${raw}"` };

  const major = Number(intPart === "" ? "0" : intPart);
  const minor = Number(fracPart.padEnd(decimals, "0") || "0");
  const cents = major * 10 ** decimals + minor;
  if (!Number.isSafeInteger(cents)) return { ok: false, error: `montant trop grand : "${raw}"` };
  return { ok: true, cents: negative ? -cents || 0 : cents };
}

/** Affichage uniquement (jamais pour calculer). */
export function formatMoney(cents: Cents, currency: CurrencyCode = "EUR", locale = "fr-FR"): string {
  const { decimals } = currencyInfo(currency);
  return new Intl.NumberFormat(locale, { style: "currency", currency, minimumFractionDigits: decimals }).format(
    cents / 10 ** decimals,
  );
}

/** Version stable (espaces normaux) utile pour les PDF/CSV. */
export function formatMoneyPlain(cents: Cents, currency: CurrencyCode = "EUR"): string {
  return formatMoney(cents, currency).replace(/[  ]/g, " ");
}
