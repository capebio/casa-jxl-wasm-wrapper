# Handoff: Progressive Paint Speedup A3 + A4

Date: 2026-06-06
Branch: `codex/optimal-settings-timing-tests`
Spec: `docs/superpowers/specs/2026-06-06-progressive-paint-speedup-design.md`

## Status

- **A1 DONE** — removed `await nextPaint()` + `await sleep(32)` from `streamIntoDecoder`
- **A2 DONE** — rAF-coalescing in `collectProgressivePaintEvents`; `paintPass`/`schedulePaint` extracted; 16/16 tests pass

## What A3 and A4 do

### A3 — Persistent canvases; no `makePassCanvas`

**Goal:** Remove the per-pass `document.createElement('canvas')` alloc. Currently every decoded frame allocates a fresh `HTMLCanvasElement`, copies pixels in, then copies again to the compare slot and thumbnail. A3 replaces this with persistent canvases.

**Current flow in `paintPass` (after A2):**
1. `makePassCanvas(pixels, w, h)` → allocates new canvas, `putImageData`
2. `addPassToTimeline(passRecord)` → allocates thumb canvas (80×50), `drawImage(srcCanvas)`
3. `autoAssignPass → assignPassToCompareSlot` → `paintCanvasIntoSlot(passRecord.srcCanvas, slot.canvas)` → `drawImage`

**Target flow:**
1. Skip `makePassCanvas`. Instead call `putImageData` directly into each compare slot's persistent canvas.
2. Per-pass thumb canvas: keep one persistent per passIdx (created lazily, stored in a module-level `Map<passIdx, HTMLCanvasElement>`). Re-use across re-runs that keep the same pass count.
3. The visible compare-slot canvases (`slot.canvas` in `compareSlots`) already persist — just write to them directly.

**Key file locations:**

| Location | Current | Change needed |
|---|---|---|
| `web/jxl-progressive-paint.js:639` | `makePassCanvas` | Delete function; replace callers |
| `web/jxl-progressive-paint.js:838` | `paintPass(ev)` | Replace `srcCanvas: makePassCanvas(...)` with direct `putImageData` into slot canvas; update `addPassToTimeline` call |
| `web/jxl-progressive-paint.js:797` | `addPassToTimeline(passRecord)` | Replace per-call `document.createElement('canvas')` with lazy persistent thumb map |
| `web/jxl-progressive-paint.js:768` | `assignPassToCompareSlot` | Reads `passRecord.srcCanvas`; after A3 `srcCanvas` should be the slot's own canvas (or removed from passRecord) |

**Important invariants from the spec:**
- `paintCanvasIntoSlot(srcCanvas, slot.canvas)` does `drawImage(srcCanvas)` into the visible canvas. After A3, the `srcCanvas` step disappears — just call `slot.canvas.getContext('2d').putImageData(imgData, 0, 0)` directly. Then `paintCanvasIntoSlot` is no longer needed (or call it with the slot canvas as both src and dst, which is a no-op — better to inline the single `putImageData`).
- Thumb canvas map: `let thumbCanvases = new Map(); // passIdx → HTMLCanvasElement`. On `clearPassTimeline()` call: `thumbCanvases.clear()`.
- Find `clearPassTimeline` call site and add `thumbCanvases.clear()` there.
- `passRecord.srcCanvas` is read in `addPassToTimeline`, `assignPassToCompareSlot`, and by timeline button click handlers. After A3, `srcCanvas` should point to the slot's persistent canvas (so click-to-pin still works). Check all read sites before removing.

**Find `clearPassTimeline`:**
```
grep -n "clearPassTimeline\|clearCompareSlots" web/jxl-progressive-paint.js
```

**Tests to add (append to `web/jxl-progressive-paint-page.test.js`):**
```js
test('A3: makePassCanvas removed — persistent canvas strategy used', () => {
    expect(source).not.toContain('function makePassCanvas(');
    expect(source).toContain('thumbCanvases');
    expect(source).toContain('putImageData');
});
```

---

### A4 — Gate full-image stats behind `?stats=1`

**Goal:** `analyzeProgressiveFrame` (O(W×H) per pass) runs by default on every pass. Gate it behind `?stats=1`.

**File:** `web/jxl-progressive-paint.js` — `paintPass` function (~line 838 after A2)

**Current in `paintPass`:**
```js
const frameStats = analyzeProgressiveFrame(ev.pixels, ev.info.width, ev.info.height);
...
const passRecord = { ..., stats: frameStats, ... };
...
const statsLine = formatFrameStatsLog(frameStats);
dbgLog(`  pass ${ev.passIdx + 1}...`, `${ev.t.toFixed(1)} ms | ${statsLine}`, 'info');
console.log('[Progressive Paint] frame stats', { ..., ...frameStats });
```

**New:**
```js
// Near module top, after query param parsing (add once):
const STATS_ENABLED = new URLSearchParams(location.search).has('stats');

// In paintPass:
const frameStats = STATS_ENABLED
    ? analyzeProgressiveFrame(ev.pixels, ev.info.width, ev.info.height)
    : null;
...
const passRecord = { ..., stats: frameStats, ... };
...
if (STATS_ENABLED) {
    const statsLine = formatFrameStatsLog(frameStats);
    dbgLog(`  pass ${ev.passIdx + 1}...`, `${ev.t.toFixed(1)} ms | ${statsLine}`, 'info');
    console.log('[Progressive Paint] frame stats', { pass: ev.passIdx + 1, isFinal: ev.isFinal, t_ms: ..., ...frameStats });
} else {
    const stage = ev.isFinal ? 'final' : 'partial';
    dbgLog(`  pass ${ev.passIdx + 1} · ${stage}`, `${ev.t.toFixed(1)} ms`, 'info');
}
```

**Important:**
- `STATS_ENABLED` is a module-level `const` (parsed once at load time from `location.search`).
- Exporters (`formatFrameStatsCompact`, TOON exporter) already tolerate `p.stats === null` per the spec. Verify with grep before landing: `grep -n "p\.stats\|passRecord\.stats\|\.stats\." web/jxl-progressive-paint.js`
- No new UI control — `?stats=1` URL param only.
- Add a footer note to `web/jxl-progressive-paint.html` mentioning `?stats=1`.

**Tests to add:**
```js
test('A4: stats gated behind STATS_ENABLED — analyzeProgressiveFrame not called unconditionally', () => {
    expect(source).toContain('STATS_ENABLED');
    const paintPassIdx = source.indexOf('function paintPass(');
    const paintPassEnd = source.indexOf('\nfunction ', paintPassIdx + 1);
    const paintPassBody = paintPassEnd === -1 ? source.slice(paintPassIdx) : source.slice(paintPassIdx, paintPassEnd);
    // analyzeProgressiveFrame must appear inside an if(STATS_ENABLED) guard
    expect(paintPassBody).toContain('STATS_ENABLED');
    expect(paintPassBody).toContain('analyzeProgressiveFrame');
});

test('A4: per-pass dbgLog shows pass N · partial|final when stats off', () => {
    expect(source).toContain('partial');
    expect(source).toContain('final');
    expect(source).toContain('STATS_ENABLED');
});
```

---

## Running tests

```powershell
bun test web/jxl-progressive-paint-page.test.js
```

Expected after A3+A4: 20 total (16 existing + 2 A3 + 2 A4).

## Notes on ordering

A4 is simpler — do it first if you want a quick win. A3 requires more care (persistent canvas map + clearing on reset).

After A3+A4 land, run the bench sweep with borders OFF to validate the perf goal: `di 1920 ≤ one-shot wall time`. See spec §Success criteria.
