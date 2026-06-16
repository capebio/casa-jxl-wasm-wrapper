/**
 * Golden-corpus baseline for encode.cc data-structure optimisations.
 *
 * Encodes deterministic synthetic images at several settings and records
 * SHA-256 hashes + output sizes. A byte-identical hash proves that a
 * data-structure-only change (F001/F002/F005 queue-head/buffer_vec_/growth)
 * did not alter the codec output path.
 *
 * Usage:
 *   # Capture baseline from the CURRENT encoder WASM:
 *   node benchmark/encode-golden-baseline.mjs --capture
 *
 *   # Verify after rebuilding WASM with modified external/libjxl:
 *   node benchmark/encode-golden-baseline.mjs --verify
 *
 * Rebuild flow for encode.cc changes:
 *   $env:LIBJXL_REPO = (Resolve-Path external/libjxl).Path   # PowerShell
 *   node packages/jxl-wasm/scripts/build.mjs --host-toolchain
 *   node benchmark/encode-golden-baseline.mjs --verify
 *
 * Expected result for pure data-structure changes (F001/F002/F004/F005):
 *   ALL hashes IDENTICAL  — no diff in codec output
 *
 * Expected result for stage-decomposition changes (F006/F009):
 *   ALL hashes IDENTICAL  — stages must produce identical bitstream order
 *   If any hash differs, the refactor changed observable output → reject.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createEncoder } from "../packages/jxl-wasm/dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = join(__dirname, "encode-golden-baseline.json");

// ---------------------------------------------------------------------------
// Deterministic synthetic image generation
// ---------------------------------------------------------------------------

/** xorshift32 — deterministic, fast, no dependencies. */
function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;  s >>>= 0;
    return s / 0xffffffff;
  };
}

/**
 * Generate a deterministic RGBA8 image.
 * Gradient + sine ripples + RNG noise so masking and AC-coding do real work.
 */
function syntheticRgba8(width, height, seed = 0xDEADBEEF) {
  const rng = makeRng(seed);
  const px = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      px[i]     = ((x * 255 / width)  + 30 * Math.sin(y / 13) + rng() * 6) & 0xff;
      px[i + 1] = ((y * 255 / height) + 30 * Math.cos(x / 11) + rng() * 6) & 0xff;
      px[i + 2] = (128 + 60 * Math.sin((x + y) / 20)           + rng() * 6) & 0xff;
      px[i + 3] = 255;
    }
  }
  return px;
}

// ---------------------------------------------------------------------------
// Encode helpers
// ---------------------------------------------------------------------------

async function encodeToBytes(rgba, width, height, opts) {
  const encoder = createEncoder({
    format: "rgba8",
    width,
    height,
    hasAlpha: false,
    distance: opts.distance ?? 1.0,
    effort: opts.effort ?? 3,
    progressive: opts.progressive ?? false,
    chunked: false,
    previewFirst: false,
  });
  const chunks = [];
  const drainTask = (async () => {
    for await (const chunk of encoder.chunks()) {
      chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
    }
  })();
  await encoder.pushPixels(rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.byteLength));
  await encoder.finish();
  await drainTask;
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// ---------------------------------------------------------------------------
// Test matrix
// ---------------------------------------------------------------------------

const IMAGES = [
  { label: "small-512x384",   width: 512,  height: 384  },
  { label: "medium-1280x800", width: 1280, height: 800  },
];

const ENCODE_VARIANTS = [
  { label: "lossy-d1.0-e3",    distance: 1.0,  effort: 3 },
  { label: "lossy-d2.0-e3",    distance: 2.0,  effort: 3 },
  { label: "lossy-d0.5-e3",    distance: 0.5,  effort: 3 },
  { label: "lossless-d0-e3",   distance: 0.0,  effort: 3 },
  { label: "lossy-d1.0-e5",    distance: 1.0,  effort: 5 },
];

// ---------------------------------------------------------------------------
// Capture / verify
// ---------------------------------------------------------------------------

async function runMatrix() {
  const results = [];
  for (const img of IMAGES) {
    const rgba = syntheticRgba8(img.width, img.height);
    for (const variant of ENCODE_VARIANTS) {
      const t0 = performance.now();
      const bytes = await encodeToBytes(rgba, img.width, img.height, variant);
      const encMs = performance.now() - t0;
      const hash = sha256(bytes);
      results.push({
        image: img.label,
        variant: variant.label,
        sizeBytes: bytes.byteLength,
        encMs: Math.round(encMs * 10) / 10,
        sha256: hash,
      });
      console.log(`  ${img.label} / ${variant.label}: ${bytes.byteLength} B  sha256=${hash.slice(0, 16)}…  (${encMs.toFixed(0)} ms)`);
    }
  }
  return results;
}

async function capture() {
  console.log("Capturing golden baseline…");
  const rows = await runMatrix();
  const baseline = {
    capturedAt: new Date().toISOString(),
    note: "Byte-identical hashes required after data-structure-only encode.cc changes (F001/F002/F004/F005). Stage-decomposition changes (F006/F009) must also produce identical hashes.",
    rows,
  };
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2));
  console.log(`\nBaseline saved to ${BASELINE_PATH} (${rows.length} entries)`);
}

async function verify() {
  if (!existsSync(BASELINE_PATH)) {
    console.error(`No baseline found at ${BASELINE_PATH}. Run with --capture first.`);
    process.exit(1);
  }
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  console.log(`Verifying against baseline captured at ${baseline.capturedAt}…`);
  const current = await runMatrix();

  let pass = 0, fail = 0;
  for (const cur of current) {
    const ref = baseline.rows.find(r => r.image === cur.image && r.variant === cur.variant);
    if (!ref) {
      console.error(`  MISSING  ${cur.image} / ${cur.variant} in baseline`);
      fail++;
      continue;
    }
    if (cur.sha256 === ref.sha256) {
      console.log(`  PASS  ${cur.image} / ${cur.variant}  ${cur.sizeBytes} B`);
      pass++;
    } else {
      console.error(`  FAIL  ${cur.image} / ${cur.variant}`);
      console.error(`    baseline: ${ref.sha256}`);
      console.error(`    current:  ${cur.sha256}`);
      console.error(`    size: baseline=${ref.sizeBytes} B  current=${cur.sizeBytes} B`);
      fail++;
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const arg = process.argv[2];
if (arg === "--capture") {
  await capture();
} else if (arg === "--verify") {
  await verify();
} else {
  console.error("Usage: node encode-golden-baseline.mjs --capture | --verify");
  process.exit(1);
}
