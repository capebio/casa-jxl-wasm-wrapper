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

## Phase E — Bridge rebuild: `IntendedDownsamplingRatio` + `is_last`

**Goal:** expose libjxl's own progressive-frame telemetry. Gives semantically stable pass labels (DC / coarse AC / final) instead of inferring from JS-side flush count.

**Reference:** investigations doc §7.10 + §7.11.

**This phase is the only one in this plan that requires a WASM rebuild.** Bundle in any other small bridge changes you want to land at the same time.

**Pre-flight check.** Confirm Docker + emscripten available:

```powershell
docker --version
$env:LIBJXL_COMMIT
```

Per `packages/jxl-wasm/scripts/build.mjs:18-24` the build pins libjxl commit `332feb17d17311c748445f7ee75c4fb55cc38530` (v0.11.2). Build runs in Docker by default; pass `--host-toolchain` to use the local emscripten install (`C:\Users\User\emsdk`).

### Task E1 — Add bridge function

**Files:** `packages/jxl-wasm/src/bridge.cpp` (add C++ function), `packages/jxl-wasm/dist/exports.txt` if such a file exists (search before assuming).

- [ ] **Step 1: Locate the symbol export list.**

```powershell
rtk proxy grep -rn "_jxl_wasm_dec_take_flushed" packages/jxl-wasm
```

The build emits an exports list (per `docs/Completed plans/casabio-jxl-wrapper-construction-spec-v2.md:316`). Find which file or build-script section it lives in. If `scripts/build.mjs` constructs the list dynamically (via `-sEXPORTED_FUNCTIONS=...`), edit there. Otherwise edit the explicit text file. **Record the file path in the commit message.**

- [ ] **Step 2: Add the C++ function** near the other `dec_*` getters in `bridge.cpp` (around line 2230, after `jxl_wasm_dec_height`):

```cpp
// libjxl v0.11.2 only exposes downsampling ratio as a getter — there is no setter to
// request smaller output. This returns libjxl's own answer to "what is the natural
// resolution of the current progressive snapshot?" — 8 for DC, 2-4 for coarse AC,
// 1 for final. Use as a label, not a downscale factor (output buffer is always full).
uint32_t jxl_wasm_dec_intended_downsampling_ratio(const JxlWasmDecState* s) {
    if (s == nullptr || s->dec == nullptr) return 0;
    const size_t ratio = JxlDecoderGetIntendedDownsamplingRatio(s->dec);
    return static_cast<uint32_t>(ratio);
}

// Surface JxlFrameHeader.is_last so the JS facade can distinguish the truly-final
// frame from a coincidental late progress emit.
uint32_t jxl_wasm_dec_frame_is_last(const JxlWasmDecState* s) {
    return (s != nullptr) ? s->is_last_frame : 0u;
}
```

- [ ] **Step 3: Add to exports list.** Append `_jxl_wasm_dec_intended_downsampling_ratio` and `_jxl_wasm_dec_frame_is_last` to wherever the explicit exports live (from Step 1).

- [ ] **Step 4: Rebuild WASM.** Use whichever path matches your environment (see CLAUDE.md):

Docker path (preferred for reproducibility):

```powershell
rtk bun --cwd packages/jxl-wasm run build
```

Host toolchain path:

```powershell
cmd /c "call C:\Users\User\emsdk\emsdk_env.bat >nul && node packages/jxl-wasm/scripts/build.mjs --host-toolchain"
```

Expected: `packages/jxl-wasm/dist/*.wasm` files updated. Build takes 10-40 minutes depending on toolchain.

- [ ] **Step 5: Verify symbols exported.**

```powershell
rtk proxy node -e "import('./packages/jxl-wasm/dist/index.js').then(m => m.loadLibjxlModule()).then(mod => console.log(typeof mod._jxl_wasm_dec_intended_downsampling_ratio, typeof mod._jxl_wasm_dec_frame_is_last))"
```

Expect: `function function`. If either is `undefined`, the exports list edit didn't take — revisit Step 3.

- [ ] **Step 6: Commit bridge + dist together.**

```powershell
git add packages/jxl-wasm/src/bridge.cpp packages/jxl-wasm/dist
git commit -m "feat(bridge): expose IntendedDownsamplingRatio and frame_is_last for progressive telemetry"
```

### Task E2 — Wire through facade

**Files:** `packages/jxl-wasm/src/facade.ts` (event type extension + progressive loop call), `packages/jxl-wasm/dist/index.js` (rebuild).

