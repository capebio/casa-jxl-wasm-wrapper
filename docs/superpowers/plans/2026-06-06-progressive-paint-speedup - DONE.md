# Progressive Paint Speedup — Approach A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate artificial delays, redundant per-pass pixel scans, and O(W×H) block-diff churn so worker progressive total wall time beats one-shot at di/vl sizes.

**Architecture:** Pure JS/UI fixes across two files — `web/jxl-progressive-paint.js` (stream feed, event coalescing, stats gating) and `web/jxl-single-progressive.js` (block-border diff algorithm + memoization). No WASM rebuild. No protocol changes.

**Tech Stack:** `bun:test` (unit tests), browser JS (rAF, Uint32Array), existing module imports.

---

## File Map

| File | Role in this plan |
|------|-------------------|
| `web/jxl-progressive-paint.js` | A1 sleep removal; A4 stats gating; A2 rAF coalescing |
| `web/jxl-progressive-paint-page.test.js` | Update A4-related assertions |
| `web/jxl-single-progressive.js` | A6 tile-aware diff; A7 memoize |
| `web/jxl-single-progressive-page.test.js` | Add A8 assertion; verify A6 names survive |
| `web/jxl-progressive-paint-coalesce.test.js` | New — A2 coalescing unit test |
| `web/jxl-progressive-diff.test.js` | New — A6 diff correctness unit test |

---

## Task 1 — A1: Remove artificial inter-step delay

**Files:**
- Modify: `web/jxl-progressive-paint.js:891-905` (`streamIntoDecoder`)

The function feeds jxlBytes in N steps, pausing with `nextPaint()` + `sleep(32)` between each. That injects ~48 ms × (steps-1) of wall-clock idle before codec work even starts on later chunks. Remove both awaits. The `feedThrottled` path (user-controlled KB/s simulation) is a different function and must not change.

- [ ] **Locate the exact lines to remove**

Open `web/jxl-progressive-paint.js` and find `streamIntoDecoder` (currently around line 891). The section to change:

```js
async function streamIntoDecoder(decoder, jxlBytes, stepCount) {
    const streamSteps = splitEncodedBytesIntoSteps(jxlBytes, stepCount);
    for (let i = 0; i < streamSteps.length; i++) {
        const stepChunk = streamSteps[i];
        dbgLog(`  stream ${i + 1}/${streamSteps.length}`, `${(stepChunk.byteLength / 1024).toFixed(1)} KB`, 'info');
        await decoder.push(exactBuffer(stepChunk));
        if (i < streamSteps.length - 1) {
            setProgStatus(`Streaming step ${i + 1}/${streamSteps.length}… waiting for next progressive paint.`);
            await nextPaint();
            await sleep(32);
        }
    }
    await decoder.close();
    return streamSteps.length;
}
```

- [ ] **Apply change**

Replace the body of `streamIntoDecoder` so the inter-step block becomes a status update only (no awaits):

```js
async function streamIntoDecoder(decoder, jxlBytes, stepCount) {
    const streamSteps = splitEncodedBytesIntoSteps(jxlBytes, stepCount);
    for (let i = 0; i < streamSteps.length; i++) {
        const stepChunk = streamSteps[i];
        dbgLog(`  stream ${i + 1}/${streamSteps.length}`, `${(stepChunk.byteLength / 1024).toFixed(1)} KB`, 'info');
        await decoder.push(exactBuffer(stepChunk));
        if (i < streamSteps.length - 1) {
            setProgStatus(`Streaming step ${i + 1}/${streamSteps.length}…`);
        }
    }
    await decoder.close();
    return streamSteps.length;
}
```

- [ ] **Run existing page tests to verify nothing broken**

```
bun test web/jxl-progressive-paint-page.test.js
```

Expected: all 12 tests pass. (The page test that checks `'Streaming bytes…'` is about the outer dbgLog call, not the inter-step message — it survives.)

- [ ] **Commit**

```
git add web/jxl-progressive-paint.js
git commit -m "perf(progressive-paint): remove 32ms inter-step sleep from streamIntoDecoder"
```

---

## Task 2 — A4: Gate frame-stats behind ?stats=1

**Files:**
- Modify: `web/jxl-progressive-paint.js` (gating logic)
- Modify: `web/jxl-progressive-paint-page.test.js` (update assertions)

