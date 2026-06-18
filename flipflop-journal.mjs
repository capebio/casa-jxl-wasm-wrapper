// flipflop-journal.mjs — hand-rolled TOON encode + journal append (zero deps)
import { existsSync, readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';

const pad = (n) => ' '.repeat(n);

export function toonVal(v) {
  if (v === null || v === undefined) return 'n/a';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'n/a';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  const s = String(v);
  return /[,:\n"]|^\s|\s$/.test(s) ? JSON.stringify(s) : s;
}

export function toonKv(key, val, indent = 0) {
  return `${pad(indent)}${key}: ${toonVal(val)}\n`;
}

export function toonBlock(key, obj, indent = 0) {
  let s = `${pad(indent)}${key}:\n`;
  for (const [k, v] of Object.entries(obj)) s += toonKv(k, v, indent + 2);
  return s;
}

export function toonTable(key, cols, rows, indent = 0) {
  let s = `${pad(indent)}${key}[${rows.length}]{${cols.join(',')}}:\n`;
  for (const row of rows) {
    s += pad(indent + 2) + cols.map((c) => toonVal(row[c])).join(',') + '\n';
  }
  return s;
}

export function buildRecord(r) {
  let s = `=== flipflop ${r.ts} ${r.name} ===\n`;
  s += toonKv('schema', 'flipflop/v1');
  s += toonKv('ts', r.ts);
  s += toonKv('name', r.name);
  s += toonKv('description', r.description);
  s += toonKv('first_paint_of_day', r.first_paint_of_day);
  s += toonBlock('env', r.env);
  s += toonBlock('config', r.config);
  s += toonTable('summary', r.summaryCols, r.summary);
  if (r.marks && r.marks.length) s += toonTable('marks', r.marksCols, r.marks);
  s += toonTable('flips', r.flipsCols, r.flips);
  s += toonBlock('thermal', r.thermal);
  s += toonKv('verdict', r.verdict);
  return s;
}

export function appendRecord(journalPath, recordText) {
  mkdirSync(dirname(journalPath), { recursive: true });
  // separate records with a blank line; recordText already ends with \n
  const sep = existsSync(journalPath) && readFileSync(journalPath, 'utf8').length ? '\n' : '';
  appendFileSync(journalPath, sep + recordText);
}

export function firstPaintOfDay(journalPath, todayYmd) {
  if (!existsSync(journalPath)) return true;
  const txt = readFileSync(journalPath, 'utf8');
  const dates = [...txt.matchAll(/^ts:\s*(\d{4}-\d{2}-\d{2})/gm)].map((m) => m[1]);
  return !dates.includes(todayYmd);
}