- [ ] **Step 1: Extend the `DecodeEvent` progress/final variants** in facade.ts. Find the `Extract<DecodeEvent, { type: "progress" }>` shape (around line 1873) and add optional fields:

```ts
intendedDownsamplingRatio?: number;
isLastFrame?: boolean;
```

(Add to both `progress` and `final` event types. Search for "type: \"progress\"" and "type: \"final\"" in the file and locate the type definitions to extend.)

- [ ] **Step 2: Cache the new function references** in `eventsProgressive` near the existing `decTakeFlushed` cache (around facade.ts:1707):

```ts
const decIntendedRatio = module._jxl_wasm_dec_intended_downsampling_ratio;
const decIsLast = module._jxl_wasm_dec_frame_is_last;
```

- [ ] **Step 3: Populate the fields on emit** at the progress event construction (around facade.ts:1873):

```ts
const ratio = decIntendedRatio?.(dec) ?? 1;
const isLast = (decIsLast?.(dec) ?? 0) !== 0;
const ev: Extract<DecodeEvent, { type: "progress" }> = {
    type: "progress",
    stage,
    info: outInfo,
    pixels: outPixels.data,
    format: fmt,
    pixelStride,
    sourceScale: ratio,  // ← was `this.options.downsample ?? 1`; now reflects libjxl truth
    progressiveRegion: false,
    intendedDownsamplingRatio: ratio,
    isLastFrame: isLast,
    ...(hasRegion ? { regionFallback: "full-frame-then-crop" as const } : {}),
    ...(outPixels.region !== undefined ? { region: outPixels.region } : {}),
};
```

Repeat for the final event (around facade.ts:1956). Add `intendedDownsamplingRatio` and `isLastFrame` similarly.

- [ ] **Step 4: Build the package.**

```powershell
rtk bun --cwd packages/jxl-wasm run build:ts
```

(Or whatever the existing facade build script is. Check `packages/jxl-wasm/package.json` scripts.)

- [ ] **Step 5: Test.**

```powershell
rtk bun test packages/jxl-wasm/test/progressive-detail.test.ts
```

- [ ] **Step 6: Commit.**

```powershell
git add packages/jxl-wasm/src/facade.ts packages/jxl-wasm/dist
git commit -m "feat(facade): surface IntendedDownsamplingRatio and isLastFrame in progress events"
```

### Task E3 — Display in single-progressive page

**Files:** `web/jxl-single-progressive.js`, `web/jxl-single-progressive-page.test.js`.

- [ ] **Step 1: Capture and label in the event handler** (around line 480):

```js
const ratio = event.intendedDownsamplingRatio ?? 1;
const ratioLabel = ratio >= 8 ? '1:8 DC'
    : ratio >= 4 ? '1:4 coarse-AC'
    : ratio >= 2 ? '1:2 mid-AC'
    : 'full AC';
const isLastFlag = event.isLastFrame === true;
const pass = makePassRecord(event, passes.length, t, width, height);
pass.bytesFed = bytesFed;
pass.percentFed = Number(percentFed.toFixed(2));
pass.transferKbPerSec = transferKbPerSec;
pass.deltaMs = Number(deltaMs.toFixed(2));
pass.deltaBytes = deltaBytes;
pass.deltaKbPerSec = deltaKbPerSec;
pass.intendedRatio = ratio;
pass.ratioLabel = ratioLabel;
pass.isLastFlag = isLastFlag;
```

- [ ] **Step 2: Show in `viewerMeta` + tile label.**

In `renderProgressivePass`, change the viewerMeta line to include the ratio:

```js
viewerMeta.textContent = `pass ${pass.pass} (${pass.ratioLabel ?? '--'})${pass.isFinal ? ' final' : ''} | ${formatBytes(pass.bytesFed ?? 0)} streamed | +${pass.deltaMs ?? '--'} ms`;
```

And the tile label:

```js
label.textContent = `Pass ${pass.pass} ${pass.ratioLabel ?? ''} | ${formatBytes(pass.bytesFed ?? 0)} | +${pass.deltaMs ?? '--'} ms`;
```

- [ ] **Step 3: Surface in measurement record.** In `buildMeasurement` perPass map:

```js
intended_ratio: pass.intendedRatio ?? null,
ratio_label: pass.ratioLabel ?? null,
```

Add to CSV header / row, Markdown table, TOON.

- [ ] **Step 4: Add lightbox row.** In `passLightboxStats`, after the `['Pass', ...]` entry:

```js
['Stage', `${pass.ratioLabel ?? '--'} · ratio ${pass.intendedRatio ?? '--'}`],
```

- [ ] **Step 5: Update page test.**

