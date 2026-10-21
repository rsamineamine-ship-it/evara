/**
 * Données de DÉMONSTRATION d'EVARA — entreprise, clients et montants entièrement FICTIFS.
 *
 * Tout est construit en appelant les services métier (jamais en écrivant des totaux à la main) :
 * les soldes, restes dus, retards et prévisions du dashboard découlent donc des mêmes règles que
 * pour une vraie entreprise. Les dates sont relatives à `today` pour que la démo reste vivante.
 */
import { buildCtx, type Ctx } from "../domain/access";
import { addDays, type ISODate } from "../domain/dates";
import {
  convertQuoteToInvoice, createCreditNote, createInvoiceDraft, createQuote, decideQuote, issueInvoice, markInvoiceSent,
  markQuoteSent, newLine,
} from "../domain/documents";
import { ensureAutomationRules } from "../domain/automations";
import { confirmMatch, recordPayment } from "../domain/payments";
import { approvePurchaseInvoice, createExpense, createPurchaseInvoice, disputePurchaseInvoice } from "../domain/purchases";
import { addTransaction } from "../domain/transactions";
import { emptyLedger } from "../domain/ledger";
import type { Cents } from "../domain/money";
import type { Category, Customer, DocumentLine, Id, Ledger, PaymentTerms, Supplier } from "../domain/types";

export const DEMO_ORG_ID = "org_demo";
export const DEMO_USER_ID = "usr_demo";
export const DEMO_ACCOUNT_ID = "acc_demo_main";
export const DEMO_ORG_NAME = "Atelier Lumen (démo)";

export interface DemoSeed {
  ledger: Ledger;
  orgId: Id;
  userId: Id;
}

const net = (days: number): PaymentTerms => ({ kind: "net", days });
const eur = (n: number): Cents => Math.round(n * 100);

