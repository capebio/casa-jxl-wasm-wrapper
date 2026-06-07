# Progressive Paint Speedup — Approach A

Date: 2026-06-06
Status: Draft → user review
Branch: `codex/optimal-settings-timing-tests`

## Goal

Cut total wall-clock and first-paint latency of worker progressive decode so it beats one-shot at large sizes and stays competitive (or wins) at small sizes. Reduce variance across reruns.

Current measured loss vs one-shot (worker, baseline `progressiveDc=2 progressiveAc=1 qProgressiveAc=1 poolSize=1 pushHwm=64`):

| Size  | Passes | Progressive ms | One-shot ms |
|-------|--------|----------------|-------------|
| 160   | 2      | 254            | 12          |
| 320   | 2      | 63             | 26          |
| 640   | 2      | 140            | 90          |
| 1080  | 3      | 565            | 265         |
| 1920  | 4–7    | 598–1923       | 726         |
| 2160  | 5–8    | 577–2659       | 851         |

Variance: 1139 ms vs 1531 ms on identical settings (1.34×). Some runs dominated by per-pass paint cost.

## Non-goals

- WASM bridge rebuild. Approach B (zero-copy `TryFlushProgressiveImage`) is a separate spec; gate on measured residual gap after A lands.
- Dirty-rect partial paint via libjxl group geometry. Approach C; deferred.
- Auto-disable progressive at small sizes. User wants to keep exploring whether progressive can win below 1080 px; do not policy-gate it out.

## Root causes (verified in code + user's TOON timings)

1. **Inter-step delay injection** — `web/jxl-progressive-paint.js:899-901` adds `await nextPaint(); await sleep(32);` between every stream step. 5 passes = ~240 ms of artificial idle time.
2. **Block-borders diff scans full image per pass on main thread** — `web/jxl-single-progressive.js:1228-1271`. Plain JS byte-by-byte RGBA loop over 2160×1613 = 3.48 M pixels, with `%` and `Math.floor` per changed pixel. User's TOON data: paintMs sum 242 ms vs 18 ms (di 1920) and 467 ms vs 30 ms (vl 2160) between borders-on and borders-off runs on identical settings. Equal to entire progressive-vs-one-shot gap.
3. **Per-pass canvas churn** — `makePassCanvas` (`jxl-progressive-paint.js:635`) allocs new HTMLCanvasElement and runs `putImageData` for full frame; then `addPassToTimeline` does `drawImage` to thumbnail; then `autoAssignPass` does `drawImage` to slot. 3 full-frame rasters per pass.
4. **Per-pass full-image stats scan** — `analyzeProgressiveFrame` walks every pixel for hash + variance + alpha stats. O(W×H) × passes. Always runs; not gated.
5. **No paint coalescing** — every `decode_progress` event triggers full UI work synchronously, even when next event is already queued.

Variance source: GC pressure from per-pass canvas + ImageData allocs + diff buffer hits. Confirmed by 1.34× rerun spread on identical inputs.

## Scope (Approach A — JS/UI only, no WASM rebuild)

### A1. Drop artificial inter-step delay

File: `web/jxl-progressive-paint.js:891-905` (`streamIntoDecoder`).

Current:
```js
if (i < streamSteps.length - 1) {
    setProgStatus(...);
    await nextPaint();
    await sleep(32);
}
```

New: remove `nextPaint()` and `sleep(32)`. The setProgStatus message is informational only; can stay or move outside the wait. Throttled mode (`feedThrottled`) keeps its `sleep(msPerChunk)` — that is user-controlled bandwidth simulation.

Note: this changes nothing for codec behaviour. libjxl gets the same bytes. We just stop padding the wall clock.

### A2. rAF-coalesce progressive paints

File: `web/jxl-progressive-paint.js` event loop in `collectProgressivePaintEvents` (line 831).

Replace synchronous per-event canvas work with a one-slot pending-frame queue:

```js
let pendingFrame = null;   // { pixels, info, t, passIdx, isFinal }
let rafPending = false;

function schedulePaint(frame) {
  pendingFrame = frame;   // newer event replaces older
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    const f = pendingFrame;
    pendingFrame = null;
    if (!f) return;
    paintPass(f);
  });
}
```

`paintPass(f)` runs the canvas + timeline + autoAssign code that currently lives inline. `final` events MUST always paint — bypass coalescing if `isFinal`.

