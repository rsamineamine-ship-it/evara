import { ForbiddenError, NotFoundError } from "./errors";
import type { ISODate } from "./dates";
import type { Id, Ledger, Role } from "./types";

/** Contexte d'une requête : qui agit, pour quelle entreprise, avec quel rôle, à quelle date. */
export interface Ctx {
  userId: Id;
  orgId: Id;
  role: Role;
  /** "Aujourd'hui" dans le fuseau de l'entreprise (injecté, jamais lu implicitement). */
  today: ISODate;
  /** Instant ISO utilisé pour les horodatages. */
  nowIso: string;
}

export type Permission = "read" | "write" | "issue" | "settings" | "members";

const PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: ["read", "write", "issue", "settings", "members"],
  admin: ["read", "write", "issue", "settings", "members"],
  editor: ["read", "write", "issue"],
  viewer: ["read"],
};

export function can(role: Role, permission: Permission): boolean {
  return PERMISSIONS[role].includes(permission);
}

export function requirePermission(ctx: Ctx, permission: Permission): void {
  if (!can(ctx.role, permission)) throw new ForbiddenError("Vous n'avez pas les droits pour cette action.");
}

/**
 * Construit un contexte UNIQUEMENT si l'utilisateur est membre de l'entreprise.
 * C'est le seul point d'entrée : changer un identifiant d'entreprise dans une requête ne donne aucun accès.
 */
export function buildCtx(ledger: Ledger, userId: Id, orgId: Id, today: ISODate, nowIso: string): Ctx {
  const member = ledger.members.find((m) => m.userId === userId && m.orgId === orgId);
  if (!member) throw new ForbiddenError("Accès à cette entreprise refusé.");
  return { userId, orgId, role: member.role, today, nowIso };
}

/** Retourne l'élément s'il appartient à l'entreprise du contexte ; sinon NotFound (pas de fuite d'existence). */
export function scoped<T extends { id: Id; orgId: Id }>(items: readonly T[], ctx: Ctx, id: Id, label: string): T {
  const found = items.find((i) => i.id === id && i.orgId === ctx.orgId);
  if (!found) throw new NotFoundError(label);
  return found;
}

export function listScoped<T extends { orgId: Id }>(items: readonly T[], ctx: Ctx): T[] {
  return items.filter((i) => i.orgId === ctx.orgId);
}
