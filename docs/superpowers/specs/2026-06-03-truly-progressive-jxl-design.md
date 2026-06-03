# Truly Progressive JXL — Encode + Decode (Sneyers Route)

**Date:** 2026-06-03
**Status:** Design approved; ready for implementation plan
**Branch:** `tauriparity`
**Related docs:**
- `docs/references/designs/progressive-encode-options.md` (prior encode-side options note)
- `docs/HANDOFF-predator-continuation-2026-06-encode-matrix.md` (in-progress flag matrix work)
- `docs/HANDOFF-tauri-parity-2026-06-03.md` (Tauri parity context)
- `docs/INCOMPLETE PLANS.md` (Tauri progressive bullet)
- `docs/rejected optimizations.md` (boundary invariants — read before bridge changes)

## Goal

Produce JPEG XL files that improve perceptibly as bytes arrive over the wire, and decode them so each new chunk of input paints a more refined image — matching the behaviour Jon Sneyers demonstrates on the jxl.info site. Acceptance is evidence-based: streamed byte-progressive proof with measured paint counts and quality monotonicity, plus a visual UI throttle demo.

The bridge and facade already plumb the Sneyers stack (`PROGRESSIVE_DC/AC/QPROGRESSIVE_AC`, `GROUP_ORDER=1`, `RESPONSIVE=1`, `JxlDecoderSetProgressiveDetail`, `JxlDecoderFlushImage` on `FRAME_PROGRESSION` and opportunistically on `NEED_MORE_INPUT`). What is missing: a named preset that bundles the measured-best flag combination, a JPEG-input streaming bench (counterpart to the existing RAW one), per-cutoff PSNR/SSIM with a monotonicity assertion, a UI network-throttle slider so the progressive behaviour is visible, and re-sync of the shipped `dist/facade.js`.

## Non-goals

- No libjxl version bump unless the matrix run reveals a concrete defect.
- No bridge.cpp changes (the libjxl progressive surface is already correctly wired).
- No removal of existing presets — `SNEYERS_PRESET` is additive.
- No new tunables added to `EncoderOptions` beyond what already exists.

## Constraints

- Workers/scheduler/facade boundary invariants from `CLAUDE.md` are non-negotiable. No pixel pool, no drain callback in facade, no batching in session, no cache dedup by sourceKey, no soft preemption.
- Public encoder/decoder API surface must stay backwards-compatible. Existing per-flag overrides win over preset.
- Encoder effort sweeps cover {3, 5}. Higher efforts only with evidence. Reason: prior in-repo measurements showed effort=3 best on both speed and filesize; libjxl's "recommended ≥7 for progressive" advice must be empirically validated on this workload before adoption.
- Streaming bench must be cross-platform (Node 20+) and use the same fixtures the existing RAW matrix uses where possible.

## Success criteria

The Sneyers preset (under whatever flag combination wins the measured matrix) must achieve, on the reference sets (Gobabeb 30-file ORF for RAW; first 11 files of an equivalent JPEG folder for JPEG):

| Metric | Target |
|--------|--------|
| `paintedCutoffs` | ≥ 4 |
| `firstPaintBytes` | ≤ 10% of total |
| `firstRecognizableBytes` (PSNR ≥ 20 dB vs final) | ≤ 25% of total |
| `previewBytes` (PSNR ≥ 30 dB vs final) | ≤ 50% of total |
| `monotone` (each paint ≥ prior − 0.5 dB tolerance) | true |
| `finalPsnr` vs source | ≥ 40 dB |
| Encode time vs current `previewFirst:true` default (effort=3, DC=1, AC=1, QAC=1, groupOrder=1, buffering=0) | within 1.5× |

If the measurement matrix shows the bridge cannot meet these targets, escalate to Approach C in the brainstorm (investigate libjxl flag semantics, possibly decoder coalescing in the JS facade).

Plus visual proof: the UI throttle slider on `web/jxl-progressive-paint.html` paints visibly growing image content at 50, 100, 500, 2000 KB/s simulated rates.

## Architecture

