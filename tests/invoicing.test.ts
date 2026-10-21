import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { world, line, eur, TODAY } from "./helpers";
import {
  cancelInvoice, convertQuoteToInvoice, correctInvoice, createCreditNote, createInvoiceDraft, createQuote, decideQuote, invoiceView,
  issueInvoice, markInvoiceSent, markQuoteSent, quoteDisplayStatus, updateInvoiceDraft, deleteDraftInvoice,
} from "../src/domain/documents";
import { recordPayment, voidPayment } from "../src/domain/payments";
import { assertNoDuplicateNumbers } from "../src/domain/numbering";
import { cashPosition } from "../src/domain/transactions";
import { DomainError } from "../src/domain/errors";

function issued(w = world(), amountHt = 1000, issueDate = "2026-06-10", terms = { kind: "net", days: 30 } as const) {
  const inv = createInvoiceDraft(w.ledger, w.ctx, { customerId: "c1_orgA", issueDate, lines: [line("Prestation", 1, amountHt)], paymentTerms: terms });
  issueInvoice(w.ledger, w.ctx, inv.id);
  return { ...w, inv };
}

describe("Devis", () => {
  it("crée un devis brouillon : total exact, pas de numéro, aucun paiement", () => {
    const { ledger, ctx } = world();
    const q = createQuote(ledger, ctx, { customerId: "c1_orgA", issueDate: TODAY, validUntil: "2026-07-15", lines: [line("Mission", 2, 1000)] });
    assert.equal(q.status, "draft");
    assert.equal(q.number, null);
    assert.equal(q.totals.totalTtcCents, eur(2400));
    assert.equal(ledger.payments.length, 0); // règle 7 : un devis n'est pas une facture
  });
  it("refuse une date de validité antérieure à l'émission", () => {
    const { ledger, ctx } = world();
    assert.throws(() => createQuote(ledger, ctx, { customerId: "c1_orgA", issueDate: TODAY, validUntil: "2026-06-01", lines: [line("x", 1, 10)] }));
  });
  it("n'enregistre « envoyé » que sur confirmation explicite de l'utilisateur", () => {
    const { ledger, ctx } = world();
    const q = createQuote(ledger, ctx, { customerId: "c1_orgA", issueDate: TODAY, validUntil: "2026-07-15", lines: [line("x", 1, 10)] });
    assert.throws(() => markQuoteSent(ledger, ctx, q.id, { confirmedByUser: false, via: "manual" }));
    markQuoteSent(ledger, ctx, q.id, { confirmedByUser: true, via: "manual" });
    assert.equal(q.status, "sent");
    assert.match(q.number ?? "", /^DEV-2026-0001$/);
  });
  it("convertit un devis accepté en facture liée ; un devis accepté n'est pas un paiement (règle 8)", () => {
    const { ledger, ctx } = world();
    const q = createQuote(ledger, ctx, { customerId: "c1_orgA", issueDate: TODAY, validUntil: "2026-07-15", lines: [line("Mission", 1, 2000, 0)] });
    markQuoteSent(ledger, ctx, q.id, { confirmedByUser: true, via: "manual" });
    assert.throws(() => convertQuoteToInvoice(ledger, ctx, q.id), (e: unknown) => e instanceof DomainError && e.code === "NOT_ACCEPTED");
    decideQuote(ledger, ctx, q.id, "accepted");
    assert.equal(ledger.payments.length, 0);
    const inv = convertQuoteToInvoice(ledger, ctx, q.id);
    assert.equal(inv.quoteId, q.id);
    assert.equal(q.convertedInvoiceId, inv.id);
    assert.equal(q.status, "converted");
    assert.equal(inv.status, "draft");
    assert.equal(inv.totals.totalTtcCents, eur(2000));
    assert.throws(() => convertQuoteToInvoice(ledger, ctx, q.id), (e: unknown) => e instanceof DomainError && e.code === "ALREADY_CONVERTED");
  });
  it("affiche « expiré » sans le stocker", () => {
    assert.equal(quoteDisplayStatus({ status: "sent", validUntil: "2026-06-01" }, TODAY), "expired");
    assert.equal(quoteDisplayStatus({ status: "accepted", validUntil: "2026-06-01" }, TODAY), "accepted");
  });
});

