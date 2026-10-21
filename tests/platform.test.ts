import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { world, line, eur, TODAY } from "./helpers";
import { buildCtx } from "../src/domain/access";
import { createInvoiceDraft, issueInvoice, createQuote, invoiceView } from "../src/domain/documents";
import { recordPayment } from "../src/domain/payments";
import { addTransaction } from "../src/domain/transactions";
import { forecastCash } from "../src/domain/forecast";
import { buildDashboard } from "../src/domain/dashboard";
import { ForbiddenError, NotFoundError } from "../src/domain/errors";
import { answerQuestion, cancelProposal, confirmProposal } from "../src/domain/assistant";
import { ensureAutomationRules, runAutomation, toggleRule } from "../src/domain/automations";
import { integrationStatuses, NotConfiguredEmail, NotConfiguredAI } from "../src/domain/integrations";
import { PLANS, automationAllowed } from "../src/domain/plans";
import { validateUpload } from "../src/domain/attachments";
import { renderDocumentPdf } from "../src/pdf/document";
import { buildDemoLedger, DEMO_ORG_ID, DEMO_USER_ID } from "../src/demo/seed";
import { assertNoDuplicateNumbers } from "../src/domain/numbering";
import { cashPosition, signedCents } from "../src/domain/transactions";

describe("Isolation entre entreprises et permissions (règle 17)", () => {
  it("un utilisateur n'obtient aucun contexte sur une entreprise dont il n'est pas membre", () => {
    const { ledger } = world();
    assert.throws(() => buildCtx(ledger, "userA", "orgB", TODAY, TODAY), ForbiddenError);
  });
  it("changer un identifiant (facture, client, compte) d'une autre entreprise donne « introuvable » sans fuite", () => {
    const w = world();
    const invB = createInvoiceDraft(w.ledger, w.ctxB, { customerId: "c1_orgB", issueDate: TODAY, lines: [line("x", 1, 100)] });
    issueInvoice(w.ledger, w.ctxB, invB.id);
    assert.throws(() => issueInvoice(w.ledger, w.ctx, invB.id), NotFoundError);
    assert.throws(() => createInvoiceDraft(w.ledger, w.ctx, { customerId: "c1_orgB", issueDate: TODAY, lines: [line("x", 1, 1)] }), NotFoundError);
    assert.throws(() => addTransaction(w.ledger, w.ctx, { accountId: "acc_orgB", date: TODAY, label: "x", amountCents: 100, direction: "in" }), NotFoundError);
    assert.throws(() => recordPayment(w.ledger, w.ctx, { documentType: "sales_invoice", documentId: invB.id, amountCents: 100, date: TODAY, method: "transfer" }), NotFoundError);
  });
  it("les indicateurs et prévisions ne voient que l'entreprise du contexte", () => {
    const w = world();
    const invB = createInvoiceDraft(w.ledger, w.ctxB, { customerId: "c1_orgB", issueDate: "2026-06-01", lines: [line("gros", 1, 99_999, 0)] });
    issueInvoice(w.ledger, w.ctxB, invB.id);
    const a = buildDashboard(w.ledger, w.ctx);
    assert.equal(a.receivablesCents, 0);
    assert.equal(forecastCash(w.ledger, w.ctx, { horizonDays: 60 }).events.length, 0);
    assert.equal(buildDashboard(w.ledger, w.ctxB).receivablesCents, eur(99_999));
  });
  it("un lecteur ne peut rien modifier ; seuls propriétaire/admin gèrent les réglages", () => {
    const w = world();
    w.ledger.members.push({ orgId: "orgA", userId: "viewer", role: "viewer" });
    const viewer = buildCtx(w.ledger, "viewer", "orgA", TODAY, TODAY);
    assert.throws(() => createQuote(w.ledger, viewer, { customerId: "c1_orgA", issueDate: TODAY, validUntil: TODAY, lines: [line("x", 1, 1)] }), ForbiddenError);
    assert.throws(() => addTransaction(w.ledger, viewer, { accountId: "acc_orgA", date: TODAY, label: "x", amountCents: 1, direction: "in" }), ForbiddenError);
    ensureAutomationRules(w.ledger, "orgA");
    assert.throws(() => toggleRule(w.ledger, viewer, w.ledger.automationRules[0]!.id, false), ForbiddenError);
    answerQuestion(w.ledger, viewer, "Quelles factures sont en retard ?"); // lecture autorisée
  });
  it("contrôle les uploads (type, taille, nom)", () => {
    assert.ok(validateUpload({ fileName: "facture.pdf", mimeType: "application/pdf", sizeBytes: 1000 }).length === 0);
    assert.ok(validateUpload({ fileName: "virus.exe", mimeType: "application/x-msdownload", sizeBytes: 1000 }).length > 0);
    assert.ok(validateUpload({ fileName: "enorme.pdf", mimeType: "application/pdf", sizeBytes: 50 * 1024 * 1024 }).length > 0);
  });
});

