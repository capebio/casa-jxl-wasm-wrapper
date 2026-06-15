// Flip-flop: detectMonotone call path in summarizeByteCutoffResults.
// OLD = re-materialize a {bytes,<key>} array via .map() before detectMonotone.
// NEW = pass the series directly with { valueKey } (no allocation).
// 10 interleaved rounds; median of N inner iterations. Emits TOON with per-run CPU deltas.
// Run: node benchmark/summarize-detectmonotone-mapelim.mjs

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectMonotone } from '../web/jxl-progressive-quality.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hrMs = () => Number(process.hrtime.bigint()) / 1e6;
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// Realistic 12-step butter + ssim series (one benchmark variant's worth of cutoffs).
const STEPS = 12;
const butter = [], ssim = [];
for (let i = 0; i < STEPS; i++) {
  butter.push({ bytes: (i + 1) * 4096, butter: 3.0 - i * 0.2 }); // lower-better, improving
  ssim.push({ bytes: (i + 1) * 4096, ssim: 0.5 + i * 0.03 });    // higher-better, improving
}

const ROUNDS = 10;
const INNER = 200_000; // amplify the microsecond op to a measurable window

function oldPath() {
  // re-materialize arrays (the code before the fix)
  const mB = detectMonotone(butter.map((e) => ({ bytes: e.bytes, butter: e.butter })), 0.1, { valueKey: 'butter', lowerIsBetter: true });
  const mS = detectMonotone(ssim.map((e) => ({ bytes: e.bytes, ssim: e.ssim }))); // note: BUGGY default key 'psnr'
  return mB.monotone === true && mS.monotone === true ? 1 : 0;
}
function newPath() {
  const mB = detectMonotone(butter, 0.1, { valueKey: 'butter', lowerIsBetter: true });
  const mS = detectMonotone(ssim, 0.01, { valueKey: 'ssim' });
  return mB.monotone === true && mS.monotone === true ? 1 : 0;
}

// Correctness probe: old ssim path is buggy (reads .psnr → undefined → trivially monotone=true even on a regressing series).
const regressingSsim = [{ bytes: 1, ssim: 0.9 }, { bytes: 2, ssim: 0.4 }, { bytes: 3, ssim: 0.95 }];
const oldSsimMono = detectMonotone(regressingSsim.map((e) => ({ bytes: e.bytes, ssim: e.ssim }))).monotone; // buggy → true
const newSsimMono = detectMonotone(regressingSsim, 0.01, { valueKey: 'ssim' }).monotone;                    // correct → false

const A = [], B = [], cpuA = [], cpuB = [];
let guard = 0;
for (let r = 0; r < ROUNDS; r++) {
  let c = process.cpuUsage(); let t = hrMs();
  for (let k = 0; k < INNER; k++) guard += oldPath();
  A.push(hrMs() - t); const du = process.cpuUsage(c); cpuA.push((du.user + du.system) / 1000);

  c = process.cpuUsage(); t = hrMs();
  for (let k = 0; k < INNER; k++) guard += newPath();
  B.push(hrMs() - t); const dv = process.cpuUsage(c); cpuB.push((dv.user + dv.system) / 1000);
}

const cpu = os.cpus();
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const medA = median(A), medB = median(B);
const lines = [];
lines.push('TestName: summarize-detectmonotone-mapelim');
lines.push(`RunTimestamp: ${ts}`);
lines.push('Agent: claude');
lines.push(`Cpu: ${cpu[0].model}`);
lines.push(`Cores: ${cpu.length}`);
lines.push(`CpuMhz: ${cpu[0].speed}`);
lines.push(`MemFreeGb: ${(os.freemem() / 1e9).toFixed(1)}`);
lines.push(`MemTotalGb: ${(os.totalmem() / 1e9).toFixed(1)}`);
lines.push(`LoadAvg: ${os.loadavg().map((x) => x.toFixed(2)).join('/')}`);
lines.push(`Rounds: ${ROUNDS}`);
lines.push(`InnerIters: ${INNER}`);
lines.push('');
lines.push('---');
lines.push('runs[' + ROUNDS + ']{round|old_ms|old_cpu_ms|new_ms|new_cpu_ms}:');
for (let r = 0; r < ROUNDS; r++) {
  lines.push(`  ${r + 1} | ${A[r].toFixed(3)} | ${cpuA[r].toFixed(1)} | ${B[r].toFixed(3)} | ${cpuB[r].toFixed(1)}`);
}
lines.push('');
lines.push('# Aggregates');
lines.push(`OldMedianMs: ${medA.toFixed(3)}`);
lines.push(`NewMedianMs: ${medB.toFixed(3)}`);
lines.push(`Speedup_old_over_new: ${(medA / medB).toFixed(2)}x`);
lines.push(`AllocEliminated: ${STEPS * 2} objects + 2 arrays per summarize call`);
lines.push('');
lines.push('# Correctness (ssim monotone on a regressing series 0.9->0.4->0.95)');
lines.push(`OldSsimMonotone: ${oldSsimMono}  (BUG: reports monotone despite regression)`);
lines.push(`NewSsimMonotone: ${newSsimMono}  (correct: regression detected)`);
lines.push(`Guard: ${guard}`);

const outDir = path.join(__dirname, '..', 'docs', 'outputs', 'timing tests');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `detectmonotone-mapelim-${ts}.toon`);
fs.writeFileSync(outFile, lines.join('\n'));
console.log(lines.join('\n'));
console.log(`\nWrote ${outFile}`);
