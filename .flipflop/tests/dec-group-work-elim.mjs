// dec-group-work-elim.mjs
// OLD vs NEW libjxl-012 dec_group.cc: 7 work-elimination optimisations.
//
// OLD (8feaac3b): base branch — sparse ProcessSections + max_block_area precompute
// NEW (880a06aa): + 7 dec_group opts:
//   1. component-aware qblock clear + extended dc_only gate (X/B skip when Y dc_only)
//   2. DequantSingleBlock template specialization (covered_blocks==1)
//   3. hoist JpegGroupParams from per-branch to per-call
//   4. JPEG NeedsGroupRenderInput + idct_row guard
//   5. EnsureEntropyPredictors / EnsureRenderWorkspace phase split
//   6. persistent AC-occupancy sidecar (pre-sized vector)
//   7. fix ac_occupancy block_idx to include group offset
//
// Byte-exactness proven by tools/dec-work-elim-verify.mjs (4 SHA hashes, 0 failures).
// equal() does a byte-compare of the output PNGs as a runtime sanity guard.
//
// Build artifacts:
//   OLD: submodule@8feaac3b → C:\Tmp\djxl_old.exe
//   NEW: submodule@880a06aa → C:\Tmp\djxl_new.exe

import { execFileSync } from 'node:child_process';
import { readFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const OLD = 'C:\\Tmp\\djxl_old.exe';
const NEW = 'C:\\Tmp\\djxl_new.exe';

let _seq = 0;
function tmpPng() { return `${tmpdir()}\\ff_djxl_${process.pid}_${_seq++}.png`; }

function decodeWith(exe, jxlPath) {
  const out = tmpPng();
  try {
    execFileSync(exe, [jxlPath, out], { stdio: 'pipe', timeout: 60_000 });
    const buf = readFileSync(out);
    try { unlinkSync(out); } catch {}
    return buf;
  } catch (e) {
    try { if (existsSync(out)) unlinkSync(out); } catch {}
    throw e;
  }
}

export const name = 'dec-group-work-elim';
export const description =
  'libjxl-012 dec_group 7-opt work-elimination: component dc_only + DequantSingle + ' +
  'JpegParams hoist + idct_row guard + phase-split init + ac_occupancy presizing';

// setup: return the file path so run() receives the path string directly
// (avoids loading the entire JXL into a JS buffer that run() would discard anyway)
export const setup = (loaded) => loaded.path;

// Real JXL corpus of varying complexity:
//   20.5MP lossy photo — many decode groups, exercises all changed code paths
//   1.2MP thumb (e3)  — moderate size, mid-range complexity
//   lossless 16-bit   — lossless path through DequantBlock
export const corpus = () => [
  {
    name: 'P2200619-20.5MP',
    kind: 'file',
    path: 'C:/Foo/raw-converter-wasm/docs/Benchmark results/P2200619-prog-p6-q85.jxl',
    rounds: 10,
  },
  {
    name: 'medium-thumb-e3',
    kind: 'file',
    path: 'C:/Foo/raw-converter-wasm/timings/fastest/medium-thumb-e3.jxl',
    rounds: 10,
  },
  {
    name: 'lossless-16bit',
    kind: 'file',
    path: 'C:/Foo/raw-converter-wasm/packages/jxl-test-corpus/dist/fixtures/lossless-16bit.jxl',
    rounds: 20,
  },
];

export const variants = [
  {
    name: 'OLD (8feaac3b)',
    baseline: true,
    run(jxlPath, _ctx) {
      return decodeWith(OLD, jxlPath);
    },
  },
  {
    name: 'NEW (880a06aa +7 opts)',
    run(jxlPath, _ctx) {
      return decodeWith(NEW, jxlPath);
    },
  },
];

// Byte-compare output PNGs — mismatch or missing output → trust:low
export const equal = (a, b) => {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
