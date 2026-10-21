import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { world, line, eur, TODAY } from "./helpers";
import { createInvoiceDraft, issueInvoice, invoiceView } from "../src/domain/documents";
import { recordPayment } from "../src/domain/payments";
import { approvePurchaseInvoice, createExpense, createPurchaseInvoice, purchaseView, expenseState } from "../src/domain/purchases";
import { addTransaction, cashPosition } from "../src/domain/transactions";
import { aggregateSeries, forecastCash, simulate } from "../src/domain/forecast";
import { cloneLedger } from "../src/domain/ledger";
import { addDays } from "../src/domain/dates";

function openInvoice(w: ReturnType<typeof world>, amountHt: number, issue: string) {
  const inv = createInvoiceDraft(w.ledger, w.ctx, { customerId: "c1_orgA", issueDate: issue, lines: [line("Prestation", 1, amountHt, 0)] });
  issueInvoice(w.ledger, w.ctx, inv.id);
  return inv;
}

describe("Trésorerie réelle vs prévue (règles 5, 6, 9, 10)", () => {
  it("le solde dépend du solde d'ouverture et des seuls mouvements enregistrés", () => {
    const w = world();
    addTransaction(w.ledger, w.ctx, { accountId: "acc_orgA", date: "2026-06-01", label: "Entrée", amountCents: eur(250), direction: "in" });
    addTransaction(w.ledger, w.ctx, { accountId: "acc_orgA", date: "2026-06-02", label: "Sortie", amountCents: eur(100), direction: "out" });
    assert.equal(cashPosition(w.ledger, w.ctx).totalCents, eur(10_000) + eur(150));
  });
  it("un paiement avec compte crée UN mouvement ; un paiement déclaré sans mouvement ne touche pas la trésorerie", () => {
    const w = world();
    const inv = openInvoice(w, 1000, "2026-06-01");
    recordPayment(w.ledger, w.ctx, { documentType: "sales_invoice", documentId: inv.id, amountCents: eur(400), date: "2026-06-05", method: "check" }); // déclaré
    assert.equal(cashPosition(w.ledger, w.ctx).totalCents, eur(10_000));
    assert.equal(invoiceView(w.ledger, inv, TODAY).balanceCents, eur(600));
    recordPayment(w.ledger, w.ctx, { documentType: "sales_invoice", documentId: inv.id, amountCents: eur(600), date: "2026-06-06", method: "transfer", accountId: "acc_orgA" });
    assert.equal(w.ledger.transactions.length, 1);
    assert.equal(cashPosition(w.ledger, w.ctx).totalCents, eur(10_600));
  });
  it("une facture fournisseur à payer ne réduit pas la trésorerie réelle mais figure dans la prévision", () => {
    const w = world();
    const p = createPurchaseInvoice(w.ledger, w.ctx, { supplierId: "s1_orgA", reference: "F-1", issueDate: "2026-06-10", dueDate: addDays(TODAY, 10), netHtCents: eur(1000), vatCents: eur(200) });
    approvePurchaseInvoice(w.ledger, w.ctx, p.id);
    assert.equal(cashPosition(w.ledger, w.ctx).totalCents, eur(10_000));
    const f = forecastCash(w.ledger, w.ctx, { horizonDays: 30 });
    assert.ok(f.events.some((e) => e.kind === "purchase_invoice" && e.amountCents === -eur(1200)));
    assert.equal(f.endBalanceCents, eur(10_000) - eur(1200));
  });
  it("un paiement fournisseur est un décaissement réel unique ; la facture n'est plus prévue ensuite (pas de double comptage)", () => {
    const w = world();
    const p = createPurchaseInvoice(w.ledger, w.ctx, { supplierId: "s1_orgA", reference: "F-2", issueDate: "2026-06-10", dueDate: addDays(TODAY, 5), netHtCents: eur(500), vatCents: 0 });
    approvePurchaseInvoice(w.ledger, w.ctx, p.id);
    recordPayment(w.ledger, w.ctx, { documentType: "purchase_invoice", documentId: p.id, amountCents: eur(500), date: TODAY, method: "transfer", accountId: "acc_orgA" });
    assert.equal(purchaseView(w.ledger, p, TODAY).displayStatus, "paid");
    const f = forecastCash(w.ledger, w.ctx, { horizonDays: 30 });
    assert.equal(f.events.filter((e) => e.sourceId === p.id).length, 0);
    assert.equal(f.endBalanceCents, eur(10_000) - eur(500));
  });
  it("distingue dépense engagée, payée et portée par une facture fournisseur", () => {
    const w = world();
    const e = createExpense(w.ledger, w.ctx, { date: TODAY, label: "Abonnement", amountCents: eur(30), paymentMethod: "card" });
    assert.equal(expenseState(e), "committed");
    const p = createPurchaseInvoice(w.ledger, w.ctx, { supplierId: "s1_orgA", reference: "F-3", issueDate: TODAY, dueDate: addDays(TODAY, 10), netHtCents: eur(100), vatCents: 0 });
    const e2 = createExpense(w.ledger, w.ctx, { date: TODAY, label: "Même achat", amountCents: eur(100), paymentMethod: "transfer", purchaseInvoiceId: p.id });
    assert.equal(expenseState(e2), "covered_by_invoice");
  });
});