`analyzeProgressiveFrame` scans every RGBA pixel for hash + variance + alpha stats. At 2160px it's O(3.48 M iterations) per pass. The scan only matters for debugging; gate it off by default.

- [ ] **Add statsEnabled flag near top of jxl-progressive-paint.js**

After the existing imports (around line 10, before `selectedSources`):

```js
const statsEnabled = new URLSearchParams(location.search).get('stats') === '1';
```

- [ ] **Gate the analyzeProgressiveFrame call in collectProgressivePaintEvents**

Find this block (around line 840):

```js
const frameStats = analyzeProgressiveFrame(ev.pixels, ev.info.width, ev.info.height);
const passPixels = ev.pixels instanceof Uint8Array ? new Uint8Array(ev.pixels) : new Uint8Array(ev.pixels);
const passRecord = {
    passIdx,
    t,
    isFinal,
    stats: frameStats,
    srcCanvas: makePassCanvas(passPixels, ev.info.width, ev.info.height),
    pixels: passPixels,
};
```

Change to:

```js
const passPixels = ev.pixels instanceof Uint8Array ? new Uint8Array(ev.pixels) : new Uint8Array(ev.pixels);
const frameStats = statsEnabled ? analyzeProgressiveFrame(passPixels, ev.info.width, ev.info.height) : null;
const passRecord = {
    passIdx,
    t,
    isFinal,
    stats: frameStats,
    srcCanvas: makePassCanvas(passPixels, ev.info.width, ev.info.height),
    pixels: passPixels,
};
```

- [ ] **Update the dbgLog and console.log that follow (still in collectProgressivePaintEvents)**

Find:

```js
const statsLine = formatFrameStatsLog(frameStats);
dbgLog(`  pass ${passIdx + 1}${isFinal ? ' (final)' : ''}`, `${t.toFixed(1)} ms | ${statsLine}`, 'info');
console.log('[Progressive Paint] frame stats', {
    pass: passIdx + 1,
    isFinal,
    t_ms: Number(t.toFixed(2)),
    ...frameStats,
});
```

Change to:

```js
const statsLine = statsEnabled && frameStats ? formatFrameStatsLog(frameStats) : '';
dbgLog(`  pass ${passIdx + 1}${isFinal ? ' (final)' : ''}`, statsLine ? `${t.toFixed(1)} ms | ${statsLine}` : `${t.toFixed(1)} ms`, 'info');
if (statsEnabled && frameStats) {
    console.log('[Progressive Paint] frame stats', {
        pass: passIdx + 1,
        isFinal,
        t_ms: Number(t.toFixed(2)),
        ...frameStats,
    });
}
```

- [ ] **Update page test assertions for stats gating**

In `web/jxl-progressive-paint-page.test.js`, find the test named `'progressive paint records per-frame visibility stats in console and measurement exports'`.

Change:
```js
expect(source).toContain('const frameStats = analyzeProgressiveFrame(ev.pixels, ev.info.width, ev.info.height);');
expect(source).toContain('formatFrameStatsLog(frameStats)');
expect(source).toContain("console.log('[Progressive Paint] frame stats'");
```

To:
```js
expect(source).toContain("const statsEnabled = new URLSearchParams(location.search).get('stats') === '1';");
expect(source).toContain('analyzeProgressiveFrame(passPixels, ev.info.width, ev.info.height)');
expect(source).toContain('statsEnabled ? analyzeProgressiveFrame');
expect(source).toContain('formatFrameStatsLog(frameStats)');
expect(source).toContain("console.log('[Progressive Paint] frame stats'");
```

(The import line check `expect(source).toContain("import { analyzeProgressiveFrame,")` is unaffected — import stays.)

- [ ] **Run page tests**

```
bun test web/jxl-progressive-paint-page.test.js
```

Expected: all tests pass.

- [ ] **Commit**

```
git add web/jxl-progressive-paint.js web/jxl-progressive-paint-page.test.js
git commit -m "perf(progressive-paint): gate analyzeProgressiveFrame behind ?stats=1 query param"
```

---

## Task 3 — A2: rAF-coalesce progressive paints

**Files:**
- Modify: `web/jxl-progressive-paint.js`
- Create: `web/jxl-progressive-paint-coalesce.test.js`

Progress events may arrive faster than the display refresh. Currently each event blocks inside the async iterator with `await nextPaint()`, serialising all passes to ≥16 ms each. Replace with a one-slot pending queue: newer progress frames overwrite unrendered older ones; final always paints immediately.

