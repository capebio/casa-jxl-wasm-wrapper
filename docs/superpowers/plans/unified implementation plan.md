# Unified Implementation Plan — Progressive JXL Improvements

> **For agentic workers:** Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking. Phases run A → I in order; tasks within a phase may parallelise where noted.

**Goal:** Land all DO-IT items from the progressive-JXL investigations as one coherent rollout. Close the progressive-vs-one-shot gap, expose encoder knobs the bridge already supports, surface libjxl's own progressive telemetry, and prepare the gallery for true round-robin paint.

**Sources unified by this plan (read these once before starting):**
- `docs/superpowers/plans/2026-06-05-single-progressive-perf-investigation.md` — per-pass cost analysis (Phase A pulls all 8 tasks from here verbatim).
- `docs/Research/2026-06-05-progressive-jxl-five-investigations.md` — five investigations + deep-dive verdicts (Phases B-I).
- `docs/HANDOFF-single-progressive-progressive-tuning-2026-06-05.md` — handoff invariants that **must not** be violated.

**Phase summary:**

| Phase | Goal | WASM rebuild? | Can split agents? |
|-------|------|---------------|-------------------|
| A | Cut per-pass paint cost on single-progressive page | No | Tasks sequential |
| B | Worker-decode toggle for single-progressive | No | One agent |
| C | Encoder UI knobs: AC layers + decoding_speed | No | One agent |
| D | Default `dc=2` + PSNR-vs-pass chart | No | One agent |
| E | Bridge rebuild: `IntendedDownsamplingRatio` + `is_last` readback | **Yes** | One agent |
| F | Worker-side frame-stats offload | No (depends on A2) | One agent |
| G | Perceptual cutoff stopping rule | No (depends on E) | One agent |
| H | Round-robin gallery orchestrator | No | One agent |
| I | Sidecar thumbnail encode pipeline | No | One agent |

**Cross-phase dependency graph:**

```
A (paint cost)  ─┬─►  B (worker toggle)  ─►  D (defaults + PSNR chart)
                 ├─►  C (encoder UI knobs)
                 └─►  F (worker stats)
                         ▲
E (bridge IntendedDownsamplingRatio) ─►  G (perceptual cutoff)

H (gallery round-robin) — independent of A-G
I (sidecar thumbnails) — independent of A-G
```

A is the spine. B-D can land in any order once A is done. E unblocks G. F refines A2. H and I are standalone.

**Handoff invariants (DO NOT VIOLATE — see handoff doc for full context):**

1. Bridge generation gate (`packages/jxl-wasm/src/bridge.cpp:2038-2041`) stays — `opportunistic_flush_generation`.
2. No `prev_flush_checksum` dedup — was removed in commit `4764a67`, stays removed.
3. Per-chunk yield in `feedThrottled` stays — `sleep(0)` between chunks is load-bearing for multi-pass output. Removing it collapses to 2 frames.
4. Bigger chunks are OK (Phase A Task 6); zero chunks is not.

**Verification cadence:**

After every task, run:

```powershell
rtk bun test web/jxl-single-progressive-page.test.js
```

After phases that touch the gallery (H) or worker path (B, F):

```powershell
rtk bun test web/jxl-progressive-gallery.test.js packages/jxl-wasm/test/progressive-detail.test.ts
```

After phases that change the bridge (E):

```powershell
rtk bun test packages/jxl-wasm/test/progressive-detail.test.ts web/jxl-single-progressive-page.test.js web/jxl-progressive-paint-page.test.js
```

Manual A/B protocol for paint-affecting changes (Phases A-D, F, G):

1. Open `web/jxl-single-progressive.html` in Chrome.
2. Settings: `size=very-large`, `quality=very-high`, `throttle=unthrottled`, `progressiveDc=0` (until Phase D flips it), `groupOrder=center-out`, `block-borders=off`.
3. Click **Retrieve raw file**, record median of 3 runs: First paint, Final paint, One-shot, Passes, Visible progress.
4. Confirm `Passes ≥ 8` and `Visible progress ≥ 6` after every change to guard the 2-frame regression.

---

## Phase A — Per-pass paint cost on single-progressive page

**Goal:** drop final-paint time from ~2900 ms to ~400-600 ms by removing per-pass redundant work. First paint also drops as a side effect.

**Architecture:** all main-thread JS edits in `web/jxl-single-progressive.js`, with HTML default flip in Phase A5 and source-string test updates in A6.

**Predicted total impact:** first paint ~280 ms → ~50-80 ms; final paint ~2900 ms → ~400-600 ms.

### Task A1 — Bound the tile canvas to thumbnail size