```js
expect(source).toContain('intendedDownsamplingRatio');
expect(source).toContain('ratioLabel');
expect(source).toContain('intended_ratio');
```

- [ ] **Step 6: Test + commit.**

```powershell
rtk bun test web/jxl-single-progressive-page.test.js
git add web/jxl-single-progressive.js web/jxl-single-progressive-page.test.js
git commit -m "feat(single-progressive): display IntendedDownsamplingRatio per pass"
```

---

## Phase F — Worker-side frame stats offload

**Goal:** move `analyzeProgressiveFrame` (~30-50 ms per pass) off main thread entirely. Phase A2 deferred it; this phase parallelises it.

**Reference:** investigations doc §7.5.

**Depends on Phase A2** (lazy stats — without it the worker pattern races with paint).

**Trade:** transferring the pixel buffer to the worker detaches it from main thread. Only do this for passes whose pixels we've finished painting AND don't need synchronously for compare/diff. Phase A2's lazy-stats pattern fits this exactly — stats only get computed when the lightbox opens or measurements export, by which point paint is done.

### Task F1 — Create the stats worker

**Files:** `web/jxl-frame-stats-worker.js` (new).

- [ ] **Step 1: Write the worker entry.**

```js
// web/jxl-frame-stats-worker.js
// Dedicated worker for off-main-thread analyzeProgressiveFrame.
// Receives transferred ArrayBuffers; computes stats; returns the buffer + stats.

import { analyzeProgressiveFrame } from './jxl-progressive-frame-stats.js';

self.onmessage = (e) => {
    const { id, pixels, width, height } = e.data;
    try {
        const view = new Uint8Array(pixels);
        const stats = analyzeProgressiveFrame(view, width, height);
        // Transfer the buffer back so the caller can keep using it.
        self.postMessage({ id, ok: true, stats, pixels }, [pixels]);
    } catch (err) {
        self.postMessage({ id, ok: false, error: String(err?.message ?? err), pixels }, [pixels]);
    }
};
```

- [ ] **Step 2: Add a caller wrapper** in `web/jxl-single-progressive.js`:

```js
let _statsWorker = null;
let _statsId = 0;
const _statsPending = new Map();

function getStatsWorker() {
    if (_statsWorker === null) {
        _statsWorker = new Worker(new URL('./jxl-frame-stats-worker.js', import.meta.url), { type: 'module' });
        _statsWorker.onmessage = (e) => {
            const { id, ok, stats, pixels, error } = e.data;
            const pending = _statsPending.get(id);
            if (pending === undefined) return;
            _statsPending.delete(id);
            const returnedPixels = pixels ? new Uint8Array(pixels) : null;
            if (ok) pending.resolve({ stats, pixels: returnedPixels });
            else pending.reject(new Error(error ?? 'stats worker error'));
        };
        _statsWorker.onerror = (e) => {
            console.error('[stats-worker] error', e);
        };
    }
    return _statsWorker;
}

async function analyzeFrameInWorker(pixels, width, height) {
    const id = ++_statsId;
    const w = getStatsWorker();
    // Detach the buffer; worker will transfer it back.
    const buffer = pixels.buffer.slice(pixels.byteOffset, pixels.byteOffset + pixels.byteLength);
    return new Promise((resolve, reject) => {
        _statsPending.set(id, { resolve, reject });
        w.postMessage({ id, pixels: buffer, width, height }, [buffer]);
    });
}
```

- [ ] **Step 3: Replace the sync `analyzeProgressiveFrame` call in `computeAndCachePassStats`** with an async-aware variant. This is the tricky bit — `passLightboxStats` is synchronous. Two options:

  **Option A (preferred):** compute stats async when the run ends (just before `thinRetainedPassPixels`), populate `pass.stats` for every retained pass. By the time the lightbox opens, all stats are already there.

  ```js
  async function precomputePassStatsInWorker(passes) {
      for (const pass of passes) {
          if (pass.stats || !pass.pixels) continue;
          try {
              const { stats, pixels } = await analyzeFrameInWorker(pass.pixels, pass.width, pass.height);
              pass.stats = stats;
              pass.pixels = pixels;  // re-attach the transferred-back buffer
          } catch (err) {
              console.warn('[stats] worker failed; falling back to main thread', err);
              pass.stats = analyzeProgressiveFrame(pass.pixels, pass.width, pass.height);
          }
      }
  }
  ```

  Call before `thinRetainedPassPixels(passes); return { passes, ... };` in `decodeProgressively` and `decodeProgressivelyViaWorker`.

  **Option B (fallback):** make `passLightboxStats` async and adjust the lightbox open flow. More invasive.

  **Recommendation:** use Option A.

