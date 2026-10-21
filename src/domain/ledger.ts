import type { Ctx } from "./access";
import type { AuditEntry, Id, Ledger } from "./types";

export function emptyLedger(): Ledger {
  return {
    organizations: [],
    members: [],
    customers: [],
    suppliers: [],
    quotes: [],
    invoices: [],
    creditNotes: [],
    purchaseInvoices: [],
    expenses: [],
    accounts: [],
    transactions: [],
    payments: [],
    matches: [],
    imports: [],
    categories: [],
    recurring: [],
    attachments: [],
    notifications: [],
    reminders: [],
    automationRules: [],
    automationRuns: [],
    audit: [],
    forecastSnapshots: [],
    counters: {},
  };
}

export function newId(prefix: string): Id {
  const uuid =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}_${uuid}`;
}

export function logAudit(
  ledger: Ledger,
  ctx: Ctx,
  action: string,
  entityType: string,
  entityId: Id,
  details?: Record<string, unknown>,
): AuditEntry {
  const entry: AuditEntry = {
    id: newId("aud"),
    orgId: ctx.orgId,
    actorId: ctx.userId,
    action,
    entityType,
    entityId,
    at: ctx.nowIso,
    ...(details ? { details } : {}),
  };
  ledger.audit.push(entry);
  return entry;
}

export function cloneLedger(ledger: Ledger): Ledger {
  return structuredClone(ledger);
}
