// Quantitative comparison: WASM pipeline output vs Windows Photos reference JPEG.
//
// Segments pixels into shadow/midtone/highlight zones by luminance and reports
// per-channel mean + percentiles for each zone, plus the delta (ours - ref).
// Use this to diagnose shadow dullness, colour bias, clipping, etc.
//
// Usage: bun analyze.ts [orf] [ref_jpg]
//   Defaults to the test files in c:\Foo\raw-converter\tests\

import init, { process_orf, downscale_rgb } from "./pkg/raw_converter_wasm.js";
import { readFileSync } from "node:fs";
import sharp from "sharp";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const ORF_PATH =
    process.argv[2] ??
    String.raw`c:\Foo\raw-converter\tests\P1110226.ORF`;
const REF_PATH =
    process.argv[3] ??
    String.raw`c:\Foo\raw-converter\tests\P1110226 windows.jpg`;

// Comparison resolution — both images rescaled to this before analysis.
// Smaller = faster; 1200px is plenty for statistics.
const CMP_W = 1200;

// Luminance zone boundaries (0–255 scale).
const SHADOW_MAX = 80;    // < 80  → shadow
const HIGHLIGHT_MIN = 180; // > 180 → highlight
// 80–180 → midtone

// ---------------------------------------------------------------------------
// Init WASM
// ---------------------------------------------------------------------------
const wasmBytes = readFileSync(
    new URL("./pkg/raw_converter_wasm_bg.wasm", import.meta.url),
);
await init({ module_or_path: wasmBytes });

// ---------------------------------------------------------------------------
// Run our pipeline
// ---------------------------------------------------------------------------
console.log(`\nProcessing: ${ORF_PATH}`);
const rawBytes = new Uint8Array(readFileSync(ORF_PATH));
const t0 = performance.now();
const result = process_orf(
    rawBytes,
    /* exposure_ev */ 0,
    /* contrast    */ 0,
    /* highlights  */ 0,
    /* shadows     */ 0,
    /* whites      */ 0,
    /* blacks      */ 0,
    /* saturation  */ 0,
    /* vibrance    */ 0,
    /* temp        */ 0,
    /* tint        */ 0,
    /* wb_r_override */ NaN,
    /* wb_b_override */ NaN,
    /* texture     */ 0,
    /* clarity     */ 0,
);
console.log(`Pipeline: ${(performance.now() - t0).toFixed(0)} ms  (dec ${result.decompress_ms.toFixed(0)} / dem ${result.demosaic_ms.toFixed(0)} / tone ${result.tonemap_ms.toFixed(0)} / ori ${result.orient_ms.toFixed(0)})`);
console.log(`Dims: ${result.width}×${result.height}  WB R=${result.wb_r_used.toFixed(3)} B=${result.wb_b_used.toFixed(3)}  matrix=${result.color_matrix_from_mn ? 'mn' : 'fallback'}`);

const fullRgb = result.take_rgb();
const fullW = result.width;
const fullH = result.height;

// Downscale to comparison size
const cmpH = Math.round((fullH * CMP_W) / fullW);
const oursRgb = downscale_rgb(fullRgb, fullW, fullH, CMP_W, cmpH);

