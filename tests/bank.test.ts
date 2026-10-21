import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { world, line, eur, TODAY } from "./helpers";
import { buildPreview, commitImport, parseCsv, suggestMapping, toCsv, type ColumnMapping } from "../src/domain/csv";
import { createInvoiceDraft, invoiceView, issueInvoice } from "../src/domain/documents";
import { confirmMatch, recordPayment, undoMatch } from "../src/domain/payments";
import { suggestMatches } from "../src/domain/reconcile";
import { addTransaction, allocatedCents, reconciliationStatus } from "../src/domain/transactions";
import { suggestCategory } from "../src/domain/categorize";
import { detectRecurringCandidates } from "../src/domain/recurring";
import { DomainError } from "../src/domain/errors";

const CSV = [
  "Date;Libellé;Débit;Crédit;Référence",
  "02/06/2026;VIR SEPA ACME CONSEIL FAC-2026-0001;;1 200,00;R1",
  "03/06/2026;PRLV OVH CLOUD;24,00;;",
  "03/06/2026;PRLV OVH CLOUD;24,00;;",
  "31/02/2026;DATE IMPOSSIBLE;5,00;;R3",
  "04/06/2026;;5,00;;R4",
  "05/06/2026;MONTANT ILLISIBLE;abc;;R5",
].join("\n");

function mapping(csv: ReturnType<typeof parseCsv>): { mapping: ColumnMapping; options: { dateFormat: "DMY"; decimal: "," } } {
  const m = suggestMapping(csv.headers);
  assert.equal(m.date, 0);
  assert.equal(m.label, 1);
  return { mapping: { date: m.date!, label: m.label!, debit: m.debit!, credit: m.credit!, ...(m.reference !== undefined ? { reference: m.reference } : {}) }, options: { dateFormat: "DMY", decimal: "," } };
}