**Files:** `web/jxl-single-progressive.js:589-607` (`renderProgressivePass`).

**Why:** tile is shown at 82 px tall (HTML CSS). Allocating a full-resolution backing store per pass wastes ~11 MB GPU memory per tile + a full `putImageData`. Rendering the tile by downscaling from the main canvas via `drawImage` skips both the putImageData and the second `computeChangedBlocks` call.

- [ ] **Step 1: Measure baseline.** Run A/B protocol. Record First paint, Final paint, Passes.

- [ ] **Step 2: Edit `renderProgressivePass`.**

Replace lines 589-607 with:

```js
const TILE_LONG_EDGE_PX = 192; // 2x typical CSS render size for crisp HiDPI tiles

function renderProgressivePass(pass) {
    const previousPass = currentPasses[pass.pass - 2] ?? null;
    drawPassWithOverlay(canvas, pass, previousPass);
    viewerMeta.textContent = `pass ${pass.pass}${pass.isFinal ? ' final' : ''} | ${formatBytes(pass.bytesFed ?? 0)} streamed | +${pass.deltaMs ?? '--'} ms | hash ${pass.stats?.frameHash ?? '--'}`;
    const tile = document.createElement('button');
    tile.className = 'pass-tile';
    tile.type = 'button';
    const tileCanvas = document.createElement('canvas');
    const tileScale = Math.min(1, TILE_LONG_EDGE_PX / Math.max(pass.width, pass.height));
    tileCanvas.width = Math.max(1, Math.round(pass.width * tileScale));
    tileCanvas.height = Math.max(1, Math.round(pass.height * tileScale));
    const tileCtx = tileCanvas.getContext('2d');
    tileCtx.imageSmoothingEnabled = true;
    tileCtx.imageSmoothingQuality = 'medium';
    tileCtx.drawImage(canvas, 0, 0, tileCanvas.width, tileCanvas.height);
    const label = document.createElement('span');
    label.textContent = `Pass ${pass.pass}${pass.isFinal ? ' final' : ''} | ${formatBytes(pass.bytesFed ?? 0)} | +${pass.deltaMs ?? '--'} ms`;
    tile.append(tileCanvas, label);
    tile.addEventListener('click', () => {
        showPassInLightbox(pass.pass - 1);
    });
    passStrip.append(tile);
}
```

- [ ] **Step 3: Run the page test.**

```powershell
rtk bun test web/jxl-single-progressive-page.test.js
```

Expected: PASS. `drawPassWithOverlay` still referenced.

- [ ] **Step 4: Re-measure.** Final paint should drop ~150 ms. Passes unchanged.

- [ ] **Step 5: Commit.**

```powershell
git add web/jxl-single-progressive.js
git commit -m "perf(single-progressive): render tile via drawImage downscale not full putImageData"
```

### Task A2 — Drop redundant pixel clone + defer `analyzeProgressiveFrame`

**Files:** `web/jxl-single-progressive.js:559-571` (`makePassRecord`) plus callers at `:467-514` (event handler), `:728` (`passLightboxStats`), `:828` (`buildMeasurement`).

**Why:** `event.pixels` from the facade is already an owned `Uint8Array` (facade.ts:3133 uses `HEAPU8.slice`). Cloning it again at line 560 allocates and memcpies a second 11 MB buffer per pass — the most likely cause of the two ~400 ms GC stalls. Frame stats analyzer also runs per pass at ~30-50 ms; defer to lightbox open or measurement export.

- [ ] **Step 1: Replace `makePassRecord` body.**

```js
function makePassRecord(event, index, t, width, height) {
    const pixels = event.pixels instanceof Uint8Array
        ? event.pixels
        : new Uint8Array(event.pixels);
    return {
        pass: index + 1,
        t_ms: Number(t.toFixed(2)),
        isFinal: event.type === 'final',
        width: event.info?.width ?? width,
        height: event.info?.height ?? height,
        pixels,
        stats: null,
    };
}
```

- [ ] **Step 2: Add `computeAndCachePassStats` helper near `makePassRecord`.**

```js
function computeAndCachePassStats(pass) {
    if (pass.stats) return pass.stats;
    if (!pass.pixels) {
        pass.stats = { alphaMin: 0, alphaMax: 0, alphaZeroPct: 0, rgbNonzeroCount: 0, lumaVariance: 0, frameHash: '--', pixelCount: 0, byteLength: 0 };
        return pass.stats;
    }
    pass.stats = analyzeProgressiveFrame(pass.pixels, pass.width, pass.height);
    return pass.stats;
}
```

