// OLD-vs-NEW flipflop for the enc_modular byte-exact opts.
// Runs the two harness exes (built against libjxl OLD@2169106a vs NEW=+edits)
// interleaved over the RGB corpus. Proves byte-exact (FNV hash per file must
// match) and reports enc/dec speedup. Round-alternated to cancel thermal drift.
//
// Run: node run-ab.mjs [rounds] [effort]
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const ROUNDS = parseInt(process.argv[2] || "5", 10);
const EFFORT = parseInt(process.argv[3] || "3", 10);
const RGB_DIR = process.env.RGB_DIR || String.raw`C:\Tmp\rcw-rgb`;
const MODE = process.env.MODE || "lossy";
const SIDES = [
  { tag: "old", exe: String.raw`C:\temp\jxl_old.exe` },
  { tag: "new", exe: String.raw`C:\temp\jxl_new.exe` },
];

function runOnce(side) {
  const out = execFileSync(side.exe, [RGB_DIR], {
    env: { ...process.env, EFFORT: String(EFFORT), ROUNDS: "1", TAG: side.tag, MODE },
    maxBuffer: 64 * 1024 * 1024, encoding: "utf8",
  });
  const rows = [];
  for (const line of out.split(/\r?\n/)) {
    const s = line.trim();
    if (s.startsWith("{") && s.endsWith("}")) { try { rows.push(JSON.parse(s)); } catch {} }
  }
  return rows;
}

const acc = {};
function stash(side, rows) {
  for (const r of rows) {
    (acc[r.file] ??= {});
    const a = (acc[r.file][side.tag] ??= { enc: [], dec: [], bytes: 0, hash: r.hash, butter: r.butter, mp: r.mp });
    a.enc.push(r.enc_ms); a.dec.push(r.dec_ms); a.bytes = r.bytes; a.hash = r.hash; a.butter = r.butter;
  }
}

console.log(`OLD vs NEW: ${ROUNDS} rounds, effort ${EFFORT}, mode=${MODE}, dir=${RGB_DIR}, interleaved\n`);
for (let r = 0; r < ROUNDS; r++) {
  const order = r % 2 === 0 ? SIDES : [...SIDES].reverse();
  for (const side of order) stash(side, runOnce(side));
  process.stdout.write(`  round ${r + 1}/${ROUNDS} done\r`);
}
console.log("\n");

const med = (v) => { if (!v.length) return 0; const a = v.slice().sort((x, y) => x - y); return a[a.length >> 1]; };
const pad = (s, n) => String(s).padEnd(n);
const padl = (s, n) => String(s).padStart(n);

const files = Object.keys(acc).sort();
let mismatches = 0, encGeoO = 1, encGeoN = 1, decGeoO = 1, decGeoN = 1, n = 0;
console.log(pad("file", 26) + padl("MP", 6) + padl("encOLD", 9) + padl("encNEW", 9) + padl("x", 7) + padl("decOLD", 9) + padl("decNEW", 9) + padl("x", 7) + padl("bytes", 9) + "  byte-exact");
for (const f of files) {
  const O = acc[f].old, N = acc[f].new;
  if (!O || !N) continue;
  const eO = med(O.enc), eN = med(N.enc), dO = med(O.dec), dN = med(N.dec);
  const exact = O.hash === N.hash && O.bytes === N.bytes;
  if (!exact) mismatches++;
  encGeoO *= eO; encGeoN *= eN; decGeoO *= dO; decGeoN *= dN; n++;
  console.log(
    pad(f.slice(0, 25), 26) + padl(O.mp.toFixed(1), 6) +
    padl(eO.toFixed(1), 9) + padl(eN.toFixed(1), 9) + padl((eO / Math.max(1e-9, eN)).toFixed(3) + "x", 7) +
    padl(dO.toFixed(1), 9) + padl(dN.toFixed(1), 9) + padl((dO / Math.max(1e-9, dN)).toFixed(3) + "x", 7) +
    padl(O.bytes, 9) + "  " + (exact ? "YES" : `NO  (old ${O.hash}/${O.bytes} vs new ${N.hash}/${N.bytes})`)
  );
}
const g = (p, m) => Math.pow(p, 1 / m);
console.log(`\ngeomean: encode ${(g(encGeoO, n) / g(encGeoN, n)).toFixed(4)}x  decode ${(g(decGeoO, n) / g(decGeoN, n)).toFixed(4)}x   (>1 = NEW faster)`);
console.log(mismatches === 0
  ? `\n*** BYTE-EXACT: all ${n} files produce IDENTICAL encoded bytes (OLD == NEW). ***`
  : `\n*** WARNING: ${mismatches}/${n} files DIFFER — NOT byte-exact. ***`);

writeFileSync(String.raw`C:\Foo\rcw-verify\ab-result.json`,
  JSON.stringify({ rounds: ROUNDS, effort: EFFORT, mismatches, files: files.map(f => ({ file: f, ...acc[f] })) }, null, 2));
