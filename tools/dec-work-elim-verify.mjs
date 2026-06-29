#!/usr/bin/env node
// Byte-exact decoder verification harness.
// Usage: node tools/dec-work-elim-verify.mjs
// Decodes reference JXL files with the current native build and compares
// SHA-256 hashes against the baseline in docs/dec-work-elim-baseline-sha256.txt.
// Exit 0 = all pass. Exit 1 = any mismatch.
//
// The djxl binary is looked up in this order:
//   1. DJXL_PATH env var (override for CI / custom target dirs)
//   2. C:\Tmp\raw-converter-wasm-msvc-target\release\djxl.exe  (build-msvc.ps1 default)
//   3. <repo>/target/release/djxl  (plain cargo build fallback)

import { execSync } from 'child_process';
import { readFileSync, existsSync, unlinkSync } from 'fs';
import { createHash } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const BASELINE = join(REPO, 'docs', 'dec-work-elim-baseline-sha256.txt');
const FIXTURES = join(REPO, 'packages', 'jxl-test-corpus', 'dist', 'fixtures');
const TMP = join(os.tmpdir(), `dec_verify_out_${process.pid}.png`);

// Locate djxl binary — check env override, MSVC target, then default target.
function findDjxl() {
  if (process.env.DJXL_PATH) return process.env.DJXL_PATH;
  const msvc = 'C:\\Tmp\\raw-converter-wasm-msvc-target\\release\\djxl.exe';
  if (existsSync(msvc)) return msvc;
  const ext = os.platform() === 'win32' ? '.exe' : '';
  return join(REPO, 'target', 'release', `djxl${ext}`);
}

const DJXL = findDjxl();

if (!existsSync(DJXL)) {
  console.error(`ERROR: djxl not found at ${DJXL}`);
  console.error('Build with: .\\build-msvc.ps1 build --release -p raw-pipeline --bin djxl');
  process.exit(1);
}

const baseline = Object.fromEntries(
  readFileSync(BASELINE, 'utf8').trim().split('\n')
    .filter(l => l.trim())
    .map(l => {
      const [hash, ...rest] = l.split('  ');
      return [rest.join('  ').trim(), hash.toUpperCase()];
    })
);

if (Object.keys(baseline).length === 0) {
  console.error('ERROR: baseline file is empty');
  process.exit(1);
}

let pass = 0, fail = 0, skipped = 0;
for (const [name, expected] of Object.entries(baseline)) {
  const jxlPath = join(FIXTURES, name);
  if (!existsSync(jxlPath)) {
    console.error(`SKIP: ${name} not found at ${jxlPath}`);
    skipped++;
    continue;
  }
  try {
    execSync(`"${DJXL}" "${jxlPath}" "${TMP}"`, { stdio: 'pipe' });
  } catch (e) {
    console.error(`FAIL  ${name} (decode error: ${e.message})`);
    fail++;
    continue;
  }
  const actual = createHash('sha256').update(readFileSync(TMP)).digest('hex').toUpperCase();
  try { unlinkSync(TMP); } catch {}
  if (actual === expected) {
    console.log(`PASS  ${name}`);
    pass++;
  } else {
    console.error(`FAIL  ${name}`);
    console.error(`  expected: ${expected}`);
    console.error(`  actual:   ${actual}`);
    fail++;
  }
}
if (skipped > 0 && pass === 0 && fail === 0) {
  console.error('ERROR: no fixtures found — check FIXTURES path');
  process.exit(1);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