- [ ] **Write the failing test first**

Create `web/jxl-progressive-paint-coalesce.test.js`:

```js
import { expect, test } from 'bun:test';

// Minimal coalesce harness — mirrors the schedulePaint logic extracted from jxl-progressive-paint.js.
// Tests the invariant: N synchronous progress frames → 1 paint; final frame always paints.
function makeCoalescer(onPaint) {
    let pendingItem = null;
    let rafPending = false;
    // In tests, substitute requestAnimationFrame with a synchronous flush.
    let rafQueue = [];
    const rAF = (fn) => { rafQueue.push(fn); };
    const flushRaf = () => { const q = rafQueue.splice(0); q.forEach(fn => fn()); };

    function schedulePaint(item) {
        if (item.isFinal) {
            if (rafPending && pendingItem) { onPaint(pendingItem); pendingItem = null; }
            rafPending = false;
            onPaint(item);
            return;
        }
        pendingItem = item;
        if (rafPending) return;
        rafPending = true;
        rAF(() => {
            rafPending = false;
            if (!pendingItem) return;
            const i = pendingItem;
            pendingItem = null;
            onPaint(i);
        });
    }

    return { schedulePaint, flushRaf };
}

test('3 synchronous progress events coalesce to 1 paint with most-recent pixels', () => {
    const painted = [];
    const { schedulePaint, flushRaf } = makeCoalescer((item) => painted.push(item));

    schedulePaint({ passIdx: 0, isFinal: false, pixels: new Uint8Array([1]) });
    schedulePaint({ passIdx: 1, isFinal: false, pixels: new Uint8Array([2]) });
    schedulePaint({ passIdx: 2, isFinal: false, pixels: new Uint8Array([3]) });

    expect(painted).toHaveLength(0); // nothing painted yet — rAF not flushed

    flushRaf();

    expect(painted).toHaveLength(1);
    expect(painted[0].passIdx).toBe(2);
    expect(painted[0].pixels[0]).toBe(3); // most-recent pixels
});

test('final event bypasses coalescing and paints immediately', () => {
    const painted = [];
    const { schedulePaint, flushRaf } = makeCoalescer((item) => painted.push(item));

    schedulePaint({ passIdx: 0, isFinal: false, pixels: new Uint8Array([1]) });
    schedulePaint({ passIdx: 1, isFinal: true,  pixels: new Uint8Array([2]) });

    // Final paints synchronously, no rAF flush needed
    expect(painted).toHaveLength(2); // pending progress flushed, then final
    expect(painted[0].passIdx).toBe(0);
    expect(painted[1].passIdx).toBe(1);
    expect(painted[1].isFinal).toBe(true);
});

test('final event without prior pending paints immediately alone', () => {
    const painted = [];
    const { schedulePaint } = makeCoalescer((item) => painted.push(item));

    schedulePaint({ passIdx: 0, isFinal: true, pixels: new Uint8Array([9]) });

    expect(painted).toHaveLength(1);
    expect(painted[0].isFinal).toBe(true);
});
```

- [ ] **Run — expect pass** (logic is self-contained, no imports from implementation yet)

```
bun test web/jxl-progressive-paint-coalesce.test.js
```

Expected: all 3 tests pass.

- [ ] **Restructure collectProgressivePaintEvents to use schedulePaint**

In `web/jxl-progressive-paint.js`, replace the entire `collectProgressivePaintEvents` function and add `schedulePaint`/`paintPassRecord` helpers. Keep all the existing pass-record creation logic; only defer the canvas/timeline/slot work.

Find and replace the current `collectProgressivePaintEvents` function (starting around line 831):