```
ENCODE                                              DECODE + PAINT
─────────                                           ────────────────
SNEYERS_PRESET → facade encoder                     throttled byte feed → facade decoder
        │                                                   │
        ▼                                                   ▼
   bridge.cpp::ApplyProgressiveFrameSettings           bridge.cpp::jxl_wasm_dec_push
   (DC/AC/QAC/GROUP_ORDER/BUFFERING/RESPONSIVE)       (kPasses + FlushImage on FRAME_PROGRESSION,
                                                       opportunistic on NEED_MORE_INPUT)
        │                                                   │
        ▼                                                   ▼
   libjxl encode (effort∈{3,5}, ds=0)                  libjxl decode (intermediate paint per pass)
        │                                                   │
        ▼                                                   ▼
   bytes ─────────────────────────────────────────► chunk-cutoff probe / UI canvases
                                                            │
                                                            ▼
                                                   per-cutoff PSNR/SSIM vs final
```

No change to bridge.cpp. No change to libjxl. All work lives in JS facade, presets, bench scripts, UI, and tests.

## Components

### `web/jxl-progressive-best-preset.js` (extend)

Add `SNEYERS_PRESET` constant and `createSneyersPreset()` helper alongside existing `createProgressiveWebPreset`.

```js
export const SNEYERS_PRESET = Object.freeze({
  progressive: true,
  previewFirst: true,
  progressiveDc: 2,
  progressiveAc: 1,
  qProgressiveAc: 1,
  groupOrder: 1,
  effort: 3,         // measurement-driven; matrix sweeps {3, 5}
  decodingSpeed: 0,
});

export function createSneyersPreset({ width, height, targetLongEdge, quality, progressiveDetail = "passes" }) {
  // Mirrors createProgressiveWebPreset shape; returns { target, encode, decode }.
  // encode = { ...SNEYERS_PRESET, format, width, height, quality, hasAlpha }
  // decode = { format: "rgba8", progressiveDetail, emitEveryPass: true, progressionTarget: "final", ... }
}
```

The exported `effort` value reflects the winner of the P1 matrix run. The name `SNEYERS_PRESET` stays stable even if the internal flag values shift after re-measurement.

`buffering` is intentionally absent from the preset. The facade derives it from `options.chunked` (currently `chunked ? 2 : 0`). Sneyers-preset callers using the standard one-shot encode path get `buffering=0` (libjxl-default, encode-all-then-emit); chunked callers get `buffering=2`. `buffering` affects encode-side streaming only — bitstream progressiveness (the user-visible property) is determined by DC/AC/QAC/GROUP_ORDER/RESPONSIVE, not by buffering.

### `benchmark/_progressive-stream-helper.mjs` (new shared module)

Extract the `streamDecodeCutoffs` + `concatChunks` + `exactBuffer` helpers from `progressive-flag-matrix.mjs` into a single module so the JPEG bench can reuse them without duplication. Update the existing matrix script to import from the shared module.

### `benchmark/jpeg-progressive-stream.mjs` (new)

JPEG-input mirror of `progressive-flag-matrix.mjs`. Reads JPEGs from `JPEG_DIR`, decodes to raw pixels via `sharp`, encodes through the same 6-case flag matrix × {effort 3, 5}, runs `streamDecodeCutoffs`, classifies each cutoff with `classifyByteCutoffFrame`, summarizes with the extended `summarizeByteCutoffResults` (PSNR/SSIM/monotone), writes JSON + MD artifact to `docs/Benchmark results/jpeg-progressive-stream-<ts>.{json,md}`.

Env vars: `JPEG_DIR`, `JPS_LIMIT`, `JPS_START`, `JPS_TARGET`, `JPS_QUALITY`, `JPS_DETAIL`, `JPS_WAIT_MS`.

### `web/jxl-progressive-byte-metrics.js` (extend)

Add PSNR + SSIM computation against the file's own final frame (not the source pixels — measures progressive-vs-complete fidelity, not encode quality):

```js
export function computePsnrVsFinal(cutoffPixels, finalPixels, channels = 4) { /* … */ }
export function computeSsimVsFinal(cutoffPixels, finalPixels, w, h, channels = 4) { /* simplified single-window SSIM */ }
```

