import { requirePermission, scoped, type Ctx } from "./access";
import { isValidISODate, type ISODate } from "./dates";
import { ValidationError } from "./errors";
import { logAudit, newId } from "./ledger";
import { parseLocaleAmount, type Cents } from "./money";
import { suggestCategory } from "./categorize";
import { normalizeText } from "./text";
import { addTransaction } from "./transactions";
import type { Direction, Id, ImportRecord, Ledger, Transaction } from "./types";

/* --------------------------------- Parsing --------------------------------- */

export interface ParsedCsv {
  delimiter: string;
  headers: string[];
  rows: string[][];
}

function detectDelimiter(firstLine: string): string {
  let best = ",";
  let bestCount = -1;
  for (const d of [";", ",", "\t", "|"]) {
    let count = 0;
    let inQ = false;
    for (const ch of firstLine) {
      if (ch === '"') inQ = !inQ;
      else if (ch === d && !inQ) count++;
    }
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

/** Parseur CSV (RFC 4180 : guillemets, guillemets doublés, retours à la ligne dans les champs, BOM). */
export function parseCsv(text: string, delimiter?: string): ParsedCsv {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const delim = delimiter ?? detectDelimiter(firstLine);
  const records: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQ = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i] as string;
    if (inQ) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQ = false;
      } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delim) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      records.push(row);
      row = [];
    } else field += ch;
  }
  if (inQ) throw new ValidationError("Fichier CSV invalide : guillemet non refermé.");
  if (field !== "" || row.length) {
    row.push(field);
    records.push(row);
  }
  const nonEmpty = records.filter((r) => r.some((c) => c.trim() !== ""));
  const headers = (nonEmpty[0] ?? []).map((h) => h.trim());
  return { delimiter: delim, headers, rows: nonEmpty.slice(1) };
}

/* -------------------------------- Mapping -------------------------------- */

export interface ColumnMapping {
  date: number;
  label: number;
  /** Colonne unique signée (négatif = sortie). */
  amount?: number;
  /** Ou deux colonnes séparées. */
  debit?: number;
  credit?: number;
  reference?: number;
  counterparty?: number;
}

export interface ImportOptions {
  dateFormat: "DMY" | "MDY" | "YMD";
  decimal: "," | "." | "auto";
  /** true : montants positifs = sorties (certains exports de cartes). */
  invertSign?: boolean;
}

const HEADER_HINTS: Record<keyof ColumnMapping, RegExp> = {
  date: /^(date|date operation|date de l operation|date valeur|booking date|transaction date|date comptable)/,
  label: /(libelle|label|description|intitule|motif|details|objet|memo)/,
  amount: /^(montant|amount|valeur|somme)$/,
  debit: /(debit|sortie|withdrawal|paid out)/,
  credit: /(credit|entree|deposit|paid in)/,
  reference: /(reference|ref|id transaction|transaction id|numero)/,
  counterparty: /(tiers|beneficiaire|contrepartie|counterparty|payee|emetteur)/,
};

export function suggestMapping(headers: string[]): Partial<ColumnMapping> {
  const norm = headers.map(normalizeText);
  const out: Partial<ColumnMapping> = {};
  (Object.keys(HEADER_HINTS) as (keyof ColumnMapping)[]).forEach((key) => {
    const idx = norm.findIndex((h, i) => HEADER_HINTS[key].test(h) && !Object.values(out).includes(i));
    if (idx >= 0) out[key] = idx;
  });
  return out;
}

export function parseDateCell(raw: string, format: ImportOptions["dateFormat"]): ISODate | null {
  const s = raw.trim();
  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  let y: number, m: number, d: number;
  if (iso && (format === "YMD" || /^\d{4}-/.test(s))) {
    y = Number(iso[1]);
    m = Number(iso[2]);
    d = Number(iso[3]);
  } else {
    const parts = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(s);
    if (!parts) return null;
    const a = Number(parts[1]);
    const b = Number(parts[2]);
    y = Number(parts[3]);
    if (y < 100) y += 2000;
    if (format === "MDY") {
      m = a;
      d = b;
    } else {
      d = a;
      m = b;
    }
  }
  const out = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return isValidISODate(out) ? out : null;
}