- [ ] **Step 4: Keep `computeAndCachePassStats` as the sync fallback** for export paths (CSV/JSON/MD) that don't tolerate async. If a pass somehow reaches export without stats, fall back to the existing main-thread compute.

- [ ] **Step 5: Update page test.**

```js
expect(source).toContain('analyzeFrameInWorker');
expect(source).toContain('precomputePassStatsInWorker');
expect(source).toContain('jxl-frame-stats-worker.js');
```

- [ ] **Step 6: Test + measure.**

```powershell
rtk bun test web/jxl-single-progressive-page.test.js
```

A/B: measure total decode time with worker stats vs without. Expected: ~100-500 ms total saving on the run because the main thread no longer spends time on stats. The lightbox open latency stays the same (stats are pre-computed).

- [ ] **Step 7: Commit.**

```powershell
git add web/jxl-single-progressive.js web/jxl-frame-stats-worker.js web/jxl-single-progressive-page.test.js
git commit -m "perf(single-progressive): offload frame stats to dedicated worker"
```

---

## Phase G — Perceptual cutoff stopping rule

**Goal:** stop the progressive decode when subsequent passes add no perceptual value. Saves CPU + paint cost on the late-pass refinements the user described as "almost identical".

**Reference:** investigations doc Chapter 3.

**Depends on Phase E** (`intendedDownsamplingRatio` gives a stable signal for "we're at the final-AC level"). Without E, the heuristic must use frame-hash equality, which is noisier.

**Design:** content-adaptive rule with three triggers, OR-combined:

1. **Hash equality:** two consecutive passes have identical `frameHash`. Strong signal of no perceptual delta.
2. **Low byte rate:** `deltaKbPerSec < 1 KB/s` for two consecutive passes. Encoder appending mostly entropy.
3. **PSNR plateau:** PSNR delta < 0.5 dB for two consecutive passes (only after at least one ratio-1 pass has landed).

Rule is opt-in via UI; default OFF for diagnostic accuracy.

### Task G1 — Add UI toggle + helper

**Files:** `web/jxl-single-progressive.html`, `web/jxl-single-progressive.js`, `web/jxl-single-progressive-page.test.js`.

- [ ] **Step 1: Add HTML control** in the controls section (near the block-borders toggle, around HTML line 167):

```html
<label class="inline-toggle" title="Stop decode when consecutive passes add no perceptual delta">
  <input id="perceptual-cutoff" type="checkbox" />
  Perceptual cutoff
</label>
```

- [ ] **Step 2: Add `shouldStopAtPass`** helper in `web/jxl-single-progressive.js`:

```js
const PERCEPTUAL_CUTOFF_PSNR_DELTA_DB = 0.5;
const PERCEPTUAL_CUTOFF_LOW_KBPS = 1.0;

function shouldStopAtPass(passes, targetRgba) {
    if (passes.length < 3) return false;
    const last = passes.at(-1);
    const prev = passes.at(-2);
    if (!last || !prev) return false;

    // Trigger 1: hash equality.
    if (last.stats && prev.stats && last.stats.frameHash === prev.stats.frameHash && last.stats.frameHash !== '--') {
        return { reason: 'hash-equal', last: last.pass };
    }

    // Trigger 2: low byte rate two passes running.
    if (Number.isFinite(last.deltaKbPerSec) && Number.isFinite(prev.deltaKbPerSec)
        && last.deltaKbPerSec < PERCEPTUAL_CUTOFF_LOW_KBPS
        && prev.deltaKbPerSec < PERCEPTUAL_CUTOFF_LOW_KBPS) {
        return { reason: 'low-byterate', last: last.pass };
    }

    // Trigger 3: PSNR plateau, but only once we've reached full-resolution AC.
    if ((last.intendedRatio ?? 8) <= 1 && (prev.intendedRatio ?? 8) <= 1 && targetRgba) {
        if (last.pixels?.byteLength === targetRgba.byteLength && prev.pixels?.byteLength === targetRgba.byteLength) {
            const psnrLast = computePsnrVsFinal(targetRgba, last.pixels);
            const psnrPrev = computePsnrVsFinal(targetRgba, prev.pixels);
            if (Number.isFinite(psnrLast) && Number.isFinite(psnrPrev)
                && Math.abs(psnrLast - psnrPrev) < PERCEPTUAL_CUTOFF_PSNR_DELTA_DB) {
                return { reason: 'psnr-plateau', last: last.pass, deltaDb: Math.abs(psnrLast - psnrPrev) };
            }
        }
    }

    return false;
}
```

