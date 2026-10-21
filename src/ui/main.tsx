import { createRoot } from "react-dom/client";
import { useEffect, useMemo, useState } from "react";
import "./styles.css";
import { buildDemoLedger, DEMO_ORG_ID, DEMO_USER_ID } from "../demo/seed";
import { buildCtx } from "../domain/access";
import { buildActions, buildDashboard } from "../domain/dashboard";
import { cloneLedger } from "../domain/ledger";
import { formatMoneyPlain } from "../domain/money";
import { invoiceView, quoteDisplayStatus, issueInvoice, decideQuote, convertQuoteToInvoice } from "../domain/documents";
import { purchaseView } from "../domain/purchases";
import { recordPayment, confirmMatch } from "../domain/payments";
import { suggestMatches } from "../domain/reconcile";
import { reconciliationStatus } from "../domain/transactions";
import { forecastCash, simulate, type Assumption } from "../domain/forecast";
import { answerQuestion, confirmProposal, SUGGESTED_QUESTIONS, type AssistantReply } from "../domain/assistant";
import { integrationStatuses } from "../domain/integrations";
import { PLANS } from "../domain/plans";
import { addDays, todayInTimeZone } from "../domain/dates";
import { WORDMARK_PATH, WORDMARK_WIDTH, WORDMARK_HEIGHT } from "./brand";
import type { Ledger } from "../domain/types";

const eur = (c: number) => formatMoneyPlain(c, "EUR");
const today = todayInTimeZone(new Date(), "Europe/Paris");
const fresh = () => buildDemoLedger(today).ledger;

/* ---------- routeur History API ---------- */
function useRoute() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => { const f = () => setPath(location.pathname); addEventListener("popstate", f); return () => removeEventListener("popstate", f); }, []);
  return path;
}
function go(to: string) { history.pushState({}, "", to); dispatchEvent(new PopStateEvent("popstate")); scrollTo(0, 0); }
function A(p: { to: string; className?: string; current?: boolean; children?: unknown }) {
  return <a href={p.to} className={p.className} aria-current={p.current ? "page" : undefined} onClick={(e) => { e.preventDefault(); go(p.to); }}>{p.children}</a>;
}

function Logo({ dark }: { dark?: boolean }) {
  return (
    <svg viewBox={`0 0 ${52 + WORDMARK_WIDTH + 4} 40`} height="28" role="img" aria-label="EVARA">
      <g transform="scale(0.625)"><rect width="64" height="64" rx="15" fill={dark ? "#B9F3D0" : "#111713"} /><path fill={dark ? "#111713" : "#B9F3D0"} d="M17 15h8v34h-8zM25 15h22l-4 8H25zM25 28h16l-4 8H25zM25 41h22l-4 8H25z" /></g>
      <g transform={`translate(52 ${20 + WORDMARK_HEIGHT / 2})`}><path fill={dark ? "#F7F8F5" : "currentColor"} d={WORDMARK_PATH} /></g>
    </svg>
  );
}