Extend `summarizeByteCutoffResults` return shape with:
```
{
  // existing fields kept
  firstRecognizableBytes,   // first cutoff where psnrVsFinal >= 20 dB
  previewBytes,             // first cutoff where psnrVsFinal >= 30 dB (was bytes-based; now quality-based)
  monotone: boolean,        // each paint psnr >= prior - 0.5 dB
  regressions: [{ bytes, dropDb }],   // empty if monotone
  finalPsnr,                // sanity check ≥ 40 dB
}
```

### `web/jxl-progressive-paint.html` + `.js` (extend)

Add a control row above the compare canvases:

- `<select id="throttle-rate">`: Unthrottled / 2 MB/s / 500 KB/s / 100 KB/s / 50 KB/s
- `<select id="preset-name">`: Default / Sneyers / Predator / Custom
- Per-canvas overlay text: cutoff bytes (% of total), paint index, PSNR-vs-final dB

In `runProgressive()`: when throttle rate ≠ Unthrottled, slice the encoded bytes into 16 KB chunks and `await sleep(chunkBytes / rateBytesPerMs)` between `decoder.push()` calls. Each `progress` event paints to the next compare slot. UI label shows `(decoder waiting)` if a paint arrives more than 3 cutoffs ahead of the current feed position.

### `packages/jxl-wasm/dist/facade.js` (sync)

Currently dirty per `git status` and may have drifted from `src/facade.ts`. Rebuild via `pnpm -F @casabio/jxl-wasm build` and commit synced bundle as part of the implementation. No code change beyond regeneration.

### `packages/jxl-wasm/src/facade.ts` (small change, gated on P1 verdict)

In `resolveEncoderBridgeSettings`, when `previewFirst === true` and no per-flag overrides are set, return the SNEYERS_PRESET flags. Gated behind a single `useSneyersDefault` boolean for easy rollback. Per-flag overrides (`progressiveDc`, `progressiveAc`, etc.) still win.

### No changes

- `packages/jxl-wasm/src/bridge.cpp`: already correctly wires the Sneyers libjxl surface.
- libjxl version: stays where it is.
- Worker / scheduler / cache: untouched per `CLAUDE.md` invariants.

## Data flow

### Streaming decode loop (shared helper, used by both bench scripts)

```
plan = buildByteCutoffPlan(totalBytes)
// e.g. [1KB, 4KB, 16KB, 64KB, 25%, 50%, 75%, 100%]

decoder = createDecoder({
  format: "rgba8",
  emitEveryPass: true,          // CRITICAL — jpeg-to-jxl-timings.mjs has this false
  progressionTarget: "final",
  progressiveDetail: "passes",  // kPasses for finest spectral progression
})

eventTask = consume(decoder.events()):
  on "header"   → save info
  on "progress" → snapshot pixels + ts to current cutoff slot
  on "final"    → snapshot final + ts
  on "error"    → throw

offset = 0
for entry in plan:
  await decoder.push(jxlBytes.subarray(offset, entry.bytes))
  offset = entry.bytes
  await waitForStreamEvents()   // microtask tick + optional WAIT_MS
await decoder.close()
await eventTask
```

### Per-cutoff classification

For each cutoff slot, take the *last* progress/final event captured during that cutoff (most-refined paint at that byte point):

```
{
  bytes,
  paintIndex,                       // 0-based, monotone within run
  pixels,                           // Uint8Array RGBA8
  paintMs,                          // wall time since first push
  psnrVsFinal,                      // dB
  ssimVsFinal,                      // 0..1
  recognizable: psnrVsFinal >= 20 || ssimVsFinal >= 0.85,
}
```

### Run summary

```
{
  totalBytes,
  paintedCutoffs,
  firstPaintBytes,
  firstRecognizableBytes,
  previewBytes,                     // PSNR ≥ 30 dB
  monotone,
  regressions,
  finalPsnr,
}
```

### UI throttle (UI script only — bench scripts use cutoff plan, not throttle)

```
chunkBytes   = 16384
rateMsPerKB  = throttleRate === "unthrottled" ? 0 : 1000 / kbPerSec
for slice of chunkBytes in bytes:
  await decoder.push(slice)
  await sleep(chunkBytes / 1024 * rateMsPerKB)
```

UI paints whichever `progress` events fire between pushes — gives the perceived "image growing" demo.

