import type { Cents, CurrencyCode } from "./money";
import type { ISODate } from "./dates";

export type Id = string;
export type Role = "owner" | "admin" | "editor" | "viewer";

export type PaymentTerms =
  | { kind: "on_receipt" }
  | { kind: "net"; days: number }
  /** "N jours fin de mois" : échéance = fin du mois de (émission + N jours). */
  | { kind: "end_of_month"; days: number };

export interface DocumentLine {
  id: Id;
  description: string;
  /** Jusqu'à 3 décimales. */
  quantity: number;
  unitPriceCents: Cents;
  /** Taux de TVA en points de base : 2000 = 20 %. */
  vatRateBp: number;
  /** Remise de ligne en points de base : 1000 = 10 %. */
  discountBp: number;
}

export interface VatBreakdown {
  rateBp: number;
  baseCents: Cents;
  vatCents: Cents;
}

export interface Totals {
  /** Somme des lignes avant remises. */
  grossCents: Cents;
  discountCents: Cents;
  netHtCents: Cents;
  vatByRate: VatBreakdown[];
  vatCents: Cents;
  totalTtcCents: Cents;
}

export interface Address {
  line1: string;
  line2?: string;
  postalCode: string;
  city: string;
  country: string;
}

export interface Party {
  id: Id;
  orgId: Id;
  name: string;
  company?: string;
  email?: string;
  phone?: string;
  address?: Address;
  /** SIREN/SIRET ou équivalent. */
  companyId?: string;
  vatNumber?: string;
  defaultPaymentTerms: PaymentTerms;
  createdAt: string;
}
export type Customer = Party;
export type Supplier = Party;

/* ------------------------------ Devis ------------------------------ */

export type QuoteStatus = "draft" | "sent" | "viewed" | "accepted" | "declined" | "expired" | "converted";

export interface Quote {
  id: Id;
  orgId: Id;
  customerId: Id;
  /** Attribué à la sortie du brouillon. */
  number: string | null;
  status: QuoteStatus;
  currency: CurrencyCode;
  issueDate: ISODate;
  validUntil: ISODate;
  lines: DocumentLine[];
  documentDiscountBp: number;
  paymentTerms: PaymentTerms;
  notes?: string;
  totals: Totals;
  convertedInvoiceId: Id | null;
  sentAt?: string;
  acceptedAt?: string;
  declinedAt?: string;
  createdAt: string;
}

/* ------------------------- Factures clients ------------------------- */

/** Statut stocké. Le statut de paiement est DÉRIVÉ (voir invoices.ts). */
export type InvoiceStoredStatus = "draft" | "issued" | "sent" | "cancelled";

export interface SalesInvoice {
  id: Id;
  orgId: Id;
  customerId: Id;
  number: string | null;
  status: InvoiceStoredStatus;
  currency: CurrencyCode;
  issueDate: ISODate;
  dueDate: ISODate;
  lines: DocumentLine[];
  documentDiscountBp: number;
  paymentTerms: PaymentTerms;
  notes?: string;
  totals: Totals;
  quoteId: Id | null;
  /** Si cette facture remplace une facture corrigée (via avoir). */
  replacesInvoiceId: Id | null;
  issuedAt?: string;
  sentAt?: string;
  createdAt: string;
}

export interface CreditNote {
  id: Id;
  orgId: Id;
  invoiceId: Id;
  number: string;
  issueDate: ISODate;
  reason: string;
  currency: CurrencyCode;
  lines: DocumentLine[];
  documentDiscountBp: number;
  totals: Totals;
  createdAt: string;
}

/* ------------------------ Factures fournisseurs ------------------------ */

export type PurchaseStoredStatus = "to_review" | "approved" | "disputed";

