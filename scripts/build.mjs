#!/usr/bin/env node
/**
 * Build de production : bundle React + CSS avec esbuild, copie des ressources publiques, génération d'index.html.
 * esbuild est résolu depuis node_modules, sinon depuis /opt/npm-tools (environnement hors-ligne de développement).
 */
import { createRequire } from "node:module";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

function loadEsbuild() {
  for (const p of ["esbuild", "/opt/npm-tools/node_modules/esbuild"]) {
    try { return require(p); } catch { /* essai suivant */ }
  }
  throw new Error("esbuild introuvable : exécutez `npm install`.");
}

const esbuild = loadEsbuild();
const watch = process.argv.includes("--watch");
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const options = {
  entryPoints: { app: join(root, "src/ui/main.tsx") },
  outdir: dist,
  bundle: true,
  format: "esm",
  target: ["es2022"],
  platform: "browser",
  jsx: "automatic",
  minify: !watch,
  sourcemap: watch ? "inline" : true,
  splitting: false,
  legalComments: "none",
  loader: { ".woff": "file", ".svg": "text" },
  define: { "process.env.NODE_ENV": JSON.stringify(watch ? "development" : "production") },
  // Variables publiques uniquement (jamais de secret côté client).
  nodePaths: ["/home/claude/.npm-global/lib/node_modules", "/opt/npm-tools/node_modules"],
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("Surveillance activée.");
} else {
  const res = await esbuild.build({ ...options, metafile: true });
  const out = Object.entries(res.metafile.outputs).filter(([k]) => /\.(js|css)$/.test(k)).map(([k, v]) => `${k.replace(`${root}/`, "")}  ${(v.bytes / 1024).toFixed(1)} Ko`);
  console.log(out.join("\n"));
}

cpSync(join(root, "public"), dist, { recursive: true });
const html = readFileSync(join(root, "src/ui/index.html"), "utf8");
writeFileSync(join(dist, "index.html"), html);
// Redirections SPA pour les hébergeurs statiques (Netlify / Cloudflare Pages).
writeFileSync(join(dist, "_redirects"), "/*  /index.html  200\n");

function size(dir) { let n = 0; for (const f of readdirSync(dir)) { const p = join(dir, f); n += statSync(p).isDirectory() ? size(p) : statSync(p).size; } return n; }
if (!watch) console.log(`dist/ prêt : ${(size(dist) / 1024).toFixed(0)} Ko au total`);