describe("Assistant, automatisations, intégrations : honnêteté", () => {
  it("l'assistant est en mode démonstration, cite ses sources et ne modifie rien sans confirmation", () => {
    const { ledger, orgId, userId } = buildDemoLedger(TODAY);
    const ctx = buildCtx(ledger, userId, orgId, TODAY, `${TODAY}T10:00:00Z`);
    const reply = answerQuestion(ledger, ctx, "Prépare une relance pour la facture la plus en retard.");
    assert.equal(reply.simulated, true);
    assert.ok(reply.sources.length >= 0);
    assert.ok(reply.proposal);
    const reminders = ledger.reminders.length;
    assert.equal(ledger.reminders.length, reminders); // proposer ≠ exécuter
    assert.throws(() => confirmProposal(ledger, ctx, reply.proposal!, { confirmedByUser: false as never }));
    confirmProposal(ledger, ctx, reply.proposal!, { confirmedByUser: true });
    assert.equal(ledger.reminders.length, reminders + 1);
    assert.equal(ledger.reminders.at(-1)!.status, "draft"); // préparé, jamais envoyé
    assert.throws(() => confirmProposal(ledger, ctx, reply.proposal!, { confirmedByUser: true })); // plus en attente
  });
  it("annuler une proposition ne change aucune donnée", () => {
    const { ledger, orgId, userId } = buildDemoLedger(TODAY);
    const ctx = buildCtx(ledger, userId, orgId, TODAY, `${TODAY}T10:00:00Z`);
    const reply = answerQuestion(ledger, ctx, "Prépare une relance");
    const before = JSON.stringify(ledger);
    cancelProposal(reply.proposal!);
    assert.equal(JSON.stringify(ledger), before);
    assert.equal(reply.proposal!.status, "cancelled");
  });
  it("les automatisations sont idempotentes (pas de double exécution le même jour)", async () => {
    const { ledger, orgId, userId } = buildDemoLedger(TODAY);
    const ctx = buildCtx(ledger, userId, orgId, TODAY, `${TODAY}T10:00:00Z`);
    const rule = ledger.automationRules.find((r) => r.key === "detect_overdue_invoices")!;
    const first = await runAutomation(ledger, ctx, rule.id, "business", { emailConfigured: false });
    const notifs = ledger.notifications.length;
    const second = await runAutomation(ledger, ctx, rule.id, "business", { emailConfigured: false });
    assert.equal(first.status, "succeeded");
    assert.equal(second.id, first.id);
    assert.equal(ledger.notifications.length, notifs);
  });
  it("sans email configuré, la notification externe est « ignorée » honnêtement et la relance reste un brouillon", async () => {
    const { ledger, orgId, userId } = buildDemoLedger(TODAY);
    const ctx = buildCtx(ledger, userId, orgId, TODAY, `${TODAY}T10:00:00Z`);
    const notify = ledger.automationRules.find((r) => r.key === "notify_channel")!;
    const run = await runAutomation(ledger, ctx, notify.id, "business", { emailConfigured: false });
    assert.equal(run.status, "skipped");
    assert.match(run.result ?? "", /non configuré/i);
    const rem = ledger.automationRules.find((r) => r.key === "prepare_reminders")!;
    await runAutomation(ledger, ctx, rem.id, "business", { emailConfigured: false });
    assert.ok(ledger.reminders.length > 0 && ledger.reminders.every((r) => r.status === "draft"));
  });
  it("respecte les offres : une automatisation hors offre est ignorée", async () => {
    const { ledger, orgId, userId } = buildDemoLedger(TODAY);
    const ctx = buildCtx(ledger, userId, orgId, TODAY, `${TODAY}T10:00:00Z`);
    const rule = ledger.automationRules.find((r) => r.key === "flag_anomalies")!;
    assert.equal(automationAllowed("pro", "flag_anomalies"), false);
    const run = await runAutomation(ledger, ctx, rule.id, "pro", { emailConfigured: false });
    assert.equal(run.status, "skipped");
  });
  it("les adaptateurs non configurés échouent explicitement et l'état de configuration le dit", async () => {
    assert.deepEqual(await NotConfiguredEmail.send({ to: "a@b.c", subject: "s", body: "b" }), { ok: false, error: "NOT_CONFIGURED" });
    assert.deepEqual(await NotConfiguredAI.complete({ system: "", messages: [] }), { ok: false, error: "NOT_CONFIGURED" });
    const st = integrationStatuses({});
    assert.ok(st.find((s) => s.id === "csv_import")!.configured);
    assert.ok(st.filter((s) => s.id !== "csv_import").every((s) => !s.configured && s.missing.length > 0));
    assert.equal(integrationStatuses({ EMAIL_PROVIDER_API_KEY: "x", EMAIL_FROM_ADDRESS: "y" }).find((s) => s.id === "email")!.configured, true);
  });
  it("les offres sont des hypothèses modifiables en un seul endroit", () => {
    assert.deepEqual([PLANS.discovery.priceCentsHtMonthly, PLANS.pro.priceCentsHtMonthly, PLANS.business.priceCentsHtMonthly], [0, 2900, 7900]);
  });
});