export interface PurchaseInvoice {
  id: Id;
  orgId: Id;
  supplierId: Id;
  /** Référence portée par le fournisseur. */
  reference: string;
  status: PurchaseStoredStatus;
  currency: CurrencyCode;
  issueDate: ISODate;
  dueDate: ISODate;
  netHtCents: Cents;
  vatCents: Cents;
  totalTtcCents: Cents;
  categoryId: Id | null;
  attachmentId: Id | null;
  accountId?: Id | null;
  disputedReason?: string;
  createdAt: string;
}

/* ----------------------------- Dépenses ----------------------------- */

export interface Expense {
  id: Id;
  orgId: Id;
  date: ISODate;
  label: string;
  amountCents: Cents;
  vatCents: Cents;
  categoryId: Id | null;
  supplierId: Id | null;
  paymentMethod: "card" | "transfer" | "direct_debit" | "cash" | "other";
  receiptAttachmentId: Id | null;
  /** Une dépense est "engagée" tant qu'aucune sortie d'argent n'y est rattachée. */
  paidTransactionId: Id | null;
  /** Si la dépense est la contrepartie d'une facture fournisseur : on ne la compte qu'une fois (via la facture). */
  purchaseInvoiceId?: Id | null;
  recurringItemId?: Id | null;
  notes?: string;
  createdAt: string;
}

/* ----------------------- Comptes et transactions ----------------------- */

export interface FinancialAccount {
  id: Id;
  orgId: Id;
  name: string;
  type: "bank" | "cash" | "other";
  currency: CurrencyCode;
  openingBalanceCents: Cents;
  openingDate: ISODate;
  openingSource: "user_entered" | "imported";
}

export type Direction = "in" | "out";

export interface Transaction {
  id: Id;
  orgId: Id;
  accountId: Id;
  date: ISODate;
  label: string;
  /** Toujours positif ; le sens est porté par `direction`. */
  amountCents: Cents;
  direction: Direction;
  currency: CurrencyCode;
  categoryId: string | null;
  counterparty?: string;
  source: "manual" | "csv" | "payment";
  externalRef?: string;
  importId?: Id;
  /** Marqué par l'utilisateur comme virement interne ou sans lien avec une facture. */
  reconciliationIgnored?: boolean;
  /** Une transaction annulée n'est jamais supprimée : elle sort simplement des soldes. */
  voidedAt?: string;
  createdAt: string;
}

export interface Payment {
  id: Id;
  orgId: Id;
  documentType: "sales_invoice" | "purchase_invoice";
  documentId: Id;
  amountCents: Cents;
  date: ISODate;
  method: "transfer" | "card" | "check" | "cash" | "direct_debit" | "other";
  isDeposit: boolean;
  /** Mouvement d'argent confirmé qui supporte ce paiement ; null = paiement déclaré, non rattaché. */
  transactionId: Id | null;
  note?: string;
  voidedAt?: string;
  voidReason?: string;
  createdAt: string;
}

export interface ImportRecord {
  id: Id;
  orgId: Id;
  accountId: Id;
  fileName: string;
  totalRows: number;
  importedRows: number;
  rejectedRows: number;
  duplicateRowsSkipped: number;
  createdBy: Id;
  createdAt: string;
}

export interface AuditEntry {
  id: Id;
  orgId: Id;
  actorId: Id;
  action: string;
  entityType: string;
  entityId: Id;
  at: string;
  details?: Record<string, unknown>;
}

export interface Category {
  id: Id;
  orgId: Id;
  name: string;
  kind: "expense" | "income";
}

export interface RecurringItem {
  id: Id;
  orgId: Id;
  label: string;
  direction: Direction;
  amountCents: Cents;
  interval: "weekly" | "monthly" | "quarterly" | "yearly";
  nextDate: ISODate;
  endDate?: ISODate;
  /** Les revenus récurrents non contractuels doivent rester "uncertain". */
  confidence: "confirmed" | "expected" | "uncertain";
  categoryId?: string | null;
  accountId?: Id | null;
}

