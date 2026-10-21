import { normalizeText } from "./text";
import type { Category, Direction, Id } from "./types";

export interface CategorySuggestion {
  categoryId: Id;
  categoryName: string;
  reason: string;
}

/** Règles simples et explicables (mot-clé -> nom de catégorie). Une suggestion n'est jamais appliquée sans validation. */
export const DEFAULT_CATEGORY_RULES: { pattern: RegExp; category: string; direction?: Direction }[] = [
  { pattern: /\b(ovh|aws|amazon web|google workspace|gsuite|notion|slack|adobe|github|figma|zoom|dropbox|atlassian|microsoft 365|office 365)\b/, category: "Abonnements logiciels", direction: "out" },
  { pattern: /\b(orange|sfr|bouygues|free mobile|free pro|telecom)\b/, category: "Télécommunications", direction: "out" },
  { pattern: /\b(sncf|uber|air france|ouigo|hotel|ibis|airbnb|taxi|navigo)\b/, category: "Déplacements", direction: "out" },
  { pattern: /\b(axa|maif|allianz|macif|hiscox|assurance)\b/, category: "Assurance", direction: "out" },
  { pattern: /\b(frais bancaires|commission|cotisation carte|agios|frais de tenue)\b/, category: "Frais bancaires", direction: "out" },
  { pattern: /\b(urssaf|dgfip|impots|tva|cfe|taxe)\b/, category: "Impôts et cotisations", direction: "out" },
  { pattern: /\b(loyer|bail|coworking|wework|regus)\b/, category: "Loyer et locaux", direction: "out" },
  { pattern: /\b(virement client|paiement client|encaissement|reglement facture|reglement fac)\b/, category: "Ventes de services", direction: "in" },
];

export function suggestCategory(label: string, direction: Direction, categories: readonly Category[]): CategorySuggestion | null {
  const text = normalizeText(label);
  for (const rule of DEFAULT_CATEGORY_RULES) {
    if (rule.direction && rule.direction !== direction) continue;
    if (!rule.pattern.test(text)) continue;
    const cat = categories.find((c) => normalizeText(c.name) === normalizeText(rule.category));
    if (cat) return { categoryId: cat.id, categoryName: cat.name, reason: `Le libellé correspond à la règle « ${rule.category} ».` };
  }
  return null;
}