Semantics:
- If progress events arrive faster than display refresh, intermediate pixels dropped; only most-recent survives to paint. Final never dropped.
- Pixels are detached `ArrayBuffer`s from worker. Once superseded, the dropped buffer can be GC'd; this reduces overall memory churn vs current path that allocates a canvas for each.
- Per-pass stats / timeline thumbs computed inside `paintPass`, so dropped passes also skip stats. This is intentional — dropped passes don't appear in the timeline. Document this in the bench UI.

Edge: byte-cutoff probe (`runByteCutoffProbe`) is a separate decode session and unaffected.

### A3. Persistent canvases; no `makePassCanvas`

Files: `web/jxl-progressive-paint.js:635 (makePassCanvas)`, `:768 (assignPassToCompareSlot)`, `:793 (addPassToTimeline)`.

Plan:
- Compare slots: store one persistent offscreen RGBA canvas per slot, dimensioned to the current run's pass size on first paint. Subsequent passes `putImageData` straight into it. `paintCanvasIntoSlot` already does `drawImage(srcCanvas)` into the visible canvas — keep that step; just stop creating a fresh `srcCanvas` per pass.
- Timeline thumbs: keep one persistent thumb canvas per pass (created lazily on first paint of that pass index). Re-runs that clear the timeline release the old set.
- Drop `makePassCanvas` entirely. `paintPass(f)` puts pixels directly into the slot's persistent canvas, then draws thumb from that canvas to the thumb canvas.

Saves 2 of 3 full-frame rasters per pass (the intermediate srcCanvas → slot copy, and the analogous intermediate for the thumbnail).

### A4. Gate full-image stats behind debug flag

File: `web/jxl-progressive-paint.js:842 (analyzeProgressiveFrame)`.

- Default: stats off. Per-pass record still includes `t`, `isFinal`, `passIdx`, byte-cutoff bookkeeping. Frame stats fields become `null`.
- Toggle: `?stats=1` query param. No new UI control — keeps bench surface stable and avoids muscle-memory churn. Document on the page footer.
- CSV/JSON/TOON exporters already tolerate missing stats fields (per-pass exporter checks `p.stats`).
- When stats off, `formatFrameStatsLog` skipped; dbgLog line just shows `pass N · t ms · partial|final`.

Expected: removes O(W×H) per-pass scan from default sweep runs.

### A5. (number reserved — no auto-disable; user wants to keep exploring small-size progressive)

### A6. Block-borders diff — tile-aware first-diff-wins + bbox pre-pass

File: `web/jxl-single-progressive.js:1228 (computeChangedBlocks)`.

Constants already declared: `BLOCK_BORDER_TILE_SIZE = 256`. Keep.

New algorithm:

```
const TILE = 256;
const cols = ceil(W / TILE);
const rows = ceil(H / TILE);
const changed = new Uint8Array(cols * rows);

// Uint32 view = 1 compare per pixel instead of 4 byte compares
const cur32 = new Uint32Array(current.buffer, current.byteOffset, W*H);
const prv32 = new Uint32Array(previous.buffer, previous.byteOffset, W*H);

// Stage 1: stride-sample bbox.
// Sample every STRIDE rows, every STRIDE cols. Mark hit tiles.
// Tunable: STRIDE = 10 rows × 10 cols. Cost: W*H/100 compares.
// Output: bbox [tr0..tr1, tc0..tc1] of tiles that contain at least one sampled diff.
// Tiles outside bbox remain unmarked (assumed unchanged).
// Note: this is a heuristic. A diff fully contained in a 10×10 sub-tile patch can be
// missed. Acceptable: borders are a developer inspection tool, not a correctness gate.
// If user wants strict mode, add `?bordersStrict=1` to skip Stage 1 and run Stage 2
// over the full image.

// Stage 2: per-tile first-diff-wins within bbox.
for (tr in [tr0..tr1])
  for (tc in [tc0..tc1])
    if changed[tr*cols+tc] already 1, continue
    const y0 = tr*TILE, y1 = min(H, y0+TILE)
    const x0 = tc*TILE, x1 = min(W, x0+TILE)
    outer:
    for (y = y0; y < y1; y++) {
      const rowBase = y * W
      for (x = x0; x < x1; x++) {
        if (cur32[rowBase + x] !== prv32[rowBase + x]) {
          changed[tr*cols+tc] = 1
          break outer
        }
      }
    }

// Emit blocks from `changed` grid as before.
```