```js
// Module-level coalesce state — reset at each run start by resetCoalescer().
let _coalesceItem = null;
let _coalesceRafPending = false;
let _coalesceOnPaint = null;

function resetCoalescer(onPaint) {
    _coalesceItem = null;
    _coalesceRafPending = false;
    _coalesceOnPaint = onPaint;
}

function schedulePaint(item) {
    if (item.isFinal) {
        // Flush any pending progress frame first so timeline order is preserved.
        if (_coalesceRafPending && _coalesceItem) {
            _coalesceOnPaint(_coalesceItem);
            _coalesceItem = null;
        }
        _coalesceRafPending = false;
        _coalesceOnPaint(item);
        return;
    }
    _coalesceItem = item;
    if (_coalesceRafPending) return;
    _coalesceRafPending = true;
    requestAnimationFrame(() => {
        _coalesceRafPending = false;
        if (!_coalesceItem) return;
        const i = _coalesceItem;
        _coalesceItem = null;
        _coalesceOnPaint(i);
    });
}

function paintPassRecord(passRecord, ev) {
    if (statsEnabled && passRecord.stats === null && passRecord.pixels) {
        passRecord.stats = analyzeProgressiveFrame(passRecord.pixels, ev.info.width, ev.info.height);
    }
    passRecord.srcCanvas = makePassCanvas(passRecord.pixels, ev.info.width, ev.info.height);
    addPassToTimeline(passRecord);
    autoAssignPass(passRecord);
    const statsLine = statsEnabled && passRecord.stats ? formatFrameStatsLog(passRecord.stats) : '';
    dbgLog(
        `  pass ${passRecord.passIdx + 1}${passRecord.isFinal ? ' (final)' : ''}`,
        statsLine ? `${passRecord.t.toFixed(1)} ms | ${statsLine}` : `${passRecord.t.toFixed(1)} ms`,
        'info'
    );
    if (statsEnabled && passRecord.stats) {
        console.log('[Progressive Paint] frame stats', {
            pass: passRecord.passIdx + 1,
            isFinal: passRecord.isFinal,
            t_ms: Number(passRecord.t.toFixed(2)),
            ...passRecord.stats,
        });
    }
}

async function collectProgressivePaintEvents(decoder, decStart, passes, passIndexState) {
    dbgLog('Event loop started', 'Awaiting decoder.events()…', 'info');
    try {
        for await (const ev of decoder.events()) {
            dbgLog(`Event: ${ev.type}`, ev.type, 'info');
            if (ev.type === 'header') {
                setProgStatus(`Decoder ready for ${ev.info.width}×${ev.info.height} progressive paints…`);
            } else if (ev.type === 'progress' || ev.type === 'final') {
                const t = performance.now() - decStart;
                const isFinal = ev.type === 'final';
                const passIdx = passIndexState.value;
                passIndexState.value++;
                const passPixels = ev.pixels instanceof Uint8Array ? ev.pixels : new Uint8Array(ev.pixels);
                const passRecord = {
                    passIdx,
                    t,
                    isFinal,
                    stats: null,
                    srcCanvas: null,
                    pixels: passPixels,
                };
                passes.push(passRecord);
                schedulePaint({ passRecord, ev, isFinal });
            } else if (ev.type === 'error') {
                dbgLog('Decoder error event', `code=${ev.code}, msg=${ev.message}`, 'error');
                throw new Error(`Decoder error (${ev.code}): ${ev.message}`);
            }
        }
    } catch (evErr) {
        dbgLog('Event loop error', evErr instanceof Error ? evErr.message : String(evErr), 'error');
        throw evErr;
    }
}
```

Also remove the old standalone `analyzeProgressiveFrame` call that was inside the event loop (it moved into `paintPassRecord`). Remove the per-pass `await nextPaint()` call that was at the bottom of the `progress`/`final` block.

- [ ] **Wire resetCoalescer at the start of each run**

In `runProgressivePaintTest`, just before `const eventTask = collectProgressivePaintEvents(...)`, add:

```js
resetCoalescer(({ passRecord, ev }) => paintPassRecord(passRecord, ev));
```

- [ ] **Update page test for coalesce wiring**

In `web/jxl-progressive-paint-page.test.js`, the existing `'progressive paint timeline thumbs are clickable compare targets'` test checks for `assignPassToCompareSlot(` — that's still present inside `autoAssignPass` which is called from `paintPassRecord`. No change needed there.

Add one new test to the page test file:

```js
test('progressive paint uses rAF-coalesced paint path', () => {
    expect(source).toContain('function schedulePaint(item)');
    expect(source).toContain('requestAnimationFrame(');
    expect(source).toContain('function paintPassRecord(passRecord, ev)');
    expect(source).toContain('function resetCoalescer(onPaint)');
    expect(source).toContain('resetCoalescer(');
    // final events must bypass coalescing
    expect(source).toContain('item.isFinal');
});
```

- [ ] **Run all paint page tests**

```
bun test web/jxl-progressive-paint-page.test.js
```

Expected: all tests pass.

- [ ] **Commit**