describe("Import CSV bancaire", () => {
  it("détecte le délimiteur, propose un mapping et prévisualise sans rien écrire", () => {
    const w = world();
    const csv = parseCsv(CSV);
    assert.equal(csv.delimiter, ";");
    assert.equal(csv.rows.length, 6);
    const before = w.ledger.transactions.length;
    const rows = buildPreview(w.ledger, w.ctx, { accountId: "acc_orgA", csv, ...mapping(csv) });
    assert.equal(w.ledger.transactions.length, before);
    assert.equal(rows[0]!.status, "valid");
    assert.equal(rows[0]!.direction, "in");
    assert.equal(rows[0]!.amountCents, eur(1200));
    assert.equal(rows[1]!.direction, "out");
  });
  it("rejette les lignes invalides (date impossible, libellé vide, montant illisible) avec une raison", () => {
    const w = world();
    const csv = parseCsv(CSV);
    const rows = buildPreview(w.ledger, w.ctx, { accountId: "acc_orgA", csv, ...mapping(csv) });
    assert.deepEqual(rows.map((r) => r.status), ["valid", "valid", "duplicate_in_file", "invalid", "invalid", "invalid"]);
    for (const r of rows.filter((x) => x.status === "invalid")) {
      assert.ok(r.errors.length > 0);
      assert.equal(r.include, false);
    }
  });
  it("signale les doublons dans le fichier et avec des transactions existantes, et ne les importe pas par défaut", () => {
    const w = world();
    addTransaction(w.ledger, w.ctx, { accountId: "acc_orgA", date: "2026-06-02", label: "VIR SEPA ACME CONSEIL FAC-2026-0001", amountCents: eur(1200), direction: "in" });
    const csv = parseCsv(CSV);
    const rows = buildPreview(w.ledger, w.ctx, { accountId: "acc_orgA", csv, ...mapping(csv) });
    assert.equal(rows[0]!.status, "duplicate_existing");
    assert.equal(rows[2]!.status, "duplicate_in_file");
    assert.equal(rows[0]!.include, false);
  });
  it("importe seulement les lignes retenues et trace l'import", () => {
    const w = world();
    const csv = parseCsv(CSV);
    const rows = buildPreview(w.ledger, w.ctx, { accountId: "acc_orgA", csv, ...mapping(csv) });
    const { record, transactions } = commitImport(w.ledger, w.ctx, { accountId: "acc_orgA", fileName: "releve.csv", rows });
    assert.equal(transactions.length, record.importedRows);
    assert.ok(record.importedRows >= 2);
    assert.equal(record.rejectedRows, 3);
    assert.ok(transactions.every((t) => t.source === "csv" && t.importId === record.id));
    assert.ok(w.ledger.audit.some((a) => a.action === "import.committed"));
    // Réimport du même fichier : plus rien de neuf n'est retenu.
    const again = buildPreview(w.ledger, w.ctx, { accountId: "acc_orgA", csv, ...mapping(csv) });
    assert.equal(again.filter((r) => r.include).length, 0);
  });
  it("neutralise l'injection de formules à l'export CSV", () => {
    const out = toCsv([["=HYPERLINK(\"http://x\")", "+1+1", "normal", -12.5]]);
    assert.ok(out.includes("'=HYPERLINK"));
    assert.ok(out.includes("'+1+1"));
    assert.ok(out.includes("-12.5"));
  });
  it("propose (sans appliquer) une catégorie explicable", () => {
    const w = world();
    w.ledger.categories.push({ id: "k1", orgId: "orgA", name: "Abonnements logiciels", kind: "expense" });
    const s = suggestCategory("PRLV OVH CLOUD", "out", w.ledger.categories);
    assert.equal(s?.categoryId, "k1");
    assert.match(s?.reason ?? "", /règle/);
    assert.equal(suggestCategory("PRLV OVH CLOUD", "in", w.ledger.categories), null);
  });
  it("ne déclare pas récurrente une opération unique", () => {
    const w = world();
    addTransaction(w.ledger, w.ctx, { accountId: "acc_orgA", date: "2026-05-01", label: "ACHAT UNIQUE ECRAN", amountCents: eur(300), direction: "out" });
    assert.equal(detectRecurringCandidates(w.ledger, "orgA").length, 0);
    for (const d of ["2026-03-05", "2026-04-05", "2026-05-05"]) addTransaction(w.ledger, w.ctx, { accountId: "acc_orgA", date: d, label: "PRLV ASSURANCE PRO", amountCents: eur(80), direction: "out" });
    const c = detectRecurringCandidates(w.ledger, "orgA");
    assert.equal(c.length, 1);
    assert.equal(c[0]!.interval, "monthly");
  });
});

function openInv(w: ReturnType<typeof world>, ht: number, customerId = "c1_orgA") {
  const inv = createInvoiceDraft(w.ledger, w.ctx, { customerId, issueDate: "2026-05-20", lines: [line("Mission", 1, ht, 0)] });
  issueInvoice(w.ledger, w.ctx, inv.id);
  return inv;
}

