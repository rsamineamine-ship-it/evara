/** Normalisation de libellés bancaires : minuscules, sans accents, alphanumérique, espaces simples. */
export function normalizeText(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function significantTokens(s: string, minLen = 3): string[] {
  const stop = new Set(["sas", "sarl", "eurl", "sasu", "sa", "the", "and", "des", "les", "pour", "avec", "ets", "cie", "ste", "societe", "group", "groupe"]);
  return normalizeText(s)
    .split(" ")
    .filter((t) => t.length >= minLen && !stop.has(t));
}

/** Compacte une référence ("FAC-2026-0012" -> "fac20260012") pour la chercher dans un libellé. */
export function compactRef(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}