- [ ] **Step 3: Wire into the decode event loop.** In `decodeProgressively` (and `decodeProgressivelyViaWorker`), after a non-final pass is recorded, check the cutoff:

```js
const cutoffEnabled = document.getElementById('perceptual-cutoff')?.checked === true;
if (cutoffEnabled && !pass.isFinal) {
    const verdict = shouldStopAtPass(passes, /* targetRgba */ null);
    if (verdict) {
        setStatus(`Perceptual cutoff: ${verdict.reason} after pass ${pass.pass}. Cancelling.`);
        dbgLog('Perceptual cutoff', JSON.stringify(verdict), 'info');
        await decoder.cancel?.();  // main-thread path
        break;  // exit the for-await loop
    }
}
```

For the worker path, replace `await decoder.cancel?.()` with `await session.close()`.

- [ ] **Step 4: Wire `targetRgba` into the cutoff check.** Plumb the `targetRgba` from `runSourceWithSettings` into `decodeProgressively`. This requires passing it as an additional argument — small refactor:

```js
const decode = await decodeProgressively({
    jxlBytes: encodeBytes,
    width: target.width,
    height: target.height,
    throttleKbPerSec: settings.throttleKbPerSec,
    targetRgba,  // ← new
});
```

And accept it in the function signature. Pass through to `shouldStopAtPass`.

- [ ] **Step 5: Add UX feedback.** When cutoff fires, the status panel should clearly distinguish "done early" from "actually finished":

```js
const cutoffFired = !passes.some(p => p.isFinal);
const finalLine = cutoffFired
    ? `Stopped early at pass ${passes.length} (perceptual cutoff)`
    : `Done. ${metrics.passCount} passes, final ${metrics.final_ms ?? '--'} ms`;
setStatus(finalLine);
```

- [ ] **Step 6: Update page test.**

```js
expect(html).toContain('id="perceptual-cutoff"');
expect(source).toContain('shouldStopAtPass');
expect(source).toContain('PERCEPTUAL_CUTOFF_PSNR_DELTA_DB');
```

- [ ] **Step 7: A/B verify.** Run with cutoff OFF, record passes + final_ms. Run with cutoff ON, record passes + final_ms + cutoff reason. Confirm visual quality at cutoff is acceptable — the PSNR chart from D2 should show the cutoff point on the curve plateau.

- [ ] **Step 8: Commit.**

```powershell
git add web/jxl-single-progressive.html web/jxl-single-progressive.js web/jxl-single-progressive-page.test.js
git commit -m "feat(single-progressive): perceptual cutoff stopping rule (opt-in)"
```

---

## Phase H — Round-robin gallery orchestrator

**Goal:** make the gallery feed all open files at the same byte-fraction per tick, so all files reach pass-1 around the same wall time. Current behaviour races each file to completion in parallel, then defers display via coordinator.

**Reference:** investigations doc Chapter 1.

**Files:** `web/jxl-progressive-gallery.js`, possibly `web/jxl-progressive-gallery-coordinator.js`.

**Risk:** the scheduler's preemption logic is built for visible-vs-background priority; the orchestrator must drive all sessions in the same priority lane to avoid scheduler thrash. Use `priority: 'visible'` for all round-robin sessions.

**Design:** introduce `BYTES_PER_TICK = 16384`. Per tick, for each open session, push up to `BYTES_PER_TICK` bytes of its source. After each tick yield via `sleep(0)`. Continue until every source is closed.

### Task H1 — Add round-robin feed mode

**Files:** `web/jxl-progressive-gallery.js`, `web/jxl-progressive-gallery.test.js`, `web/jxl-progressive-gallery.html`.

- [ ] **Step 1: Add HTML toggle** in the gallery controls section (find the section with `concurrent`, `wasm-tier`, etc.):

```html
<label class="inline-toggle" title="Feed all files at equal byte-fraction per tick instead of racing each to completion">
  <input id="round-robin-feed" type="checkbox" />
  Round-robin feed
</label>
```

- [ ] **Step 2: Add an orchestrator helper** in `web/jxl-progressive-gallery.js`:

