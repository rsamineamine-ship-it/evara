import type { AutomationKey } from "./types";

export type PlanId = "discovery" | "pro" | "business";

export interface PlanDefinition {
  id: PlanId;
  name: string;
  /** Prix indicatif HT / mois en centimes. HYPOTHÈSE DE LANCEMENT à tester, pas un tarif validé. */
  priceCentsHtMonthly: number;
  tagline: string;
  features: string[];
  limits: {
    invoicesPerMonth: number | null;
    members: number | null;
    aiQuestionsPerMonth: number;
    forecastScenarios: boolean;
    forecastHorizonDays: number;
    simulations: boolean;
    advancedReports: boolean;
    automations: AutomationKey[];
  };
}

const BASIC_AUTOMATIONS: AutomationKey[] = ["detect_overdue_invoices", "supplier_due_alerts"];
const PRO_AUTOMATIONS: AutomationKey[] = [...BASIC_AUTOMATIONS, "prepare_reminders", "flag_unmatched_transactions", "detect_missing_receipts", "refresh_forecast"];
const BUSINESS_AUTOMATIONS: AutomationKey[] = [...PRO_AUTOMATIONS, "notify_channel", "detect_recurring_expenses", "periodic_report", "flag_anomalies"];

/** Modifiable en un seul endroit : les tarifs sont des hypothèses. */
export const PLANS: Record<PlanId, PlanDefinition> = {
  discovery: {
    id: "discovery",
    name: "Découverte",
    priceCentsHtMonthly: 0,
    tagline: "Pour explorer EVARA avec la démonstration et un usage limité.",
    features: ["Démonstration complète avec données fictives", "5 factures par mois", "1 utilisateur", "Trésorerie à 30 jours (scénario central)", "Import CSV bancaire"],
    limits: { invoicesPerMonth: 5, members: 1, aiQuestionsPerMonth: 0, forecastScenarios: false, forecastHorizonDays: 30, simulations: false, advancedReports: false, automations: BASIC_AUTOMATIONS },
  },
  pro: {
    id: "pro",
    name: "Pro",
    priceCentsHtMonthly: 2900,
    tagline: "La gestion financière centralisée pour une petite structure.",
    features: ["Devis et factures illimités", "Dépenses et factures fournisseurs", "Suivi des paiements et rapprochement", "Trésorerie jusqu'à 90 jours", "3 utilisateurs", "Automatisations de base"],
    limits: { invoicesPerMonth: null, members: 3, aiQuestionsPerMonth: 0, forecastScenarios: false, forecastHorizonDays: 90, simulations: false, advancedReports: false, automations: PRO_AUTOMATIONS },
  },
  business: {
    id: "business",
    name: "Business",
    priceCentsHtMonthly: 7900,
    tagline: "Prévisions avancées, automatisations et collaboration.",
    features: ["Tout Pro", "Trois scénarios et simulations de trésorerie", "Assistant IA (limites d'usage définies)", "Toutes les automatisations", "Rapports avancés et comparaisons", "Collaboration jusqu'à 10 utilisateurs"],
    limits: { invoicesPerMonth: null, members: 10, aiQuestionsPerMonth: 200, forecastScenarios: true, forecastHorizonDays: 90, simulations: true, advancedReports: true, automations: BUSINESS_AUTOMATIONS },
  },
};

const ORDER: PlanId[] = ["discovery", "pro", "business"];

export function planAtLeast(plan: PlanId, min: PlanId): boolean {
  return ORDER.indexOf(plan) >= ORDER.indexOf(min);
}

export function automationAllowed(plan: PlanId, key: AutomationKey): boolean {
  return PLANS[plan].limits.automations.includes(key);
}
