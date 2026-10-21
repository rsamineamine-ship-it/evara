import { requirePermission, scoped, type Ctx } from "./access";
import { invoiceView } from "./documents";
import { ConflictError, ValidationError } from "./errors";
import { logAudit, newId } from "./ledger";
import { formatMoneyPlain } from "./money";
import type { Id, Ledger, ReminderDraft } from "./types";

/** Prépare un brouillon de relance. N'ENVOIE RIEN : l'envoi réel exige une intégration email configurée et un clic humain. */
export function prepareReminder(ledger: Ledger, ctx: Ctx, invoiceId: Id): ReminderDraft {
  requirePermission(ctx, "write");
  const inv = scoped(ledger.invoices, ctx, invoiceId, "Facture");
  const view = invoiceView(ledger, inv, ctx.today);
  if (!view.isOverdue) throw new ConflictError("Cette facture n'est pas en retard.", "NOT_OVERDUE");
  const customer = ledger.customers.find((c) => c.id === inv.customerId);
  const org = ledger.organizations.find((o) => o.orgId === ctx.orgId);
  const firstName = customer?.name?.split(" ")[0] ?? "";
  const draft: ReminderDraft = {
    id: newId("rem"),
    orgId: ctx.orgId,
    invoiceId,
    to: customer?.email ?? "",
    subject: `Rappel : facture ${inv.number} arrivée à échéance le ${inv.dueDate}`,
    body:
      `Bonjour${firstName ? " " + firstName : ""},\n\n` +
      `Sauf erreur de notre part, la facture ${inv.number} d'un montant restant dû de ${formatMoneyPlain(view.balanceCents, inv.currency)} ` +
      `était exigible le ${inv.dueDate} (${view.daysOverdue} jour${view.daysOverdue > 1 ? "s" : ""} de retard).\n\n` +
      `Pourriez-vous nous confirmer la date de règlement prévue ? Si le paiement a déjà été effectué, merci de ne pas tenir compte de ce message.\n\n` +
      `Cordialement,\n${org?.name ?? ""}`,
    status: "draft",
    createdAt: ctx.nowIso,
  };
  ledger.reminders.push(draft);
  logAudit(ledger, ctx, "reminder.prepared", "invoice", invoiceId, { reminderId: draft.id });
  return draft;
}

export function markReminderSent(ledger: Ledger, ctx: Ctx, id: Id, confirmedByUser: boolean): ReminderDraft {
  requirePermission(ctx, "write");
  const r = scoped(ledger.reminders, ctx, id, "Relance");
  if (!confirmedByUser) throw new ValidationError("Confirmez que la relance a réellement été envoyée.");
  r.status = "marked_sent";
  logAudit(ledger, ctx, "reminder.marked_sent", "invoice", r.invoiceId, { reminderId: id });
  return r;
}

export function dismissReminder(ledger: Ledger, ctx: Ctx, id: Id): ReminderDraft {
  requirePermission(ctx, "write");
  const r = scoped(ledger.reminders, ctx, id, "Relance");
  r.status = "dismissed";
  return r;
}

export function mailtoLink(to: string, subject: string, body: string): string {
  return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
