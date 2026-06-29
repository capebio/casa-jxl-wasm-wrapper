# facade.ts hot-path kernel micro-optimizations (2026-06-29)

Branch: `perf/facade-kernels-20260629-cake` (superproject only — no submodule, no WASM rebuild).
Worktree: `C:\Foo\rcw-facade-cake`. Base: `6cda6c21`.

All changes are **byte-exact** (output bytes identical to the prior implementation) and proven
by a randomized flipflop harness that freezes the OLD implementations as an oracle and asserts
the new exported kernels match across a wide sweep of shapes/strides/regions/scales.

Test: `packages/jxl-wasm/test/facade-kernels-flipflop.test.ts`
(`bun test` — 6 tests, ~13.8k assertions). Existing `facade.test.ts` stays 53/53.

## Landed (3 wins)

1. **`applyRegionAndDownsample` — word-copy downsample + dead-clamp removal.**
   The old rgba16/rgbaf32 downsample path allocated a `data.subarray()` view **per output
   pixel** (`out.set(data.subarray(src, src+stride), dst)`); rgba8 did 4 element stores.
   New path walks source by a fixed pixel/row step and, when the source is 4-byte aligned,
   copies whole pixels as 32-bit words (1/2/4 words for rgba8/16/f32) — no per-pixel alloc.
   An unaligned per-byte fallback preserves correctness for non-4-aligned views (tested).
   The per-pixel `Math.min(...)` clamps are removed: `outWidth = ceil(w/ds)` ⇒
   `(outWidth-1)*ds ≤ w-1` (same for height), so the clamps were mathematically unreachable.
   Biggest win on 16-bit/float ROI/downsample (kills the subarray-per-pixel churn).

2. **`bilinearResize` / `buildResizeAxis` — weight caching + 4-channel unroll.**
   rgba8 8.8 fixed-point weights for *both* axes are now cached on the axis object
   (`fixed256`, via `fixedResizeWeights256`); a `ResizePlan` axis is reused across every
   progressive paint, so the float→int truncation happens once instead of per call/row.
   The 4-channel inner loop is unrolled for all three strides, and `1-xt`/`1-yt` are hoisted
   in the 16/f32 paths. Same arithmetic, same operand order ⇒ byte-exact.

3. **`ButteraugliComparator.compare` — reused candidate scratch.**
   `width`/`height` are fixed at construction, so `pixelSize` is constant. The candidate
   staging buffer is now allocated once (grow-only) and reused, removing a `malloc`/`free`
   pair per compare — meaningful for progressive paints and parameter sweeps. Freed in
   `dispose()`. Behavioral test asserts exactly one candidate allocation across N compares
   and that each compare reflects the freshly-copied candidate bytes.

Supporting change: the three pure kernels and `buildResizeAxis` are now `export`ed (from
`facade.ts` only — `index.ts` public surface unchanged) so the flipflop harness can call them.

## Deliberately NOT done (with reasons)

These came from the same review pass but are unsafe/inapplicable against the *current* file:

- **Direct-WASM staging rewrite of the buffered encoder.** Assumed a pre-refactor state.
  The current encoder still uses `pixelChunks` + the `EMPTY_U8` sentinel (`facade.ts:2251`);
  deleting them breaks the live buffered path. High risk, defer.
- **Deleting `RetainedBufferView` / `retainBufferView` / `takeBufferView`.** Still used by the
  progressive + final decode paths. Removal would break decode.
- **`compactQueue` simplification.** Removing the `copyWithin` no-alloc compaction is rejected
  in `CLAUDE.md` (DH-4) — it increases array churn during long streams.
- **Bounded ingestion / back-pressure in the facade (DecodePlan §3/§4).** `CLAUDE.md` invariant:
  backpressure lives at the scheduler/worker boundary, never in the facade.
- **Native progressive ROI / unified encoder bridge / WasmSpan / dirty-rect surfaces.** Require
  C++ bridge changes + a WASM rebuild (memory: 0.12 WASM is runtime-broken). Out of scope for a
  JS-only, byte-exact pass.
- **`prepareAdvancedSettings` double-`map()` → loop.** Trivially byte-exact but marginal and not
  cleanly unit-testable in isolation; dropped to avoid untested production code.

## Verification notes

- `bun test test/facade.test.ts test/facade-kernels-flipflop.test.ts` → 59 pass / 0 fail.
- Integration-suite failures in the worktree are all `ENOENT` source-file-read tests (worktree
  has no submodule checkout; one untracked `web/` file) plus the marginal-timing
  `progressive-visible-passes` test (~26–32s against a 30s wall; passes at 26.4s on the
  untouched primary checkout). None execute the modified code — that test decodes with
  `region:null, downsample:1` and no target, hitting the unchanged fast-path.
- `tsc --noEmit`: only pre-existing `process`/`loader.ts` env-type errors; no errors in changed code.