/* -------------------------------- Aperçu -------------------------------- */

export type PreviewStatus = "valid" | "invalid" | "duplicate_existing" | "duplicate_in_file";

export interface PreviewRow {
  rowNumber: number;
  raw: string[];
  status: PreviewStatus;
  errors: string[];
  date?: ISODate;
  label?: string;
  amountCents?: Cents;
  direction?: Direction;
  externalRef?: string;
  counterparty?: string;
  categoryId?: Id | null;
  categorySuggestion?: string;
  duplicateOf?: Id;
  duplicateReason?: string;
  /** Ligne retenue pour l'import (modifiable par l'utilisateur ; jamais vrai pour une ligne invalide). */
  include: boolean;
}

function dupKey(date: string, cents: number, dir: Direction, label: string): string {
  return `${date}|${cents}|${dir}|${normalizeText(label)}`;
}

function labelsSimilar(a: string, b: string): boolean {
  const x = normalizeText(a);
  const y = normalizeText(b);
  return x === y || (x.length >= 6 && y.includes(x)) || (y.length >= 6 && x.includes(y));
}

export function buildPreview(
  ledger: Ledger,
  ctx: Ctx,
  args: { accountId: Id; csv: ParsedCsv; mapping: ColumnMapping; options: ImportOptions },
): PreviewRow[] {
  scoped(ledger.accounts, ctx, args.accountId, "Compte");
  const { mapping, options, csv } = args;
  const existing = ledger.transactions.filter((t) => t.orgId === ctx.orgId && t.accountId === args.accountId && !t.voidedAt);
  const seenInFile = new Map<string, number>();
  const rows: PreviewRow[] = [];
  const hasAmountSource = mapping.amount !== undefined || (mapping.debit !== undefined && mapping.credit !== undefined);

  csv.rows.forEach((raw, idx) => {
    const rowNumber = idx + 2; // ligne 1 = en-têtes
    const errors: string[] = [];
    if (!hasAmountSource) errors.push("Aucune colonne de montant n'est associée.");
    const date = parseDateCell(raw[mapping.date] ?? "", options.dateFormat);
    if (!date) errors.push(`Date illisible : « ${(raw[mapping.date] ?? "").trim()} ».`);
    const label = (raw[mapping.label] ?? "").trim();
    if (!label) errors.push("Libellé manquant.");

    let signed: Cents | null = null;
    if (hasAmountSource) {
      if (mapping.amount !== undefined) {
        const r = parseLocaleAmount(raw[mapping.amount] ?? "", { decimal: options.decimal });
        if (r.ok) signed = options.invertSign ? -r.cents : r.cents;
        else errors.push(r.error);
      } else {
        const dRaw = (raw[mapping.debit as number] ?? "").trim();
        const cRaw = (raw[mapping.credit as number] ?? "").trim();
        const d = dRaw ? parseLocaleAmount(dRaw, { decimal: options.decimal }) : null;
        const c = cRaw ? parseLocaleAmount(cRaw, { decimal: options.decimal }) : null;
        if (d && !d.ok) errors.push(d.error);
        else if (c && !c.ok) errors.push(c.error);
        else if (d?.ok && c?.ok && d.cents !== 0 && c.cents !== 0) errors.push("Débit et crédit renseignés sur la même ligne.");
        else if (d?.ok && d.cents !== 0) signed = -Math.abs(d.cents);
        else if (c?.ok && c.cents !== 0) signed = Math.abs(c.cents);
        else errors.push("Montant manquant.");
      }
      if (signed === 0) errors.push("Montant nul.");
    }

    const row: PreviewRow = { rowNumber, raw, status: "valid", errors, include: false };
    if (errors.length || !date || signed === null) {
      row.status = "invalid";
      rows.push(row);
      return;
    }
    const direction: Direction = signed > 0 ? "in" : "out";
    const amountCents = Math.abs(signed);
    const externalRef = mapping.reference !== undefined ? (raw[mapping.reference] ?? "").trim() : "";
    const counterparty = mapping.counterparty !== undefined ? (raw[mapping.counterparty] ?? "").trim() : "";
    Object.assign(row, { date, label, amountCents, direction });
    if (externalRef) row.externalRef = externalRef;
    if (counterparty) row.counterparty = counterparty;

    const suggestion = suggestCategory(label, direction, ledger.categories.filter((c) => c.orgId === ctx.orgId));
    if (suggestion) {
      row.categoryId = suggestion.categoryId;
      row.categorySuggestion = suggestion.reason;
    }

    // Doublon avec une transaction existante : même référence externe, ou même date/montant/sens + libellé proche.
    const dupExisting = existing.find(
      (t) =>
        (externalRef && t.externalRef && t.externalRef === externalRef) ||
        (t.date === date && t.amountCents === amountCents && t.direction === direction && labelsSimilar(t.label, label)),
    );
    if (dupExisting) {
      row.status = "duplicate_existing";
      row.duplicateOf = dupExisting.id;
      row.duplicateReason = externalRef && dupExisting.externalRef === externalRef ? "Même référence externe déjà importée." : "Même date, même montant et libellé proche d'une transaction existante.";
      rows.push(row);
      return;
    }
    const key = externalRef ? `ref|${externalRef}` : dupKey(date, amountCents, direction, label);
    const first = seenInFile.get(key);
    if (first !== undefined) {
      row.status = "duplicate_in_file";
      row.duplicateReason = `Identique à la ligne ${first} du fichier (deux opérations réelles identiques sont possibles : confirmez si c'est le cas).`;
      rows.push(row);
      return;
    }
    seenInFile.set(key, rowNumber);
    row.include = true;
    rows.push(row);
  });
  return rows;
}