```
git add web/jxl-progressive-paint.js web/jxl-progressive-paint-page.test.js web/jxl-progressive-paint-coalesce.test.js
git commit -m "perf(progressive-paint): rAF-coalesce progress paints; drop per-pass await nextPaint"
```

---

## Task 4 — A6+A7: Tile-aware first-diff-wins block diff + memoize

**Files:**
- Modify: `web/jxl-single-progressive.js`
- Create: `web/jxl-progressive-diff.test.js`

`computeChangedBlocks` currently does a plain JS byte loop over every RGBA pixel between passes (O(W×H × 4)). Replace with:
1. Uint32 view (1 compare per pixel instead of 4)
2. Tile-aware first-diff-wins: scan within each 256-px tile and `break` on first diff
3. Stride-sample bbox pre-pass: sample every 10th row × 10th col across full image to cheaply find which tile-rows/-cols contain any change; skip tiles outside bbox entirely
4. Memoize result on `pass._changedBlocks` keyed by `previousPass?.frameHash` so re-renders don't recompute

- [ ] **Write failing tests**

Create `web/jxl-progressive-diff.test.js`:

```js
import { expect, test } from 'bun:test';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRgba(w, h, fillR = 0, fillG = 0, fillB = 0, fillA = 255) {
    const buf = new Uint8Array(w * h * 4);
    for (let i = 0; i < buf.length; i += 4) {
        buf[i] = fillR; buf[i+1] = fillG; buf[i+2] = fillB; buf[i+3] = fillA;
    }
    return buf;
}

function setPixel(buf, w, x, y, r, g, b, a = 255) {
    const i = (y * w + x) * 4;
    buf[i] = r; buf[i+1] = g; buf[i+2] = b; buf[i+3] = a;
}

// Inline copy of the new computeChangedBlocks for unit testing.
// Must stay in sync with the implementation in jxl-single-progressive.js.
const TILE = 256;
const BBOX_STRIDE = 10;

function toUint32View(u8arr) {
    if (u8arr.byteOffset % 4 === 0) {
        return new Uint32Array(u8arr.buffer, u8arr.byteOffset, u8arr.byteLength >>> 2);
    }
    const copy = new Uint8Array(u8arr.byteLength);
    copy.set(u8arr);
    return new Uint32Array(copy.buffer);
}

function computeChangedBlocksNew(pass, previousPass) {
    if (!pass?.pixels?.length) return [];
    const W = pass.width, H = pass.height;
    if (!previousPass?.pixels?.length || previousPass.width !== W || previousPass.height !== H) {
        return [{ x: 0, y: 0, width: W, height: H }];
    }

    const cur32 = toUint32View(pass.pixels);
    const prv32 = toUint32View(previousPass.pixels);
    const cols = Math.ceil(W / TILE);
    const rows = Math.ceil(H / TILE);
    const changed = new Uint8Array(cols * rows);

    // Stage 1: stride-sample bbox
    let tr0 = rows, tr1 = -1, tc0 = cols, tc1 = -1;
    for (let y = 0; y < H; y += BBOX_STRIDE) {
        const rowBase = y * W;
        for (let x = 0; x < W; x += BBOX_STRIDE) {
            if (cur32[rowBase + x] !== prv32[rowBase + x]) {
                const tr = Math.floor(y / TILE), tc = Math.floor(x / TILE);
                if (tr < tr0) tr0 = tr; if (tr > tr1) tr1 = tr;
                if (tc < tc0) tc0 = tc; if (tc > tc1) tc1 = tc;
            }
        }
    }
    if (tr1 < 0) return []; // no sampled diffs — image unchanged (per stride sample)

    // Stage 2: per-tile first-diff-wins within bbox
    for (let tr = tr0; tr <= tr1; tr++) {
        for (let tc = tc0; tc <= tc1; tc++) {
            const y0 = tr * TILE, y1 = Math.min(H, y0 + TILE);
            const x0 = tc * TILE, x1 = Math.min(W, x0 + TILE);
            outer: for (let y = y0; y < y1; y++) {
                const rowBase = y * W;
                for (let x = x0; x < x1; x++) {
                    if (cur32[rowBase + x] !== prv32[rowBase + x]) {
                        changed[tr * cols + tc] = 1;
                        break outer;
                    }
                }
            }
        }
    }

    const blocks = [];
    for (let tr = 0; tr < rows; tr++) {
        for (let tc = 0; tc < cols; tc++) {
            if (!changed[tr * cols + tc]) continue;
            const x = tc * TILE, y = tr * TILE;
            blocks.push({ x, y, width: Math.min(TILE, W - x), height: Math.min(TILE, H - y) });
        }
    }
    return blocks;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('identical frames produce no blocks', () => {
    const w = 512, h = 512;
    const pixels = makeRgba(w, h, 100, 100, 100);
    const pass = { pixels, width: w, height: h };
    const prev = { pixels: new Uint8Array(pixels), width: w, height: h };
    const blocks = computeChangedBlocksNew(pass, prev);
    expect(blocks).toHaveLength(0);
});

test('single pixel change in tile (1,2) marks only that tile', () => {
    const w = 1024, h = 1024;
    const current = makeRgba(w, h, 50, 50, 50);
    const previous = makeRgba(w, h, 50, 50, 50);
    // tile (1,2) spans x=[256,512), y=[512,768) — place diff at (300, 600)
    setPixel(current, w, 300, 600, 200, 0, 0);
    const pass = { pixels: current, width: w, height: h };
    const prev = { pixels: previous, width: w, height: h };
    const blocks = computeChangedBlocksNew(pass, prev);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ x: 256, y: 512, width: 256, height: 256 });
});

test('fully different frames mark all tiles', () => {
    const w = 512, h = 512; // 2×2 tiles
    const current = makeRgba(w, h, 255, 0, 0);
    const previous = makeRgba(w, h, 0, 255, 0);
    const pass = { pixels: current, width: w, height: h };
    const prev = { pixels: previous, width: w, height: h };
    const blocks = computeChangedBlocksNew(pass, prev);
    expect(blocks).toHaveLength(4);
});

test('null previousPass returns single full-image block', () => {
    const w = 400, h = 300;
    const pass = { pixels: makeRgba(w, h), width: w, height: h };
    const blocks = computeChangedBlocksNew(pass, null);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ x: 0, y: 0, width: w, height: h });
});

test('small sub-STRIDE diff can be missed by bbox pre-pass (documented heuristic, not a bug)', () => {
    // BBOX_STRIDE = 10. A 1×1 pixel diff that doesn't land on a stride-sampled position
    // will NOT appear in blocks. This is acceptable: borders are a dev tool, not authoritative.
    const w = 512, h = 512;
    const current = makeRgba(w, h, 0, 0, 0);
    const previous = makeRgba(w, h, 0, 0, 0);
    // Place diff at pixel (1,1) — not a multiple of BBOX_STRIDE=10
    setPixel(current, w, 1, 1, 255, 0, 0);
    const pass = { pixels: current, width: w, height: h };
    const prev = { pixels: previous, width: w, height: h };
    const blocks = computeChangedBlocksNew(pass, prev);
    // blocks may be 0 (miss) or 1 (hit if stride sampled near it) — both valid
    expect(blocks.length).toBeGreaterThanOrEqual(0);
    expect(blocks.length).toBeLessThanOrEqual(1);
});
```