// ---------------------------------------------------------------------------
// Load reference JPEG, resize to same dims
// ---------------------------------------------------------------------------
console.log(`\nLoading reference: ${REF_PATH}`);
const refRgb = await sharp(REF_PATH)
    .resize(CMP_W, cmpH, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer();

// ---------------------------------------------------------------------------
// Statistics engine
// ---------------------------------------------------------------------------
interface ZoneStat {
    n: number;
    rMean: number; gMean: number; bMean: number;
    rP10: number;  gP10: number;  bP10: number;
    rP50: number;  gP50: number;  bP50: number;
    rP90: number;  gP90: number;  bP90: number;
}

function zoneStat(rgb: Uint8Array | Buffer, zone: 'shadow' | 'midtone' | 'highlight'): ZoneStat {
    const rs: number[] = [], gs: number[] = [], bs: number[] = [];
    const n = rgb.length / 3;
    for (let i = 0; i < n; i++) {
        const r = rgb[i * 3];
        const g = rgb[i * 3 + 1];
        const b = rgb[i * 3 + 2];
        // Rec.601 luminance
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        const inZone =
            zone === 'shadow'    ? lum < SHADOW_MAX :
            zone === 'highlight' ? lum > HIGHLIGHT_MIN :
            /* midtone */          lum >= SHADOW_MAX && lum <= HIGHLIGHT_MIN;
        if (inZone) { rs.push(r); gs.push(g); bs.push(b); }
    }
    rs.sort((a, b) => a - b); gs.sort((a, b) => a - b); bs.sort((a, b) => a - b);
    const nn = rs.length;
    if (nn === 0) return { n: 0, rMean:0,gMean:0,bMean:0, rP10:0,gP10:0,bP10:0, rP50:0,gP50:0,bP50:0, rP90:0,gP90:0,bP90:0 };
    const pct = (arr: number[], p: number) => arr[Math.min(Math.floor((p / 100) * arr.length), arr.length - 1)];
    const avg = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;
    return {
        n: nn,
        rMean: avg(rs), gMean: avg(gs), bMean: avg(bs),
        rP10: pct(rs,10), gP10: pct(gs,10), bP10: pct(bs,10),
        rP50: pct(rs,50), gP50: pct(gs,50), bP50: pct(bs,50),
        rP90: pct(rs,90), gP90: pct(gs,90), bP90: pct(bs,90),
    };
}

// ---------------------------------------------------------------------------
// Global stats (all pixels)
// ---------------------------------------------------------------------------
function globalMeans(rgb: Uint8Array | Buffer) {
    let r = 0, g = 0, b = 0;
    const n = rgb.length / 3;
    for (let i = 0; i < n; i++) { r += rgb[i*3]; g += rgb[i*3+1]; b += rgb[i*3+2]; }
    return { r: r/n, g: g/n, b: b/n };
}

// Gamma-corrected luminance mean (perceptual brightness)
function meanLuminance(rgb: Uint8Array | Buffer) {
    let lum = 0;
    const n = rgb.length / 3;
    for (let i = 0; i < n; i++) {
        lum += 0.299 * rgb[i*3] + 0.587 * rgb[i*3+1] + 0.114 * rgb[i*3+2];
    }
    return lum / n;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const oursU8 = oursRgb instanceof Uint8Array ? oursRgb : new Uint8Array(oursRgb);
const refU8  = refRgb  instanceof Uint8Array ? refRgb  : new Uint8Array(refRgb);

const oursGlobal = globalMeans(oursU8);
const refGlobal  = globalMeans(refU8);

console.log('\n══════════════════════════════════════════════════════════');
console.log(' GLOBAL MEANS (all pixels, 0–255)');
console.log('══════════════════════════════════════════════════════════');
console.log(`  Ours : R ${oursGlobal.r.toFixed(1).padStart(5)}  G ${oursGlobal.g.toFixed(1).padStart(5)}  B ${oursGlobal.b.toFixed(1).padStart(5)}  lum ${meanLuminance(oursU8).toFixed(1)}`);
console.log(`  Ref  : R ${refGlobal.r.toFixed(1).padStart(5)}  G ${refGlobal.g.toFixed(1).padStart(5)}  B ${refGlobal.b.toFixed(1).padStart(5)}  lum ${meanLuminance(refU8).toFixed(1)}`);
const dR = oursGlobal.r - refGlobal.r, dG = oursGlobal.g - refGlobal.g, dB = oursGlobal.b - refGlobal.b;
console.log(`  Delta: R ${(dR>=0?'+':'')+dR.toFixed(1).padStart(5)}  G ${(dG>=0?'+':'')+dG.toFixed(1).padStart(5)}  B ${(dB>=0?'+':'')+dB.toFixed(1).padStart(5)}`);

for (const zone of ['shadow', 'midtone', 'highlight'] as const) {
    const o = zoneStat(oursU8, zone);
    const r = zoneStat(refU8,  zone);
    const pct = ((o.n / (oursU8.length / 3)) * 100).toFixed(1);
    console.log(`\n──────────────────────────────────────────────────────────`);
    console.log(` ZONE: ${zone.toUpperCase().padEnd(10)} (${pct}% of pixels, lum ${zone==='shadow'?'<'+SHADOW_MAX:zone==='highlight'?'>'+HIGHLIGHT_MIN:SHADOW_MAX+'–'+HIGHLIGHT_MIN})`);
    console.log(`──────────────────────────────────────────────────────────`);
    if (o.n === 0) { console.log('  (no pixels in zone)'); continue; }
    const fmt = (v: number) => v.toFixed(1).padStart(5);
    const fmtD = (v: number) => ((v>=0?'+':'')+v.toFixed(1)).padStart(6);
    console.log(`  Metric     R-ours  G-ours  B-ours  │  R-ref   G-ref   B-ref   │  ΔR      ΔG      ΔB`);
    const rows = [
        ['P10',  o.rP10, o.gP10, o.bP10, r.rP10, r.gP10, r.bP10],
        ['Mean', o.rMean,o.gMean,o.bMean,r.rMean,r.gMean,r.bMean],
        ['P50',  o.rP50, o.gP50, o.bP50, r.rP50, r.gP50, r.bP50],
        ['P90',  o.rP90, o.gP90, o.bP90, r.rP90, r.gP90, r.bP90],
    ] as [string, number, number, number, number, number, number][];
    for (const [label, or, og, ob, rr, rg, rb] of rows) {
        console.log(
            `  ${label.padEnd(6)}   ${fmt(or)}   ${fmt(og)}   ${fmt(ob)}  │  ${fmt(rr)}   ${fmt(rg)}   ${fmt(rb)}  │  ${fmtD(or-rr)} ${fmtD(og-rg)} ${fmtD(ob-rb)}`
        );
    }
    // Shadow lift diagnosis
    if (zone === 'shadow') {
        const shadowLiftOurs = o.rP50 + o.gP50 + o.bP50;
        const shadowLiftRef  = r.rP50 + r.gP50 + r.bP50;
        const ratio = shadowLiftRef > 0 ? shadowLiftOurs / shadowLiftRef : NaN;
        console.log(`\n  Shadow midpoint sum: ours=${shadowLiftOurs.toFixed(0)}  ref=${shadowLiftRef.toFixed(0)}  ratio=${ratio.toFixed(2)}x`);
        if (ratio < 0.85) console.log('  ⚠  Ours is significantly darker in shadows — increase BASELINE_EXP_EV or shadow lift');
        else if (ratio > 1.15) console.log('  ⚠  Ours is significantly brighter in shadows');
        else console.log('  ✓  Shadow brightness within 15% of reference');
    }
}

console.log('\n══════════════════════════════════════════════════════════\n');
