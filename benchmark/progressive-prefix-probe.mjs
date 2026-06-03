/**
 * Progressive JXL prefix-probe bench.
 *
 * Unlike stream-cutoff probing (which shares one decoder session across all
 * cutoff points), each probe here creates a **fresh decoder** fed exactly N
 * bytes then closed. This eliminates internal buffering carry-over and gives
 * the true "minimum bytes to first progress paint" for a given JXL.
 *
 * Usage (standalone):
 *   PROBE_JXL=path/to/file.jxl bun benchmark/progressive-prefix-probe.mjs
 *   PROBE_ORF_DIR=C:\995\... PROBE_LIMIT=2 bun benchmark/progressive-prefix-probe.mjs
 *
 * Exports runPrefixProbe() for use in matrix / integration tests.
 *
 * Env:
 *   PROBE_JXL        Comma-separated JXL file paths (pre-encoded).
 *   PROBE_ORF_DIR    ORF directory — encode with SNEYERS_PRESET then probe.
 *   PROBE_LIMIT      Max ORF files to process (default 2).
 *   PROBE_QUALITY    Encode quality 1..100 (default 85).
 *   PROBE_TARGET     Target long edge px or 'full' (default 1600).
 *   PROBE_EFFORT     Encode effort (default 3 = Falcon / SNEYERS).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const DEFAULT_ORF_DIR = String.raw`C:\995\2026-02-20 Gobabeb To Windhoek`;
const OUT_DIR = String.raw`C:\Foo\raw-converter-wasm\docs\Benchmark results`;

const PROBE_LIMIT = clampInt(process.env.PROBE_LIMIT ?? '2', 1, 100);
const PROBE_QUALITY = clampInt(process.env.PROBE_QUALITY ?? '85', 1, 100);
const PROBE_TARGET = process.env.PROBE_TARGET ?? '1600';
const PROBE_EFFORT = clampInt(process.env.PROBE_EFFORT ?? '3', 1, 9);

// Dense at the low end where first progressive paint typically occurs.
export const DEFAULT_PROBE_PERCENTS = Object.freeze([
  0.5, 1, 1.5, 2, 3, 4, 5, 7, 10, 15, 20, 25, 30, 40, 50, 65, 80, 100,
]);

/**
 * Run prefix probes on a single JXL buffer.
 *
 * For each candidate probe size N (from `probePercents` of total bytes),
 * creates a fresh decoder, pushes exactly N bytes, closes it, and records
 * whether any progress/final event fired.
 *
 * Returns:
 *   minBytesToFirstProgress  — smallest N that triggered a paint (null if none)
 *   minPercent               — corresponding percent of total JXL size
 *   minResolution            — {width,height} at that first paint
 *   totalBytes               — jxlBytes.byteLength
 *   probes                   — [{percent, bytes, gotProgress, width, height, probeMs}]
 */
export async function runPrefixProbe(
  jxlBytes,
  decodeOptions,
  { createDecoder, probePercents = DEFAULT_PROBE_PERCENTS } = {},
) {
  if (!createDecoder) throw new Error('runPrefixProbe requires createDecoder');
  const total = jxlBytes.byteLength;

  // Deduplicate byte values (small files may round different percents to the same count).
  const seenBytes = new Set();
  const plan = [];
  for (const percent of probePercents) {
    const bytes = Math.min(total, Math.max(1, Math.round((total * percent) / 100)));
    if (!seenBytes.has(bytes)) {
      seenBytes.add(bytes);
      plan.push({ percent, bytes });
    }
  }

  const probes = [];
  for (const { percent, bytes } of plan) {
    const result = await _probeOnce(jxlBytes, bytes, decodeOptions, createDecoder);
    probes.push({ percent, bytes, ...result });
  }

  const firstHit = probes.find((p) => p.gotProgress) ?? null;
  return {
    totalBytes: total,
    minBytesToFirstProgress: firstHit?.bytes ?? null,
    minPercent: firstHit?.percent ?? null,
    minResolution: firstHit ? { width: firstHit.width, height: firstHit.height } : null,
    probes,
  };
}

/**
 * Feed exactly `bytes` of `jxlBytes` to a fresh decoder and return whether
 * any progress event fired before the stream closed.
 */
async function _probeOnce(jxlBytes, bytes, decodeOptions, createDecoder) {
  const decoder = createDecoder(decodeOptions);
  let gotProgress = false;
  let width = 0;
  let height = 0;

  const eventTask = (async () => {
    for await (const event of decoder.events()) {
      if (event.type === 'progress' || event.type === 'final') {
        gotProgress = true;
        width = event.info?.width ?? 0;
        height = event.info?.height ?? 0;
      }
      // errors are expected for truncated data; don't throw
    }
  })();

  const t0 = performance.now();
  try {
    const slice = exactBuffer(jxlBytes.subarray(0, bytes));
    await decoder.push(slice);
    await decoder.close();
    await eventTask;
  } catch {
    // Partial data may produce a parse error from libjxl — expected, not a failure.
  } finally {
    try { await decoder.dispose(); } catch { /* ignore */ }
  }

  return { gotProgress, width, height, probeMs: performance.now() - t0 };
}

// ── Standalone driver ────────────────────────────────────────────────────────

