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

## Phase B — Off-main-thread decode toggle for single-progressive

**Goal:** allow single-progressive page to A/B between main-thread decode (current) and worker decode (via jxl-session). Lets future encoder A/Bs reflect encoder behaviour, not main-thread paint cost.

**Reference:** investigations doc §7.1.

**Architecture:** add a checkbox to the page. When ON, route the decode through `createBrowserContext` from `@casabio/jxl-session` instead of `createDecoder` from `@casabio/jxl-wasm`. The frame stream API differs slightly; wrap behind a single `decodeProgressively` dispatch.

**Pre-flight check:** confirm session API surface.

```powershell
rtk proxy node -e "import('./packages/jxl-session/dist/index.js').then(m => console.log(Object.keys(m)))"
```

Expect `createBrowserContext` in the output. If missing, the package may need a build (`rtk bun --cwd packages/jxl-session run build`). Halt this phase if the dist isn't shipped.

### Task B1 — Add UI toggle + dispatch

**Files:** `web/jxl-single-progressive.html` (add control), `web/jxl-single-progressive.js` (dispatch).

- [ ] **Step 1: Add HTML control** after the `Group order` `<label>` block (around HTML line 167):

```html
<label class="inline-toggle" title="Decode in a Web Worker via jxl-session (frees main thread for paint)">
  <input id="decode-in-worker" type="checkbox" />
  Worker decode
</label>
```

- [ ] **Step 2: Add import + getter at the top of `web/jxl-single-progressive.js`** (after the existing `createDecoder` import):

```js
import { createBrowserContext } from '../packages/jxl-session/dist/index.js';

let _sessionCtx = null;
function getSessionCtx() {
    if (_sessionCtx === null) _sessionCtx = createBrowserContext();
    return _sessionCtx;
}
```

- [ ] **Step 3: Add `decodeProgressivelyViaWorker`** alongside the existing `decodeProgressively`. Keep both. The dispatch:

```js
async function decodeProgressivelyViaWorker({ jxlBytes, width, height, throttleKbPerSec }) {
    const ctx = getSessionCtx();
    const session = ctx.decode({
        format: 'rgba8',
        region: null,
        downsample: 1,
        progressionTarget: 'final',
        emitEveryPass: true,
        progressiveDetail: PROGRESSIVE_DETAIL,
        preserveIcc: false,
        preserveMetadata: false,
        priority: 'visible',
    });
    const passes = [];
    const decStart = performance.now();
    const feedState = { bytesFed: 0, totalBytes: jxlBytes.byteLength, passCount: 0 };

    const frameTask = (async () => {
        for await (const frame of session.frames()) {
            const t = performance.now() - decStart;
            const bytesFed = Math.min(feedState.totalBytes, feedState.bytesFed);
            const percentFed = feedState.totalBytes ? (bytesFed / feedState.totalBytes) * 100 : 100;
            const transferKbPerSec = computeTransferKbPerSec(bytesFed, t);
            const previousPass = passes.at(-1);
            const deltaMs = previousPass ? t - previousPass.t_ms : t;
            const deltaBytes = Math.max(0, bytesFed - (previousPass?.bytesFed ?? 0));
            const deltaKbPerSec = computeTransferKbPerSec(deltaBytes, deltaMs);
            // session.frames() events have shape { stage, info, pixels, ... }.
            // Map to the same record shape as the main-thread path.
            const pseudoEvent = {
                type: frame.stage === 'final' || frame.isFinal ? 'final' : 'progress',
                info: frame.info,
                pixels: frame.pixels instanceof Uint8Array ? frame.pixels : new Uint8Array(frame.pixels),
            };
            const pass = makePassRecord(pseudoEvent, passes.length, t, width, height);
            pass.bytesFed = bytesFed;
            pass.percentFed = Number(percentFed.toFixed(2));
            pass.transferKbPerSec = transferKbPerSec;
            pass.deltaMs = Number(deltaMs.toFixed(2));
            pass.deltaBytes = deltaBytes;
            pass.deltaKbPerSec = deltaKbPerSec;
            passes.push(pass);
            feedState.passCount = passes.length;
            currentPasses = passes;
            const paintStart = performance.now();
            renderProgressivePass(pass);
            pass.paintMs = Number((performance.now() - paintStart).toFixed(2));
            pass.decodeMs = Number(Math.max(0, deltaMs - pass.paintMs).toFixed(2));
            setStatus(`[worker] ${formatBytes(bytesFed)}/${formatBytes(feedState.totalBytes)} · paint ${pass.paintMs} ms · decode ${pass.decodeMs} ms · pass ${pass.pass}${pass.isFinal ? ' final' : ''}`);
            await sleep(0);
        }
    })();

    try {
        await feedThrottled(session, jxlBytes, throttleKbPerSec, feedState);
        await frameTask;
        await session.done();
    } finally {
        await session.close();
    }
    const finalMs = passes.find(p => p.isFinal)?.t_ms ?? passes.at(-1)?.t_ms ?? null;
    const avgTransferKbPerSec = computeTransferKbPerSec(jxlBytes.byteLength, finalMs);
    thinRetainedPassPixels(passes);
    return { passes, avgTransferKbPerSec };
}
```