```js
const ROUND_ROBIN_BYTES_PER_TICK = 16 * 1024;

async function feedRoundRobin(sessions /* array of { session, bytes } */) {
    const cursors = sessions.map(() => 0);
    let openCount = sessions.length;
    while (openCount > 0) {
        for (let i = 0; i < sessions.length; i++) {
            const { session, bytes } = sessions[i];
            if (cursors[i] >= bytes.byteLength) continue;
            const start = cursors[i];
            const end = Math.min(bytes.byteLength, start + ROUND_ROBIN_BYTES_PER_TICK);
            const chunk = bytes.subarray(start, end);
            await session.push(chunk);
            cursors[i] = end;
            if (cursors[i] >= bytes.byteLength) {
                await session.close();
                openCount--;
            }
        }
        await sleep(0);
    }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
```

- [ ] **Step 3: Locate the current per-file feed loop** in `startGallery` (around line 358+). It currently iterates `selectedFiles` and runs each through its own decode pipeline. Modify so that when the round-robin toggle is ON, it creates ALL sessions first, then drives them through `feedRoundRobin` once.

Sketch (the exact integration depends on how `startGallery` is currently structured — read lines 358-700 carefully and adapt):

```js
const roundRobin = document.getElementById('round-robin-feed')?.checked === true;
if (roundRobin) {
    const allSessions = await Promise.all(selectedFiles.map(async f => {
        const bytes = await loadJxlBytesForFile(f, encodeOnTheFly, encodeOpts);
        const session = ctx.decode({ ...decodeOpts, priority: 'visible' });
        wireSessionToGallery(session, f, framesByFile, coordinator);
        return { session, bytes };
    }));
    await feedRoundRobin(allSessions);
    await Promise.all(allSessions.map(s => s.session.done()));
} else {
    // Existing per-file racing behaviour.
    // ...current code unchanged...
}
```

- [ ] **Step 4: Memory guard.** Round-robin opens N decoders at once, each with `info.xsize * info.ysize * 4` output buffer. Cap `selectedFiles.length` at `min(maxWorkers, 4)` to avoid the 1.5 GB-at-8000px scenario noted in investigations §7.7:

```js
if (roundRobin && selectedFiles.length > 4) {
    log('Round-robin capped at 4 concurrent decoders for memory safety. Splitting into batches.', 'warn');
    // Split into batches of 4 and run sequentially.
}
```

- [ ] **Step 5: Update gallery test.** Add source-string assertions:

```js
expect(html).toContain('id="round-robin-feed"');
expect(source).toContain('feedRoundRobin');
expect(source).toContain('ROUND_ROBIN_BYTES_PER_TICK');
```

- [ ] **Step 6: Manual verification.** Open the gallery with 3 files of different sizes (small, medium, large). With round-robin OFF, observe: small file finishes all passes before large file shows pass 3. With round-robin ON: all three files reach pass 1 within ~100 ms of each other, then pass 2 together, etc.

- [ ] **Step 7: Commit.**

```powershell
git add web/jxl-progressive-gallery.html web/jxl-progressive-gallery.js web/jxl-progressive-gallery.test.js
git commit -m "feat(gallery): round-robin byte-fraction feeder for synchronized progressive paint"
```

---

## Phase I — Sidecar thumbnail encode pipeline

**Goal:** generate a small thumbnail JXL alongside the full JXL so future galleries can decode thumbs in ~10-15 ms instead of ~250 ms+. Works around libjxl 0.11.2's missing partial-decode API.

**Reference:** investigations doc Chapter 2 + §7.3.

**Files:** `web/jxl-single-progressive.js` (for measurement), `packages/jxl-cache/src/browser.ts` (to store both keys — already content-agnostic, may just need a key convention).

**Design:** when the encode pipeline produces a full-size JXL, also produce a 320-px-long-edge JXL at lower quality and store both. Cache key convention: `${sourceHash}` for full, `${sourceHash}:thumb` for sidecar.

### Task I1 — Add sidecar encode helper

**Files:** `web/jxl-single-progressive.js` (for the prototype), then promote to a shared module if it lands elsewhere.

- [ ] **Step 1: Add `encodeWithSidecarThumbnail` helper** near `encodeSneyersDirect`:

