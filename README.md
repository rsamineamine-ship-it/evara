# EVARA — copilote financier pour TPE/PME

Site marketing + application de gestion financière (devis, factures, dépenses, transactions, rapprochement, trésorerie prévisionnelle, assistant, automatisations). Langue : français. Devise par défaut : EUR.

## État réel du projet (honnête)

**Fonctionne aujourd'hui (mode démonstration, données fictives, en mémoire dans le navigateur) :**
- Moteur métier `src/domain` (TypeScript strict, montants en centimes) : totaux HT/TVA/TTC, devis → facture, paiements partiels, retards, avoirs, numérotation, import CSV, doublons, rapprochement, prévisions 3 scénarios, simulations, rapports, automatisations idempotentes, assistant simulé. **69 tests** (`npm test`).
- Site public (accueil, fonctionnalités, tarifs, sécurité, connexion/inscription, pages légales provisoires).
- Application : vue d'ensemble, trésorerie + simulations, devis, factures (émission, paiement), achats/dépenses, transactions (rapprochement proposé puis confirmé), clients, fournisseurs, rapports, automatisations, assistant, paramètres.
- PDF A4 devis/factures/avoirs (`src/pdf/document.ts`, testé).
- Schéma SQL avec RLS : `supabase/migrations/0001_init.sql` (**non appliqué ni testé** sur une vraie base).

**Pas encore fait / à brancher :** authentification réelle (Supabase), persistance serveur, éditeur complet de devis/factures dans l'UI, assistant de saisie/import CSV dans l'UI (le moteur est prêt), téléchargement PDF depuis l'UI, email, stockage, IA, paiement des abonnements, facturation électronique (un PDF ne suffit pas légalement), banque. Pas de Next.js/Tailwind/Recharts/Motion : le registre npm était inaccessible lors du développement (React 19 + esbuild + CSS + SVG à la place).

## Démarrer
```bash
npm install
npm run check      # typecheck + tests + build
npm run build && npm start   # http://localhost:4173
```
Si `npm install` fonctionne, supprimez `typings/*-shim.d.ts` (les vrais `@types/*` prennent le relais).

## Configuration
Copiez `.env.example`. Sans variables, l'application reste en démonstration et le dit (Paramètres → Intégrations).

## Déploiement
Hébergement statique avec repli SPA (`dist/_redirects` fourni). Backend : `supabase db push` puis brancher l'authentification.

## Conformité
Aucune certification ni conformité n'est revendiquée. Pages légales : provisoires, à faire valider.
