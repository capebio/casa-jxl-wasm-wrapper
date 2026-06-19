#!/usr/bin/env node
// ecosystem-map-gen.mjs — regenerate the GRAPH in docs/ecosystem-map.html from
// docs/ecosystem-map.model.json reconciled against the live Rust source.
//
//   node tools/ecosystem-map-gen.mjs          # reconcile + write HTML + print drift
//   node tools/ecosystem-map-gen.mjs --check  # report only, exit 1 on stale/broken (CI)
//
// The model.json is the SOURCE OF TRUTH for the curated narrative (systems,
// conceptual modules, dataflow edges + payloads). This tool keeps the
// structural facts honest: it pulls real line numbers + doc-comment fallbacks,
// flags map nodes whose Rust symbol no longer exists (STALE), pub fns the map
// doesn't show yet (UNMAPPED), and source files absent from the map (ORPHAN).
//
// "Push an update": edit code → run this → map refreshes + drift report.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODEL = path.join(ROOT, "docs/ecosystem-map.model.json");
const HTML = path.join(ROOT, "docs/ecosystem-map.html");
const SCAN_DIRS = ["crates/raw-pipeline/src", "crates/jxl-ffi/src"]; // for ORPHAN-file detection
const CHECK = process.argv.includes("--check");

const C = { red:"\x1b[31m", yel:"\x1b[33m", grn:"\x1b[32m", dim:"\x1b[2m", cyn:"\x1b[36m", rst:"\x1b[0m" };
const warnings = [];
const errors = [];

// ── git activity (commit count per file) ─────────────────────────────────────
// `--format=""` emits a blank line per commit; non-blank lines are file paths.
const gitChanges = new Map();  // relative path → number of commits that touched it
try {
  const out = execSync("git log --all --format=\"\" --name-only", { cwd: ROOT, encoding: "utf8", maxBuffer: 8*1024*1024 });
  for (const line of out.split(/\r?\n/)) {
    const t = line.trim();
    if (t) gitChanges.set(t, (gitChanges.get(t) || 0) + 1);
  }
} catch { /* non-git dir or no commits — leave map empty */ }

