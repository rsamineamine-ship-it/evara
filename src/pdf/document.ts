/**
 * Génération PDF A4 des devis, factures et avoirs (pdf-lib, polices standard : aucune ressource externe).
 *
 * IMPORTANT : un PDF n'est pas une « facture électronique » au sens réglementaire. Ce rendu est un document
 * commercial lisible ; la transmission via un prestataire compatible reste à intégrer (voir docs/CONFORMITE.md).
 */
import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { formatMoneyPlain, type Cents } from "../domain/money";
import { lineGross } from "../domain/totals";
import { divRound } from "../domain/money";
import type { Address, DocumentLine, OrgSettings, PaymentTerms, Totals } from "../domain/types";

export type PdfKind = "quote" | "invoice" | "credit_note";

export interface PdfParty {
  name: string;
  company?: string;
  address?: Address;
  email?: string;
  companyId?: string;
  vatNumber?: string;
}

export interface PdfDocumentInput {
  kind: PdfKind;
  /** null = brouillon non numéroté : filigrane « BROUILLON ». */
  number: string | null;
  issuer: Pick<OrgSettings, "name" | "legalMentions"> & { address?: Address; companyId?: string; vatNumber?: string; email?: string };
  customer: PdfParty;
  issueDate: string;
  /** Échéance (facture) ou date de validité (devis). */
  secondaryDate?: string;
  lines: DocumentLine[];
  documentDiscountBp?: number;
  totals: Totals;
  currency: string;
  paymentTerms?: PaymentTerms;
  notes?: string;
  /** Avoir : numéro de la facture d'origine et motif. */
  relatedInvoiceNumber?: string;
  reason?: string;
  /** Montants déjà réglés / reste dû (facture). */
  paidCents?: Cents;
  balanceCents?: Cents;
}

const TITLES: Record<PdfKind, string> = { quote: "DEVIS", invoice: "FACTURE", credit_note: "AVOIR" };
const SECONDARY_LABEL: Record<PdfKind, string> = { quote: "Valable jusqu'au", invoice: "Échéance", credit_note: "" };

const GRAPHITE = rgb(0x11 / 255, 0x17 / 255, 0x13 / 255);
const MUTED = rgb(0x69 / 255, 0x73 / 255, 0x6d / 255);
const BORDER = rgb(0xe5 / 255, 0xe9 / 255, 0xe4 / 255);
const MINT = rgb(0xb9 / 255, 0xf3 / 255, 0xd0 / 255);
const GREEN = rgb(0x21 / 255, 0x86 / 255, 0x5b / 255);

const W = 595.28;
const H = 841.89;
const M = 48;

export function termsLabel(t: PaymentTerms | undefined): string {
  if (!t) return "";
  if (t.kind === "on_receipt") return "Paiement à réception";
  if (t.kind === "net") return `Paiement à ${t.days} jours`;
  return `Paiement à ${t.days} jours fin de mois`;
}

const frDate = (iso: string) => (/^\d{4}-\d{2}-\d{2}/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : iso);

/** Remplace les caractères que la police standard (WinAnsi) ne sait pas encoder. */
function safe(font: PDFFont, text: string): string {
  const t = text.replace(/[  ]/g, " ").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/…/g, "...");
  let out = "";
  for (const ch of t) {
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      out += "?";
    }
  }
  return out;
}

function wrap(font: PDFFont, text: string, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const para of safe(font, text).split(/\r?\n/)) {
    let current = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const test = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(test, size) <= maxWidth) current = test;
      else {
        if (current) lines.push(current);
        current = word;
      }
    }
    lines.push(current);
  }
  return lines;
}