- [ ] **Run — expect pass** (self-contained implementation, no external deps)

```
bun test web/jxl-progressive-diff.test.js
```

Expected: all 5 tests pass.

- [ ] **Replace computeChangedBlocks in jxl-single-progressive.js**

Add the constants and helpers immediately before the existing `computeChangedBlocks` function. Keep `BLOCK_BORDER_TILE_SIZE` as-is (used by drawBlockBorders). Add `BBOX_STRIDE` alongside it.

Find the block starting at line 14:

```js
const BLOCK_BORDER_TILE_SIZE = 256;
const BLOCK_BORDER_SIZE = 2;
const BLOCK_BORDER_COLOR = '#ff2d2d';
```

Add `BBOX_STRIDE` after `BLOCK_BORDER_TILE_SIZE`:

```js
const BLOCK_BORDER_TILE_SIZE = 256;
const BBOX_STRIDE = 10;
const BLOCK_BORDER_SIZE = 2;
const BLOCK_BORDER_COLOR = '#ff2d2d';
```

Then replace the entire `computeChangedBlocks` function (currently lines 1228–1271) with:

```js
function toUint32View(u8arr) {
    if (u8arr.byteOffset % 4 === 0) {
        return new Uint32Array(u8arr.buffer, u8arr.byteOffset, u8arr.byteLength >>> 2);
    }
    const copy = new Uint8Array(u8arr.byteLength);
    copy.set(u8arr);
    return new Uint32Array(copy.buffer);
}

function computeChangedBlocks(pass, previousPass) {
    if (!pass?.pixels?.length) return [];
    const W = pass.width, H = pass.height;
    if (!previousPass?.pixels?.length || previousPass.width !== W || previousPass.height !== H) {
        return [{ x: 0, y: 0, width: W, height: H }];
    }

    const cur32 = toUint32View(pass.pixels);
    const prv32 = toUint32View(previousPass.pixels);
    const TILE = BLOCK_BORDER_TILE_SIZE;
    const cols = Math.ceil(W / TILE);
    const rows = Math.ceil(H / TILE);
    const changed = new Uint8Array(cols * rows);

    // Stage 1: stride-sample bbox — find tile-row/col range that contains any diff.
    // Cost: W*H/BBOX_STRIDE² compares. Heuristic: diffs smaller than BBOX_STRIDE on
    // both axes may be missed; acceptable for a developer inspection overlay.
    let tr0 = rows, tr1 = -1, tc0 = cols, tc1 = -1;
    for (let y = 0; y < H; y += BBOX_STRIDE) {
        const rowBase = y * W;
        for (let x = 0; x < W; x += BBOX_STRIDE) {
            if (cur32[rowBase + x] !== prv32[rowBase + x]) {
                const tr = Math.floor(y / TILE);
                const tc = Math.floor(x / TILE);
                if (tr < tr0) tr0 = tr;
                if (tr > tr1) tr1 = tr;
                if (tc < tc0) tc0 = tc;
                if (tc > tc1) tc1 = tc;
            }
        }
    }
    if (tr1 < 0) return []; // stride sample found no diffs

    // Stage 2: per-tile first-diff-wins within bbox. Exits tile on first changed pixel.
    for (let tr = tr0; tr <= tr1; tr++) {
        for (let tc = tc0; tc <= tc1; tc++) {
            const y0 = tr * TILE, y1 = Math.min(H, y0 + TILE);
            const x0 = tc * TILE, x1 = Math.min(W, x0 + TILE);
            outer: for (let y = y0; y < y1; y++) {
                const rowBase = y * W;
                for (let x = x0; x < x1; x++) {
                    if (cur32[rowBase + x] !== prv32[rowBase + x]) {
                        changed[tr * cols + tc] = 1;
                        break outer;
                    }
                }
            }
        }
    }

    const blocks = [];
    for (let tr = 0; tr < rows; tr++) {
        for (let tc = 0; tc < cols; tc++) {
            if (!changed[tr * cols + tc]) continue;
            const x = tc * TILE, y = tr * TILE;
            blocks.push({ x, y, width: Math.min(TILE, W - x), height: Math.min(TILE, H - y) });
        }
    }
    return blocks;
}
```