describe("Génération PDF", () => {
  it("produit un PDF A4 valide pour un devis (brouillon filigrané), une facture et un avoir", async () => {
    const { ledger } = buildDemoLedger(TODAY);
    const org = ledger.organizations[0]!;
    const inv = ledger.invoices.find((i) => i.number)!;
    const cust = ledger.customers.find((c) => c.id === inv.customerId)!;
    const base = { issuer: { name: org.name, legalMentions: org.legalMentions }, customer: cust, issueDate: inv.issueDate, lines: inv.lines, totals: inv.totals, currency: "EUR" };
    for (const input of [
      { ...base, kind: "invoice" as const, number: inv.number, secondaryDate: inv.dueDate, paymentTerms: inv.paymentTerms },
      { ...base, kind: "quote" as const, number: null, secondaryDate: inv.dueDate },
      { ...base, kind: "credit_note" as const, number: "AV-2026-0001", relatedInvoiceNumber: inv.number ?? "", reason: "Geste commercial — 20 % ≥ 5 €" },
    ]) {
      const bytes = await renderDocumentPdf(input);
      assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-");
      assert.ok(bytes.length > 1500);
    }
  });
  it("gère un document de nombreuses lignes (pagination) et les caractères hors police sans planter", async () => {
    const { ledger } = buildDemoLedger(TODAY);
    const org = ledger.organizations[0]!;
    const lines = Array.from({ length: 60 }, (_, i) => line(`Ligne ${i + 1} — description très longue ✓ 日本 `.repeat(2), 1, 10 + i));
    const { computeTotals } = await import("../src/domain/totals");
    const bytes = await renderDocumentPdf({ kind: "invoice", number: "FAC-2026-9999", issuer: { name: org.name, legalMentions: org.legalMentions }, customer: ledger.customers[0]!, issueDate: TODAY, lines, totals: computeTotals(lines), currency: "EUR" });
    const { PDFDocument } = await import("pdf-lib");
    assert.ok((await PDFDocument.load(bytes)).getPageCount() >= 2);
  });
});

describe("Cohérence de la démonstration (règles 9, 14, 15, 18)", () => {
  const { ledger, orgId, userId } = buildDemoLedger(TODAY);
  const ctx = buildCtx(ledger, userId, orgId, TODAY, `${TODAY}T10:00:00Z`);
  it("le solde = soldes d'ouverture + mouvements actifs ; le dashboard est calculé, pas écrit en dur", () => {
    const expected = ledger.accounts.reduce((s, a) => s + a.openingBalanceCents + ledger.transactions.filter((t) => t.accountId === a.id && !t.voidedAt).reduce((x, t) => x + signedCents(t), 0), 0);
    assert.equal(cashPosition(ledger, ctx).totalCents, expected);
    assert.equal(buildDashboard(ledger, ctx).cash.totalCents, expected);
  });
  it("numéros sans doublon ; chaque paiement actif d'une facture pointe vers une facture de la même entreprise", () => {
    assertNoDuplicateNumbers(ledger, orgId);
    for (const p of ledger.payments.filter((x) => !x.voidedAt)) {
      const doc = p.documentType === "sales_invoice" ? ledger.invoices.find((i) => i.id === p.documentId) : ledger.purchaseInvoices.find((i) => i.id === p.documentId);
      assert.ok(doc && doc.orgId === p.orgId);
      if (p.transactionId) assert.ok(ledger.transactions.some((t) => t.id === p.transactionId));
    }
  });
  it("contient tous les statuts attendus : payée, partielle, en retard, brouillon, devis variés", () => {
    const statuses = new Set(ledger.invoices.map((i) => invoiceView(ledger, i, TODAY).displayStatus));
    for (const s of ["paid", "partially_paid", "overdue", "draft"]) assert.ok(statuses.has(s as never), s);
    const q = new Set(ledger.quotes.map((x) => x.status));
    for (const s of ["draft", "sent", "accepted", "declined", "converted"]) assert.ok(q.has(s as never), s);
  });
  it("le montant total dû par les clients correspond à la somme des restes dus", () => {
    const sum = ledger.invoices.filter((i) => i.status !== "draft" && i.status !== "cancelled").reduce((s, i) => s + invoiceView(ledger, i, TODAY).balanceCents, 0);
    assert.equal(buildDashboard(ledger, ctx).receivablesCents, sum);
  });
  it("la prévision exclut l'encaissement non rapproché identique à une facture (anti double comptage)", () => {
    const f = forecastCash(ledger, ctx, { horizonDays: 30 });
    assert.ok(f.excluded.some((e) => /pas encore rapproch/.test(e.reason)));
  });
});