Wins:
- Common case (tile changed): exits inner loop on first differing pixel. ~few compares per tile vs 65k.
- Uint32 compare: 4× over current byte-by-byte for tiles that ARE clean.
- Late progressive passes (localized AC refinement): bbox stage skips most tiles outright; no inner scan.
- Early passes (everything changes): degrades to ~Uint32-compare-per-tile cost = ~4× speedup baseline.

### A7. Memoize changed-blocks per pass pair

Compute `changed` keyed on `(currentPass.frameHash, previousPass?.frameHash)` (or pass index tuple if hash off). Store on `currentPass._changedBlocks`. Reused on every redraw (zoom, resize, slot reassign). Currently recomputed on every `drawPassWithOverlay` call.

### A8. Default borders OFF for bench sweeps; keep ON in single-pass inspection

User keeps block borders as testing tool. To stop them inflating timing-test numbers:

- HTML default `<input id="show-block-borders" type="checkbox" checked />` → leave as-is for interactive use.
- Add explicit "Run timing sweep" path (or surface a `?borders=0` query param) that forces the checkbox off before the run starts and restores after.
- Document in `docs/Tested-settings.md` that all baselines must specify borders state.

If we instead default OFF and rely on user to toggle on per inspection, that flips muscle memory. Decision: keep checked default, add the sweep-mode override.

## Files changed (estimate)

| File | Change |
|------|--------|
| `web/jxl-progressive-paint.js` | A1, A2, A3, A4 |
| `web/jxl-single-progressive.js` | A6, A7, A8 (sweep override only) |
| `web/jxl-progressive-paint.test.js` (new tests) | A1 timing, A2 coalesce dropping, A4 stats gating |
| `web/jxl-single-progressive.test.js` or new | A6 block-diff correctness vs old impl on synthetic frames |
| `docs/Tested-settings.md` | Record borders-state in baselines |

No bridge / facade / scheduler changes. No protocol changes. No WASM rebuild.

## Test plan

Unit:
- A2: feed 3 synthetic progress events synchronously into `schedulePaint`; assert only 1 paint occurs, with most-recent pixels. Feed `final` event; assert it bypasses coalescing.
- A4: with `?stats=0` (default), per-pass record `.stats === null`. With `?stats=1`, populated.
- A6: build two RGBA buffers with known diffs in tiles (0,0), (1,2), (3,3); compare `computeChangedBlocks` old vs new — same `changed` grid for fully-changed tiles. Document Stage 1 sampling limit with a "diff smaller than STRIDE in both dims" case and either accept the miss or require strict-mode.
- A6: Uint32 view alignment — ensure `byteOffset` divisible by 4 (callers concat chunks; verify).
- A7: same pass pair twice → second call returns cached array (spy on tile-scan inner).

Integration (manual + bench):
- Re-run user's TOON sweep with A1+A2+A3 only, borders OFF. Expected: di 1920 ~700 ms, vl 2160 ~800-900 ms.
- Re-run with borders ON + A6+A7. Expected: paintMs per pass falls from 30-100 ms to 5-15 ms on di/vl.
- Variance: ≥3 reruns per size; expect rerun spread to drop from 1.34× to <1.10×.

## Success criteria

- Borders OFF: worker progressive total wall time ≤ one-shot wall time at di 1920 and vl 2160.
- Borders ON: paintMs per pass at vl 2160 drops by ≥4× vs current.
- Rerun variance (max/min) of total wall time drops below 1.15× on identical inputs.
- No new test failures in `web/`, `packages/jxl-worker-browser/`, `packages/jxl-wasm/`.
- Bench page (single-progressive) visual output unchanged when borders ON; per-pass thumbnails still appear (dropped intermediate passes acknowledged in user-facing copy under "Coalescing: paints faster than display rate are dropped to keep up.").

## Open follow-ups (not in this spec)

- Approach B: bridge zero-copy `TryFlushProgressiveImage`. Gate on residual gap after A.
- Approach C: dirty-rect partial paint via libjxl group geometry. Defer.
- Investigation: why anomaly `qProgressiveAc=2` causes 5.2 s on di. Encoder structure decision; out of scope here.
- Investigation: main-thread 6-pass / 10.1 s run vs worker 1.1-1.5 s run on same image. Possible coalescing already happening at worker→main boundary; verify after A2 lands.
