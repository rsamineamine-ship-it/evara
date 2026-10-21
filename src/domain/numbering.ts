import type { ISODate } from "./dates";
import type { Id, Ledger, OrgSettings } from "./types";
import { ValidationError } from "./errors";

export type DocKind = "quote" | "invoice" | "credit_note";

/**
 * Attribue le prochain numéro : PREFIXE-AAAA-NNNN. Le compteur ne recule jamais et n'est consommé
 * qu'à l'émission (jamais pour un brouillon) : pas de trous liés aux brouillons supprimés, pas de doublons.
 * En base, le même principe est appliqué par la fonction SQL `next_document_number` (verrou de ligne).
 */
export function allocateNumber(ledger: Ledger, org: OrgSettings, kind: DocKind, issueDate: ISODate): string {
  const year = issueDate.slice(0, 4);
  const key = `${org.orgId}:${kind}:${year}`;
  const next = (ledger.counters[key] ?? 0) + 1;
  ledger.counters[key] = next;
  const prefix = org.documentPrefixes[kind];
  return `${prefix}-${year}-${String(next).padStart(4, "0")}`;
}

export function assertNoDuplicateNumbers(ledger: Ledger, orgId: Id): void {
  const seen = new Set<string>();
  const all = [
    ...ledger.quotes.filter((q) => q.orgId === orgId).map((q) => q.number),
    ...ledger.invoices.filter((i) => i.orgId === orgId).map((i) => i.number),
    ...ledger.creditNotes.filter((c) => c.orgId === orgId).map((c) => c.number),
  ];
  for (const n of all) {
    if (!n) continue;
    if (seen.has(n)) throw new ValidationError(`Numéro en doublon : ${n}`);
    seen.add(n);
  }
}