- [ ] **Step 3: Strip stats from dbgLog + console.log in the event handler** (around line 492-508). Drop `formatFrameStatsLog(pass.stats)` from the dbgLog string; drop the entire `console.log('[Single progressive] frame stats', ...)` block (lines 497-508).

- [ ] **Step 4: Update `renderProgressivePass`'s viewerMeta** to remove the `hash` suffix. (Already adjusted in Task A1's snippet via `pass.stats?.frameHash ?? '--'` — keep the safe optional chain.)

- [ ] **Step 5: Update `passLightboxStats`** (line 728) to compute stats lazily:

```js
function passLightboxStats(pass) {
    const s = computeAndCachePassStats(pass);
    return [
        ['Pass', `${pass.pass}${pass.isFinal ? ' final' : ''}`],
        ['Streamed', `${formatBytes(pass.bytesFed ?? 0)} (${pass.percentFed ?? 0}%)`],
        ['Time', `${pass.t_ms} ms`],
        ['Delta', `${pass.deltaMs ?? '--'} ms, ${formatBytes(pass.deltaBytes ?? 0)}`],
        ['Delta transfer', formatTransferSpeed(pass.deltaKbPerSec)],
        ['Dimensions', `${pass.width}x${pass.height}`],
        ['Hash', s.frameHash],
        ['Alpha', `${s.alphaMin}-${s.alphaMax}, zero ${s.alphaZeroPct.toFixed(2)}%`],
        ['RGB nonzero', String(s.rgbNonzeroCount)],
        ['Luma variance', s.lumaVariance.toFixed(2)],
    ];
}
```

- [ ] **Step 6: Update `buildMeasurement`'s perPass map** (line ~828):

```js
const perPass = decode.passes.map(pass => {
    const stats = computeAndCachePassStats(pass);
    return {
        pass: pass.pass,
        t_ms: pass.t_ms,
        isFinal: pass.isFinal,
        bytesFed: pass.bytesFed ?? null,
        percentFed: pass.percentFed ?? null,
        transferKbPerSec: pass.transferKbPerSec ?? null,
        delta_ms: pass.deltaMs ?? null,
        delta_bytes: pass.deltaBytes ?? null,
        delta_kb_per_sec: pass.deltaKbPerSec ?? null,
        deltaKbPerSec: pass.deltaKbPerSec ?? null,
        stats: normalizeFrameStatsForExport(stats),
    };
});
```

- [ ] **Step 7: Run the page test.**

```powershell
rtk bun test web/jxl-single-progressive-page.test.js
```

Expected: PASS.

- [ ] **Step 8: Re-measure.** Final paint should drop another ~400-700 ms. The two ~400 ms GC stalls in pass deltas should disappear.

- [ ] **Step 9: Commit.**

```powershell
git add web/jxl-single-progressive.js
git commit -m "perf(single-progressive): defer analyzeProgressiveFrame off hot path; drop redundant pixel clone"
```

### Task A3 — Replace `await nextPaint()` with `await sleep(0)`

**Files:** `web/jxl-single-progressive.js:509`.

**Why:** `nextPaint` blocks a full vsync (~16 ms on 60 Hz). With 14 passes that is ~224 ms of pure vsync stall. `putImageData` is synchronous to the JS step boundary — it does not need vsync to flush. A microtask yield (`sleep(0)`) is enough.

- [ ] **Step 1: Replace line 509.**

From:

```js
await nextPaint();
```

To:

```js
await sleep(0);
```

- [ ] **Step 2: Sanity check.**

```powershell
rtk proxy node --check web/jxl-single-progressive.js
rtk bun test web/jxl-single-progressive-page.test.js
```

- [ ] **Step 3: Measure.** Final paint should drop another ~100-220 ms. **Visually verify** pass count ≥ 8 and progression looks gradual. If passes collapse, revert and use a hybrid: `sleep(0)` for intermediate, `nextPaint()` for final.

- [ ] **Step 4: Commit.**

```powershell
git add web/jxl-single-progressive.js
git commit -m "perf(single-progressive): yield events via sleep(0) instead of rAF vsync"
```

### Task A4 — Skip canvas dimension reset when unchanged

**Files:** `web/jxl-single-progressive.js:743-749` (`drawPixels`).

**Why:** writing to `canvas.width`/`canvas.height` always clears the canvas and may force GPU texture reallocation, even when unchanged. After the first pass dims are stable.

- [ ] **Step 1: Edit `drawPixels`.**

```js
function drawPixels(targetCanvas, pixels, width, height) {
    if (targetCanvas.width !== width) targetCanvas.width = width;
    if (targetCanvas.height !== height) targetCanvas.height = height;
    const ctx = targetCanvas.getContext('2d');
    const data = new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    ctx.putImageData(new ImageData(data, width, height), 0, 0);
}
```

