// Coverage ledger: track which (file, lens) the optimizer agents examined and how many times.
// Distinguishes "examined & clean" (visits>0, lastFindings===0) from "never looked" (gap).
// Persisted JSON; query for gaps (missed) and saturation (dry → stop sweeping).
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function emptyLedger() { return { schema: 'optimize-coverage/v1', files: {}, runs: [] }; }

export function recordSweep(ledger, { run, lens, examined = [], findingsByFile = {} }) {
  const L = { ...ledger, files: { ...ledger.files }, runs: [...ledger.runs] };
  if (run && !L.runs.includes(run)) L.runs.push(run);
  for (const file of examined) {
    const byLens = L.files[file] ? { ...L.files[file] } : {};
    const cur = byLens[lens] || { visits: 0, lastRun: null, lastFindings: 0, totalFindings: 0 };
    const lf = findingsByFile[file] ?? 0;
    byLens[lens] = {
      visits: cur.visits + 1,
      lastRun: run ?? cur.lastRun,
      lastFindings: lf,
      totalFindings: cur.totalFindings + lf,
    };
    L.files[file] = byLens;
  }
  return L;
}

export function gaps(ledger, files, lenses) {
  const out = [];
  for (const file of files) for (const lens of lenses) {
    if (!ledger.files[file]?.[lens]) out.push({ file, lens });
  }
  return out;
}

export function saturated(ledger, minVisits = 2) {
  const out = [];
  for (const [file, byLens] of Object.entries(ledger.files)) {
    for (const [lens, e] of Object.entries(byLens)) {
      if (e.visits >= minVisits && e.lastFindings === 0) out.push({ file, lens, visits: e.visits });
    }
  }
  return out;
}

export function underVisited(ledger, files, lenses, minVisits = 2) {
  const out = [];
  for (const file of files) for (const lens of lenses) {
    const e = ledger.files[file]?.[lens];
    const visits = e?.visits ?? 0;
    if (visits < minVisits) out.push({ file, lens, visits });
  }
  return out;
}

// Per-lens productivity rollup — how productive each lens is across everything it examined.
// Sorted most-productive first (by findings_per_visit, then total_findings).
export function lensStats(ledger) {
  const acc = {};
  for (const byLens of Object.values(ledger.files)) {
    for (const [lens, e] of Object.entries(byLens)) {
      const a = acc[lens] ??= { lens, files_examined: 0, visits: 0, total_findings: 0, dry_files: 0 };
      a.files_examined += 1;
      a.visits += e.visits;
      a.total_findings += e.totalFindings;
      if (e.lastFindings === 0) a.dry_files += 1;
    }
  }
  return Object.values(acc)
    .map(a => ({ ...a, findings_per_visit: a.visits ? +(a.total_findings / a.visits).toFixed(2) : 0 }))
    .sort((x, y) => y.findings_per_visit - x.findings_per_visit || y.total_findings - x.total_findings);
}

export function matrix(ledger, files, lenses) {
  return files.map(file => {
    const row = { file };
    for (const lens of lenses) row[lens] = ledger.files[file]?.[lens]?.visits ?? 0;
    return row;
  });
}

export function loadLedger(path) {
  if (!existsSync(path)) return emptyLedger();
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return emptyLedger(); }
}

export function saveLedger(path, ledger) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(ledger, null, 2));
}