async function main() {
  if (typeof globalThis.Worker === 'undefined' && !process.env.JXL_WASM_FORCE_TIER) {
    process.env.JXL_WASM_FORCE_TIER = 'simd';
  }
  const { createDecoder, createEncoder, detectTier } = await import('../packages/jxl-wasm/dist/index.js');
  const tier = detectTier();
  console.log(`[prefix-probe] tier=${tier}`);

  const results = [];

  if (process.env.PROBE_JXL) {
    // Mode A: probe pre-encoded JXL files directly.
    const paths = process.env.PROBE_JXL.split(',').map((s) => s.trim()).filter(Boolean);
    for (const p of paths) {
      if (!existsSync(p)) { console.warn(`[prefix-probe] skip missing: ${p}`); continue; }
      const jxlBytes = new Uint8Array(readFileSync(p));
      console.log(`[prefix-probe] probing ${basename(p)} (${fmtBytes(jxlBytes.byteLength)})`);
      const probe = await runPrefixProbe(jxlBytes, {}, { createDecoder });
      _printResult(basename(p), probe);
      results.push({ file: basename(p), ...probe });
    }
  } else {
    // Mode B: encode ORF files with SNEYERS_PRESET then probe.
    const orfDir = process.env.PROBE_ORF_DIR ?? DEFAULT_ORF_DIR;
    if (!existsSync(orfDir)) throw new Error(`ORF dir not found: ${orfDir}`);

    const { createProgressiveWebPreset } = await import('../web/jxl-progressive-best-preset.js');
    const initRaw = (await import('../pkg/raw_converter_wasm.js')).default;
    const { downscale_rgb, process_orf_with_flags, rgb_to_rgba } = await import('../pkg/raw_converter_wasm.js');
    await initRaw({ module_or_path: readFileSync(new URL('../pkg/raw_converter_wasm_bg.wasm', import.meta.url)) });

    const orfFiles = readdirSync(orfDir, { withFileTypes: true })
      .filter((e) => e.isFile() && extname(e.name).toLowerCase() === '.orf')
      .map((e) => ({ name: e.name, path: join(orfDir, e.name), size: statSync(join(orfDir, e.name)).size }))
      .sort((a, b) => a.size - b.size)
      .slice(0, PROBE_LIMIT);

    if (orfFiles.length === 0) throw new Error(`No ORF files in ${orfDir}`);

    const PROCESS_ARGS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, Number.NaN, Number.NaN, 0, 0];
    const OUTPUT_FULL_RGB = 1;

    for (const { name, path } of orfFiles) {
      console.log(`[prefix-probe] encoding ${name}`);
      const raw = new Uint8Array(readFileSync(path));
      const decoded = process_orf_with_flags(raw, OUTPUT_FULL_RGB, ...PROCESS_ARGS);
      let jxlBytes;
      try {
        const rgb = decoded.take_rgb();
        const targetLongEdge = PROBE_TARGET === 'full' ? 'full' : Number(PROBE_TARGET);
        const preset = createProgressiveWebPreset({
          width: decoded.width, height: decoded.height,
          targetLongEdge, quality: PROBE_QUALITY, progressiveDetail: 'passes',
        });
        const rgba = makeTargetRgba({ width: decoded.width, height: decoded.height, rgb }, preset.target.width, preset.target.height, rgb_to_rgba, downscale_rgb);
        const encodeOptions = {
          ...preset.encode,
          progressiveFlavor: 'dc', previewFirst: true,
          progressiveDc: 2, progressiveAc: 1, qProgressiveAc: 1,
          groupOrder: 1, effort: PROBE_EFFORT, decodingSpeed: 0,
        };
        jxlBytes = await encodeJxl(rgba, encodeOptions, createEncoder);
        console.log(`[prefix-probe]   encoded → ${fmtBytes(jxlBytes.byteLength)}`);

        const probe = await runPrefixProbe(jxlBytes, preset.decode, { createDecoder });
        _printResult(name, probe);
        results.push({ file: name, source: { width: decoded.width, height: decoded.height }, target: preset.target, encodeOptions, ...probe });
      } finally {
        decoded.free();
      }
    }
  }

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = join(OUT_DIR, `prefix-probe-${stamp}.json`);
  writeFileSync(outPath, JSON.stringify({
    exportedAt: new Date().toISOString(),
    generator: 'progressive-prefix-probe',
    tier,
    results,
  }, null, 2));
  console.log(`[prefix-probe] wrote ${outPath}`);
}

function _printResult(label, probe) {
  const hit = probe.minBytesToFirstProgress;
  if (hit == null) {
    console.log(`  ${label}: no progress paint at any probe point`);
    return;
  }
  console.log(`  ${label}: first paint @ ${fmtBytes(hit)} = ${probe.minPercent?.toFixed(1)}% of ${fmtBytes(probe.totalBytes)} → ${probe.minResolution?.width}×${probe.minResolution?.height}`);
  // Show probe ladder summary
  const cols = probe.probes.map((p) => `${p.percent}%:${p.gotProgress ? '✓' : '·'}`).join('  ');
  console.log(`  probes: ${cols}`);
}

function makeTargetRgba(source, tw, th, rgb_to_rgba, downscale_rgb) {
  if (source.width === tw && source.height === th) return rgb_to_rgba(source.rgb);
  return rgb_to_rgba(downscale_rgb(source.rgb, source.width, source.height, tw, th));
}

async function encodeJxl(rgba, encodeOptions, createEncoder) {
  const encoder = createEncoder(encodeOptions);
  const chunks = [];
  const chunkTask = (async () => {
    for await (const chunk of encoder.chunks()) {
      chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
    }
  })();
  await encoder.pushPixels(exactBuffer(rgba));
  await encoder.finish();
  await chunkTask;
  await encoder.dispose();
  return concatChunks(chunks);
}

function exactBuffer(view) {
  if (view instanceof ArrayBuffer) return view;
  if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) return view.buffer;
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

function concatChunks(chunks) {
  const total = chunks.reduce((s, c) => s + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '--';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n, u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v.toFixed(v >= 10 || u === 0 ? 0 : 1)} ${units[u]}`;
}

function clampInt(v, min, max) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : min;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