```js
const SIDECAR_THUMB_LONG_EDGE = 320;
const SIDECAR_THUMB_QUALITY = 75;

async function encodeWithSidecarThumbnail({ rgba, width, height, quality, lossless, progressiveDc, progressiveAc, qProgressiveAc, decodingSpeed, groupOrder }) {
    const full = await encodeSneyersDirect({
        rgba, width, height, quality, lossless,
        progressiveDc, progressiveAc, qProgressiveAc, decodingSpeed, groupOrder,
    });

    const longEdge = Math.max(width, height);
    if (longEdge <= SIDECAR_THUMB_LONG_EDGE) {
        return { full, thumb: null };  // source is already thumbnail-sized
    }
    const scale = SIDECAR_THUMB_LONG_EDGE / longEdge;
    const tw = Math.max(1, Math.round(width * scale));
    const th = Math.max(1, Math.round(height * scale));
    const thumbRgba = resizeRgba(rgba, width, height, tw, th);
    const thumb = await encodeSneyersDirect({
        rgba: thumbRgba,
        width: tw,
        height: th,
        quality: SIDECAR_THUMB_QUALITY,
        lossless: false,
        progressiveDc: 0,
        progressiveAc: 0,
        qProgressiveAc: 0,
        decodingSpeed: 2,
        groupOrder: 0,
    });
    return { full, thumb };
}
```

- [ ] **Step 2: Add a UI toggle** (`web/jxl-single-progressive.html`):

```html
<label class="inline-toggle" title="Also encode a 320px sidecar thumbnail for fast preview decode">
  <input id="emit-sidecar-thumb" type="checkbox" />
  Sidecar thumb
</label>
```

- [ ] **Step 3: Dispatch from `runSourceWithSettings`.** When the toggle is ON, call `encodeWithSidecarThumbnail` and surface both byte sizes in the metrics panel:

```js
const useSidecar = document.getElementById('emit-sidecar-thumb')?.checked === true;
let encodeBytes;
let thumbBytes = null;
if (useSidecar) {
    const result = await encodeWithSidecarThumbnail({ /* ...same args as encodeSneyersDirect... */ });
    encodeBytes = result.full;
    thumbBytes = result.thumb;
} else {
    encodeBytes = await encodeSneyersDirect({ /* ... */ });
}
```

- [ ] **Step 4: Add a "decode thumbnail" measurement.** When `thumbBytes != null`, decode it one-shot and record the time:

```js
let thumbDecodeMs = null;
if (thumbBytes) {
    const thumbStart = performance.now();
    await decodeOneShotFinal(thumbBytes);
    thumbDecodeMs = Number((performance.now() - thumbStart).toFixed(2));
}
```

Add a metric tile:

```html
<div class="metric"><span>Sidecar thumb decode</span><strong id="m-thumb-decode">--</strong></div>
<div class="metric"><span>Sidecar thumb size</span><strong id="m-thumb-size">--</strong></div>
```

And populate in `renderMetrics`:

```js
setMetric('m-thumb-decode', m.thumbDecodeMs == null ? '--' : `${m.thumbDecodeMs} ms`);
setMetric('m-thumb-size', m.thumbBytes == null ? '--' : formatBytes(m.thumbBytes));
```

- [ ] **Step 5: Update page test.**

```js
expect(html).toContain('id="emit-sidecar-thumb"');
expect(source).toContain('encodeWithSidecarThumbnail');
expect(source).toContain('SIDECAR_THUMB_LONG_EDGE');
```

- [ ] **Step 6: Verify the win.** Run a 5240×3912 source with sidecar ON. Expect: thumb size ~3-5 KB, thumb decode time ~10-15 ms. Compare with the full file's one-shot decode time (~250-300 ms).

- [ ] **Step 7: Commit.**

```powershell
git add web/jxl-single-progressive.html web/jxl-single-progressive.js web/jxl-single-progressive-page.test.js
git commit -m "feat(single-progressive): emit sidecar 320px thumbnail JXL for fast preview"
```

### Task I2 — Plumb sidecar into the cache (optional follow-up)

**Files:** `packages/jxl-cache/src/browser.ts`.

The cache is content-agnostic and already stores `ArrayBuffer` keyed by string. To store sidecars alongside their source:

```js
await cache.set(sourceHash, fullBytes);
if (thumbBytes) await cache.set(`${sourceHash}:thumb`, thumbBytes);

// Lookup:
const thumb = await cache.get(`${sourceHash}:thumb`);
const full = thumb ?? await cache.get(sourceHash);
```

No code change required in the cache layer itself — only the key convention. Add a comment to `packages/jxl-cache/README.md` documenting the `:thumb` convention so other call sites pick it up consistently.

- [ ] **Step 1: Document key convention** in `packages/jxl-cache/README.md`:

```markdown
## Key conventions

Callers SHOULD use these prefixes/suffixes to avoid collisions:

- `${sourceHash}` — the full-resolution encoded JXL.
- `${sourceHash}:thumb` — a 320 px long-edge sidecar thumbnail JXL, if available.
- `${sourceHash}:dc-prefix-${kb}kb` — a byte-truncated DC-only prefix (Chapter 2 of investigations).

The cache itself is content-agnostic and does not enforce these — it is purely a convention for cross-page reuse.
```