describe("Prévision de trésorerie (règles 10 et 11)", () => {
  it("formule : départ + entrées prévues − sorties prévues, et la série est cohérente avec les événements", () => {
    const w = world();
    const inv = openInvoice(w, 2000, addDays(TODAY, -10)); // échéance dans 20 jours
    const p = createPurchaseInvoice(w.ledger, w.ctx, { supplierId: "s1_orgA", reference: "F-4", issueDate: TODAY, dueDate: addDays(TODAY, 3), netHtCents: eur(700), vatCents: 0 });
    approvePurchaseInvoice(w.ledger, w.ctx, p.id);
    const f = forecastCash(w.ledger, w.ctx, { horizonDays: 60, scenario: "central" });
    assert.equal(f.endBalanceCents, f.startingCashCents + f.totalInCents - f.totalOutCents);
    assert.ok(f.events.some((e) => e.sourceId === inv.id));
    const daily = f.series.reduce((s, d) => s + d.inCents - d.outCents, 0);
    assert.equal(f.startingCashCents + daily, f.endBalanceCents);
  });
  it("une facture payée n'est plus comptée comme encaissement attendu", () => {
    const w = world();
    const inv = openInvoice(w, 2000, addDays(TODAY, -10));
    const before = forecastCash(w.ledger, w.ctx, { horizonDays: 60 });
    assert.ok(before.events.some((e) => e.sourceId === inv.id));
    recordPayment(w.ledger, w.ctx, { documentType: "sales_invoice", documentId: inv.id, amountCents: eur(2000), date: TODAY, method: "transfer", accountId: "acc_orgA" });
    const after = forecastCash(w.ledger, w.ctx, { horizonDays: 60 });
    assert.equal(after.events.filter((e) => e.sourceId === inv.id).length, 0);
    assert.equal(after.endBalanceCents, eur(10_000) + eur(2000)); // compté une seule fois
  });
  it("un paiement partiel ne prévoit que le reste dû", () => {
    const w = world();
    const inv = openInvoice(w, 2000, addDays(TODAY, -10));
    recordPayment(w.ledger, w.ctx, { documentType: "sales_invoice", documentId: inv.id, amountCents: eur(500), date: TODAY, method: "transfer", accountId: "acc_orgA" });
    const f = forecastCash(w.ledger, w.ctx, { horizonDays: 60 });
    const ev = f.events.find((e) => e.sourceId === inv.id);
    assert.equal(ev?.amountCents, eur(1500));
  });
  it("les scénarios sont ordonnés : prudent ≤ central ≤ favorable", () => {
    const w = world();
    openInvoice(w, 3000, addDays(TODAY, -40));
    w.ledger.recurring.push({ id: "r1", orgId: "orgA", label: "Missions", direction: "in", amountCents: eur(1000), interval: "monthly", nextDate: addDays(TODAY, 10), confidence: "uncertain" });
    const [a, b, c] = (["prudent", "central", "favorable"] as const).map((s) => forecastCash(w.ledger, w.ctx, { horizonDays: 60, scenario: s }).endBalanceCents);
    assert.ok(a! <= b! && b! <= c!, `${a} ≤ ${b} ≤ ${c}`);
  });
  it("une simulation ne modifie JAMAIS les données réelles (règle 11)", () => {
    const w = world();
    const inv = openInvoice(w, 4000, addDays(TODAY, -5));
    const snapshot = JSON.stringify(cloneLedger(w.ledger));
    const r = simulate(w.ledger, w.ctx, {
      horizonDays: 60,
      assumptions: [
        { type: "delay_invoice", invoiceId: inv.id, days: 15 },
        { type: "one_off_expense", date: addDays(TODAY, 4), amountCents: eur(3000), label: "Matériel" },
        { type: "investment", date: addDays(TODAY, 8), amountCents: eur(2000), label: "Machine" },
      ],
    });
    assert.equal(JSON.stringify(w.ledger), snapshot);
    assert.equal(r.simulated.simulated, true);
    assert.ok(r.deltaEndCents < 0);
  });
  it("retarder une facture de 15 jours décale l'encaissement prévu de 15 jours", () => {
    const w = world();
    const inv = openInvoice(w, 4000, addDays(TODAY, -5)); // échéance J+25
    const base = forecastCash(w.ledger, w.ctx, { horizonDays: 90 }).events.find((e) => e.sourceId === inv.id)!;
    const delayed = forecastCash(w.ledger, w.ctx, { horizonDays: 90, assumptions: [{ type: "delay_invoice", invoiceId: inv.id, days: 15 }] }).events.find((e) => e.sourceId === inv.id)!;
    assert.equal(delayed.date, addDays(base.date, 15));
  });
  it("alerte de trésorerie négative avec ses opérations d'origine, et prévient quand les données sont incomplètes", () => {
    const w = world();
    const p = createPurchaseInvoice(w.ledger, w.ctx, { supplierId: "s1_orgA", reference: "BIG", issueDate: TODAY, dueDate: addDays(TODAY, 5), netHtCents: eur(15_000), vatCents: 0 });
    approvePurchaseInvoice(w.ledger, w.ctx, p.id);
    const f = forecastCash(w.ledger, w.ctx, { horizonDays: 30 });
    const neg = f.alerts.find((a) => a.kind === "negative_cash");
    assert.ok(neg);
    assert.ok(neg.evidence.length > 0);
    assert.equal(f.completeness.isComplete, false);
    assert.ok(f.completeness.warnings.length > 0);
  });
  it("agrège par semaine sans perdre de montants", () => {
    const w = world();
    openInvoice(w, 1000, addDays(TODAY, -20));
    const f = forecastCash(w.ledger, w.ctx, { horizonDays: 28 });
    const weeks = aggregateSeries(f.series, f.startingCashCents, "week");
    assert.equal(weeks.length, 4);
    assert.equal(weeks[weeks.length - 1]!.closingCents, f.endBalanceCents);
  });
});
