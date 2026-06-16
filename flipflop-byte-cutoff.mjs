// Targeted flip-flop A/B harness for jxl-byte-cutoff-probe.js + jxl-progressive-byte-benchmark-core.js changes.
// Tests the byte-walking machinery (cursor vs scalar, eager vs lazy, drainTurns) WITHOUT the real WASM decoder.
// 10 interleaved rounds per test; reports medians. Run: node flipflop-byte-cutoff.mjs

import { ByteIntervalCursor, LazyByteIntervalCursor, exactBuffer } from './web/jxl-byte-utils.js';
import { buildByteCutoffPlan } from './web/jxl-byte-cutoff-probe.js';

const hrMs = () => Number(process.hrtime.bigint()) / 1e6;
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// Synthetic JXL-sized byte stream (~2 MB) and a realistic cutoff plan.
const TOTAL = 2 * 1024 * 1024;
const jxl = new Uint8Array(TOTAL);
for (let i = 0; i < TOTAL; i++) jxl[i] = i & 0xff;
const plan = buildByteCutoffPlan(TOTAL, { transportProfile: 'lte', maxSteps: 12 });
const tChunk = 16 * 1024; // lte chunkBytes
const ROUNDS = 10;

// Mock decoder: push is a no-op that just sums byteLengths (forces buffer materialization, prevents dead-code elision).
let sink = 0;
const mockPush = (buf) => { sink += buf.byteLength; };

// ---- Walk helpers (mirror streamDecodeCutoffs inner loop) ----
function walkCursor(CursorCls) {
  const cursor = new CursorCls(jxl, tChunk);
  let offset = 0;
  for (const entry of plan) {
    if (entry.bytes <= offset) continue;
    while (offset < entry.bytes) {
      const need = entry.bytes - offset;
      const { buffer, advanced } = cursor.nextFor(need);
      if (!buffer || advanced <= 0) {
        const nextOffset = Math.min(entry.bytes, offset + tChunk);
        mockPush(exactBuffer(jxl.subarray(offset, nextOffset)));
        offset = nextOffset;
      } else { mockPush(buffer); offset += advanced; }
    }
  }
}

function walkScalar() {
  let offset = 0;
  for (const entry of plan) {
    if (entry.bytes <= offset) continue;
    while (offset < entry.bytes) {
      const need = entry.bytes - offset;
      const end = Math.min(offset + Math.min(need, tChunk), jxl.byteLength);
      mockPush(exactBuffer(jxl.subarray(offset, end)));
      offset = end;
    }
  }
}

// ---- Test 1: cursor (eager) vs raw subarray scalar ----
function test1() {
  const A = [], B = [];
  for (let r = 0; r < ROUNDS; r++) {
    let t = hrMs(); walkCursor(ByteIntervalCursor); A.push(hrMs() - t);
    t = hrMs(); walkScalar(); B.push(hrMs() - t);
  }
  return { name: 'T1 cursor(eager) vs scalar-subarray', a: median(A), b: median(B), aLabel: 'cursor', bLabel: 'scalar' };
}

// ---- Test 2: eager ByteIntervalCursor vs LazyByteIntervalCursor (runCount=5 walks) ----
function test2() {
  const A = [], B = [];
  for (let r = 0; r < ROUNDS; r++) {
    let t = hrMs(); for (let k = 0; k < 5; k++) walkCursor(ByteIntervalCursor); A.push(hrMs() - t);
    t = hrMs(); for (let k = 0; k < 5; k++) walkCursor(LazyByteIntervalCursor); B.push(hrMs() - t);
  }
  return { name: 'T2 eager vs lazy cursor (5 walks)', a: median(A), b: median(B), aLabel: 'eager', bLabel: 'lazy' };
}

// ---- Test 3: drainTurns 2 vs 0 (setTimeout(0) overhead per cutoff) ----
const waitForTurn = () => new Promise((res) => setTimeout(res, 0));
async function drainWalk(drainTurns) {
  let offset = 0;
  for (const entry of plan) {
    if (entry.bytes <= offset) continue;
    while (offset < entry.bytes) {
      const end = Math.min(offset + tChunk, entry.bytes);
      mockPush(exactBuffer(jxl.subarray(offset, end)));
      offset = end;
    }
    for (let i = 0; i < drainTurns; i++) await waitForTurn();
  }
}
async function test3() {
  const A = [], B = [];
  for (let r = 0; r < ROUNDS; r++) {
    let t = hrMs(); await drainWalk(2); A.push(hrMs() - t);
    t = hrMs(); await drainWalk(0); B.push(hrMs() - t);
  }
  return { name: 'T3 drainTurns 2 vs 0', a: median(A), b: median(B), aLabel: 'drain=2', bLabel: 'drain=0' };
}

function report(r) {
  const ratio = r.b === 0 ? '∞' : (r.a / r.b).toFixed(2) + 'x';
  console.log(`  ${r.name}: ${r.aLabel}=${r.a.toFixed(3)}ms ${r.bLabel}=${r.b.toFixed(3)}ms (${r.aLabel}/${r.bLabel}=${ratio})`);
}

console.log(`=== Flip-Flop Byte-Cutoff Harness (${ROUNDS} rounds, plan steps=${plan.length}, total=${(TOTAL/1024/1024).toFixed(1)}MB) ===`);
report(test1());
report(test2());
report(await test3());
console.log(`  (sink=${sink} — anti-elision guard)`);