## Error handling

- `decoder.events()` or `decoder.push()` throws → mark all unfilled cutoffs `error=<msg>`, persist captures up to the fault point. Don't lose successful early paints.
- Bench continues to next file on file-level error; matrix run never aborts mid-batch.
- Empty-paint cutoff (first N bytes < header) is legitimate: `paintIndex` absent, `pixels=null`, `recognizable=false`. Not an error.
- Monotonicity regression: cutoff with PSNR drop > 0.5 dB vs prior → flag `regressed=true`, append to `regressions[]`, set `monotone=false`. Test asserts and prints offending cutoff bytes + delta; doesn't crash bench.
- UI throttle starvation: `progress` event fires > 3 cutoffs ahead of current chunk position → label `(decoder waiting)`. Not an error.
- Bridge errors already surface via `JXL_DEC_RESULT_ERROR` + `error_code`; facade rethrows via `decError(dec)`. No new error surface.
- Dist-bundle drift: build step `pnpm -F @casabio/jxl-wasm build` must succeed; CI gates out-of-sync dist.

## Testing strategy

### Unit
- `web/jxl-progressive-best-preset.test.js`: assert `SNEYERS_PRESET` shape; `createSneyersPreset()` returns expected `{ target, encode, decode }`.
- `web/jxl-progressive-byte-metrics.test.js`: extend with PSNR cases (identical → ∞, all-zero → 0, fixed delta → known dB) and monotone detection (synthetic ascending → true; ascending-with-1dB-drop → false with regression logged).

### Integration (Node)
- `benchmark/progressive-flag-matrix.test.js` (exists): extend — assert Sneyers row meets §Success-criteria thresholds on 1 small ORF fixture (use existing fixture; smallest file in Gobabeb set or `crates/raw-pipeline/test_data/` equivalent).
- `benchmark/jpeg-progressive-stream.test.js` (new): same assertions on 1 small JPEG fixture (use one of the Gobabeb `JPEG/` files at quick-compare size).

### Visual smoke
- `tools/predator-paint-visual-smoke.mjs`: extend with a Sneyers preset run, dump PNG per cutoff to `docs/visual-smoke/sneyers-<file>-<bytes>.png`. Manual eyeball check before merge.

### Live UI test
- `web/jxl-progressive-paint-page.test.js`: extend to load `sneyers` preset, set throttle to 100 KB/s, assert ≥ 3 paints emitted to compare slots within 10 s.

### Acceptance gate
- Run `progressive-flag-matrix.mjs` (RAW, Gobabeb 30 ORFs, env `PFM_LIMIT=30`) + `jpeg-progressive-stream.mjs` (JPEG, 11 files from `JPEG_DIR`, env `JPS_LIMIT=11`) end-to-end. Persist artifacts. Write summary `docs/Benchmark results/truly-progressive-<ts>.md` with per-preset table and verdict.

### No false-positive defaults
Don't wire `previewFirst → SNEYERS_PRESET` (P4) until the matrix proves the named preset wins. If a different combo wins, ship that combo under the `SNEYERS_PRESET` name (name is the public surface, internals follow numbers).

## Rollout phases

```
P1. Evidence:    Sneyers preset measured on 30 ORF (Gobabeb set, `C:\995\2026-02-20 Gobabeb To Windhoek`)
                 + 11 JPEG (P2200 set; JPEG counterparts in same Gobabeb folder under `JPEG/`).
                 Sweep effort ∈ {3, 5}. Numbers persisted to docs/Benchmark results/.
P2. Verdict:     Compare measured rows. Pick winner on composite:
                 monotone=true AND lowest firstRecognizableBytes
                 AND finalPsnr ≥ 40 dB AND encode within 1.5× current default.
P3. Rename:      Winning combo → SNEYERS_PRESET constant.
                 Public export name stays stable regardless of internal flag values.
P4. Wire:        facade.ts:resolveEncoderBridgeSettings — when previewFirst===true
                 and no per-flag overrides, return SNEYERS_PRESET flags.
                 Gated by single useSneyersDefault boolean for one-line rollback.
P5. Migration:   Per-flag overrides (progressiveDc/Ac/qProgressiveAc/groupOrder)
                 still win; preset only fills unset values.
P6. Docs:        Update suggested-settings.md with measured numbers + recipe.
                 Update progressive-encode-options.md status → "Implemented".
                 Update INCOMPLETE PLANS.md Tauri progressive line with citation.
```