export interface OrgSettings {
  orgId: Id;
  name: string;
  currency: CurrencyCode;
  locale: string;
  timeZone: string;
  vatRatesBp: number[];
  defaultPaymentTerms: PaymentTerms;
  minimumCashThresholdCents: Cents;
  legalMentions: string;
  documentPrefixes: { quote: string; invoice: string; credit_note: string };
  plan?: "discovery" | "pro" | "business";
}

/* ------------------------- Rapprochement & divers ------------------------- */

/** Lien confirmé entre une transaction et un document. Source unique de vérité pour "montant affecté". */
export interface TransactionMatch {
  id: Id;
  orgId: Id;
  transactionId: Id;
  documentType: "sales_invoice" | "purchase_invoice" | "expense";
  documentId: Id;
  paymentId: Id | null;
  amountCents: Cents;
  origin: "suggested" | "manual" | "auto_payment";
  /** Vrai si le paiement a été créé par ce rapprochement (annuler le rapprochement annule alors le paiement). */
  createdPayment: boolean;
  confirmedBy: Id;
  confirmedAt: string;
  voidedAt?: string;
}

export interface Member {
  orgId: Id;
  userId: Id;
  role: Role;
}

export interface Attachment {
  id: Id;
  orgId: Id;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  /** Clé de stockage (jamais une URL publique). */
  storageKey: string;
  createdAt: string;
}

export interface Notification {
  id: Id;
  orgId: Id;
  kind: string;
  title: string;
  body: string;
  target?: { type: string; id: Id };
  createdAt: string;
  readAt?: string;
}

export interface ReminderDraft {
  id: Id;
  orgId: Id;
  invoiceId: Id;
  to: string;
  subject: string;
  body: string;
  /** "draft" = préparé, jamais envoyé automatiquement. */
  status: "draft" | "marked_sent" | "dismissed";
  createdAt: string;
}

export interface AutomationRule {
  id: Id;
  orgId: Id;
  key: AutomationKey;
  name: string;
  description: string;
  enabled: boolean;
  trigger: string;
  conditions: string;
  action: string;
  requiresHumanApproval: boolean;
  /** Canal externe nécessaire (ex. email) : si non configuré, l'action est préparée mais pas exécutée. */
  channel?: "email";
  minPlan: "discovery" | "pro" | "business";
}

export type AutomationKey =
  | "detect_overdue_invoices"
  | "prepare_reminders"
  | "notify_channel"
  | "supplier_due_alerts"
  | "flag_unmatched_transactions"
  | "detect_missing_receipts"
  | "detect_recurring_expenses"
  | "periodic_report"
  | "refresh_forecast"
  | "flag_anomalies";

export interface AutomationRun {
  id: Id;
  orgId: Id;
  ruleId: Id;
  /** Clé d'idempotence : une même clé ne s'exécute qu'une fois avec succès. */
  idempotencyKey: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "succeeded" | "failed" | "skipped";
  attempt: number;
  result?: string;
  error?: string;
  produced: number;
}

export interface ForecastSnapshot {
  id: Id;
  orgId: Id;
  takenOn: ISODate;
  targetDate: ISODate;
  scenario: "prudent" | "central" | "favorable";
  forecastCents: Cents;
}

export interface Ledger {
  organizations: OrgSettings[];
  members: Member[];
  customers: Customer[];
  suppliers: Supplier[];
  quotes: Quote[];
  invoices: SalesInvoice[];
  creditNotes: CreditNote[];
  purchaseInvoices: PurchaseInvoice[];
  expenses: Expense[];
  accounts: FinancialAccount[];
  transactions: Transaction[];
  payments: Payment[];
  matches: TransactionMatch[];
  imports: ImportRecord[];
  categories: Category[];
  recurring: RecurringItem[];
  attachments: Attachment[];
  notifications: Notification[];
  reminders: ReminderDraft[];
  automationRules: AutomationRule[];
  automationRuns: AutomationRun[];
  audit: AuditEntry[];
  forecastSnapshots: ForecastSnapshot[];
  /** Compteurs de numérotation : "orgId:kind:year" -> dernier numéro attribué. */
  counters: Record<string, number>;
}