export async function renderDocumentPdf(input: PdfDocumentInput): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${TITLES[input.kind]} ${input.number ?? "(brouillon)"}`);
  pdf.setProducer("EVARA");
  pdf.setCreator("EVARA");
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const money = (c: Cents) => safe(font, formatMoneyPlain(c, input.currency));

  let page = pdf.addPage([W, H]);
  let y = H - M;

  const text = (p: PDFPage, s: string, x: number, yy: number, size = 9, f: PDFFont = font, color = GRAPHITE) => p.drawText(safe(f, s), { x, y: yy, size, font: f, color });
  const right = (p: PDFPage, s: string, xr: number, yy: number, size = 9, f: PDFFont = font, color = GRAPHITE) => {
    const t = safe(f, s);
    p.drawText(t, { x: xr - f.widthOfTextAtSize(t, size), y: yy, size, font: f, color });
  };

  const drawWatermark = (p: PDFPage) => {
    if (input.number) return;
    p.drawText("BROUILLON", { x: 120, y: 330, size: 90, font: bold, color: rgb(0.93, 0.94, 0.93), rotate: degrees(35) });
  };
  drawWatermark(page);

  /* ---- En-tête ---- */
  page.drawRectangle({ x: M, y: y - 4, width: 28, height: 28, color: GRAPHITE });
  text(page, input.issuer.name.slice(0, 1).toUpperCase(), M + 9.5, y + 4, 15, bold, MINT);
  text(page, input.issuer.name, M + 38, y + 8, 13, bold);
  let iy = y - 6;
  const issuerLines = [
    input.issuer.address?.line1,
    input.issuer.address ? `${input.issuer.address.postalCode} ${input.issuer.address.city}` : undefined,
    input.issuer.companyId ? `SIREN/SIRET : ${input.issuer.companyId}` : undefined,
    input.issuer.vatNumber ? `TVA : ${input.issuer.vatNumber}` : undefined,
    input.issuer.email,
  ].filter((x): x is string => !!x);
  for (const l of issuerLines) {
    iy -= 12;
    text(page, l, M + 38, iy, 8.5, font, MUTED);
  }

  right(page, TITLES[input.kind], W - M, y + 6, 22, bold);
  right(page, input.number ? `N° ${input.number}` : "N° (attribué à l'émission)", W - M, y - 12, 10, font, MUTED);
  right(page, `Date : ${frDate(input.issueDate)}`, W - M, y - 26, 9);
  if (input.secondaryDate && SECONDARY_LABEL[input.kind]) right(page, `${SECONDARY_LABEL[input.kind]} : ${frDate(input.secondaryDate)}`, W - M, y - 39, 9);
  if (input.kind === "credit_note" && input.relatedInvoiceNumber) right(page, `Facture d'origine : ${input.relatedInvoiceNumber}`, W - M, y - 39, 9);

  y = Math.min(iy, y - 52) - 28;

  /* ---- Client ---- */
  page.drawRectangle({ x: W - M - 230, y: y - 62, width: 230, height: 78, color: rgb(0.97, 0.975, 0.96), borderColor: BORDER, borderWidth: 0.6 });
  text(page, input.kind === "quote" ? "DESTINATAIRE DU DEVIS" : "FACTURÉ À", W - M - 220, y + 4, 7, bold, MUTED);
  let cy = y - 10;
  const customerLines = [
    input.customer.company ?? input.customer.name,
    input.customer.company ? input.customer.name : undefined,
    input.customer.address?.line1,
    input.customer.address ? `${input.customer.address.postalCode} ${input.customer.address.city}` : undefined,
    input.customer.companyId ? `SIREN/SIRET : ${input.customer.companyId}` : undefined,
  ].filter((x): x is string => !!x);
  customerLines.forEach((l, i) => {
    text(page, l, W - M - 220, cy, i === 0 ? 10 : 8.5, i === 0 ? bold : font, i === 0 ? GRAPHITE : MUTED);
    cy -= 12;
  });
  if (input.kind === "credit_note" && input.reason) {
    for (const l of wrap(font, `Motif : ${input.reason}`, 8.5, 230)) {
      text(page, l, M, y - 4, 8.5, font, MUTED);
      y -= 12;
    }
  }
  y -= 86;

  /* ---- Tableau des lignes ---- */
  const cols = { desc: M, qty: 318, pu: 372, vat: 422, disc: 462, total: W - M };
  const header = (p: PDFPage, yy: number) => {
    p.drawRectangle({ x: M, y: yy - 6, width: W - 2 * M, height: 20, color: GRAPHITE });
    text(p, "Description", cols.desc + 8, yy, 8, bold, MINT);
    right(p, "Qté", cols.qty + 20, yy, 8, bold, MINT);
    right(p, "PU HT", cols.pu + 36, yy, 8, bold, MINT);
    right(p, "TVA", cols.vat + 28, yy, 8, bold, MINT);
    right(p, "Remise", cols.disc + 32, yy, 8, bold, MINT);
    right(p, "Total HT", cols.total - 8, yy, 8, bold, MINT);
  };
  header(page, y);
  y -= 24;

  for (const l of input.lines) {
    const descLines = wrap(font, l.description, 9, 255);
    const rowH = Math.max(18, descLines.length * 11 + 8);
    if (y - rowH < M + 150) {
      page = pdf.addPage([W, H]);
      drawWatermark(page);
      y = H - M;
      header(page, y);
      y -= 24;
    }
    descLines.forEach((dl, i) => text(page, dl, cols.desc + 8, y - i * 11, 9));
    const gross = lineGross(l);
    const net = gross - divRound(gross * l.discountBp, 10_000);
    right(page, String(l.quantity).replace(".", ","), cols.qty + 20, y, 9);
    right(page, money(l.unitPriceCents), cols.pu + 36, y, 9);
    right(page, `${(l.vatRateBp / 100).toString().replace(".", ",")} %`, cols.vat + 28, y, 9);
    right(page, l.discountBp ? `${(l.discountBp / 100).toString().replace(".", ",")} %` : "—", cols.disc + 32, y, 9, font, MUTED);
    right(page, money(net), cols.total - 8, y, 9, bold);
    y -= rowH;
    page.drawLine({ start: { x: M, y: y + 7 }, end: { x: W - M, y: y + 7 }, thickness: 0.4, color: BORDER });
  }

  /* ---- Totaux ---- */
  if (y < M + 170) {
    page = pdf.addPage([W, H]);
    drawWatermark(page);
    y = H - M;
  }
  y -= 8;
  const tx = W - M - 210;
  const row = (label: string, value: string, strong = false, color = GRAPHITE) => {
    text(page, label, tx, y, strong ? 10.5 : 9, strong ? bold : font, strong ? GRAPHITE : MUTED);
    right(page, value, W - M, y, strong ? 10.5 : 9, strong ? bold : font, color);
    y -= strong ? 18 : 14;
  };
  if (input.totals.discountCents > 0) row("Total brut HT", money(input.totals.grossCents));
  if (input.totals.discountCents > 0) row("Remises", `- ${money(input.totals.discountCents)}`);
  row("Total HT", money(input.totals.netHtCents));
  for (const v of input.totals.vatByRate) row(`TVA ${(v.rateBp / 100).toString().replace(".", ",")} % sur ${money(v.baseCents)}`, money(v.vatCents));
  y -= 12;
  page.drawRectangle({ x: tx - 8, y: y - 8, width: 218, height: 26, color: MINT });
  text(page, input.kind === "credit_note" ? "Total TTC à déduire" : "Total TTC", tx, y, 11, bold);
  right(page, money(input.totals.totalTtcCents), W - M - 6, y, 11, bold);
  y -= 30;
  if (input.kind === "invoice" && input.paidCents !== undefined && input.balanceCents !== undefined) {
    row("Déjà réglé", `- ${money(input.paidCents)}`);
    row("Reste à payer", money(input.balanceCents), true, input.balanceCents > 0 ? GRAPHITE : GREEN);
  }

  /* ---- Conditions et notes ---- */
  const infoLines: string[] = [];
  if (input.paymentTerms && input.kind !== "credit_note") infoLines.push(termsLabel(input.paymentTerms));
  if (input.notes) infoLines.push(input.notes);
  if (infoLines.length) {
    y -= 6;
    text(page, "CONDITIONS ET NOTES", M, y, 7, bold, MUTED);
    y -= 13;
    for (const l of infoLines.flatMap((x) => wrap(font, x, 9, W - 2 * M - 220))) {
      text(page, l, M, y, 9);
      y -= 12;
    }
  }

  /* ---- Pied de page (toutes les pages) ---- */
  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    p.drawLine({ start: { x: M, y: 62 }, end: { x: W - M, y: 62 }, thickness: 0.5, color: BORDER });
    wrap(font, input.issuer.legalMentions, 7, W - 2 * M - 60).slice(0, 3).forEach((l, k) => text(p, l, M, 50 - k * 9, 7, font, MUTED));
    right(p, `Page ${i + 1}/${pages.length}`, W - M, 22, 7, font, MUTED);
    text(p, "Document généré par EVARA — ne vaut pas transmission via une plateforme de facturation électronique.", M, 22, 6.5, font, MUTED);
  });

  return pdf.save();
}