## Backwards compatibility

- Public surface unchanged: `progressive: true` + `previewFirst: true` keeps working, just produces better bytes-to-recognizable behaviour.
- Per-flag overrides still honoured exactly as today.
- Existing `createProgressiveWebPreset` retained; `SNEYERS_PRESET` and `createSneyersPreset` are additive.

## Rollback

P4 wiring lives behind a single `useSneyersDefault` boolean in `resolveEncoderBridgeSettings`. Flip false → revert to current default. No bridge change to roll back; bundle stays valid.

## Risk register

| Risk | Mitigation |
|------|-----------|
| effort=3 produces too few intermediate passes for `kPasses` to fire | If effort=3 row has <3 paints despite AC=QAC=1, escalate to effort=5; only climb higher with data |
| decodingSpeed=0 increases file size unacceptably | Measure ratio delta; if > 10% larger, ship ds=1 or default |
| group=1 (center-out) breaks tiled/ROI decode | Verify against existing JXTC/tiled tests before P4 wire |
| DC=2 increases header bytes, pushing past 10% firstPaintBytes threshold for small files | Threshold is a *target*; flag violation in report, decide per data whether to ship DC=1 instead |
| Sneyers preset wins on JPEG but loses on RAW (or vice versa) | Two presets: `SNEYERS_PRESET_PHOTO` + `SNEYERS_PRESET_RAW`. Or pick the combo that wins worst-case |
| `dist/facade.js` rebuild fails due to toolchain drift | Document `pnpm -F @casabio/jxl-wasm build` requirements in CLAUDE.md; CI catches |

## Done definition

- Both bench scripts run successfully on the full reference sets; artifacts in `docs/Benchmark results/`.
- `SNEYERS_PRESET` is wired as the `previewFirst` default (under measured-best name).
- UI throttle slider on `web/jxl-progressive-paint.html` shows visibly growing image at 50/100/500/2000 KB/s.
- `dist/facade.js` synced and committed.
- All tests green: unit, integration, visual smoke, live UI.
- `docs/superpowers/specs/2026-06-03-truly-progressive-jxl-design.md` (this file) committed.
- `docs/INCOMPLETE PLANS.md` Tauri progressive line marked done with measurement citation.
- `docs/references/designs/progressive-encode-options.md` status set to "Implemented".
- `docs/suggested-settings.md` updated with the measured Sneyers recipe and numbers.

## References

- libjxl encoder progressive flag enums: `JXL_ENC_FRAME_SETTING_PROGRESSIVE_DC`, `JXL_ENC_FRAME_SETTING_PROGRESSIVE_AC`, `JXL_ENC_FRAME_SETTING_QPROGRESSIVE_AC`, `JXL_ENC_FRAME_SETTING_BUFFERING`, `JXL_ENC_FRAME_SETTING_GROUP_ORDER`, `JXL_ENC_FRAME_SETTING_RESPONSIVE`.
- libjxl decoder progressive flags: `JxlDecoderSetProgressiveDetail(kDC | kLastPasses | kPasses | kDCProgressive)`, `JxlDecoderFlushImage`, `JXL_DEC_FRAME_PROGRESSION`.
- Jon Sneyers blog posts on responsive / progressive JPEG XL: cited from the jxl.info site (review qualitatively; measurements drive defaults).
- `packages/jxl-wasm/src/bridge.cpp` lines 462-477 (`ApplyProgressiveFrameSettings`), 1848-2065 (`TryFlushProgressiveImage`, `jxl_wasm_dec_create`, `jxl_wasm_dec_push`).
- `packages/jxl-wasm/src/facade.ts` lines 720-742 (`resolveEncoderBridgeSettings`), 1325-1633 (`eventsProgressive`).
- `benchmark/progressive-flag-matrix.mjs` (existing RAW streaming bench, blueprint for JPEG version).
- `web/jxl-progressive-paint.js` (existing UI host for throttle slider).
