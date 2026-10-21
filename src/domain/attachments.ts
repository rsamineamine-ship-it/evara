import { requirePermission, scoped, type Ctx } from "./access";
import { ValidationError } from "./errors";
import { logAudit, newId } from "./ledger";
import type { Attachment, Id, Ledger } from "./types";

export const ALLOWED_UPLOAD_TYPES: Record<string, string[]> = {
  "application/pdf": [".pdf"],
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/webp": [".webp"],
};
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Nom de fichier assaini : pas de chemin, pas de caractères de contrôle, longueur bornée. */
export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "fichier";
  const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, "").replace(/^\.+/, "").trim();
  return (cleaned || "fichier").slice(0, 120);
}

export function validateUpload(file: { fileName: string; mimeType: string; sizeBytes: number }): string[] {
  const issues: string[] = [];
  const exts = ALLOWED_UPLOAD_TYPES[file.mimeType];
  if (!exts) issues.push("Type de fichier non autorisé (PDF, PNG, JPEG ou WebP uniquement).");
  else if (!exts.some((e) => file.fileName.toLowerCase().endsWith(e))) issues.push("L'extension du fichier ne correspond pas à son type.");
  if (!(file.sizeBytes > 0)) issues.push("Fichier vide.");
  if (file.sizeBytes > MAX_UPLOAD_BYTES) issues.push("Fichier trop volumineux (10 Mo maximum).");
  return issues;
}

/** Enregistre les métadonnées. Le contenu doit être envoyé vers le stockage privé via l'adaptateur configuré. */
export function registerAttachment(ledger: Ledger, ctx: Ctx, file: { fileName: string; mimeType: string; sizeBytes: number }): Attachment {
  requirePermission(ctx, "write");
  const issues = validateUpload(file);
  if (issues.length) throw new ValidationError("Fichier refusé", issues);
  const att: Attachment = {
    id: newId("att"),
    orgId: ctx.orgId,
    fileName: sanitizeFileName(file.fileName),
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    storageKey: `${ctx.orgId}/${newId("obj")}`,
    createdAt: ctx.nowIso,
  };
  ledger.attachments.push(att);
  logAudit(ledger, ctx, "attachment.registered", "attachment", att.id, { fileName: att.fileName });
  return att;
}

export function getAttachment(ledger: Ledger, ctx: Ctx, id: Id): Attachment {
  return scoped(ledger.attachments, ctx, id, "Justificatif");
}