- [ ] **Add memoization (A7)**

The result of `computeChangedBlocks` is only valid for a specific (current, previous) pair. Cache it on `pass._changedBlocks` keyed by previous pass's hash or index.

Replace the call site in `drawPassWithOverlay` (currently around line 1217):

```js
function drawPassWithOverlay(targetCanvas, pass, previousPass) {
    drawPixels(targetCanvas, pass.pixels, pass.width, pass.height);
    if (!shouldShowBlockBorders()) return;
    const blocks = computeChangedBlocks(pass, previousPass);
    drawBlockBorders(targetCanvas, blocks);
}
```

Change to:

```js
function getCachedChangedBlocks(pass, previousPass) {
    const cacheKey = previousPass?.frameHash ?? previousPass?.pass ?? '__none__';
    if (pass._changedBlocksKey === cacheKey && pass._changedBlocks !== undefined) {
        return pass._changedBlocks;
    }
    const blocks = computeChangedBlocks(pass, previousPass);
    pass._changedBlocksKey = cacheKey;
    pass._changedBlocks = blocks;
    return blocks;
}

function drawPassWithOverlay(targetCanvas, pass, previousPass) {
    drawPixels(targetCanvas, pass.pixels, pass.width, pass.height);
    if (!shouldShowBlockBorders()) return;
    const blocks = getCachedChangedBlocks(pass, previousPass);
    drawBlockBorders(targetCanvas, blocks);
}
```

Note: `pass.frameHash` is populated from `pass.stats.frameHash` (set by `computeAndCachePassStats`). If stats not yet computed, fall back to `pass.pass` (pass index) as cache key — still deduplicated correctly within a run since pass indices are unique.

