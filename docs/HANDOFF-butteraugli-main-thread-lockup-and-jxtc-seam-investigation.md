# Handoff: Butteraugli Main-Thread Lockups & JXTC Tiled Boundary Seam Investigation

Date: 2026-06-12
Status: Investigative / Performance and Correctness Action Plan
Files Involved: 
* `web/jxl-single-progressive.js` (Main-thread UI chart)
* `web/jxl-frame-stats-worker.js` (Existing background worker)
* `packages/jxl-wasm/src/bridge.cpp` (C++ WASM bridge & tiled container decoder)

---

## Executive Summary

Based on today's performance benchmark runs (`StandardMultifileTest.mjs` and `test-metrics-performance.mjs`), we have identified two highly critical, actionable improvements in the raw-converter codebase:

1. **[G1 Performance - High] Butteraugli Main-Thread UI Freeze**: The progressive chart rendering (`drawButtChart`) currently runs sRGB-to-linear-XYB color conversion and heavy per-pass Butteraugli calculations on the main thread, causing a **515ms to 640ms synchronous freeze**. This blocks the browser event loop completely.
2. **[G3 Correctness - Medium] JXTC Tiled Region Seam Drift**: Independent crop decodes on JXTC Tiled Containers (`decodeTileContainerRegionRgba8`) failed the pixel-exact `[P-4 Seam Test]` against monolithic crop decodes (734 mismatched bytes out of 1.04MB, max channel drift of 11). This indicates boundary filtering/reconstruction anomalies.

---

## 🚀 Improvement 1: Offloading Butteraugli Chart Calculations (G1)

### The Problem
When rendering progressive quality metrics charts in the viewer UI, `web/jxl-single-progressive.js` calls `drawButtChart(passes, targetRgba)`. 

```js
// web/jxl-single-progressive.js (Line ~2052)
function drawButtChart(passes, targetRgba) {
    ...
    const refXyb = pixelsToXyb(refDs, n);  // ⚠️ Runs synchronously on main thread
    const values = passes.map(pass => {
        ...
        return computeButteraugliVsFinal(refXyb, px, dsW, dsH);  // ⚠️ Runs synchronously on main thread
    });
    ...
}
```
At $1920\text{px}$, computing XYB conversion and evaluating multiple progressive passes takes **over 515 ms** (representing **80.5%** of the entire UI thread lockup).

### The Actionable Solution
A fully-featured background worker **already exists** in `web/jxl-frame-stats-worker.js` that implements background chart calculations!

```js
// web/jxl-frame-stats-worker.js (Line ~29)
function handleChartRequest(id, data) {
    const { ref, refWidth, refHeight, passes } = data;
    try {
        const refPx = new Uint8Array(ref);
        const n = refWidth * refHeight;
        const refXyb = pixelsToXyb(refPx, n); // Runs safely in background thread
        const values = passes.map(p => {
            ...
            return {
                index: p.index,
                psnr: computePsnrVsFinal(refPx, px),
                ssim: computeSsimVsFinal(refPx, px, refWidth, refHeight),
                butt: computeButteraugliVsFinal(refXyb, px, refWidth, refHeight),
            };
        });
        self.postMessage({ id, ok: true, type: 'chart', values });
    } ...
}
```

### Action Plan / Implementation Steps
1. **Refactor `drawButtChart`** to instantiate or reuse an active `jxl-frame-stats-worker.js` instance.
2. **Post message to worker**: Instead of calling `pixelsToXyb` and `computeButteraugliVsFinal` directly, package the reference pixel buffer (`targetRgba.buffer`), dimensions, and pass buffers, and transfer ownership to the worker:
   ```js
   worker.postMessage({
       type: 'chart',
       ref: reference.buffer,
       refWidth: pw,
       refHeight: ph,
       passes: passes.map(p => ({ index: p.index, buf: p.pixels.buffer }))
   }, [reference.buffer, ...passes.map(p => p.pixels.buffer)]);
   ```
3. **Handle message asynchronously**: Receive the processed `{ type: 'chart', values }` in `web/jxl-single-progressive.js`, draw the `butt-chart` using the values returned, and recover UI responsiveness instantly.

---

## 🔍 Improvement 2: Resolving JXTC Tiled Region Seam Drift (G3)

### The Problem
During `StandardMultifileTest.mjs` execution, the `[P-4 Seam Test]` compares the pixels obtained from cropping a monolithic JXL file with the pixels from a seek-aware JXTC Tiled Container decode (`decodeTileContainerRegionRgba8`).

* **Expected**: 100% pixel-exact, byte-identical matching (0 mismatches).
* **Actual**: `❌ FAIL: Failed! Found 734 mismatched bytes out of 1048576 total bytes. Max difference: 11`

### The Core Cause
In lossy JXL compression, decoding a rectangular subgrid of tiles independently prevents adjacent tiles from sharing filter/loop-filtering context. As a result, inverse-DCT calculations and adaptive quantization boundaries differ slightly at the tile boundaries compared to a unified, monolithic image decode.

While this difference is perceptually imperceptible, it violates the contract of **pixel-exact reproducibility** for analytical scientific platforms (such as botanical specimens analysis).

### Investigative Plan / Implementation Steps
1. **Audit `DecodeRgba8TileContainerRegion` in `packages/jxl-wasm/src/bridge.cpp`**:
   * Inspect how tile margins/halos are handled. Standard JXL tiling requires a border halo overlap of $\approx 16\text{px}$ to $32\text{px}$ during decoding to resolve multi-scale filter extents correctly.
   * If independent tiles are decoded without a halo boundary overlap, the filter edge-effects bleed into the central tile pixels.
2. **Validate Fixed-Point Seam Blending (A3)**:
   * Research notes indicate boundary blending math is applied in `bridge.cpp` at line 1722 using `Q8` fixed-point integer math. 
   * Audit this formula to ensure there are no truncation or rounding errors that scale with the color channel intensity (since max difference is 11, which scales proportionally with color channels).
3. **Enhance Halo Decoding Contract**:
   * If haloing is not yet active in the WASM bridge, modify `DecodeRgba8TileContainerRegion` to decode each tile with its adjacent 16px border, crop out the boundary artifacting, and stitch only the clean, artifact-free inner quadrants together.

---

## 📊 Reference Telemetry (From June 12, 2026 Run)

* **UI Lockup Baseline**:
  * Total synchronous lockup: **641.10 ms**
  * Butteraugli computation: **515.97 ms** (xyb precompute: 24.71 ms, pass evaluation: 491.27 ms)
  * SSIM evaluation: **88.23 ms**
  * PSNR evaluation: **36.90 ms**

* **Tiled Decodes Speedup**:
  * Monolithic ROI Crop (512x512): **301 ms**
  * Tiled JXTC ROI Crop (512x512): **72 ms** (**4.2x faster!**)
  * *Tiled decoding delivers massive performance gains, making the resolution of the G3 seam drift highly critical to unlock production readiness.*