/* ---------- graphique de prévision (SVG) ---------- */
function ForecastChart({ ledger, ctx }: { ledger: Ledger; ctx: ReturnType<typeof buildCtx> }) {
  const [hover, setHover] = useState<number | null>(null);
  const sc = (s: "prudent" | "central" | "favorable") => forecastCash(ledger, ctx, { horizonDays: 60, scenario: s });
  const { p, c, f } = useMemo(() => ({ p: sc("prudent"), c: sc("central"), f: sc("favorable") }), [ledger]);
  const W = 720, H = 240, L = 56, B = 24;
  const all = [...p.series, ...c.series, ...f.series].map((d) => d.balanceCents);
  const lo = Math.min(...all, 0), hi = Math.max(...all);
  const x = (i: number) => L + (i / 60) * (W - L - 8);
  const y = (v: number) => 8 + (1 - (v - lo) / (hi - lo || 1)) * (H - B - 8);
  const path = (r: typeof c) => r.series.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(d.balanceCents).toFixed(1)}`).join(" ");
  const th = ledger.organizations[0]!.minimumCashThresholdCents;
  const ticks = [lo, lo + (hi - lo) / 2, hi];
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} onMouseLeave={() => setHover(null)} onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); const i = Math.round(((e.clientX - r.left) / r.width * W - L) / (W - L - 8) * 60); setHover(Math.max(0, Math.min(60, i))); }}>
        {ticks.map((t, i) => <g key={i} className="axis"><line className="grid-line" x1={L} x2={W} y1={y(t)} y2={y(t)} /><text x={L - 8} y={y(t) + 4} textAnchor="end">{Math.round(t / 100000)} k€</text></g>)}
        <line x1={L} x2={W} y1={y(th)} y2={y(th)} stroke="var(--warn)" strokeDasharray="4 4" />
        <path d={path(f)} fill="none" stroke="var(--chart-3)" strokeWidth="2" strokeDasharray="2 5" className="draw" />
        <path d={path(p)} fill="none" stroke="var(--chart-2)" strokeWidth="2" strokeDasharray="6 4" className="draw" />
        <path d={path(c)} fill="none" stroke="var(--chart-1)" strokeWidth="3" className="draw" />
        <circle cx={x(0)} cy={y(c.series[0]!.balanceCents)} r="5" fill="var(--ink)" />
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1="8" y2={H - B} stroke="var(--muted)" />}
        <g className="axis"><text x={L} y={H - 4}>Aujourd'hui</text><text x={W - 8} y={H - 4} textAnchor="end">+60 jours</text></g>
      </svg>
      {hover !== null && <div className="chart-tip" style={{ left: `${Math.min(70, (x(hover) / W) * 100)}%`, top: 0 }}>
        <b>{c.series[hover]!.date}</b>
        <div className="tip-row"><span>Prudent</span><span className="num">{eur(p.series[hover]!.balanceCents)}</span></div>
        <div className="tip-row"><span>Central</span><span className="num">{eur(c.series[hover]!.balanceCents)}</span></div>
        <div className="tip-row"><span>Favorable</span><span className="num">{eur(f.series[hover]!.balanceCents)}</span></div></div>}
      <div className="legend"><span><i style={{ borderColor: "var(--chart-1)" }} />Central</span><span><i className="dashed" style={{ borderColor: "var(--chart-2)" }} />Prudent</span><span><i className="dotted" style={{ borderColor: "var(--chart-3)" }} />Favorable</span><span><i className="dashed" style={{ borderColor: "var(--warn)" }} />Seuil minimal</span></div>
      <p className="hint" style={{ marginTop: 6 }}>Prévision calculée depuis vos échéances : ce n'est pas un solde bancaire certain.</p>
    </div>
  );
}

/* ---------- application ---------- */
const NAV: [string, string][] = [["/app", "Vue d'ensemble"], ["/app/tresorerie", "Trésorerie"], ["/app/devis", "Devis"], ["/app/factures", "Factures clients"], ["/app/achats", "Achats et dépenses"], ["/app/transactions", "Transactions"], ["/app/clients", "Clients"], ["/app/fournisseurs", "Fournisseurs"], ["/app/rapports", "Rapports"], ["/app/automatisations", "Automatisations"], ["/app/assistant", "Assistant EVARA"], ["/app/parametres", "Paramètres"]];
const STATUS: Record<string, [string, string]> = { draft: ["Brouillon", ""], issued: ["Émise", "badge-info"], sent: ["Envoyée", "badge-info"], partially_paid: ["Partiellement payée", "badge-warn"], paid: ["Payée", "badge-ok"], overdue: ["En retard", "badge-danger"], credited: ["Soldée par avoir", "badge-ok"], cancelled: ["Annulée", ""], accepted: ["Accepté", "badge-ok"], declined: ["Refusé", "badge-danger"], expired: ["Expiré", "badge-warn"], converted: ["Converti en facture", "badge-ok"], viewed: ["Consulté", "badge-info"], to_review: ["À vérifier", "badge-warn"], to_pay: ["À payer", "badge-info"], disputed: ["Contestée", "badge-danger"], unmatched: ["Non rapprochée", "badge-warn"], matched: ["Rapprochée", "badge-ok"], partial: ["Partielle", "badge-warn"], ignored: ["Ignorée", ""] };
const Badge = ({ s }: { s: string }) => <span className={`badge ${STATUS[s]?.[1] ?? ""}`}>{STATUS[s]?.[0] ?? s}</span>;

function App({ path }: { path: string }) {
  const [ledger, setLedger] = useState<Ledger>(fresh);
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null);
  const [open, setOpen] = useState(false);
  const ctx = buildCtx(ledger, DEMO_USER_ID, DEMO_ORG_ID, today, new Date().toISOString());
  const say = (msg: string, err?: boolean) => { setToast({ msg, err }); setTimeout(() => setToast(null), 4000); };
  /** Toute écriture passe par le moteur métier, sur une copie : tout ou rien. */
  const act = (fn: (l: Ledger, c: typeof ctx) => void, ok: string) => {
    try { const next = cloneLedger(ledger); fn(next, buildCtx(next, DEMO_USER_ID, DEMO_ORG_ID, today, new Date().toISOString())); setLedger(next); say(ok); } catch (e) { say(e instanceof Error ? e.message : "Erreur", true); }
  };
  const cust = (id: string) => ledger.customers.find((c) => c.id === id)?.company ?? "—";
  const sup = (id: string) => ledger.suppliers.find((c) => c.id === id)?.company ?? "—";
  const page = path.replace(/\/$/, "");
  const props = { ledger, ctx, act, cust, sup, say };
  return (
    <div className="app">
      <a className="skip-link" href="#main">Aller au contenu</a>
      <nav className={`sidebar ${open ? "open" : ""}`} aria-label="Navigation principale">
        <div className="brand"><A to="/"><Logo dark /></A></div>
        {NAV.map(([to, label]) => <A key={to} to={to} className="nav-link" current={page === to}>{label}</A>)}
        <div className="sidebar-foot">Données fictives — stockées en mémoire, dans ce navigateur uniquement.</div>
      </nav>
      <div className="main">
        <div className="demo-banner"><span className="tag-demo">Démo</span> Entreprise fictive « {ledger.organizations[0]!.name} ». Rien n'est envoyé, aucun virement n'est exécuté.
          <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={() => { setLedger(fresh()); say("Données de démonstration réinitialisées."); }}>Réinitialiser la démo</button>
          <button className="btn btn-sm only-mobile" onClick={() => setOpen(!open)}>Menu</button></div>
        <main id="main" className="page" key={page}>
          {page === "/app" && <Overview {...props} />}
          {page === "/app/tresorerie" && <Treasury {...props} />}
          {page === "/app/devis" && <Quotes {...props} />}
          {page === "/app/factures" && <Invoices {...props} />}
          {page === "/app/achats" && <Purchases {...props} />}
          {page === "/app/transactions" && <Transactions {...props} />}
          {page === "/app/clients" && <Parties {...props} kind="customers" />}
          {page === "/app/fournisseurs" && <Parties {...props} kind="suppliers" />}
          {page === "/app/rapports" && <Reports {...props} />}
          {page === "/app/automatisations" && <Automations {...props} />}
          {page === "/app/assistant" && <Assistant {...props} />}
          {page === "/app/parametres" && <Settings {...props} />}
          {!NAV.some(([t]) => t === page) && <div className="empty"><h3>Page introuvable</h3><A to="/app" className="btn">Retour à la vue d'ensemble</A></div>}
        </main>
      </div>
      {toast && <div className="toasts" role="status"><div className={`toast ${toast.err ? "error" : "success"}`}>{toast.msg}</div></div>}
    </div>
  );
}
type P = { ledger: Ledger; ctx: ReturnType<typeof buildCtx>; act: (fn: (l: Ledger, c: ReturnType<typeof buildCtx>) => void, ok: string) => void; cust: (id: string) => string; sup: (id: string) => string; say: (m: string, e?: boolean) => void };
const Head = ({ t, d, children }: { t: string; d?: string; children?: unknown }) => <div className="page-head"><div><h1>{t}</h1>{d && <p>{d}</p>}</div><div className="row-wrap">{children}</div></div>;

function Overview({ ledger, ctx }: P) {
  const d = useMemo(() => buildDashboard(ledger, ctx), [ledger]);
  const actions = useMemo(() => buildActions(ledger, ctx), [ledger]);
  return (<>
    <Head t="Vue d'ensemble" d="Combien j'ai, combien je dois recevoir, combien je dois payer, et où va ma trésorerie." />
    <div className="grid grid-4">
      <div className="card kpi kpi-primary"><span className="kpi-label">Solde de trésorerie actuel</span><span className="kpi-value">{eur(d.cash.totalCents)}</span><span className="kpi-foot">{d.provenance}</span></div>
      <div className="card kpi"><span className="kpi-label">Dû par les clients</span><span className="kpi-value">{eur(d.receivablesCents)}</span><span className="kpi-foot">dont {eur(d.receivablesOverdueCents)} en retard ({d.overdueInvoiceCount})</span></div>
      <div className="card kpi"><span className="kpi-label">À payer aux fournisseurs</span><span className="kpi-value">{eur(d.payablesCents)}</span><span className="kpi-foot">dont {eur(d.payablesOverdueCents)} en retard</span></div>
      <div className="card kpi"><span className="kpi-label">Prévision à 30 jours (centrale)</span><span className="kpi-value">{eur(d.forecast30.endBalanceCents)}</span><span className="kpi-foot">Prudent {eur(d.forecast30Prudent.endBalanceCents)} · Favorable {eur(d.forecast30Favorable.endBalanceCents)}</span></div>
    </div>
    <div className="grid grid-4">
      <div className="card kpi"><span className="kpi-label">Encaissé (30 j, mouvements réels)</span><span className="kpi-value pos">{eur(d.receivedCents)}</span></div>
      <div className="card kpi"><span className="kpi-label">Décaissé (30 j, mouvements réels)</span><span className="kpi-value">{eur(d.spentCents)}</span></div>
      <div className="card kpi" style={{ gridColumn: "span 2" }}><span className="kpi-label">Prochaine échéance importante</span><span className="kpi-value" style={{ fontSize: 18 }}>{d.nextImportantDue ? `${d.nextImportantDue.label} — ${eur(-d.nextImportantDue.amountCents)}` : "Aucune"}</span><span className="kpi-foot">{d.nextImportantDue?.date}</span></div>
    </div>
    <div className="grid grid-main">
      <section className="card"><div className="card-head"><h2>Trésorerie prévisionnelle</h2><span className="card-sub">60 jours · 3 scénarios</span></div><div className="card-pad"><ForecastChart ledger={ledger} ctx={ctx} /></div></section>
      <section className="card"><div className="card-head"><h2>Centre d'actions</h2><span className="badge badge-plain">{actions.length}</span></div>
        <div className="list">{actions.slice(0, 8).map((a) => <div key={a.id} className="list-item"><span className={`dot dot-${a.severity}`} /><div className="grow"><b>{a.title}</b><div className="card-sub">{a.detail}</div><div className="small pos">→ {a.nextStep}</div></div></div>)}</div></section>
    </div>
    {d.forecast30.completeness.warnings.length > 0 && <div className="callout callout-info">Prévision incomplète : {d.forecast30.completeness.warnings.join(" ")}</div>}
  </>);
}

function Treasury({ ledger, ctx }: P) {
  const [days, setDays] = useState(60);
  const [kind, setKind] = useState("delay");
  const [on, setOn] = useState(false);
  const overdueOrOpen = ledger.invoices.filter((i) => invoiceView(ledger, i, today).balanceCents > 0 && i.status !== "draft");
  const [inv, setInv] = useState(overdueOrOpen[0]?.id ?? "");
  const [amount, setAmount] = useState(5000);
  const assumptions: Assumption[] = !on ? [] : kind === "delay" ? [{ type: "delay_invoice", invoiceId: inv, days: 15 }] : kind === "expense" ? [{ type: "one_off_expense", date: addDays(today, 10), amountCents: amount * 100, label: "Dépense exceptionnelle" }] : kind === "sale" ? [{ type: "extra_sale", date: addDays(today, 20), amountCents: amount * 100, label: "Vente supplémentaire" }] : [{ type: "investment", date: addDays(today, 7), amountCents: amount * 100, label: "Investissement" }];
  const r = useMemo(() => simulate(ledger, ctx, { horizonDays: days, assumptions }), [ledger, days, on, kind, inv, amount]);
  const f = r.simulated;
  return (<>
    <Head t="Trésorerie" d="Prévision explicable : solde de départ + entrées prévues − sorties prévues. Les simulations ne modifient jamais vos données." />
    <div className="seg">{[7, 30, 60, 90].map((n) => <button key={n} aria-pressed={days === n} onClick={() => setDays(n)}>{n} jours</button>)}</div>
    <div className="grid grid-4">
      <div className="card kpi"><span className="kpi-label">Solde de départ</span><span className="kpi-value">{eur(f.startingCashCents)}</span></div>
      <div className="card kpi"><span className="kpi-label">Entrées prévues</span><span className="kpi-value pos">{eur(f.totalInCents)}</span></div>
      <div className="card kpi"><span className="kpi-label">Sorties prévues</span><span className="kpi-value">{eur(f.totalOutCents)}</span></div>
      <div className="card kpi"><span className="kpi-label">Solde prévu à {days} j</span><span className="kpi-value">{eur(f.endBalanceCents)}</span><span className="kpi-foot">Écart simulation : {eur(r.deltaEndCents)}</span></div>
    </div>
    <section className="card"><div className="card-head"><h2>Simulation (aucune donnée réelle modifiée)</h2><label className="check"><input type="checkbox" checked={on} onChange={(e) => setOn(e.currentTarget.checked)} /> Activer</label></div>
      <div className="card-pad form-grid">
        <div className="field"><label htmlFor="k">Scénario</label><select id="k" className="select" value={kind} onChange={(e) => setKind(e.currentTarget.value)}><option value="delay">Une facture payée avec 15 jours de retard</option><option value="expense">Dépense exceptionnelle</option><option value="sale">Vente supplémentaire</option><option value="invest">Investissement</option></select></div>
        {kind === "delay" ? <div className="field"><label htmlFor="i">Facture</label><select id="i" className="select" value={inv} onChange={(e) => setInv(e.currentTarget.value)}>{overdueOrOpen.map((i) => <option key={i.id} value={i.id}>{i.number} — {eur(invoiceView(ledger, i, today).balanceCents)}</option>)}</select></div>
          : <div className="field"><label htmlFor="a">Montant (€)</label><input id="a" className="input input-money" type="number" min="0" value={amount} onChange={(e) => setAmount(Number(e.currentTarget.value))} /></div>}
      </div>
      {r.newlyNegative && <div className="callout callout-danger" style={{ margin: 16 }}>Cette simulation rend la trésorerie négative.</div>}
    </section>
    <section className="card"><div className="card-head"><h2>Événements pris en compte</h2><span className="card-sub">{f.events.length} opérations</span></div>
      <div className="table-wrap"><table className="table stackable"><thead><tr><th>Date</th><th>Opération</th><th>Confiance</th><th className="num">Montant</th><th>Pourquoi</th></tr></thead><tbody>
        {f.events.map((e) => <tr key={e.id}><td data-label="Date">{e.date}</td><td data-label="Opération">{e.label}{e.simulated && <span className="badge badge-info" style={{ marginLeft: 6 }}>Simulé</span>}</td><td data-label="Confiance"><span className="badge badge-plain">{e.confidence === "confirmed" ? "Confirmé" : e.confidence === "expected" ? "Attendu" : "Incertain"}</span></td><td data-label="Montant" className={`num ${e.amountCents > 0 ? "pos" : ""}`}>{eur(e.amountCents)}</td><td data-label="Pourquoi" className="small muted">{e.explanation}</td></tr>)}</tbody></table></div></section>
    {f.excluded.length > 0 && <section className="card card-pad"><h2 style={{ fontSize: 14.5, marginBottom: 8 }}>Exclus de la prévision</h2>{f.excluded.map((x, i) => <p key={i} className="small muted">• {x.label} — {x.reason}</p>)}</section>}
    <section className="card card-pad"><h2 style={{ fontSize: 14.5, marginBottom: 8 }}>Hypothèses</h2>{f.assumptions.map((x, i) => <p key={i} className="small muted">• {x}</p>)}</section>
  </>);
}

function Quotes({ ledger, act, cust }: P) {
  return (<><Head t="Devis" d="Un devis n'est pas une facture. Accepter un devis ne crée aucun paiement." />
    <section className="card"><div className="table-wrap"><table className="table stackable"><thead><tr><th>N°</th><th>Client</th><th>Valable jusqu'au</th><th className="num">Total TTC</th><th>Statut</th><th /></tr></thead><tbody>
      {ledger.quotes.map((q) => { const s = quoteDisplayStatus(q, today); return <tr key={q.id}><td data-label="N°">{q.number ?? "—"}</td><td data-label="Client">{cust(q.customerId)}</td><td data-label="Valable">{q.validUntil}</td><td data-label="Total" className="num">{eur(q.totals.totalTtcCents)}</td><td data-label="Statut"><Badge s={s} /></td>
        <td className="right">{(s === "sent" || s === "viewed") && <><button className="btn btn-sm" onClick={() => act((l, c) => decideQuote(l, c, q.id, "accepted"), "Devis accepté.")}>Accepté</button> <button className="btn btn-sm" onClick={() => act((l, c) => decideQuote(l, c, q.id, "declined"), "Devis refusé.")}>Refusé</button></>}
          {s === "accepted" && <button className="btn btn-sm btn-primary" onClick={() => act((l, c) => convertQuoteToInvoice(l, c, q.id), "Brouillon de facture créé et lié au devis.")}>Convertir en facture</button>}</td></tr>; })}</tbody></table></div></section></>);
}

function Invoices({ ledger, act, cust }: P) {
  const [f, setF] = useState("all");
  const rows = ledger.invoices.map((i) => invoiceView(ledger, i, today)).filter((v) => f === "all" || (f === "due" ? v.balanceCents > 0 && v.invoice.status !== "draft" : f === "overdue" ? v.isOverdue : f === "partial" ? v.displayStatus === "partially_paid" : f === "paid" ? v.displayStatus === "paid" : v.displayStatus === "draft")).sort((a, b) => (b.invoice.number ?? "~").localeCompare(a.invoice.number ?? "~"));
  const [pay, setPay] = useState<string | null>(null);
  const [amt, setAmt] = useState("");
  const target = rows.find((v) => v.invoice.id === pay);
  return (<><Head t="Factures clients" d="Le statut de paiement est toujours recalculé depuis les paiements : jamais stocké." />
    <div className="seg" role="group">{[["all", "Toutes"], ["draft", "Brouillons"], ["due", "À encaisser"], ["partial", "Partiellement payées"], ["overdue", "En retard"], ["paid", "Payées"]].map(([k, l]) => <button key={k} aria-pressed={f === k} onClick={() => setF(k!)}>{l}</button>)}</div>
    <section className="card"><div className="table-wrap"><table className="table stackable"><thead><tr><th>N°</th><th>Client</th><th>Échéance</th><th className="num">Total TTC</th><th className="num">Reste dû</th><th>Statut</th><th /></tr></thead><tbody>
      {rows.map((v) => <tr key={v.invoice.id}><td data-label="N°">{v.invoice.number ?? "Brouillon"}</td><td data-label="Client">{cust(v.invoice.customerId)}</td><td data-label="Échéance">{v.invoice.dueDate}</td><td data-label="Total" className="num">{eur(v.totalCents)}</td><td data-label="Reste dû" className="num">{eur(v.balanceCents)}</td><td data-label="Statut"><Badge s={v.displayStatus} />{v.isOverdue && <span className="small muted"> {v.daysOverdue} j</span>}</td>
        <td className="right">{v.invoice.status === "draft" && <button className="btn btn-sm" onClick={() => act((l, c) => issueInvoice(l, c, v.invoice.id), "Facture émise et numérotée.")}>Émettre</button>}{v.balanceCents > 0 && v.invoice.status !== "draft" && <button className="btn btn-sm btn-primary" onClick={() => { setPay(v.invoice.id); setAmt((v.balanceCents / 100).toFixed(2).replace(".", ",")); }}>Enregistrer un paiement</button>}</td></tr>)}</tbody></table></div></section>
    {target && <><div className="scrim" onClick={() => setPay(null)} /><div className="modal" role="dialog" aria-modal="true" aria-label="Enregistrer un paiement"><div className="modal-head"><h2>Paiement — {target.invoice.number}</h2></div><div className="modal-body stack">
      <p className="muted">Reste dû : <b className="num">{eur(target.balanceCents)}</b>. Un mouvement d'argent est créé sur le compte courant : la trésorerie réelle sera mise à jour.</p>
      <div className="field"><label htmlFor="amt">Montant reçu (€)</label><input id="amt" className="input input-money" value={amt} onChange={(e) => setAmt(e.currentTarget.value)} /></div></div>
      <div className="modal-foot"><button className="btn" onClick={() => setPay(null)}>Annuler</button><button className="btn btn-primary" onClick={() => { const cents = Math.round(Number(amt.replace(/\s/g, "").replace(",", ".")) * 100); act((l, c) => { recordPayment(l, c, { documentType: "sales_invoice", documentId: target.invoice.id, amountCents: cents, date: today, method: "transfer", accountId: l.accounts.find((a) => a.type === "bank")!.id }); }, "Paiement enregistré, reste dû recalculé."); setPay(null); }}>Valider</button></div></div></>}
  </>);
}

function Purchases({ ledger, sup }: P) {
  return (<><Head t="Achats et dépenses" d="Distingue facture fournisseur, dépense engagée et décaissement réellement enregistré : une facture à payer ne réduit pas le solde réel." />
    <section className="card"><div className="card-head"><h2>Factures fournisseurs</h2></div><div className="table-wrap"><table className="table stackable"><thead><tr><th>Référence</th><th>Fournisseur</th><th>Échéance</th><th className="num">TTC</th><th className="num">Reste à payer</th><th>Statut</th></tr></thead><tbody>
      {ledger.purchaseInvoices.map((p) => { const v = purchaseView(ledger, p, today); return <tr key={p.id}><td data-label="Réf.">{p.reference}</td><td data-label="Fournisseur">{sup(p.supplierId)}</td><td data-label="Échéance">{p.dueDate}</td><td data-label="TTC" className="num">{eur(p.totalTtcCents)}</td><td data-label="Reste" className="num">{eur(v.balanceCents)}</td><td data-label="Statut"><Badge s={v.displayStatus} /></td></tr>; })}</tbody></table></div></section>
    <section className="card"><div className="card-head"><h2>Dépenses</h2></div><div className="table-wrap"><table className="table stackable"><thead><tr><th>Date</th><th>Libellé</th><th>Catégorie</th><th className="num">Montant</th><th>État</th><th>Justificatif</th></tr></thead><tbody>
      {ledger.expenses.map((e) => <tr key={e.id}><td data-label="Date">{e.date}</td><td data-label="Libellé">{e.label}</td><td data-label="Catégorie">{ledger.categories.find((c) => c.id === e.categoryId)?.name ?? "—"}</td><td data-label="Montant" className="num">{eur(e.amountCents)}</td><td data-label="État"><span className="badge badge-plain">{e.purchaseInvoiceId ? "Portée par facture" : e.paidTransactionId ? "Payée" : "Engagée"}</span></td><td data-label="Justificatif">{e.receiptAttachmentId ? "Oui" : <span className="badge badge-warn">Manquant</span>}</td></tr>)}</tbody></table></div></section></>);
}

function Transactions({ ledger, ctx, act }: P) {
  const txs = [...ledger.transactions].filter((t) => !t.voidedAt).sort((a, b) => b.date.localeCompare(a.date));
  return (<><Head t="Transactions" d="Registre des mouvements d'argent. Les rapprochements sont proposés, jamais imposés." />
    <section className="card"><div className="table-wrap"><table className="table stackable"><thead><tr><th>Date</th><th>Libellé</th><th className="num">Montant</th><th>Rapprochement</th><th>Proposition</th></tr></thead><tbody>
      {txs.map((t) => { const st = reconciliationStatus(ledger, t); const s = st === "unmatched" ? suggestMatches(ledger, ctx, t, 1)[0] : undefined; return <tr key={t.id}><td data-label="Date">{t.date}</td><td data-label="Libellé">{t.label}</td><td data-label="Montant" className={`num ${t.direction === "in" ? "pos" : ""}`}>{t.direction === "in" ? "+" : "−"}{eur(t.amountCents)}</td><td data-label="État"><Badge s={st} /></td>
        <td data-label="Proposition">{s ? <div><div className="small">{s.documentLabel} — {s.counterparty} <span className="badge badge-plain">{s.confidence === "high" ? "forte" : s.confidence === "medium" ? "moyenne" : "faible"} · {s.score}</span></div><div className="small muted">{s.reasons[0]}</div><button className="btn btn-sm" onClick={() => act((l, c) => { confirmMatch(l, c, { transactionId: t.id, documentType: s.documentType, documentId: s.documentId, ...(s.paymentId ? { paymentId: s.paymentId } : {}), origin: "suggested" }); }, "Rapprochement confirmé.")}>Confirmer</button></div> : <span className="muted">—</span>}</td></tr>; })}</tbody></table></div></section></>);
}

function Parties({ ledger, kind }: P & { kind: "customers" | "suppliers" }) {
  const list = ledger[kind];
  return (<><Head t={kind === "customers" ? "Clients" : "Fournisseurs"} />
    <section className="card"><div className="table-wrap"><table className="table stackable"><thead><tr><th>Société</th><th>Contact</th><th>Email</th><th className="num">{kind === "customers" ? "Reste dû" : "Reste à payer"}</th></tr></thead><tbody>
      {list.map((p) => { const due = kind === "customers" ? ledger.invoices.filter((i) => i.customerId === p.id && i.status !== "draft").reduce((s, i) => s + invoiceView(ledger, i, today).balanceCents, 0) : ledger.purchaseInvoices.filter((i) => i.supplierId === p.id).reduce((s, i) => s + purchaseView(ledger, i, today).balanceCents, 0); return <tr key={p.id}><td data-label="Société">{p.company}</td><td data-label="Contact">{p.name}</td><td data-label="Email">{p.email}</td><td data-label="Dû" className="num">{eur(due)}</td></tr>; })}</tbody></table></div></section></>);
}

function Reports({ ledger }: P) {
  const inv = ledger.invoices.filter((i) => i.status !== "draft").reduce((s, i) => s + i.totals.totalTtcCents, 0);
  const cashed = ledger.transactions.filter((t) => !t.voidedAt && t.direction === "in").reduce((s, t) => s + t.amountCents, 0);
  return (<><Head t="Rapports" d="Les indicateurs de trésorerie sont distincts des indicateurs comptables : le facturé n'est pas de l'argent encaissé." />
    <div className="grid grid-3"><div className="card kpi"><span className="kpi-label">Facturé TTC (indicateur commercial)</span><span className="kpi-value">{eur(inv)}</span></div><div className="card kpi"><span className="kpi-label">Encaissé (mouvements réels)</span><span className="kpi-value pos">{eur(cashed)}</span></div><div className="card kpi"><span className="kpi-label">Écart</span><span className="kpi-value">{eur(inv - cashed)}</span><span className="kpi-foot">Non comparable à un bénéfice ni à un bilan certifié.</span></div></div></>);
}

function Automations({ ledger }: P) {
  return (<><Head t="Automatisations" d="Rien n'est envoyé sans intégration email configurée ; les opérations à risque exigent une validation humaine." />
    <section className="card"><div className="table-wrap"><table className="table stackable"><thead><tr><th>Nom</th><th>Déclencheur</th><th>Action</th><th>Offre</th><th>Validation</th></tr></thead><tbody>
      {ledger.automationRules.map((r) => <tr key={r.id}><td data-label="Nom"><b>{r.name}</b><div className="small muted">{r.description}</div></td><td data-label="Déclencheur">{r.trigger}</td><td data-label="Action">{r.action}</td><td data-label="Offre">{PLANS[r.minPlan].name}</td><td data-label="Validation">{r.requiresHumanApproval ? "Humaine" : "—"}</td></tr>)}</tbody></table></div></section></>);
}

function Assistant({ ledger, ctx, act }: P) {
  const [log, setLog] = useState<{ q: string; r: AssistantReply }[]>([]);
  const ask = (q: string) => setLog((l) => [...l, { q, r: answerQuestion(ledger, ctx, q) }]);
  return (<><Head t="Assistant EVARA" d="Mode démonstration : aucun modèle d'IA n'est connecté. Réponses simulées, chiffres issus des services métier." />
    <div className="row-wrap">{SUGGESTED_QUESTIONS.map((q) => <button key={q} className="btn btn-sm" onClick={() => ask(q)}>{q}</button>)}</div>
    {log.map((m, i) => <div key={i} className="card card-pad stack"><b>{m.q}</b><p style={{ whiteSpace: "pre-line" }}>{m.r.text}</p><span className="tag-demo" style={{ width: "fit-content" }}>Réponse simulée</span>
      {m.r.proposal?.status === "pending" && <div className="callout callout-warn stack"><div><b>Action proposée : {m.r.proposal.title}</b><div className="small">Données : {m.r.proposal.affectedData.join(", ")}. Conséquences : {m.r.proposal.consequences.join(" ")}</div></div><div className="row"><button className="btn btn-primary btn-sm" onClick={() => { const p = m.r.proposal!; act((l, c) => { confirmProposal(l, c, p, { confirmedByUser: true }); }, "Brouillon de relance préparé (rien n'a été envoyé)."); }}>Confirmer</button></div></div>}</div>)}</>);
}

function Settings({ ledger }: P) {
  const st = integrationStatuses({});
  return (<><Head t="Paramètres" />
    <section className="card"><div className="card-head"><h2>Intégrations externes</h2></div><div className="list">{st.map((s) => <div key={s.id} className="list-item" style={{ cursor: "default" }}><div className="grow"><b>{s.label}</b><div className="small muted">{s.note}</div></div><span className={`badge ${s.configured ? "badge-ok" : "badge-warn"}`}>{s.builtIn ? "Intégré" : s.configured ? "Configuré" : "Non configuré"}</span></div>)}</div></section>
    <section className="card card-pad"><b>Entreprise :</b> {ledger.organizations[0]!.name} · Devise EUR · Fuseau Europe/Paris · Offre {PLANS[ledger.organizations[0]!.plan ?? "discovery"].name} (hypothèse de lancement)</section></>);
}

/* ---------- site marketing ---------- */
function Shell({ children }: { children?: unknown }) {
  return (<>
    <header className="m-nav"><div className="m-wrap m-nav-inner"><A to="/"><Logo /></A>
      <nav className="m-links" aria-label="Principal"><A to="/fonctionnalites">Fonctionnalités</A><A to="/#comment">Comment ça marche</A><A to="/tarifs">Tarifs</A><A to="/securite">Sécurité</A></nav>
      <div className="m-right"><A to="/connexion" className="btn btn-ghost hide-sm">Connexion</A><A to="/app" className="btn btn-dark">Essayer EVARA</A></div></div></header>
    {children}
    <footer className="footer"><div className="m-wrap"><div className="footer-grid"><div><Logo dark /><p style={{ marginTop: 14, maxWidth: 280 }}>Finance, simplified. Votre trésorerie, sous contrôle.</p></div>
      <div><h4>Produit</h4><A to="/fonctionnalites">Fonctionnalités</A><A to="/tarifs">Tarifs</A><A to="/app">Démonstration</A></div><div><h4>Confiance</h4><A to="/securite">Sécurité</A><a href="mailto:support@evara.example">Support</a></div><div><h4>Légal</h4><A to="/confidentialite">Confidentialité</A><A to="/conditions">Conditions</A></div></div>
      <div className="footer-bottom"><span>© EVARA — projet en construction. Aucun client, témoignage ni certification revendiqués.</span></div></div></footer></>);
}
function Home() {
  const d = useMemo(() => { const { ledger } = buildDemoLedger(today); const ctx = buildCtx(ledger, DEMO_USER_ID, DEMO_ORG_ID, today, new Date().toISOString()); return { ledger, ctx, dash: buildDashboard(ledger, ctx), acts: buildActions(ledger, ctx) }; }, []);
  return (<Shell>
    <section className="hero"><div className="m-wrap hero-grid"><div className="page-load"><span className="eyebrow">Finance, simplified.</span><h1>Votre entreprise avance. <em>Votre trésorerie aussi.</em></h1>
      <p className="lead">Devis, factures, dépenses et prévisions : EVARA centralise votre gestion financière et automatise les tâches qui vous prennent du temps.</p>
      <div className="hero-cta"><A to="/app" className="btn btn-primary btn-lg">Découvrir EVARA</A><A to="/app" className="btn btn-lg">Voir la démonstration</A></div><p className="hero-note">Démonstration avec données fictives. Aucun paiement, aucune carte requise.</p></div>
      <div className="hero-stage"><div className="mini-dash"><span className="tag-demo">Données fictives</span>
        <div className="mini-kpis" style={{ marginTop: 8 }}><div className="mini-kpi dark"><div className="l">Solde actuel</div><div className="v">{eur(d.dash.cash.totalCents)}</div></div><div className="mini-kpi"><div className="l">Encaissements attendus</div><div className="v">{eur(d.dash.receivablesCents)}</div></div><div className="mini-kpi"><div className="l">Dépenses à venir</div><div className="v">{eur(d.dash.payablesCents)}</div></div><div className="mini-kpi"><div className="l">Impayés en retard</div><div className="v neg">{eur(d.dash.receivablesOverdueCents)}</div></div></div>
        <div style={{ marginTop: 12 }}><ForecastChart ledger={d.ledger} ctx={d.ctx} /></div></div>
        <div className="float-notes">{d.acts.slice(0, 3).map((a, i) => <div key={a.id} className={`note ${a.severity === "critical" ? "warn" : ""}`} style={{ animationDelay: `${0.6 + i * 0.5}s` }}><span className="ic">!</span><span><b>{a.title}</b>{a.nextStep}</span></div>)}</div></div></div></section>
    <section className="m-section dark"><div className="m-wrap"><div className="sec-head"><span className="eyebrow">Le problème</span><h2>Vous gérez votre entreprise. Pas besoin de passer vos journées à suivre vos chiffres.</h2></div>
      <div className="pain-grid">{[["Les factures en retard", "Relances oubliées, encaissements qui glissent."], ["Les paiements fournisseurs oubliés", "Des échéances qui surprennent."], ["Les données dispersées", "Devis, factures, banque : trois outils, trois vérités."], ["Les prévisions incertaines", "Impossible de savoir ce qu'il restera dans 30 jours."], ["Les tâches répétitives", "Rapprocher, relancer, saisir : du temps perdu."]].map(([t, p], i) => <div className="pain" key={t}><span className="n">0{i + 1}</span><h3>{t}</h3><p>{p}</p></div>)}</div></div></section>
    <section className="m-section"><div className="m-wrap"><div className="sec-head"><span className="eyebrow">La solution</span><h2>Un seul endroit, des modules qui se parlent.</h2><p className="sec-lead">Un devis accepté devient une facture ; un paiement rapproché solde la facture ; la prévision se recalcule.</p></div>
      <div className="module-grid">{[["Devis et facturation", "Numérotation sans doublon, avoirs reliés, PDF A4."], ["Suivi des entrées et sorties", "Import CSV, rapprochement proposé, jamais imposé."], ["Dépenses et fournisseurs", "Facture à payer ≠ décaissement réel."], ["Trésorerie prévisionnelle", "Trois scénarios, simulations, hypothèses expliquées."], ["Automatisation intelligente", "Relances préparées, validation humaine pour les actions à risque."]].map(([t, p], i) => <div key={t} className={`module ${i > 2 ? "wide" : ""}`}><h3>{t}</h3><p>{p}</p></div>)}</div></div></section>
    <section id="comment" className="m-section alt"><div className="m-wrap"><div className="sec-head"><h2>Trois étapes</h2></div><div className="steps"><div className="step"><h3>Centralisez vos opérations</h3><p>Clients, devis, factures, dépenses et relevés au même endroit.</p></div><div className="step"><h3>Automatisez les tâches répétitives</h3><p>EVARA prépare, vous validez.</p></div><div className="step"><h3>Pilotez votre trésorerie</h3><p>Voyez ce qui arrive, simulez, anticipez.</p></div></div>
      <div style={{ marginTop: 40 }}><A to="/app" className="btn btn-primary btn-lg">Ouvrir la démonstration interactive</A></div></div></section>
    <Pricing /></Shell>);
}
function Pricing() {
  return (<section id="tarifs" className="m-section"><div className="m-wrap"><div className="sec-head"><span className="eyebrow">Tarifs</span><h2>Trois offres indicatives</h2><p className="sec-lead">Hypothèses de lancement à tester, pas des tarifs de marché validés. Aucun paiement n'est activé.</p></div>
    <div className="price-grid">{Object.values(PLANS).map((p) => <div key={p.id} className={`price ${p.id === "business" ? "featured" : ""}`}><h3>{p.name}</h3><div className="amount">{p.priceCentsHtMonthly / 100} €<small> HT/mois</small></div><p className="muted">{p.tagline}</p><ul>{p.features.map((f) => <li key={f}>✓ {f}</li>)}</ul><A to="/app" className={`btn ${p.id === "business" ? "btn-mint" : ""}`}>Essayer en démonstration</A></div>)}</div></div></section>);
}
function Doc({ title, children, provisional }: { title: string; children?: unknown; provisional?: boolean }) {
  return <Shell><div className="m-wrap" style={{ padding: "56px 24px" }}><div className="prose"><h1 style={{ fontSize: 38 }}>{title}</h1>{provisional && <div className="callout callout-warn" style={{ margin: "18px 0" }}>Document provisoire : à faire valider par un juriste avant toute mise en production.</div>}{children}</div></div></Shell>;
}
function Auth({ mode }: { mode: "login" | "signup" }) {
  return <Shell><div className="auth-wrap"><div className="card auth-card stack"><h1 style={{ fontSize: 24 }}>{mode === "login" ? "Connexion" : "Créer un compte"}</h1>
    <div className="callout callout-warn">Authentification non configurée : aucun backend (Supabase) n'est branché. Aucun faux compte local n'est créé.</div>
    <div className="field"><label htmlFor="e">Email</label><input id="e" className="input" type="email" disabled /></div><div className="field"><label htmlFor="p">Mot de passe</label><input id="p" className="input" type="password" disabled /></div>
    <button className="btn btn-primary" disabled>{mode === "login" ? "Se connecter" : "Créer mon compte"}</button><A to="/app" className="btn">Explorer la démonstration (données fictives)</A></div></div></Shell>;
}
function Features() {
  const items: [string, string][] = [["Devis", "Lignes, remises, TVA, validité, conversion en facture liée."], ["Factures clients", "Numérotation côté serveur, acomptes, paiements partiels, avoirs, historique."], ["Factures fournisseurs", "Échéancier, paiements partiels, contestation."], ["Transactions", "Import CSV, doublons signalés, rapprochement proposé."], ["Trésorerie", "Prévision explicable, 3 scénarios, simulations sans effet sur les données."], ["Assistant", "Mode démonstration : réponses simulées, actions soumises à confirmation."]];
  return <Shell><section className="m-section"><div className="m-wrap"><div className="sec-head"><h2>Fonctionnalités</h2></div><div className="module-grid">{items.map(([t, p]) => <div className="module" key={t}><h3>{t}</h3><p>{p}</p></div>)}</div></div></section></Shell>;
}

function Root() {
  const path = useRoute().replace(/\/$/, "") || "/";
  useEffect(() => { if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView(); }, [path]);
  if (path.startsWith("/app")) return <App path={path} />;
  if (path === "/fonctionnalites") return <Features />;
  if (path === "/tarifs") return <Shell><Pricing /></Shell>;
  if (path === "/securite") return <Doc title="Sécurité"><p>Principes prévus : séparation des données par entreprise (Row Level Security), contrôle des accès par rôle, chiffrement approprié, journalisation des actions sensibles, sauvegardes.</p><div className="callout callout-warn" style={{ marginTop: 16 }}>EVARA ne revendique aucune certification ni conformité qui n'ait été obtenue. Le mode démonstration ne stocke rien hors de votre navigateur.</div></Doc>;
  if (path === "/connexion") return <Auth mode="login" />;
  if (path === "/inscription") return <Auth mode="signup" />;
  if (path === "/confidentialite") return <Doc title="Politique de confidentialité" provisional><p>Contenu provisoire. La démonstration n'envoie aucune donnée à un serveur.</p></Doc>;
  if (path === "/conditions") return <Doc title="Conditions d'utilisation" provisional><p>Contenu provisoire. Les offres et tarifs sont indicatifs.</p></Doc>;
  return <Home />;
}
createRoot(document.getElementById("root")!).render(<Root />);