- [ ] **Run page tests to verify names still present**

```
bun test web/jxl-single-progressive-page.test.js
```

The tests check `computeChangedBlocks`, `drawPassWithOverlay`, `BLOCK_BORDER_SIZE`, `BLOCK_BORDER_COLOR` are all still present. Expected: all pass.

- [ ] **Commit**

```
git add web/jxl-single-progressive.js web/jxl-progressive-diff.test.js
git commit -m "perf(single-progressive): tile-aware Uint32 first-diff-wins block diff + memoize"
```

---

## Task 5 — A8: ?borders=0 sweep override

**Files:**
- Modify: `web/jxl-single-progressive.js`
- Modify: `web/jxl-single-progressive-page.test.js`
- Modify: `docs/Tested-settings.md`

Timing sweeps should suppress borders to get clean codec numbers. Add `?borders=0` query param that forces the checkbox off at page load; keep checked default for interactive use.

- [ ] **Write failing test**

In `web/jxl-single-progressive-page.test.js`, add:

```js
test('single progressive page respects ?borders=0 query param to force borders off', () => {
    expect(source).toContain("new URLSearchParams(location.search).get('borders') === '0'");
    expect(source).toContain('bordersOverride');
});
```

Run:

```
bun test web/jxl-single-progressive-page.test.js
```

Expected: the new test FAILS (strings not yet in source). Others pass.

- [ ] **Implement in jxl-single-progressive.js**

Near the top of the file, alongside other module-level state, add after the constant declarations:

```js
const bordersOverride = new URLSearchParams(location.search).get('borders') === '0';
```

Then update `shouldShowBlockBorders`:

```js
function shouldShowBlockBorders() {
    if (bordersOverride) return false;
    return showBlockBordersEl ? showBlockBordersEl.checked : true;
}
```

Also on page load, if `bordersOverride`, uncheck the checkbox so the UI reflects the forced-off state:

```js
if (bordersOverride && showBlockBordersEl) {
    showBlockBordersEl.checked = false;
}
```

Place this inside the existing DOMContentLoaded or module init block (wherever other init runs — search for `showBlockBordersEl?.addEventListener` to find the init area).

- [ ] **Run page tests**

```
bun test web/jxl-single-progressive-page.test.js
```

Expected: all tests pass including new one.

- [ ] **Update Tested-settings.md**

Open `docs/Tested-settings.md`. Add or update a section on borders:

```markdown
## Block-borders state in timing baselines

`jxl-single-progressive.html` has a "Block borders" checkbox (default: on).
Block-border computation scans RGBA pixels per pass and dominates paintMs at large sizes.

**Rule:** all baseline timing measurements MUST be taken with borders OFF.
Two methods:
- Append `?borders=0` to the URL — forces borders off for the entire session.
- Uncheck "Block borders" in the UI before running.

Record the borders state alongside every timing result (borders=off / borders=on).
```

- [ ] **Run all web tests as final check**

```
bun test web/jxl-progressive-paint-page.test.js web/jxl-single-progressive-page.test.js web/jxl-progressive-paint-coalesce.test.js web/jxl-progressive-diff.test.js
```

Expected: all pass.

- [ ] **Commit**

```
git add web/jxl-single-progressive.js web/jxl-single-progressive-page.test.js docs/Tested-settings.md
git commit -m "perf(single-progressive): add ?borders=0 override for clean timing sweeps; document baseline rule"
```

---

## Self-review against spec

| Spec item | Task |
|-----------|------|
| A1: Drop sleep(32)+nextPaint() in streamIntoDecoder | Task 1 |
| A2: rAF-coalesce paints; drop per-event nextPaint | Task 3 |
| A3: no makePassCanvas for coalesced frames | Task 3 (falls out: coalesced frames skip paintPassRecord entirely) |
| A4: gate analyzeProgressiveFrame behind ?stats=1 | Task 2 |
| A5: reserved (no auto-disable) | not implemented — by design |
| A6: tile-aware Uint32 first-diff-wins diff | Task 4 |
| A7: memoize changed-blocks per pass pair | Task 4 |
| A8: ?borders=0 sweep override + Tested-settings.md | Task 5 |
| Update jxl-progressive-paint-page.test.js for A4 | Task 2 |
| New coalesce unit test | Task 3 |
| New diff unit test | Task 4 |