// ── Rust source scanner ──────────────────────────────────────────────────────
// matches pub AND private decls (the map references private helpers + extern "C" fns)
const DECL = /^(\s*)(pub(?:\([^)]*\))?\s+)?(?:async\s+|unsafe\s+|default\s+|const\s+|extern\s+(?:"[^"]*"\s+)?)*(fn|struct|enum|trait|mod|type|static)\s+([A-Za-z_]\w*)/;
const fileCache = new Map();
function scanRust(abs) {
  if (fileCache.has(abs)) return fileCache.get(abs);
  let txt; try { txt = fs.readFileSync(abs, "utf8"); } catch { fileCache.set(abs, null); return null; }
  const lines = txt.split(/\r?\n/);
  const byName = new Map();        // name -> {kind,line,doc}
  const pubFns = [];
  let doc = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const dm = ln.match(/^\s*\/\/\/ ?(.*)$/);
    if (dm) { doc.push(dm[1]); continue; }
    const m = ln.match(DECL);
    if (m) {
      const isPub = !!m[2], kind = m[3], name = m[4];
      // first decl of a name wins (method vs free fn collisions are rare here)
      if (!byName.has(name)) byName.set(name, { kind, line: i + 1, doc: doc.join(" ").trim(), pub: isPub });
      if (kind === "fn" && isPub) pubFns.push(name);  // only the public surface counts as "exported"
      doc = [];
      continue;
    }
    if (ln.trim() === "" || /^\s*#\[/.test(ln)) continue; // blanks / attributes keep the doc buffer
    doc = [];
  }
  const out = { byName, pubFns, lineCount: lines.length };
  fileCache.set(abs, out);
  return out;
}

// ── load model ───────────────────────────────────────────────────────────────
const model = JSON.parse(fs.readFileSync(MODEL, "utf8"));
const nodes = model.nodes, edges = model.edges;
const byId = new Map(nodes.map(n => [n.id, n]));

// reference integrity (parents + edges)
for (const n of nodes) if (n.p && !byId.has(n.p)) errors.push(`node "${n.id}" → missing parent "${n.p}"`);
const pays = new Set(Object.keys(model.payloads));
for (const e of edges) {
  if (!byId.has(e.f)) errors.push(`edge → missing source "${e.f}"`);
  if (!byId.has(e.t)) errors.push(`edge → missing target "${e.t}"`);
  if (e.pay && !pays.has(e.pay)) warnings.push(`edge ${e.f}→${e.t} → unknown payload "${e.pay}"`);
}

// resolve each node's nearest ancestor that is a real .rs file
function fileAncestor(n) {
  let c = n;
  while (c) {
    if (c.path && /\.rs$/.test(c.path)) {
      const abs = path.join(ROOT, c.path);
      if (fs.existsSync(abs)) return { node: c, abs };
      else { warnings.push(`file node "${c.id}" → path not found: ${c.path}`); return null; }
    }
    c = c.p ? byId.get(c.p) : null;
  }
  return null;
}
const STOP = new Set(["the","and","via","per","one","raw","for","rgb","rgba","not","all","new","via","map","two"]);
function candidates(label) {
  const starred = label.includes("*");
  const toks = (label.match(/[A-Za-z_][A-Za-z0-9_]*/g) || [])
    .filter(t => t.length >= 3 && !STOP.has(t.toLowerCase()));
  return { starred, toks };
}
// a token is "code-shaped" (worth verifying) if snake_case, or CamelCase that is a decl here
function verifiable(toks, scan) {
  return toks.some(t => t.includes("_") || (/[a-z]/.test(t) && /[A-Z]/.test(t) && scan.byName.has(t)));
}

// ── reconcile structure ──────────────────────────────────────────────────────
const claimed = new Map();  // abs -> Set(symbol names the map accounts for)
let staleCount = 0, enriched = 0;
for (const n of nodes) {
  delete n.stale; delete n.line;  // recompute fresh
  if (n.path && /\.rs$/.test(n.path)) {            // file node: attach line count
    const sc = scanRust(path.join(ROOT, n.path));
    if (sc) n.lines = sc.lineCount;
  }
  // git activity: count commits that touched this file (any extension → real path)
  if (n.path && /\.\w+$/.test(n.path)) {
    const rel = n.path.replace(/\\/g, "/");
    n.gc = gitChanges.get(rel) || 0;
  } else {
    delete n.gc;
  }
  if (n.k !== "fn" && n.k !== "module" && n.k !== "component") continue;
  const fa = fileAncestor(n);
  if (!fa) continue;
  const sc = scanRust(fa.abs); if (!sc) continue;
  if (!claimed.has(fa.abs)) claimed.set(fa.abs, new Set());
  const { starred, toks } = candidates(n.l);
  if (!toks.length) continue;
  let hit = null;
  for (const t of toks) {
    if (sc.byName.has(t)) { hit = hit || sc.byName.get(t); claimed.get(fa.abs).add(t); continue; }
    // prefix match: a starred family (build_pre_lut*) or a long unique stem
    // (molchanov_residuals → molchanov_residuals_and_atensor)
    if (starred || t.length >= 5) {
      for (const name of sc.byName.keys()) if (name.startsWith(t)) { hit = hit || sc.byName.get(name); claimed.get(fa.abs).add(name); }
    }
  }
  if (hit) {
    n.line = hit.line;
    if (!n.desc && hit.doc) { n.desc = hit.doc; enriched++; }
  } else if (n.k === "fn" && verifiable(toks, sc)) {   // only real fn nodes can be STALE; modules/components are conceptual
    n.stale = true; staleCount++;
    warnings.push(`STALE  ${n.id} "${n.l}" → no symbol in ${fa.node.path}`);
  }
}

// ── drift: unmapped pub fns + orphan files ───────────────────────────────────
const unmapped = [];
for (const [abs, set] of claimed) {
  const sc = scanRust(abs); if (!sc) continue;
  const rel = path.relative(ROOT, abs).replace(/\\/g, "/");
  const miss = [...new Set(sc.pubFns)].filter(f => !set.has(f));
  if (miss.length) unmapped.push({ rel, miss });
}
const mappedFiles = new Set(nodes.filter(n => n.path && /\.rs$/.test(n.path)).map(n => n.path.replace(/\\/g, "/")));
const orphanFiles = [];
function walk(dir) {
  let ents; try { ents = fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel);
    else if (e.name.endsWith(".rs") && !mappedFiles.has(rel)) orphanFiles.push(rel);
  }
}
SCAN_DIRS.forEach(walk);

