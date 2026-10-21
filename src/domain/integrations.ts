/**
 * Interfaces des services externes + adaptateurs « non configuré ».
 * Aucune intégration factice : tant qu'un prestataire n'est pas branché, l'appel retourne une erreur explicite
 * et l'interface affiche un état de configuration clair. Aucun secret ne transite par le navigateur.
 */
export type Result<T> = ({ ok: true } & T) | { ok: false; error: "NOT_CONFIGURED" | string };

export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
  replyTo?: string;
}
export interface EmailProvider {
  readonly id: string;
  send(msg: EmailMessage): Promise<Result<{ providerMessageId: string }>>;
}
export interface StorageProvider {
  readonly id: string;
  put(key: string, bytes: Uint8Array, mimeType: string): Promise<Result<object>>;
  signedUrl(key: string, ttlSeconds: number): Promise<Result<{ url: string }>>;
}
export interface AIProvider {
  readonly id: string;
  complete(input: { system: string; messages: { role: "user" | "assistant"; content: string }[] }): Promise<Result<{ text: string }>>;
}
export interface EInvoicingProvider {
  readonly id: string;
  /** Transmission d'une facture à un prestataire compatible. Distincte de l'émission et du paiement. */
  transmit(invoiceId: string): Promise<Result<{ transmissionId: string }>>;
}
export interface BankFeedProvider {
  readonly id: string;
  listTransactions(accountRef: string, since: string): Promise<Result<{ transactions: unknown[] }>>;
}
export interface BillingProvider {
  readonly id: string;
  createCheckout(orgId: string, plan: string): Promise<Result<{ url: string }>>;
}

const notConfigured = async (): Promise<{ ok: false; error: "NOT_CONFIGURED" }> => ({ ok: false, error: "NOT_CONFIGURED" });

export const NotConfiguredEmail: EmailProvider = { id: "none", send: notConfigured };
export const NotConfiguredStorage: StorageProvider = { id: "none", put: notConfigured, signedUrl: notConfigured };
export const NotConfiguredAI: AIProvider = { id: "none", complete: notConfigured };
export const NotConfiguredEInvoicing: EInvoicingProvider = { id: "none", transmit: notConfigured };
export const NotConfiguredBankFeed: BankFeedProvider = { id: "none", listTransactions: notConfigured };
export const NotConfiguredBilling: BillingProvider = { id: "none", createCheckout: notConfigured };

export interface IntegrationStatus {
  id: "email" | "storage" | "ai" | "csv_import" | "billing" | "einvoicing" | "bank_feed" | "database";
  label: string;
  configured: boolean;
  /** Toujours disponible, sans configuration externe. */
  builtIn?: boolean;
  requiredEnv: string[];
  missing: string[];
  note: string;
}

const SPEC: Omit<IntegrationStatus, "configured" | "missing">[] = [
  { id: "database", label: "Base de données et authentification (Supabase)", requiredEnv: ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"], note: "Sans elle, seul le mode démonstration (données fictives, navigateur uniquement) est disponible." },
  { id: "email", label: "Email transactionnel", requiredEnv: ["EMAIL_PROVIDER_API_KEY", "EMAIL_FROM_ADDRESS"], note: "Sans elle, devis, factures et relances sont PRÉPARÉS mais jamais envoyés." },
  { id: "storage", label: "Stockage privé des justificatifs", requiredEnv: ["STORAGE_BUCKET", "STORAGE_ACCESS_KEY"], note: "Sans elle, les pièces jointes ne sont pas conservées." },
  { id: "ai", label: "Fournisseur d'IA", requiredEnv: ["AI_PROVIDER_API_KEY"], note: "Sans elle, l'assistant fonctionne en mode démonstration : réponses simulées et identifiées comme telles." },
  { id: "billing", label: "Paiement des abonnements EVARA", requiredEnv: ["BILLING_SECRET_KEY", "BILLING_WEBHOOK_SECRET"], note: "Sans elle, aucun abonnement payant ne peut être activé." },
  { id: "einvoicing", label: "Facturation électronique (prestataire compatible)", requiredEnv: ["EINVOICING_API_KEY", "EINVOICING_ENDPOINT"], note: "La génération d'un PDF ne suffit pas à satisfaire les obligations légales : un prestataire compatible reste à raccorder et à faire valider." },
  { id: "bank_feed", label: "Connexion bancaire (agrégation)", requiredEnv: ["BANK_FEED_CLIENT_ID", "BANK_FEED_SECRET"], note: "Non implémentée. L'import CSV couvre le besoin sans connexion bancaire." },
];

export function integrationStatuses(env: Record<string, string | undefined>): IntegrationStatus[] {
  const list: IntegrationStatus[] = SPEC.map((s) => {
    const missing = s.requiredEnv.filter((k) => !env[k]);
    return { ...s, configured: missing.length === 0, missing };
  });
  list.splice(1, 0, { id: "csv_import", label: "Import CSV bancaire", configured: true, builtIn: true, requiredEnv: [], missing: [], note: "Disponible sans connexion bancaire." });
  return list;
}