describe("Rapprochement (règles 2, 15)", () => {
  it("propose une correspondance forte (montant + numéro + nom) sans rien modifier", () => {
    const w = world();
    const inv = openInv(w, 1200);
    const tx = addTransaction(w.ledger, w.ctx, { accountId: "acc_orgA", date: "2026-06-10", label: `VIR SEPA ACME CONSEIL ${inv.number}`, amountCents: eur(1200), direction: "in" });
    const before = JSON.stringify(w.ledger);
    const [best] = suggestMatches(w.ledger, w.ctx, tx);
    assert.equal(JSON.stringify(w.ledger), before);
    assert.equal(best?.documentId, inv.id);
    assert.equal(best?.confidence, "high");
    assert.equal(best?.resultingStatus, "paid");
    assert.ok(best!.reasons.length >= 2);
  });
  it("une correspondance approximative est proposée avec ses avertissements, jamais imposée", () => {
    const w = world();
    const inv = openInv(w, 1200);
    const tx = addTransaction(w.ledger, w.ctx, { accountId: "acc_orgA", date: "2026-06-10", label: "VIR SEPA ACME", amountCents: eur(500), direction: "in" });
    const [s] = suggestMatches(w.ledger, w.ctx, tx);
    assert.equal(s?.documentId, inv.id);
    assert.equal(s?.resultingStatus, "partially_paid");
    assert.ok(s!.warnings.length > 0);
    assert.equal(w.ledger.payments.length, 0);
    assert.equal(reconciliationStatus(w.ledger, tx), "unmatched");
  });
  it("confirmer crée un paiement unique rattaché ; défaire le rapprochement annule ce paiement", () => {
    const w = world();
    const inv = openInv(w, 1200);
    const tx = addTransaction(w.ledger, w.ctx, { accountId: "acc_orgA", date: "2026-06-10", label: "VIR ACME", amountCents: eur(1200), direction: "in" });
    const m = confirmMatch(w.ledger, w.ctx, { transactionId: tx.id, documentType: "sales_invoice", documentId: inv.id });
    assert.equal(invoiceView(w.ledger, inv, TODAY).displayStatus, "paid");
    assert.equal(reconciliationStatus(w.ledger, tx), "matched");
    assert.equal(w.ledger.payments.length, 1);
    undoMatch(w.ledger, w.ctx, m.id);
    assert.equal(invoiceView(w.ledger, inv, TODAY).balanceCents, eur(1200));
    assert.equal(allocatedCents(w.ledger, tx.id), 0);
  });
  it("une transaction ne peut pas être affectée deux fois (double allocation refusée)", () => {
    const w = world();
    const a = openInv(w, 1000);
    const b = openInv(w, 1000, "c2_orgA");
    const tx = addTransaction(w.ledger, w.ctx, { accountId: "acc_orgA", date: "2026-06-10", label: "VIR", amountCents: eur(1000), direction: "in" });
    confirmMatch(w.ledger, w.ctx, { transactionId: tx.id, documentType: "sales_invoice", documentId: a.id });
    assert.throws(() => confirmMatch(w.ledger, w.ctx, { transactionId: tx.id, documentType: "sales_invoice", documentId: b.id }), (e: unknown) => e instanceof DomainError && e.code === "DOUBLE_ALLOCATION");
  });
  it("rattacher une transaction à un paiement déjà déclaré ne le compte pas deux fois", () => {
    const w = world();
    const inv = openInv(w, 1000);
    const { payment } = recordPayment(w.ledger, w.ctx, { documentType: "sales_invoice", documentId: inv.id, amountCents: eur(1000), date: "2026-06-08", method: "check" });
    const tx = addTransaction(w.ledger, w.ctx, { accountId: "acc_orgA", date: "2026-06-10", label: "REMISE CHEQUE ACME", amountCents: eur(1000), direction: "in" });
    const [s] = suggestMatches(w.ledger, w.ctx, tx);
    assert.equal(s?.paymentId, payment.id);
    confirmMatch(w.ledger, w.ctx, { transactionId: tx.id, documentType: "sales_invoice", documentId: inv.id, paymentId: payment.id });
    assert.equal(w.ledger.payments.filter((p) => !p.voidedAt).length, 1);
    assert.equal(invoiceView(w.ledger, inv, TODAY).paidCents, eur(1000));
  });
  it("gère les paiements partiels et refuse un sens incohérent", () => {
    const w = world();
    const inv = openInv(w, 1000);
    const part = addTransaction(w.ledger, w.ctx, { accountId: "acc_orgA", date: "2026-06-10", label: "ACOMPTE", amountCents: eur(300), direction: "in" });
    confirmMatch(w.ledger, w.ctx, { transactionId: part.id, documentType: "sales_invoice", documentId: inv.id });
    assert.equal(invoiceView(w.ledger, inv, TODAY).displayStatus, "partially_paid");
    const out = addTransaction(w.ledger, w.ctx, { accountId: "acc_orgA", date: "2026-06-11", label: "SORTIE", amountCents: eur(700), direction: "out" });
    assert.throws(() => confirmMatch(w.ledger, w.ctx, { transactionId: out.id, documentType: "sales_invoice", documentId: inv.id }), (e: unknown) => e instanceof DomainError && e.code === "WRONG_DIRECTION");
  });
});