describe("Factures et paiements", () => {
  it("paiement partiel : reste dû recalculé, statut « partiellement payée » (règles 1 et 3)", () => {
    const { ledger, ctx, inv } = issued();
    recordPayment(ledger, ctx, { documentType: "sales_invoice", documentId: inv.id, amountCents: eur(500), date: "2026-06-12", method: "transfer", accountId: "acc_orgA" });
    const v = invoiceView(ledger, inv, TODAY);
    assert.equal(v.paidCents, eur(500));
    assert.equal(v.balanceCents, eur(700));
    assert.equal(v.displayStatus, "partially_paid");
    assert.notEqual(v.paymentState, "paid");
  });
  it("paiement intégral : le solde tombe à zéro et la facture passe à « payée »", () => {
    const { ledger, ctx, inv } = issued();
    recordPayment(ledger, ctx, { documentType: "sales_invoice", documentId: inv.id, amountCents: eur(500), date: "2026-06-12", method: "transfer", accountId: "acc_orgA" });
    recordPayment(ledger, ctx, { documentType: "sales_invoice", documentId: inv.id, amountCents: eur(700), date: "2026-06-13", method: "transfer", accountId: "acc_orgA" });
    const v = invoiceView(ledger, inv, TODAY);
    assert.equal(v.balanceCents, 0);
    assert.equal(v.displayStatus, "paid");
    assert.equal(v.isOverdue, false);
  });
  it("refuse un trop-perçu, un paiement sur brouillon et un doublon (règle 2)", () => {
    const { ledger, ctx, inv } = issued();
    assert.throws(() => recordPayment(ledger, ctx, { documentType: "sales_invoice", documentId: inv.id, amountCents: eur(5000), date: TODAY, method: "transfer" }), (e: unknown) => e instanceof DomainError && e.code === "OVERPAYMENT");
    recordPayment(ledger, ctx, { documentType: "sales_invoice", documentId: inv.id, amountCents: eur(100), date: TODAY, method: "check" });
    assert.throws(() => recordPayment(ledger, ctx, { documentType: "sales_invoice", documentId: inv.id, amountCents: eur(100), date: TODAY, method: "check" }), (e: unknown) => e instanceof DomainError && e.code === "DUPLICATE_PAYMENT");
    const draft = createInvoiceDraft(ledger, ctx, { customerId: "c1_orgA", issueDate: TODAY, lines: [line("x", 1, 10)] });
    assert.throws(() => recordPayment(ledger, ctx, { documentType: "sales_invoice", documentId: draft.id, amountCents: 100, date: TODAY, method: "transfer" }), (e: unknown) => e instanceof DomainError && e.code === "NOT_ISSUED");
  });
  it("détecte le retard : échéance dépassée ET solde > 0, jamais le jour même (règle 4)", () => {
    const w = issued(world(), 1000, "2026-05-01", { kind: "net", days: 30 }); // échéance 2026-05-31
    assert.equal(invoiceView(w.ledger, w.inv, "2026-05-31").isOverdue, false);
    const v = invoiceView(w.ledger, w.inv, "2026-06-01");
    assert.equal(v.isOverdue, true);
    assert.equal(v.daysOverdue, 1);
    assert.equal(v.displayStatus, "overdue");
    recordPayment(w.ledger, w.ctx, { documentType: "sales_invoice", documentId: w.inv.id, amountCents: eur(1200), date: "2026-06-02", method: "transfer", accountId: "acc_orgA" });
    assert.equal(invoiceView(w.ledger, w.inv, TODAY).isOverdue, false);
  });
  it("une facture partiellement payée dont l'échéance est passée reste en retard sur le solde", () => {
    const w = issued(world(), 1000, "2026-04-01");
    recordPayment(w.ledger, w.ctx, { documentType: "sales_invoice", documentId: w.inv.id, amountCents: eur(300), date: "2026-05-02", method: "transfer", accountId: "acc_orgA" });
    const v = invoiceView(w.ledger, w.inv, TODAY);
    assert.equal(v.isOverdue, true);
    assert.equal(v.balanceCents, eur(900));
  });
  it("annuler un paiement recalcule les statuts (règle 15) et reste tracé", () => {
    const { ledger, ctx, inv } = issued();
    const { payment } = recordPayment(ledger, ctx, { documentType: "sales_invoice", documentId: inv.id, amountCents: eur(1200), date: "2026-06-12", method: "transfer", accountId: "acc_orgA" });
    assert.equal(invoiceView(ledger, inv, TODAY).displayStatus, "paid");
    voidPayment(ledger, ctx, payment.id, "Erreur de saisie");
    assert.notEqual(invoiceView(ledger, inv, TODAY).displayStatus, "paid");
    assert.ok(ledger.payments.includes(payment)); // jamais supprimé
    assert.ok(ledger.audit.some((a) => a.action === "payment.voided"));
  });
  it("une facture émise n'est pas modifiable ni supprimable ; elle se corrige par avoir + nouveau brouillon (règles 16, 18)", () => {
    const { ledger, ctx, inv } = issued();
    assert.throws(() => updateInvoiceDraft(ledger, ctx, inv.id, { customerId: "c1_orgA", issueDate: TODAY, lines: [line("x", 1, 1)] }), (e: unknown) => e instanceof DomainError && e.code === "ISSUED_IMMUTABLE");
    assert.throws(() => deleteDraftInvoice(ledger, ctx, inv.id));
    const { creditNote, draft } = correctInvoice(ledger, ctx, inv.id, "Erreur de TVA");
    assert.equal(creditNote.invoiceId, inv.id); // règle 12
    assert.equal(creditNote.totals.totalTtcCents, inv.totals.totalTtcCents);
    assert.equal(draft.replacesInvoiceId, inv.id);
    assert.equal(invoiceView(ledger, inv, TODAY).balanceCents, 0);
    assert.ok(ledger.invoices.includes(inv)); // l'historique est conservé
  });
  it("un avoir ne peut pas dépasser la facture d'origine et réduit le reste dû", () => {
    const { ledger, ctx, inv } = issued();
    createCreditNote(ledger, ctx, inv.id, { reason: "Remise", lines: [line("Remise", 1, 200)] });
    assert.equal(invoiceView(ledger, inv, TODAY).balanceCents, eur(960));
    assert.throws(() => createCreditNote(ledger, ctx, inv.id, { reason: "Trop", lines: [line("Trop", 1, 5000)] }));
    assert.throws(() => createCreditNote(ledger, ctx, inv.id, { reason: " ", lines: [line("x", 1, 1)] }));
  });
  it("annuler une facture avec paiements est refusé", () => {
    const { ledger, ctx, inv } = issued();
    recordPayment(ledger, ctx, { documentType: "sales_invoice", documentId: inv.id, amountCents: eur(100), date: TODAY, method: "transfer", accountId: "acc_orgA" });
    assert.throws(() => cancelInvoice(ledger, ctx, inv.id, "x"), (e: unknown) => e instanceof DomainError && e.code === "HAS_PAYMENTS");
  });
  it("la numérotation est séquentielle, sans doublon, et ne consomme rien pour un brouillon", () => {
    const { ledger, ctx } = world();
    createInvoiceDraft(ledger, ctx, { customerId: "c1_orgA", issueDate: TODAY, lines: [line("brouillon", 1, 1)] });
    const nums = [1, 2, 3].map(() => {
      const d = createInvoiceDraft(ledger, ctx, { customerId: "c1_orgA", issueDate: TODAY, lines: [line("x", 1, 10)] });
      return issueInvoice(ledger, ctx, d.id).number;
    });
    assert.deepEqual(nums, ["FAC-2026-0001", "FAC-2026-0002", "FAC-2026-0003"]);
    assertNoDuplicateNumbers(ledger, ctx.orgId);
  });
  it("« envoyée » exige la confirmation de l'utilisateur (aucun email n'est émis)", () => {
    const { ledger, ctx, inv } = issued();
    assert.throws(() => markInvoiceSent(ledger, ctx, inv.id, { confirmedByUser: false, via: "manual" }));
    markInvoiceSent(ledger, ctx, inv.id, { confirmedByUser: true, via: "manual" });
    assert.equal(inv.status, "sent");
  });
  it("une facture non payée n'est pas un encaissement : la trésorerie réelle ne bouge pas (règle 6)", () => {
    const { ledger, ctx } = issued();
    assert.equal(cashPosition(ledger, ctx).totalCents, 1_000_000);
  });
});