- [ ] **Step 4: Dispatch at the call site in `runSourceWithSettings`** (around line 295):

```js
const useWorker = document.getElementById('decode-in-worker')?.checked === true;
const decode = await (useWorker
    ? decodeProgressivelyViaWorker({ jxlBytes: encodeBytes, width: target.width, height: target.height, throttleKbPerSec: settings.throttleKbPerSec })
    : decodeProgressively({ jxlBytes: encodeBytes, width: target.width, height: target.height, throttleKbPerSec: settings.throttleKbPerSec }));
```

- [ ] **Step 5: Update page test** — add:

```js
expect(html).toContain('id="decode-in-worker"');
expect(source).toContain('decodeProgressivelyViaWorker');
expect(source).toContain('createBrowserContext');
```

- [ ] **Step 6: Test + measure.** A/B both modes on the same source. Expectation: worker mode shows lower `paintMs` per pass (paint no longer blocks decode) and similar or slightly higher `decodeMs` (postMessage overhead). Net: similar or slightly better total. Most important: pass count stays ≥ 8 in worker mode (the scheduler's adaptive HWM must not coalesce too aggressively).

- [ ] **Step 7: If worker mode collapses passes**, the scheduler's chunk coalescing is too aggressive. Mitigation: call `session.push` with smaller chunks than `STEADY_DECODE_CHUNK_BYTES` (try `8 KiB`) or insert `await new Promise(r => setTimeout(r, 1))` between pushes. Document the workaround if needed.

- [ ] **Step 8: Commit.**

```powershell
git add web/jxl-single-progressive.html web/jxl-single-progressive.js web/jxl-single-progressive-page.test.js
git commit -m "feat(single-progressive): add Worker decode toggle via jxl-session"
```

---

## Phase C — Encoder UI knobs: AC layers + decoding_speed

**Goal:** surface bridge-exposed encoder knobs the page currently hides. Unlocks the chapter-4 recommendation: more, smaller pass deltas via `progressive_ac=2`, `qprogressive_ac=2`.

**Reference:** investigations doc §7.4, §7.9.

**Files:** `web/jxl-single-progressive.html`, `web/jxl-single-progressive.js`, `web/jxl-single-progressive-page.test.js`.

### Task C1 — Add `progressive_ac` / `qprogressive_ac` / `decoding_speed` controls

- [ ] **Step 1: Add HTML controls** after the `progressive-dc` label (around HTML line 160):

```html
<label>
  Progressive AC
  <select id="progressive-ac">
    <option value="0">0 · single AC pass</option>
    <option value="1" selected>1 · two-band split (Sneyers default)</option>
    <option value="2">2 · multi-band finer split</option>
  </select>
</label>
<label>
  qProgressive AC
  <select id="qprogressive-ac">
    <option value="0">0 · single quantization tier</option>
    <option value="1" selected>1 · two-tier (Sneyers default)</option>
    <option value="2">2 · multi-tier finer quantization</option>
  </select>
</label>
<label>
  Decoding speed
  <select id="decoding-speed">
    <option value="0" selected>0 · slowest decode / highest quality</option>
    <option value="1">1</option>
    <option value="2">2 · balanced</option>
    <option value="3">3</option>
    <option value="4">4 · fastest decode / lower quality</option>
  </select>
</label>
```

- [ ] **Step 2: Extend `readSettings`** (around line 331):

```js
const acRaw = document.getElementById('progressive-ac')?.value ?? '1';
const progressiveAc = Math.max(0, Math.min(2, Number(acRaw) || 0));
const qacRaw = document.getElementById('qprogressive-ac')?.value ?? '1';
const qProgressiveAc = Math.max(0, Math.min(2, Number(qacRaw) || 0));
const dsRaw = document.getElementById('decoding-speed')?.value ?? '0';
const decodingSpeed = Math.max(0, Math.min(4, Number(dsRaw) || 0));
return {
    // ...existing fields...
    progressiveAc,
    qProgressiveAc,
    decodingSpeed,
};
```

- [ ] **Step 3: Thread into `encodeSneyersDirect`** (around line 416):

```js
async function encodeSneyersDirect({ rgba, width, height, quality, lossless, progressiveDc, progressiveAc, qProgressiveAc, decodingSpeed, groupOrder }) {
    // ...existing preset wiring...
    const encoder = createEncoder({
        ...preset.encode,
        width,
        height,
        quality,
        ...(lossless ? { distance: 0 } : {}),
        ...(progressiveDc != null ? { progressiveDc } : {}),
        ...(progressiveAc != null ? { progressiveAc } : {}),
        ...(qProgressiveAc != null ? { qProgressiveAc } : {}),
        ...(decodingSpeed != null ? { decodingSpeed } : {}),
        ...(groupOrder != null ? { groupOrder } : {}),
        progressiveDetail: undefined,
        buffering: { strategy: 0 },
        chunked: false,
    });
    // ...rest unchanged...
}
```

And update the call site in `runSourceWithSettings`:

```js
const encodeBytes = await encodeSneyersDirect({
    rgba: targetRgba,
    width: target.width,
    height: target.height,
    quality: settings.qualityNumber,
    lossless: settings.lossless,
    progressiveDc: settings.progressiveDc,
    progressiveAc: settings.progressiveAc,
    qProgressiveAc: settings.qProgressiveAc,
    decodingSpeed: settings.decodingSpeed,
    groupOrder: settings.groupOrder,
});
```

- [ ] **Step 4: Surface in measurement** (`buildMeasurement` around line 870):

```js
progressiveAc: settings.progressiveAc,
qProgressiveAc: settings.qProgressiveAc,
decodingSpeed: settings.decodingSpeed,
progressive_ac: settings.progressiveAc,
qprogressive_ac: settings.qProgressiveAc,
decoding_speed: settings.decodingSpeed,
```

Add to CSV header + row, Markdown table, TOON export. Pattern matches existing `progressive_dc` handling.

- [ ] **Step 5: Update page test.**

```js
expect(html).toContain('id="progressive-ac"');
expect(html).toContain('id="qprogressive-ac"');
expect(html).toContain('id="decoding-speed"');
expect(source).toContain('progressiveAc');
expect(source).toContain('qProgressiveAc');
expect(source).toContain('decodingSpeed');
expect(source).toContain('progressive_ac');
expect(source).toContain('qprogressive_ac');
expect(source).toContain('decoding_speed');
```

- [ ] **Step 6: Verify encoder option names match facade.** Open `packages/jxl-wasm/src/facade.ts` and grep for `progressiveAc` and `qProgressiveAc` in `EncoderOptions`. If facade expects different casing (`progressive_ac` snake_case), adjust the option names at the call site. **This is a verification step — if the facade does not expose these as TS options, the bridge call will silently ignore them.**

```powershell
rtk proxy grep -n "progressiveAc\|qProgressiveAc\|decodingSpeed" packages/jxl-wasm/src/facade.ts
```

If the facade doesn't expose them, file a follow-up to extend the facade `EncoderOptions` type — small TS change. Document the result in the commit message.

- [ ] **Step 7: Run sweep.** Manual A/B on the same source: `(ac, qac) ∈ {(0,0), (1,1), (2,1), (2,2)}` with `dc=2`. Record pass count + first/final paint per combination. The (2,2) combination should produce ~18-22 passes.

- [ ] **Step 8: Commit.**

```powershell
git add web/jxl-single-progressive.html web/jxl-single-progressive.js web/jxl-single-progressive-page.test.js
git commit -m "feat(single-progressive): expose progressive_ac, qprogressive_ac, decoding_speed knobs"
```

---

## Phase D — Default `dc=2` + PSNR-vs-pass chart

**Goal:** make the canonical Sneyers truly-progressive layout the page default. Surface PSNR-vs-pass so the chapter-3 perceptual cutoff has visual evidence.

**Reference:** investigations doc Chapter 5 + Chapter 3.

### Task D1 — Flip the `progressive_dc` default

**Files:** `web/jxl-single-progressive.html:155-159`.

**Why:** current default `value="0" selected` produces block-by-block AC group landing, not Sneyers's whole-image refinement. `dc=2` gives 1:32 then 1:8 DC preview before AC — the canonical truly-progressive look.

- [ ] **Step 1: Edit the `progressive-dc` select.**

```html
<label>
  Progressive DC
  <select id="progressive-dc">
    <option value="2" selected>2 · 1:32 then 1:8 preview (Sneyers default)</option>
    <option value="1">1 · single 1:8 DC</option>
    <option value="0">0 · no DC progressive</option>
  </select>
</label>
```

- [ ] **Step 2: Update page test** if it asserts on the previous default:

```js
// Was: expect(html).toContain('value="0" selected>0 · no DC progressive');
expect(html).toContain('value="2" selected>2 · 1:32 then 1:8 preview');
```

- [ ] **Step 3: A/B verify.** Re-run the standard A/B protocol. First paint will be **blurrier** (1:32 DC is whole-image at very low res) but should now look like the Sneyers paper — fuzzy whole image → less-fuzzy whole image → AC refinement.

- [ ] **Step 4: Commit.**

```powershell
git add web/jxl-single-progressive.html web/jxl-single-progressive-page.test.js
git commit -m "feat(single-progressive): default progressive_dc to 2 (Sneyers canonical layout)"
```

### Task D2 — Add PSNR-vs-pass chart in the metrics panel

**Files:** `web/jxl-single-progressive.html` (new chart container), `web/jxl-single-progressive.js` (chart logic), `web/jxl-progressive-quality.js` (already exports `computePsnrVsFinal`).

**Why:** the perceptual-cutoff discussion (chapter 3 + phase G) needs PSNR data. Already collected; just not plotted.

- [ ] **Step 1: Add HTML container** in the metrics panel (after the existing `.metric-list`, around HTML line 225):

```html
<div class="psnr-chart-wrap">
  <div class="psnr-chart-head">
    <span>PSNR vs pass</span>
    <span id="psnr-chart-legend" class="viewer-meta">--</span>
  </div>
  <canvas id="psnr-chart" width="380" height="120"></canvas>
</div>
```

Add minimal CSS in the same file (in the existing `<style>` block):

```css
.psnr-chart-wrap { padding: 10px; border-top: 1px solid #263940; }
.psnr-chart-head { display: flex; justify-content: space-between; font-size: 12px; color: var(--sp-muted); margin-bottom: 6px; }
#psnr-chart { width: 100%; height: 120px; background: #0a0f11; border: 1px solid #2c4249; border-radius: 6px; }
```

- [ ] **Step 2: Add `drawPsnrChart`** helper in `web/jxl-single-progressive.js`:

```js
function drawPsnrChart(passes, targetRgba) {
    const chartCanvas = document.getElementById('psnr-chart');
    const legend = document.getElementById('psnr-chart-legend');
    if (!chartCanvas || !passes.length) return;
    const finalPass = passes.find(p => p.isFinal) ?? passes.at(-1);
    if (!finalPass?.pixels) {
        if (legend) legend.textContent = 'final pixels released';
        return;
    }
    const ctx = chartCanvas.getContext('2d');
    const w = chartCanvas.width;
    const h = chartCanvas.height;
    ctx.fillStyle = '#0a0f11';
    ctx.fillRect(0, 0, w, h);
    const padL = 30, padR = 8, padT = 8, padB = 18;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    // Compute PSNR per pass against the final pixels (or against targetRgba if available).
    const reference = targetRgba ?? finalPass.pixels;
    const psnrs = passes.map(p => {
        if (!p.pixels || p.pixels.byteLength !== reference.byteLength) return null;
        return computePsnrVsFinal(reference, p.pixels);
    });
    const finite = psnrs.filter(v => Number.isFinite(v));
    if (!finite.length) {
        if (legend) legend.textContent = 'no comparable passes';
        return;
    }
    const minY = Math.max(10, Math.min(...finite) - 2);
    const maxY = Math.min(80, Math.max(...finite) + 2);

    // Axes.
    ctx.strokeStyle = '#2c4249';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, padT);
    ctx.lineTo(padL, padT + plotH);
    ctx.lineTo(padL + plotW, padT + plotH);
    ctx.stroke();

    // Y-axis labels.
    ctx.fillStyle = '#9fb6b0';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`${maxY.toFixed(0)}`, padL - 4, padT + 8);
    ctx.fillText(`${minY.toFixed(0)}`, padL - 4, padT + plotH);
    ctx.textAlign = 'left';
    ctx.fillText('dB', 2, padT + 8);

    // Plot.
    ctx.strokeStyle = '#7de0b0';
    ctx.lineWidth = 2;
    ctx.beginPath();
    let drewFirst = false;
    psnrs.forEach((p, i) => {
        if (!Number.isFinite(p)) return;
        const x = padL + (i / Math.max(1, passes.length - 1)) * plotW;
        const y = padT + plotH - ((p - minY) / Math.max(0.01, maxY - minY)) * plotH;
        if (!drewFirst) { ctx.moveTo(x, y); drewFirst = true; } else { ctx.lineTo(x, y); }
    });
    ctx.stroke();

    // Final marker.
    psnrs.forEach((p, i) => {
        if (!Number.isFinite(p)) return;
        const x = padL + (i / Math.max(1, passes.length - 1)) * plotW;
        const y = padT + plotH - ((p - minY) / Math.max(0.01, maxY - minY)) * plotH;
        ctx.fillStyle = passes[i].isFinal ? '#f0c86a' : '#7de0b0';
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();
    });

    if (legend) legend.textContent = `${finite.length} of ${passes.length} passes plotted · ${finite.at(-1).toFixed(1)} dB final`;
}
```

- [ ] **Step 3: Wire to `renderMetrics` or end of `runSourceWithSettings`** (after the run completes):

```js
drawPsnrChart(decode.passes, targetRgba);
```

(Make `targetRgba` reachable at that scope — either store on the result object or recompute from `loadedSource`.)

- [ ] **Step 4: Update page test.**

```js
expect(html).toContain('id="psnr-chart"');
expect(source).toContain('drawPsnrChart');
expect(source).toContain('computePsnrVsFinal');
```

- [ ] **Step 5: Test + commit.**

```powershell
rtk bun test web/jxl-single-progressive-page.test.js
git add web/jxl-single-progressive.html web/jxl-single-progressive.js web/jxl-single-progressive-page.test.js
git commit -m "feat(single-progressive): add PSNR-vs-pass chart in metrics panel"
```

---