export function buildDemoLedger(today: ISODate): DemoSeed {
  const ledger = emptyLedger();
  const orgId = DEMO_ORG_ID;
  const userId = DEMO_USER_ID;
  const d = (offset: number) => addDays(today, offset);
  const nowAt = (date: ISODate) => `${date}T09:00:00.000Z`;

  /* ----------------------------- Entreprise ----------------------------- */
  ledger.organizations.push({
    orgId,
    name: DEMO_ORG_NAME,
    currency: "EUR",
    locale: "fr-FR",
    timeZone: "Europe/Paris",
    vatRatesBp: [2000, 1000, 550, 0],
    defaultPaymentTerms: net(30),
    minimumCashThresholdCents: eur(5000),
    legalMentions: "Atelier Lumen SAS (société fictive de démonstration) — capital de 10 000 € — SIREN 000 000 000. Pénalité de retard : 3 fois le taux d'intérêt légal ; indemnité forfaitaire de recouvrement : 40 €.",
    documentPrefixes: { quote: "DEV", invoice: "FAC", credit_note: "AV" },
    plan: "business",
  });
  ledger.members.push({ orgId, userId, role: "owner" });

  const ctxAt = (date: ISODate): Ctx => buildCtx(ledger, userId, orgId, today, nowAt(date));
  const ctxToday = ctxAt(today);

  /* ----------------------------- Catégories ----------------------------- */
  const catNames: [string, Category["kind"]][] = [
    ["Abonnements logiciels", "expense"], ["Télécommunications", "expense"], ["Déplacements", "expense"], ["Assurance", "expense"],
    ["Frais bancaires", "expense"], ["Impôts et cotisations", "expense"], ["Loyer et locaux", "expense"], ["Sous-traitance", "expense"],
    ["Matériel", "expense"], ["Divers", "expense"], ["Ventes de services", "income"],
  ];
  const cat: Record<string, Id> = {};
  catNames.forEach(([name, kind], i) => {
    const id = `cat_demo_${i + 1}`;
    cat[name] = id;
    ledger.categories.push({ id, orgId, name, kind });
  });

  /* ----------------------------- Compte ----------------------------- */
  ledger.accounts.push({
    id: DEMO_ACCOUNT_ID, orgId, name: "Compte courant (démo)", type: "bank", currency: "EUR",
    openingBalanceCents: eur(18_500), openingDate: d(-120), openingSource: "user_entered",
  });
  ledger.accounts.push({
    id: "acc_demo_cash", orgId, name: "Caisse (démo)", type: "cash", currency: "EUR",
    openingBalanceCents: eur(300), openingDate: d(-120), openingSource: "user_entered",
  });

  /* ----------------------- Clients et fournisseurs ----------------------- */
  const mkParty = (id: string, name: string, company: string, email: string, city: string, terms: PaymentTerms): Customer => ({
    id, orgId, name, company, email, defaultPaymentTerms: terms, createdAt: nowAt(d(-130)),
    address: { line1: "1 rue de la Démonstration", postalCode: "75000", city, country: "FR" },
  });
  const customers: Customer[] = [
    mkParty("cus_nordia", "Camille Roux", "Nordia Conseil", "compta@nordia.example", "Paris", net(30)),
    mkParty("cus_verdier", "Julien Verdier", "Maison Verdier", "julien@verdier.example", "Lyon", net(30)),
    mkParty("cus_helix", "Sonia Haddad", "Helix Logistique", "finance@helix.example", "Lille", net(45)),
    mkParty("cus_alba", "Marc Alba", "Studio Alba", "marc@studioalba.example", "Bordeaux", net(30)),
    mkParty("cus_kairos", "Inès Dupuis", "Kairos Santé", "ines.dupuis@kairos.example", "Nantes", net(30)),
    mkParty("cus_orbis", "Paul Girard", "Orbis Énergie", "paul.girard@orbis.example", "Toulouse", net(30)),
  ];
  ledger.customers.push(...customers);
  const suppliers: Supplier[] = [
    mkParty("sup_nuage", "Service client", "Nuage Hébergement", "factures@nuage.example", "Roubaix", net(30)),
    mkParty("sup_pivot", "Accueil", "Espace Cowork Pivot", "compta@pivot.example", "Paris", net(15)),
    mkParty("sup_horizon", "Gestion", "Mutuelle Horizon", "contrats@horizon.example", "Niort", net(30)),
    mkParty("sup_fibra", "Facturation", "Télécom Fibra", "factu@fibra.example", "Paris", net(30)),
    mkParty("sup_quanta", "Facturation", "Logiciels Quanta", "billing@quanta.example", "Dublin", net(30)),
    mkParty("sup_lea", "Léa Martin", "Léa Martin (indépendante)", "lea.martin@example.org", "Rennes", net(30)),
  ];
  ledger.suppliers.push(...suppliers);

  /* --------------------------- Aides internes --------------------------- */
  const line = (description: string, qty: number, unitEur: number, vatBp = 2000, discountBp = 0): DocumentLine =>
    newLine({ description, quantity: qty, unitPriceCents: eur(unitEur), vatRateBp: vatBp, discountBp });

  /** Crée, émet, marque « envoyée » (action réputée faite par l'utilisateur) et éventuellement paie une facture. */
  const invoice = (o: { customerId: Id; issueOffset: number; lines: DocumentLine[]; terms?: PaymentTerms; sent?: boolean; paid?: { offset: number; fraction?: number } | null; declared?: { offset: number; amount: Cents }; notes?: string }) => {
    const issue = d(o.issueOffset);
    const c = ctxAt(issue);
    const draft = createInvoiceDraft(ledger, c, { customerId: o.customerId, issueDate: issue, lines: o.lines, ...(o.terms ? { paymentTerms: o.terms } : {}), ...(o.notes ? { notes: o.notes } : {}) });
    issueInvoice(ledger, c, draft.id);
    if (o.sent !== false) markInvoiceSent(ledger, c, draft.id, { confirmedByUser: true, via: "manual" });
    if (o.paid) {
      const payDate = d(o.paid.offset);
      const total = draft.totals.totalTtcCents;
      const amount = o.paid.fraction ? Math.round(total * o.paid.fraction) : total;
      recordPayment(ledger, ctxAt(payDate), { documentType: "sales_invoice", documentId: draft.id, amountCents: amount, date: payDate, method: "transfer", accountId: DEMO_ACCOUNT_ID, isDeposit: !!o.paid.fraction && o.paid.fraction < 1 && false });
    }
    if (o.declared) {
      recordPayment(ledger, ctxAt(d(o.declared.offset)), { documentType: "sales_invoice", documentId: draft.id, amountCents: o.declared.amount, date: d(o.declared.offset), method: "check", note: "Chèque remis, pas encore encaissé en banque" });
    }
    return draft;
  };

  /* ----------------------- Factures clients (historique) ----------------------- */
  invoice({ customerId: "cus_nordia", issueOffset: -105, lines: [line("Refonte du site vitrine — design et intégration", 1, 4800)], paid: { offset: -70 } });
  invoice({ customerId: "cus_verdier", issueOffset: -95, lines: [line("Audit de la chaîne commerciale", 4, 600)], paid: { offset: -62 } });
  invoice({ customerId: "cus_helix", issueOffset: -88, terms: net(30), lines: [line("Développement plateforme — lot 1", 12, 500)], paid: { offset: -50 } });
  invoice({ customerId: "cus_nordia", issueOffset: -75, lines: [line("Contrat de maintenance — mois 1", 1, 1800)], paid: { offset: -68 } });
  invoice({ customerId: "cus_alba", issueOffset: -70, lines: [line("Identité visuelle — logotype et charte", 1, 3200)], paid: { offset: -38 } });
  invoice({ customerId: "cus_kairos", issueOffset: -60, lines: [line("Atelier de cadrage produit", 5, 1100)], paid: { offset: -22 } });
  invoice({ customerId: "cus_nordia", issueOffset: -45, lines: [line("Contrat de maintenance — mois 2", 1, 1800)], paid: { offset: -36 } });
  invoice({ customerId: "cus_orbis", issueOffset: -50, lines: [line("Formation équipes — 2 jours", 2, 900)], paid: { offset: -12 } });

  // Retards : un de 22 jours (attention), un de 45 jours (critique).
  const overdueVerdier = invoice({ customerId: "cus_verdier", issueOffset: -52, lines: [line("Développement module de devis en ligne", 6, 600)] });
  const overdueAlba = invoice({ customerId: "cus_alba", issueOffset: -75, lines: [line("Shooting photo produits", 1, 1450)] });

  // Paiement partiel : 50 % encaissé, le reste dû reste ouvert (échéance dans 5 jours, termes 45 jours).
  const partialHelix = invoice({ customerId: "cus_helix", issueOffset: -40, terms: net(45), lines: [line("Développement plateforme — lot 2", 15, 480)], paid: { offset: -5, fraction: 0.5 } });

  // À venir, non payées : ne sont PAS de l'argent disponible.
  invoice({ customerId: "cus_nordia", issueOffset: -15, lines: [line("Contrat de maintenance — mois 3", 1, 1800)] });
  invoice({ customerId: "cus_kairos", issueOffset: -12, lines: [line("Développement tableau de bord patients", 7, 520), line("Hébergement de recette", 1, 460, 2000, 1000)] });
  invoice({ customerId: "cus_orbis", issueOffset: -5, lines: [line("Intégration API de facturation", 4, 650)] });

  // Facture avec paiement DÉCLARÉ (chèque non encaissé) : réduit le reste dû, pas la trésorerie réelle.
  invoice({ customerId: "cus_alba", issueOffset: -26, lines: [line("Déclinaisons de supports print", 1, 980, 2000)], declared: { offset: -1, amount: eur(500) } });

  // Brouillon jamais émis.
  createInvoiceDraft(ledger, ctxToday, { customerId: "cus_nordia", issueDate: today, lines: [line("Évolution du site — phase 2 (brouillon)", 3, 700)] });

  // Un avoir partiel sur une facture émise (document spécifique relié à la facture d'origine).
  const creditedBase = invoice({ customerId: "cus_orbis", issueOffset: -18, lines: [line("Licence d'exploitation annuelle", 1, 1200), line("Support prioritaire", 1, 300)] });
  createCreditNote(ledger, ctxAt(d(-16)), creditedBase.id, { reason: "Geste commercial : remise de 20 % sur le support prioritaire", lines: [line("Support prioritaire — remise commerciale", 1, 60)] });

  /* ------------------------------- Devis ------------------------------- */
  const quote = (customerId: Id, issueOffset: number, validDays: number, lines: DocumentLine[], flow: "draft" | "sent" | "accepted" | "declined" | "converted", notes?: string) => {
    const issue = d(issueOffset);
    const c = ctxAt(issue);
    const q = createQuote(ledger, c, { customerId, issueDate: issue, validUntil: addDays(issue, validDays), lines, ...(notes ? { notes } : {}) });
    if (flow === "draft") return q;
    markQuoteSent(ledger, c, q.id, { confirmedByUser: true, via: "manual" });
    if (flow === "sent") return q;
    if (flow === "declined") decideQuote(ledger, ctxAt(addDays(issue, 6)), q.id, "declined");
    else decideQuote(ledger, ctxAt(addDays(issue, 4)), q.id, "accepted");
    if (flow === "converted") convertQuoteToInvoice(ledger, ctxAt(addDays(issue, 5)), q.id);
    return q;
  };
  quote("cus_helix", -2, 30, [line("Application mobile logistique — cadrage et maquettes", 8, 560)], "draft");
  quote("cus_kairos", -9, 30, [line("Module de prise de rendez-vous", 10, 540)], "sent", "Devis valable 30 jours. Acompte de 30 % à la commande.");
  quote("cus_orbis", -14, 30, [line("Refonte espace client", 14, 580)], "accepted");
  quote("cus_alba", -30, 30, [line("Site e-commerce — phase 1", 16, 520)], "declined");
  quote("cus_verdier", -50, 30, [line("Maintenance évolutive — 6 mois", 6, 750)], "sent"); // expiré (dérivé de la date)
  quote("cus_nordia", -20, 30, [line("Campagne de contenus — trimestre", 1, 2400)], "converted");

  /* ---------------------- Factures fournisseurs ---------------------- */
  const purchase = (supplierId: Id, ref: string, issueOffset: number, dueOffset: number, ht: number, vatBp: number, category: string, opts: { approve?: boolean; dispute?: string; paid?: { offset: number; fraction?: number } } = {}) => {
    const issue = d(issueOffset);
    const c = ctxAt(issue);
    const htC = eur(ht);
    const p = createPurchaseInvoice(ledger, c, { supplierId, reference: ref, issueDate: issue, dueDate: d(dueOffset), netHtCents: htC, vatCents: Math.round((htC * vatBp) / 10_000), categoryId: cat[category] ?? null });
    if (opts.dispute) disputePurchaseInvoice(ledger, c, p.id, opts.dispute);
    else if (opts.approve !== false) approvePurchaseInvoice(ledger, c, p.id);
    if (opts.paid) {
      const payDate = d(opts.paid.offset);
      const total = p.totalTtcCents;
      recordPayment(ledger, ctxAt(payDate), { documentType: "purchase_invoice", documentId: p.id, amountCents: opts.paid.fraction ? Math.round(total * opts.paid.fraction) : total, date: payDate, method: "transfer", accountId: DEMO_ACCOUNT_ID });
    }
    return p;
  };
  purchase("sup_lea", "LM-2026-021", -80, -50, 2400, 0, "Sous-traitance", { paid: { offset: -48 } });
  purchase("sup_lea", "LM-2026-022", -50, -20, 1800, 0, "Sous-traitance", { paid: { offset: -19 } });
  purchase("sup_nuage", "NH-90311", -62, -32, 310, 2000, "Abonnements logiciels", { paid: { offset: -30 } });
  purchase("sup_nuage", "NH-91208", -32, -2, 310, 2000, "Abonnements logiciels"); // en retard de 2 jours, non payée
  purchase("sup_lea", "LM-2026-024", -18, 12, 2100, 0, "Sous-traitance", { paid: { offset: -3, fraction: 0.4 } }); // partiellement payée
  purchase("sup_quanta", "QNT-77120", -4, 26, 840, 2000, "Abonnements logiciels", { approve: false }); // à vérifier
  purchase("sup_fibra", "FIB-554112", -40, -10, 189, 2000, "Télécommunications", { dispute: "Surfacturation constatée sur l'option internationale" });
  purchase("sup_horizon", "MH-T4-2026", -2, 5, 640, 0, "Assurance"); // à payer dans 5 jours

  /* ------------------------------ Dépenses ------------------------------ */
  const recurringExpense = (label: string, offsets: number[], amountEur: number, category: string, supplierId: Id, vatBp: number, withReceipt = true) => {
    offsets.forEach((off, idx) => {
      const date = d(off);
      const c = ctxAt(date);
      const amt = eur(amountEur);
      const att = withReceipt && idx < offsets.length - 1 ? `att_${label.slice(0, 4)}_${idx}` : null;
      if (att && !ledger.attachments.some((a) => a.id === att)) {
        ledger.attachments.push({ id: att, orgId, fileName: `justificatif-${idx + 1}.pdf`, mimeType: "application/pdf", sizeBytes: 54_000, storageKey: `demo/${att}`, createdAt: nowAt(date) });
      }
      const exp = createExpense(ledger, c, { date, label, amountCents: amt, vatCents: Math.round(amt - amt / (1 + vatBp / 10_000)), categoryId: cat[category] ?? null, supplierId, paymentMethod: "direct_debit", receiptAttachmentId: att });
      const tx = addTransaction(ledger, c, { accountId: DEMO_ACCOUNT_ID, date, label: `PRLV ${label.toUpperCase()}`, amountCents: amt, direction: "out", categoryId: cat[category] ?? null, counterparty: label, source: "csv" });
      // Les prélèvements anciens sont rapprochés ; le plus récent reste à rapprocher (démonstration du rapprochement).
      if (idx < offsets.length - 1) confirmMatch(ledger, ctxAt(date), { transactionId: tx.id, documentType: "expense", documentId: exp.id, origin: "manual" });
    });
  };
  recurringExpense("Espace Cowork Pivot", [-105, -75, -45, -15], 690, "Loyer et locaux", "sup_pivot", 2000);
  recurringExpense("Logiciels Quanta", [-100, -70, -40, -10], 49, "Abonnements logiciels", "sup_quanta", 2000);
  recurringExpense("Télécom Fibra", [-96, -66, -36, -6], 69.9, "Télécommunications", "sup_fibra", 2000);

  // Dépense unique, sans justificatif et inhabituelle pour sa catégorie (≥ 2,5 × médiane) : alerte « dépense inhabituelle ».
  createExpense(ledger, ctxAt(d(-9)), { date: d(-9), label: "Licence annuelle suite de design", amountCents: eur(420), vatCents: eur(70), categoryId: cat["Abonnements logiciels"] ?? null, supplierId: "sup_quanta", paymentMethod: "card" });
  // Dépense sans justificatif (card).
  createExpense(ledger, ctxAt(d(-7)), { date: d(-7), label: "Déjeuner client Lyon", amountCents: eur(58), vatCents: eur(5.27), categoryId: cat["Déplacements"] ?? null, supplierId: null, paymentMethod: "card" });

  /* ------------------------ Mouvements bancaires libres ------------------------ */
  const free = (offset: number, label: string, amountEur: number, dir: "in" | "out", category: string | null, counterparty?: string, ref?: string) => {
    const date = d(offset);
    addTransaction(ledger, ctxAt(date), { accountId: DEMO_ACCOUNT_ID, date, label, amountCents: eur(amountEur), direction: dir, categoryId: category ? cat[category] ?? null : null, source: "csv", ...(counterparty ? { counterparty } : {}), ...(ref ? { externalRef: ref } : {}) });
  };
  free(-92, "FRAIS DE TENUE DE COMPTE", 14.5, "out", "Frais bancaires");
  free(-62, "FRAIS DE TENUE DE COMPTE", 14.5, "out", "Frais bancaires");
  free(-32, "FRAIS DE TENUE DE COMPTE", 14.5, "out", "Frais bancaires");
  free(-2, "FRAIS DE TENUE DE COMPTE", 14.5, "out", "Frais bancaires");
  free(-47, "URSSAF COTISATIONS T3", 1380, "out", "Impôts et cotisations", "URSSAF");
  free(-18, "SNCF BILLET PARIS-LYON", 94, "out", "Déplacements", "SNCF");
  // Encaissement identique à une facture en retard, NON rapproché : l'app propose le rapprochement,
  // et la prévision l'exclut pour éviter le double comptage.
  const verdierBalance = overdueVerdier.totals.totalTtcCents;
  addTransaction(ledger, ctxAt(d(-2)), { accountId: DEMO_ACCOUNT_ID, date: d(-2), label: `VIR SEPA MAISON VERDIER REGLEMENT ${overdueVerdier.number ?? ""}`, amountCents: verdierBalance, direction: "in", categoryId: cat["Ventes de services"] ?? null, counterparty: "Maison Verdier", source: "csv" });
  // Encaissement sans document identifiable.
  free(-1, "VIR SEPA KAIROS SANTE ACOMPTE PROJET", 1500, "in", "Ventes de services", "Kairos Santé");

  // Utilisée pour que les variables inutilisées ne soient pas élidées par un linter.
  void overdueAlba;
  void partialHelix;

  /* ------------------------ Charges / revenus récurrents ------------------------ */
  ledger.recurring.push(
    { id: "rec_pivot", orgId, label: "Espace Cowork Pivot", direction: "out", amountCents: eur(690), interval: "monthly", nextDate: d(15), confidence: "confirmed", categoryId: cat["Loyer et locaux"] ?? null, accountId: DEMO_ACCOUNT_ID },
    { id: "rec_quanta", orgId, label: "Logiciels Quanta", direction: "out", amountCents: eur(49), interval: "monthly", nextDate: d(20), confidence: "confirmed", categoryId: cat["Abonnements logiciels"] ?? null, accountId: DEMO_ACCOUNT_ID },
    { id: "rec_fibra", orgId, label: "Télécom Fibra", direction: "out", amountCents: eur(69.9), interval: "monthly", nextDate: d(24), confidence: "confirmed", categoryId: cat["Télécommunications"] ?? null, accountId: DEMO_ACCOUNT_ID },
    { id: "rec_urssaf", orgId, label: "URSSAF cotisations", direction: "out", amountCents: eur(1380), interval: "quarterly", nextDate: d(43), confidence: "expected", categoryId: cat["Impôts et cotisations"] ?? null, accountId: DEMO_ACCOUNT_ID },
    { id: "rec_missions", orgId, label: "Missions ponctuelles récurrentes (estimation)", direction: "in", amountCents: eur(1200), interval: "monthly", nextDate: d(28), confidence: "uncertain", categoryId: cat["Ventes de services"] ?? null, accountId: DEMO_ACCOUNT_ID },
  );

  ensureAutomationRules(ledger, orgId);
  ledger.notifications.push({ id: "ntf_welcome", orgId, kind: "info", title: "Bienvenue dans la démonstration EVARA", body: "Toutes les données sont fictives et stockées uniquement dans ce navigateur.", createdAt: nowAt(today) });

  return { ledger, orgId, userId };
}
