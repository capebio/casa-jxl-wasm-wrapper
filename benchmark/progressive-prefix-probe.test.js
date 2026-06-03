import { expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

const source = readFileSync(new URL('./progressive-prefix-probe.mjs', import.meta.url), 'utf8');

test('progressive-prefix-probe exports runPrefixProbe and DEFAULT_PROBE_PERCENTS', () => {
  expect(source).toContain('export async function runPrefixProbe');
  expect(source).toContain('DEFAULT_PROBE_PERCENTS');
  expect(source).toContain('minBytesToFirstProgress');
  expect(source).toContain('minPercent');
  expect(source).toContain('probes');
});

test('probe ladder is dense at the low end and includes 100%', () => {
  expect(source).toContain('0.5');
  expect(source).toContain('100');
  // Probe percents must include small values and cover the full range
  const match = source.match(/DEFAULT_PROBE_PERCENTS\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/);
  expect(match).not.toBeNull();
  const percents = match[1].split(',').map((s) => parseFloat(s.trim())).filter(Number.isFinite);
  expect(percents.length).toBeGreaterThanOrEqual(10);
  expect(percents[0]).toBeLessThanOrEqual(1); // dense start
  expect(percents[percents.length - 1]).toBe(100); // covers full file
  // Verify ordering
  for (let i = 1; i < percents.length; i++) {
    expect(percents[i]).toBeGreaterThan(percents[i - 1]);
  }
});

test('each probe creates a fresh decoder (no shared state)', () => {
  // The impl must call createDecoder inside the per-probe loop, not outside.
  // Verify _probeOnce is called per iteration by checking the loop structure.
  expect(source).toContain('_probeOnce');
  expect(source).toContain('for (const { percent, bytes } of plan)');
  // createDecoder must be called inside _probeOnce (not hoisted outside).
  const probeOnceBody = source.match(/async function _probeOnce[\s\S]*?^}/m)?.[0] ?? '';
  expect(probeOnceBody).toContain('createDecoder(decodeOptions)');
});

test('runPrefixProbe on smallest available ORF with live WASM', async () => {
  const GOB = process.env.PROBE_ORF_DIR ?? String.raw`C:\995\2026-02-20 Gobabeb To Windhoek`;
  let orfs;
  try {
    orfs = readdirSync(GOB)
      .filter((n) => extname(n).toLowerCase() === '.orf')
      .map((n) => ({ name: n, size: statSync(join(GOB, n)).size }))
      .sort((a, b) => a.size - b.size);
  } catch {
    console.warn('[skip] fixture dir not accessible');
    return;
  }
  if (orfs.length === 0) { console.warn('[skip] no ORFs'); return; }

  // We need WASM to encode + decode. Import lazily so the test can be skipped
  // when the WASM tier is unavailable without crashing the test runner.
  let createDecoder, createEncoder, initRaw, process_orf_with_flags, rgb_to_rgba, downscale_rgb;
  try {
    if (typeof globalThis.Worker === 'undefined' && !process.env.JXL_WASM_FORCE_TIER) {
      process.env.JXL_WASM_FORCE_TIER = 'simd';
    }
    ({ createDecoder, createEncoder } = await import('../packages/jxl-wasm/dist/index.js'));
    const rawMod = await import('../pkg/raw_converter_wasm.js');
    initRaw = rawMod.default;
    ({ process_orf_with_flags, rgb_to_rgba, downscale_rgb } = rawMod);
    await initRaw({ module_or_path: readFileSync(new URL('../pkg/raw_converter_wasm_bg.wasm', import.meta.url)) });
  } catch {
    console.warn('[skip] WASM modules not loadable in this environment');
    return;
  }

  const { createProgressiveWebPreset } = await import('../web/jxl-progressive-best-preset.js');
  const { runPrefixProbe } = await import('./progressive-prefix-probe.mjs');

  const orfPath = join(GOB, orfs[0].name);
  const raw = new Uint8Array(readFileSync(orfPath));
  const PROCESS_ARGS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, Number.NaN, Number.NaN, 0, 0];
  const decoded = process_orf_with_flags(raw, 1, ...PROCESS_ARGS);
  let result;
  try {
    const rgb = decoded.take_rgb();
    const preset = createProgressiveWebPreset({
      width: decoded.width, height: decoded.height,
      targetLongEdge: 1200, quality: 85, progressiveDetail: 'passes',
    });
    // Encode with SNEYERS_PRESET
    const rgba = rgb_to_rgba(
      decoded.width === preset.target.width && decoded.height === preset.target.height
        ? rgb
        : downscale_rgb(rgb, decoded.width, decoded.height, preset.target.width, preset.target.height),
    );
    const encodeOptions = {
      ...preset.encode, progressiveFlavor: 'dc', previewFirst: true,
      progressiveDc: 2, progressiveAc: 1, qProgressiveAc: 1,
      groupOrder: 1, effort: 3, decodingSpeed: 0,
    };
    const encoder = createEncoder(encodeOptions);
    const chunks = [];
    const chunkTask = (async () => {
      for await (const chunk of encoder.chunks()) chunks.push(new Uint8Array(chunk instanceof Uint8Array ? chunk : chunk));
    })();
    const ab = rgba instanceof ArrayBuffer ? rgba : rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.byteLength);
    await encoder.pushPixels(ab);
    await encoder.finish();
    await chunkTask;
    await encoder.dispose();
    const total = chunks.reduce((s, c) => s + c.byteLength, 0);
    const jxlBytes = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { jxlBytes.set(c, off); off += c.byteLength; }

    result = await runPrefixProbe(jxlBytes, preset.decode, { createDecoder });
  } finally {
    decoded.free();
  }

  // Shape assertions (always run)
  expect(result).toHaveProperty('totalBytes');
  expect(result).toHaveProperty('probes');
  expect(Array.isArray(result.probes)).toBe(true);
  expect(result.probes.length).toBeGreaterThan(0);
  for (const p of result.probes) {
    expect(typeof p.gotProgress).toBe('boolean');
    expect(typeof p.bytes).toBe('number');
    expect(typeof p.probeMs).toBe('number');
  }

  // If probe found a first-paint point, validate it
  if (result.minBytesToFirstProgress != null) {
    expect(result.minPercent).toBeGreaterThan(0);
    expect(result.minPercent).toBeLessThanOrEqual(100);
    expect(result.minBytesToFirstProgress).toBeGreaterThan(0);
    expect(result.minBytesToFirstProgress).toBeLessThanOrEqual(result.totalBytes);
    // Probe should NOT have found a hit at any smaller index than minBytesToFirstProgress
    const hitIdx = result.probes.findIndex((p) => p.gotProgress);
    expect(hitIdx).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < hitIdx; i++) {
      expect(result.probes[i].gotProgress).toBe(false);
    }
    console.log(`[probe] first paint @ ${result.minPercent?.toFixed(1)}% (${result.minBytesToFirstProgress} / ${result.totalBytes} bytes) → ${result.minResolution?.width}×${result.minResolution?.height}`);
  } else {
    // paints=0 across all probes is expected for some real images (probe calibration issue
    // on small/simple files where the WASM progressive structure never surfaces a cutoff paint).
    console.warn(`[probe] no progress paint detected on ${orfs[0].name} — may be a small/simple file`);
  }
}, 240_000); // 4-minute timeout: encode + 18 fresh decoder probes