// ── emit GRAPH into the HTML ─────────────────────────────────────────────────
const KEEP = ["id", "p", "k", "l", "col", "path", "line", "lines", "special", "stale", "tech", "n", "gate", "mutates", "desc", "gc"];
const clean = nodes.map(n => { const o = {}; for (const k of KEEP) if (n[k] !== undefined) o[k] = n[k]; return o; });
const gitMax = Math.max(0, ...clean.filter(n => n.gc !== undefined).map(n => n.gc));
const generated = new Date().toISOString().slice(0, 10);
const graphJs =
`// <<ECOSYSTEM-GRAPH-START>> generated by tools/ecosystem-map-gen.mjs — edit docs/ecosystem-map.model.json, not here
const GRAPH = {
  version: ${JSON.stringify(model.version)},
  generated: ${JSON.stringify(generated)},
  colors: ${JSON.stringify(model.colors)},
  payloads: ${JSON.stringify(model.payloads)},
  tech: ${JSON.stringify(model.tech || {})},
  gitMax: ${gitMax},
  nodes: ${JSON.stringify(clean)},
  edges: ${JSON.stringify(edges)},
};
// <<ECOSYSTEM-GRAPH-END>>`;

if (!CHECK) {
  let html = fs.readFileSync(HTML, "utf8");
  const re = /\/\/ <<ECOSYSTEM-GRAPH-START>>[\s\S]*?\/\/ <<ECOSYSTEM-GRAPH-END>>/;
  if (!re.test(html)) { console.error(`${C.red}markers not found in ${HTML}${C.rst}`); process.exit(2); }
  fs.writeFileSync(HTML, html.replace(re, graphJs));
  // keep the model's generated stamp in sync (handy for diffs)
  model.generated = generated;
  fs.writeFileSync(MODEL, JSON.stringify(model, null, 2));
}

// ── report ───────────────────────────────────────────────────────────────────
console.log(`\n${C.cyn}ecosystem-map-gen${C.rst}  ${generated}  ${C.dim}(${CHECK ? "check" : "wrote " + path.relative(ROOT, HTML)})${C.rst}`);
console.log(`  nodes ${nodes.length} · edges ${edges.length} · descriptions enriched ${enriched}`);
if (errors.length) { console.log(`\n${C.red}✖ ${errors.length} broken reference(s):${C.rst}`); errors.forEach(e => console.log(`    ${e}`)); }
if (staleCount) {
  console.log(`\n${C.yel}⚠ ${staleCount} STALE node(s)${C.rst} ${C.dim}(map points at code that no longer exists):${C.rst}`);
  warnings.filter(w => w.startsWith("STALE")).forEach(w => console.log(`    ${w.slice(6)}`));
}
const otherW = warnings.filter(w => !w.startsWith("STALE"));
if (otherW.length) { console.log(`\n${C.yel}⚠ ${otherW.length} warning(s):${C.rst}`); otherW.forEach(w => console.log(`    ${w}`)); }
if (orphanFiles.length) {
  console.log(`\n${C.yel}○ ${orphanFiles.length} source file(s) not on the map:${C.rst}`);
  orphanFiles.forEach(f => console.log(`    ${f}`));
}
const unmappedTotal = unmapped.reduce((s, u) => s + u.miss.length, 0);
if (unmappedTotal) {
  console.log(`\n${C.dim}○ ${unmappedTotal} exported fn(s) in mapped files not shown on the map (candidates to add):${C.rst}`);
  unmapped.forEach(u => console.log(`    ${C.dim}${u.rel}: ${u.miss.slice(0, 8).join(", ")}${u.miss.length > 8 ? ` …(+${u.miss.length - 8})` : ""}${C.rst}`));
}
if (!errors.length && !staleCount) console.log(`\n${C.grn}✓ map is in sync with the source${C.rst}${orphanFiles.length ? C.dim + " (orphan/unmapped notes above are advisory)" + C.rst : ""}.`);
console.log("");

// orphan/unmapped are advisory; only broken refs + stale nodes fail --check.
if (CHECK && (errors.length || staleCount)) process.exit(1);
