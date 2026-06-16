// Flip-flop: butteraugli sRGB→linear gamma decode — per-pixel pow vs 256-entry LUT (bridge.cpp B-1).
// The bridge gamma-decodes both RGBA8 images to linear-light float before butteraugli. Input is u8,
// so a 256-entry LUT is bit-identical to per-pixel pow while removing all transcendental calls.
// This JS model mirrors the C++ change exactly: for integer v, pow(v/255,2.2) is deterministic, so
// lut[v] == per-pixel pow(v/255,2.2) bit-for-bit (Float32). We measure throughput and prove equality.
//
// Emits CPU/thermal telemetry per round to a .toon ledger per docs/ToonInstructions.md.

import { execSync } from "node:child_process";
import os from "node:os";
import { writeFileSync, mkdirSync } from "node:fs";
import { performance } from "node:perf_hooks";

const WIDTH = 1920, HEIGHT = 1080;          // ~2.07 MP, representative compare size
const N = WIDTH * HEIGHT;
const ROUNDS = 10;

// Deterministic pseudo-random RGBA8 source (stable across runs).
const rgba = new Uint8Array(N * 4);
let seed = 0x1234567;
for (let i = 0; i < rgba.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; rgba[i] = seed & 0xff; }

const INV255 = 1 / 255;

// Method A: per-pixel pow (the old bridge path).
function gammaPow(out) {
  for (let i = 0; i < N; i++) {
    const o = i * 4;
    out[i * 3 + 0] = Math.pow(rgba[o]     * INV255, 2.2);
    out[i * 3 + 1] = Math.pow(rgba[o + 1] * INV255, 2.2);
    out[i * 3 + 2] = Math.pow(rgba[o + 2] * INV255, 2.2);
  }
}

// Method B: 256-entry LUT (the B-1 path). LUT built once, as in the C++ static initializer.
const LUT = new Float32Array(256);
for (let i = 0; i < 256; i++) LUT[i] = Math.pow(i * INV255, 2.2);
function gammaLut(out) {
  for (let i = 0; i < N; i++) {
    const o = i * 4;
    out[i * 3 + 0] = LUT[rgba[o]];
    out[i * 3 + 1] = LUT[rgba[o + 1]];
    out[i * 3 + 2] = LUT[rgba[o + 2]];
  }
}

function telemetry() {
  const t = { loadPct: "N/A", clockGhz: "N/A", maxGhz: "N/A", throttlePct: "100.0" };
  if (process.platform === "win32") {
    try {
      const out = execSync(
        'powershell.exe -NoProfile -Command "Get-CimInstance Win32_Processor | Select-Object CurrentClockSpeed,MaxClockSpeed,LoadPercentage | ConvertTo-Json"',
        { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }).trim();
      const d = JSON.parse(out); const c = Array.isArray(d) ? d[0] : d;
      if (c && c.MaxClockSpeed) {
        t.loadPct = String(c.LoadPercentage);
        t.clockGhz = (c.CurrentClockSpeed / 1000).toFixed(2);
        t.maxGhz = (c.MaxClockSpeed / 1000).toFixed(2);
        t.throttlePct = ((c.CurrentClockSpeed / c.MaxClockSpeed) * 100).toFixed(1);
      }
    } catch { /* sensor blocked */ }
  }
  return t;
}

const outPow = new Float32Array(N * 3);
const outLut = new Float32Array(N * 3);

// Correctness: bit-identical Float32 outputs.
gammaPow(outPow); gammaLut(outLut);
let mismatches = 0;
for (let i = 0; i < outPow.length; i++) if (outPow[i] !== outLut[i]) mismatches++;

// Warm both JITs.
for (let w = 0; w < 2; w++) { gammaPow(outPow); gammaLut(outLut); }

const rows = [];
for (let r = 0; r < ROUNDS; r++) {
  const tel = telemetry();
  let t = performance.now(); gammaPow(outPow); const powMs = performance.now() - t;
  t = performance.now(); gammaLut(outLut); const lutMs = performance.now() - t;
  rows.push({ r: r + 1, powMs, lutMs, speedup: powMs / lutMs, tel });
  console.log(`round ${r + 1}: pow=${powMs.toFixed(2)}ms lut=${lutMs.toFixed(2)}ms speedup=${(powMs / lutMs).toFixed(2)}x | cpu ${tel.clockGhz}/${tel.maxGhz}GHz load=${tel.loadPct}% throttle=${tel.throttlePct}%`);
}

const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const medPow = med(rows.map(r => r.powMs));
const medLut = med(rows.map(r => r.lutMs));

console.log(`\nMEDIAN pow=${medPow.toFixed(2)}ms lut=${medLut.toFixed(2)}ms speedup=${(medPow / medLut).toFixed(2)}x | mismatches=${mismatches}/${outPow.length}`);

// Emit TOON ledger.
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dir = "docs/outputs/timing tests";
mkdirSync(dir, { recursive: true });
const cpu = os.cpus()[0]?.model ?? "Unknown";
let toon = `TestName: butteraugli-gamma-lut-flipflop
RunTimestamp: ${new Date().toISOString()}
Agent: claude-code
Platform: ${process.platform} (${process.arch})
Cpu: ${cpu}
ImageSize: ${WIDTH}x${HEIGHT}
Pixels: ${N}
Rounds: ${ROUNDS}
Mismatches: ${mismatches}
MedianPowMs: ${medPow.toFixed(3)}
MedianLutMs: ${medLut.toFixed(3)}
MedianSpeedupX: ${(medPow / medLut).toFixed(2)}

---
runs[${ROUNDS}]{round|pow_ms|lut_ms|speedup_x|cpu_ghz|cpu_max_ghz|load_pct|throttle_pct}:
`;
for (const r of rows) {
  toon += `  ${r.r} | ${r.powMs.toFixed(3)} | ${r.lutMs.toFixed(3)} | ${r.speedup.toFixed(2)} | ${r.tel.clockGhz} | ${r.tel.maxGhz} | ${r.tel.loadPct} | ${r.tel.throttlePct}\n`;
}
toon += `\n# Conclusion\nLUT output bit-identical to per-pixel pow (${mismatches} mismatches over ${outPow.length} floats).\n`;
toon += `LUT median ${(medPow / medLut).toFixed(2)}x faster on this JS proxy; the C++ bridge eliminates the same\n`;
toon += `width*height*3 transcendental calls per image (x2 images per compare), with zero pixel drift.\n`;
const file = `${dir}/butteraugli-gamma-lut-${stamp}.toon`;
writeFileSync(file, toon);
console.log(`\nTOON: ${file}`);
