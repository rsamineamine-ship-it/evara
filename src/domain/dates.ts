/**
 * Dates métier : on manipule des dates calendaires "YYYY-MM-DD" (sans heure ni fuseau).
 * Le "aujourd'hui" est toujours injecté (jamais Date.now() dans la logique), ce qui rend
 * la détection des retards déterministe et testable.
 */
export type ISODate = string;

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidISODate(value: string): boolean {
  const m = ISO_RE.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export function assertISODate(value: string, label = "date"): void {
  if (!isValidISODate(value)) throw new RangeError(`${label} invalide : "${value}" (attendu YYYY-MM-DD)`);
}

function toUTC(value: ISODate): number {
  assertISODate(value);
  const m = ISO_RE.exec(value) as RegExpExecArray;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function fromUTC(ms: number): ISODate {
  const d = new Date(ms);
  const y = String(d.getUTCFullYear()).padStart(4, "0");
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

export function addDays(value: ISODate, days: number): ISODate {
  if (!Number.isInteger(days)) throw new RangeError("addDays attend un entier");
  return fromUTC(toUTC(value) + days * 86_400_000);
}

/** a - b, en jours calendaires. */
export function diffDays(a: ISODate, b: ISODate): number {
  return Math.round((toUTC(a) - toUTC(b)) / 86_400_000);
}

export function compareDates(a: ISODate, b: ISODate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function endOfMonth(value: ISODate): ISODate {
  const m = ISO_RE.exec(value);
  if (!m) throw new RangeError(`date invalide : ${value}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  return fromUTC(Date.UTC(y, mo, 0));
}

/** Ajoute des mois en conservant le jour quand c'est possible (sinon dernier jour du mois). */
export function addMonths(value: ISODate, months: number): ISODate {
  const m = ISO_RE.exec(value);
  if (!m) throw new RangeError(`date invalide : ${value}`);
  assertISODate(value);
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const target = new Date(Date.UTC(y, mo + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return fromUTC(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d, lastDay)));
}

/** "Aujourd'hui" dans un fuseau donné (ex. Europe/Paris), à partir d'un instant. */
export function todayInTimeZone(now: Date, timeZone: string): ISODate {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return parts; // en-CA => YYYY-MM-DD
}

export function isBetween(value: ISODate, from: ISODate, to: ISODate): boolean {
  return value >= from && value <= to;
}