- [ ] **Step 2: Test + measure.** Modest gain ~30-70 ms.

- [ ] **Step 3: Commit.**

```powershell
git add web/jxl-single-progressive.js
git commit -m "perf(single-progressive): skip canvas dim reset when unchanged"
```

### Task A5 — Default block-borders overlay to OFF

**Files:** `web/jxl-single-progressive.html:169`.

**Why:** when overlay is ON, `computeChangedBlocks` runs on the main canvas (22 MB read per pass). Default off; toggle still available.

- [ ] **Step 1: Edit HTML.**

Change `<input id="show-block-borders" type="checkbox" checked />` to `<input id="show-block-borders" type="checkbox" />`.

- [ ] **Step 2: Test + measure.** Final paint drops ~400-600 ms.

- [ ] **Step 3: Commit.**

```powershell
git add web/jxl-single-progressive.html
git commit -m "perf(single-progressive): default block-borders overlay to off"
```

### Task A6 — Reshape chunk schedule for earlier first paint

**Files:** `web/jxl-single-progressive.js:10-11` (constants), `:573-587` (`feedThrottled`), `web/jxl-single-progressive-page.test.js:67-68`.

**Why:** `FIRST_PAINT_DECODE_CHUNK_BYTES = 2 KiB` forces ~30 macrotask round-trips to first paint (~9 ms each → ~270 ms). Geometric ramp keeps fine yields for the first few chunks (header parsing) then grows to amortise the round-trip overhead. Per-chunk yield is **kept** to preserve multi-pass output (handoff invariant).

- [ ] **Step 1: Replace constants at lines 10-11.**

```js
const FIRST_PAINT_CHUNK_RAMP = [1 * 1024, 2 * 1024, 4 * 1024, 8 * 1024, 16 * 1024];
const STEADY_DECODE_CHUNK_BYTES = 32 * 1024;
```

- [ ] **Step 2: Edit `feedThrottled` at lines 573-587.**

```js
async function feedThrottled(decoder, jxlBytes, throttleKbPerSec, feedState) {
    let offset = 0;
    let preFirstPaintChunkIndex = 0;
    while (offset < jxlBytes.byteLength) {
        let chunkBytes;
        if ((feedState?.passCount ?? 0) > 0) {
            chunkBytes = STEADY_DECODE_CHUNK_BYTES;
        } else {
            const rampIdx = Math.min(preFirstPaintChunkIndex, FIRST_PAINT_CHUNK_RAMP.length - 1);
            chunkBytes = FIRST_PAINT_CHUNK_RAMP[rampIdx];
            preFirstPaintChunkIndex++;
        }
        const start = offset;
        const end = Math.min(jxlBytes.byteLength, offset + chunkBytes);
        await decoder.push(exactBuffer(jxlBytes.subarray(offset, end)));
        offset = end;
        if (feedState) feedState.bytesFed = offset;
        const delayMs = throttleKbPerSec > 0 ? ((end - start) / 1024) * (1000 / throttleKbPerSec) : 0;
        if (delayMs > 0 && offset < jxlBytes.byteLength) await sleep(delayMs);
        else if (offset < jxlBytes.byteLength) await sleep(0);
    }
    await decoder.close();
}
```

- [ ] **Step 3: Update page test** at `web/jxl-single-progressive-page.test.js:67`. Change `expect(source).toContain('FIRST_PAINT_DECODE_CHUNK_BYTES');` to `expect(source).toContain('FIRST_PAINT_CHUNK_RAMP');`.

- [ ] **Step 4: Test + measure.** First paint should drop ~180 ms. **Confirm pass count ≥ 8 and visible progress ≥ 6.** If collapses, narrow ramp to `[2, 4, 8, 16]` or `[1, 2, 4, 8, 12, 16]`; re-measure.

- [ ] **Step 5: Commit.**

```powershell
git add web/jxl-single-progressive.js web/jxl-single-progressive-page.test.js
git commit -m "perf(single-progressive): ramp chunk size for earlier first paint"
```

### Task A7 — Add `paint_ms` / `decode_ms` split metric

**Files:** `web/jxl-single-progressive.js:467-514` (event handler), `:828` (`buildMeasurement`), `:968` (CSV header), `:1106` (markdown table), `web/jxl-single-progressive-page.test.js`.

**Why:** `delta_ms` blends decode + paint + GC. Splitting reveals which one to attack next.

- [ ] **Step 1: Wrap `renderProgressivePass` in the event handler.**