/* ---------------------------- Import effectif ---------------------------- */

export function commitImport(
  ledger: Ledger,
  ctx: Ctx,
  args: { accountId: Id; fileName: string; rows: PreviewRow[] },
): { record: ImportRecord; transactions: Transaction[] } {
  requirePermission(ctx, "write");
  scoped(ledger.accounts, ctx, args.accountId, "Compte");
  const selected = args.rows.filter((r) => r.include && r.status !== "invalid");
  const importId = newId("imp");
  const created: Transaction[] = [];
  for (const r of selected) {
    created.push(
      addTransaction(ledger, ctx, {
        accountId: args.accountId,
        date: r.date as ISODate,
        label: r.label as string,
        amountCents: r.amountCents as Cents,
        direction: r.direction as Direction,
        categoryId: r.categoryId ?? null,
        ...(r.counterparty ? { counterparty: r.counterparty } : {}),
        ...(r.externalRef ? { externalRef: r.externalRef } : {}),
        source: "csv",
        importId,
      }),
    );
  }
  const record: ImportRecord = {
    id: importId,
    orgId: ctx.orgId,
    accountId: args.accountId,
    fileName: args.fileName,
    totalRows: args.rows.length,
    importedRows: created.length,
    rejectedRows: args.rows.filter((r) => r.status === "invalid").length,
    duplicateRowsSkipped: args.rows.filter((r) => (r.status === "duplicate_existing" || r.status === "duplicate_in_file") && !r.include).length,
    createdBy: ctx.userId,
    createdAt: ctx.nowIso,
  };
  ledger.imports.push(record);
  logAudit(ledger, ctx, "import.committed", "import", importId, { fileName: args.fileName, imported: record.importedRows, rejected: record.rejectedRows, duplicates: record.duplicateRowsSkipped });
  return { record, transactions: created };
}

export function toCsv(rows: (string | number | null | undefined)[][], delimiter = ";"): string {
  const esc = (v: string | number | null | undefined): string => {
    let s = v === null || v === undefined ? "" : String(v);
    // Neutralise l'injection de formules dans les tableurs.
    if (/^[=+\-@]/.test(s) && !/^-?\d+([.,]\d+)?$/.test(s)) s = `'${s}`;
    return /[";\n\r]/.test(s) || s.includes(delimiter) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "﻿" + rows.map((r) => r.map(esc).join(delimiter)).join("\r\n");
}