- [ ] **Step 2: Commit.**

```powershell
git add packages/jxl-cache/README.md
git commit -m "docs(cache): document key prefix convention for sidecar thumbnails"
```

---

## Final commit / post-rollout

### Verification checklist

After all phases land:

- [ ] Single-progressive page: first paint ≈ 50-80 ms, final paint ≈ 400-600 ms, one-shot ≈ 250 ms, progressive/one-shot ratio ≈ 2× on display preset.
- [ ] Single-progressive page: with `dc=2 ac=2 qac=2`, observe ~18-22 passes with smooth PSNR-vs-pass curve.
- [ ] Single-progressive page: perceptual-cutoff toggle stops decode 1-3 passes before final; visual quality acceptable.
- [ ] Single-progressive page: pass labels show `1:8 DC`, `1:4 coarse-AC`, etc., reflecting libjxl's intended downsampling.
- [ ] Single-progressive page: worker-decode toggle produces same pass count + similar timing as main-thread; main thread `paintMs` lower per pass.
- [ ] Single-progressive page: sidecar thumb decodes in 10-15 ms.
- [ ] Gallery: round-robin toggle synchronises pass-N arrival across files.
- [ ] All tests pass: `rtk bun test web/jxl-single-progressive-page.test.js web/jxl-progressive-gallery.test.js packages/jxl-wasm/test/progressive-detail.test.ts`.
- [ ] No two-frame regression on any default A/B run.

### Update sibling docs

- [ ] In `docs/HANDOFF-single-progressive-progressive-tuning-2026-06-05.md`, append a "Status as of 2026-06-XX" section noting which phases landed.
- [ ] In `docs/superpowers/plans/2026-06-05-single-progressive-perf-investigation.md`, mark as "superseded by `docs/superpowers/plans/unified implementation plan.md`" — leave intact for context but link forward.
- [ ] In `docs/Research/2026-06-05-progressive-jxl-five-investigations.md`, the verdict matrix at the top of Chapter 7 can be updated with land dates per item.

### Self-review against original spec

This plan covers:

- **Sibling plan Tasks 1-8** → Phase A (verbatim).
- **Chapter 1** (round-robin gallery) → Phase H.
- **Chapter 2** (thumbnail-sized decode) → Phase I (sidecar workaround).
- **Chapter 3** (stop after 2 passes) → Phase G (perceptual cutoff).
- **Chapter 4** (more, smaller passes) → Phase C (encoder AC knobs).
- **Chapter 5** (whole-image vs block-by-block) → Phase D (default `dc=2`).
- **§7.1 worker decode** → Phase B.
- **§7.2 SetDownsamplingFactor** → SKIPPED (confirmed blocked at libjxl API).
- **§7.3 preview frames** → SKIPPED in favour of Phase I sidecar.
- **§7.4 AC knobs** → Phase C.
- **§7.5 worker stats** → Phase F.
- **§7.6 cross-page cache** → SKIPPED (low value).
- **§7.7 smaller output buffer** → SKIPPED (libjxl-blocked).
- **§7.8 smart pacing** → DEFERRED (per investigation recommendation).
- **§7.9 decoding_speed** → Phase C.
- **§7.10 IntendedDownsamplingRatio** → Phase E.
- **§7.11 SkipCurrentFrame** → DEFERRED to animation milestone.

Everything in the SHOULD-DO column of the deep dive has a phase. Everything BLOCKED or DEFERRED is documented as such.

---

## Execution Handoff

Plan complete at `docs/superpowers/plans/unified implementation plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per phase, review between phases, fast iteration. Best because Phase A's 8 tasks are independently measurable and Phases B-I are largely independent.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch with checkpoints.

**Suggested agent allocation:**

- Agent 1: Phase A (sequential, 8 tasks).
- Agent 2: Phase B (after A1-A2 done).
- Agent 3: Phase C (after A done).
- Agent 4: Phase D (after A done).
- Agent 5: Phase E (independent; WASM rebuild required).
- Agent 6: Phase F (after A2 + E done).
- Agent 7: Phase G (after E done).
- Agent 8: Phase H (independent).
- Agent 9: Phase I (independent).

Phases B-D + H + I can run in parallel once A lands. Phase E gates F and G. Phase F gates nothing downstream but should not start before A2's lazy-stats pattern is in place.

If the budget runs out mid-plan, the most valuable phases to land in order are: **A → C → D → E → G**. Together these deliver the user's five-investigation goals; B, F, H, I are quality-of-life follow-ups.