```js
const paintStart = performance.now();
renderProgressivePass(pass);
pass.paintMs = Number((performance.now() - paintStart).toFixed(2));
pass.decodeMs = Number(Math.max(0, deltaMs - pass.paintMs).toFixed(2));
setStatus(`Decoding ${formatBytes(bytesFed)}/${formatBytes(feedState.totalBytes)} (${pass.percentFed}%) · paint ${pass.paintMs} ms · decode ${pass.decodeMs} ms · pass ${pass.pass}${pass.isFinal ? ' final' : ''}`);
dbgLog(
    `Pass ${pass.pass}${pass.isFinal ? ' final' : ''}`,
    `${pass.t_ms} ms (+${pass.deltaMs} ms = ${pass.decodeMs} decode + ${pass.paintMs} paint) · ${formatBytes(bytesFed)}/${formatBytes(feedState.totalBytes)} (+${formatBytes(deltaBytes)}) · ${formatTransferSpeed(deltaKbPerSec)} delta`,
    'info'
);
await sleep(0);
```

- [ ] **Step 2: Surface in `perPass` map** (around line 828):

```js
paint_ms: pass.paintMs ?? null,
decode_ms: pass.decodeMs ?? null,
```

- [ ] **Step 3: Add CSV + Markdown columns.** In `exportMeasurementsCSV` headers add `'pass_paint_ms', 'pass_decode_ms'` and corresponding `(m.perPass || []).map(p => `${p.pass}:${p.paint_ms ?? ''}`).join(';')` rows. In `buildMeasurementsMarkdown` per-pass table add `Paint ms | Decode ms |` to header and rows.

- [ ] **Step 4: Update page test** — add:

```js
expect(source).toContain('paint_ms');
expect(source).toContain('decode_ms');
expect(source).toContain('paintMs');
```

- [ ] **Step 5: Test + commit.**

```powershell
rtk bun test web/jxl-single-progressive-page.test.js
git add web/jxl-single-progressive.js web/jxl-single-progressive-page.test.js
git commit -m "feat(single-progressive): split delta_ms into paint_ms and decode_ms"
```

### Task A8 — Bound retained pass-pixel memory

**Files:** `web/jxl-single-progressive.js:467-514` (event handler), lightbox handlers around `:609-635`.

**Why:** 14 × 11 MB = 154 MB resident for the lightbox + measurements. Adds GC pressure; combined with A2's clone-removal, eliminates the two ~400 ms stalls.

- [ ] **Step 1: Add `thinRetainedPassPixels` helper.**

```js
const RETAINED_PASS_BYTES_BUDGET = 64 * 1024 * 1024;

function thinRetainedPassPixels(passes) {
    if (passes.length <= 3) return;
    let totalBytes = 0;
    for (const p of passes) totalBytes += p.pixels?.byteLength ?? 0;
    if (totalBytes <= RETAINED_PASS_BYTES_BUDGET) return;

    const lastIdx = passes.length - 1;
    const intermediateCount = passes.length - 2;
    const keepEveryN = Math.max(1, Math.ceil(intermediateCount / 6));
    for (let i = 1; i < lastIdx; i++) {
        if ((i - 1) % keepEveryN !== 0) {
            passes[i].pixels = null;
        }
    }
}
```

- [ ] **Step 2: Call `thinRetainedPassPixels(passes)` before `decodeProgressively` returns** (just before `return { passes, avgTransferKbPerSec };` around line 525).

- [ ] **Step 3: Guard `showPassInLightbox`** against null pixels:

```js
if (!pass.pixels) {
    lightboxStats.innerHTML = '<div><span>Status</span><strong>pixels released to free memory</strong></div>';
    return;
}
```

(`computeChangedBlocks` already handles missing previous pixels via line 765 fallback.)

- [ ] **Step 4: Test + measure.** Memory peak drops from ~150 MB to ~50-60 MB on very-large/original runs.

- [ ] **Step 5: Commit.**

```powershell
git add web/jxl-single-progressive.js
git commit -m "perf(single-progressive): thin retained pass pixels above 64 MiB budget"
```

---

## Phase A done-criteria

After A1-A8 land:

- First paint ≈ 50-80 ms (was ~280 ms).
- Final paint ≈ 400-600 ms (was ~2900 ms).
- One-shot ≈ 250 ms (unchanged).
- Progressive/one-shot ratio ≈ 2× (was ~9×).
- Passes ≥ 10 (was 14 — A6 may drop count slightly; verify ≥ 8 minimum).
- Memory peak ≈ 50-60 MB (was ~150 MB).
- No two-frame regression on any A/B run.

If any of these regress, halt and diagnose before advancing to Phase B.

---
