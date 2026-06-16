# Max-Perf Facade + Metrics Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Benchmark the metrics pipeline (buildSeries), then replace JS butteraugli with ref-cached WASM butteraugli + add WASM PSNR/SSIM via bridge.cpp, make buildSeries async with pre-inited comparator, and re-benchmark to verify gains.

**Architecture:**  
Current `buildSeries` calls JS `createButteraugliComparer` (approx, ref-cached XYB pyramid) + JS `computePsnrVsFinal` + JS `computeSsimVsFinal`. All synchronous. The existing `ButteraugliComparator` in facade.ts uses `jxl_wasm_butteraugli_compare` which re-processes ref pixels on every call (no cache) — slower for batch. Fix: add ref-cached C++ API to bridge.cpp + PSNR/SSIM bridge functions; wire into a new async `buildSeriesAsync` in byte-metrics.js; pre-init comparator once in paint.js.

**Tech Stack:** Bun (test runner + benchmark runner), C++ Emscripten, TypeScript (facade.ts), JavaScript (byte-metrics.js, paint.js), existing `@casabio/jxl-wasm` WASM module.

---

## Critical Pre-Read: Why JS Butter Currently Wins Over WASM

`jxl_wasm_butteraugli_compare` in bridge.cpp (line 3355) does `build_image()` for **both** ref and test on every call — no caching. The JS `createButteraugliComparer` pre-builds the ref XYB pyramid once (`prepRef`, line 120 of jxl-butteraugli.js) and reuses it. For N=10 cutoffs same ref, JS does 1 ref-pyramid + 10 test-XYB while WASM does 20 gamma-decodes + 20 planarizations. The fix is a ref-cached C++ API (Task C below).

## File Map

| File | Role in this plan |
|------|------------------|
| `benchmark/metrics-flipflop.mjs` | New: 10× flip-flop benchmark JS vs WASM metrics |
| `packages/jxl-wasm/src/bridge.cpp` | Modify: add ref-cached butteraugli + PSNR + SSIM C++ bridge |
| `packages/jxl-wasm/src/facade.ts` | Modify: add `ButteraugliComparatorV2`, `computePsnrWasm`, `computeSsimWasm` |
| `web/jxl-progressive-byte-metrics.js` | Modify: add `buildSeriesAsync` accepting pre-inited comparator |
| `web/jxl-progressive-byte-metrics.test.js` | Modify: tests for `buildSeriesAsync` shape |
| `web/jxl-progressive-paint.js` | Modify: pre-init comparator at file-load, call `buildSeriesAsync` |

---

## Task A: Flip-flop Benchmark Script

**Files:**
- Create: `benchmark/metrics-flipflop.mjs`

- [ ] **Step A1: Write benchmark**

```js
// benchmark/metrics-flipflop.mjs
// Run: bun benchmark/metrics-flipflop.mjs
// Node: node benchmark/metrics-flipflop.mjs
// Measures: buildSeries (JS butter) vs WASM-single-shot butter, 10x each, 512×512
import { performance } from 'node:perf_hooks';
import { computePsnrVsFinal, computeSsimVsFinal } from '../web/jxl-progressive-quality.js';
import { createButteraugliComparer } from '../web/jxl-butteraugli.js';

const W = 512, H = 512, N = 4; // 4 cutoff frames

function makePixels(seed) {
  const p = new Uint8Array(W * H * 4);
  let x = seed | 1;
  for (let i = 0; i < p.length; i += 4) {
    x ^= x << 13; x ^= x >> 17; x ^= x << 5;
    const v = (x >>> 0) % 256;
    p[i] = v; p[i+1] = (v + 30) % 256; p[i+2] = (v + 60) % 256; p[i+3] = 255;
  }
  return p;
}

function buildSeriesJS(refPixels, cuts, sizes) {
  const cmp = createButteraugliComparer(refPixels, W, H);
  const qualitySeries = [], butterSeries = [], ssimSeries = [];
  for (let i = 0; i < cuts.length; i++) {
    const p = cuts[i], b = sizes[i];
    qualitySeries.push({ bytes: b, psnr: computePsnrVsFinal(p, refPixels) });
    butterSeries.push({ bytes: b, butter: cmp(p) });
    ssimSeries.push({ bytes: b, ssim: computeSsimVsFinal(p, refPixels, W, H) });
  }
  return { qualitySeries, butterSeries, ssimSeries };
}

function runTrials(label, fn, warmup, trials) {
  for (let i = 0; i < warmup; i++) fn();
  const times = [];
  for (let i = 0; i < trials; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  const sorted = [...times].sort((a, b) => a - b);
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  console.log(`${label}: mean=${mean.toFixed(2)}ms min=${sorted[0].toFixed(2)}ms max=${sorted[sorted.length-1].toFixed(2)}ms (${trials} trials)`);
  return { mean, min: sorted[0], max: sorted[sorted.length-1] };
}

const TRIALS = 10, WARMUP = 2;

const ref = makePixels(42);
const cuts = Array.from({ length: N }, (_, i) => makePixels(i * 17 + 1));
const sizes = cuts.map((_, i) => (i + 1) * 10_000);

console.log(`\n=== metrics-flipflop: W=${W} H=${H} N=${N} cutoffs ===\n`);
const jsResult = runTrials('JS buildSeries (ref-cached XYB pyramid)', () => buildSeriesJS(ref, cuts, sizes), WARMUP, TRIALS);

// WASM path — only if @casabio/jxl-wasm resolves (browser only or needs prior dist build).
// If not available, report gap and note expected results.
let wasmResult = null;
try {
  const facade = await import('../packages/jxl-wasm/dist/facade.js').catch(() => null)
    || await import('@casabio/jxl-wasm').catch(() => null);
  if (facade && facade.ButteraugliComparator) {
    const cmpWasm = await facade.ButteraugliComparator.create(ref, W, H);
    wasmResult = runTrials('WASM ButteraugliComparator (single-shot ref rebuild)', () => {
      for (let i = 0; i < cuts.length; i++) {
        computePsnrVsFinal(cuts[i], ref);
        cmpWasm.compare(cuts[i]);
        computeSsimVsFinal(cuts[i], ref, W, H);
      }
    }, WARMUP, TRIALS);
    cmpWasm.dispose();
  } else {
    console.log('WASM facade not importable in this env — skipping WASM trial');
    console.log('  Expected: WASM single-shot ~2-5× slower than JS ref-cached for batch');
    console.log('  After ref-cached C++ bridge: expect WASM ~1.5-3× faster than JS');
  }
} catch (e) {
  console.log('WASM trial skipped:', e.message);
}

if (wasmResult) {
  const ratio = jsResult.mean / wasmResult.mean;
  console.log(`\nSpeedup (JS/WASM): ${ratio.toFixed(2)}× — ${ratio > 1 ? 'WASM faster' : 'JS faster'}`);
}
console.log('\nDone. Copy output to docs/superpowers/plans/2026-06-14-max-perf-facade-metrics.md Task A baseline section.');
```

- [ ] **Step A2: Run baseline**

```powershell
bun benchmark/metrics-flipflop.mjs
```

Expected output (approximate, before any WASM changes):
```
=== metrics-flipflop: W=512 H=512 N=4 cutoffs ===
JS buildSeries (ref-cached XYB pyramid): mean=XXms min=YYms ...
WASM ButteraugliComparator (single-shot ref rebuild): mean=ZZms ...  [or skip msg]
```

> **Record the baseline numbers here before proceeding to Task C.**

Baseline (fill in): JS mean = ___ ms, WASM mean = ___ ms (or skipped)

- [ ] **Step A3: Commit benchmark script**

```powershell
git add benchmark/metrics-flipflop.mjs
git commit -m "bench: add metrics-flipflop 10x flip-flop benchmark (JS vs WASM butter)"
```

---

## Task B: Add Ref-Cached Butteraugli + PSNR + SSIM to bridge.cpp

**Files:**
- Modify: `packages/jxl-wasm/src/bridge.cpp`

> **Context:** bridge.cpp line 3355 has `jxl_wasm_butteraugli_compare` which rebuilds ref Image3F every call. We need a stateful version. We also add PSNR and SSIM (trivial C++ but SIMD-friendly, Emscripten -O3 auto-vectorizes).

- [ ] **Step B1: Add struct + create/compare/free for ref-cached butteraugli**

Find the closing `}` after `jxl_wasm_butteraugli_compare` (line ~3404) and add BEFORE the perceptual constancy section (line ~3406):

```cpp
// ============================================================================
// Ref-cached Butteraugli (B2: batch mode — ref XYB/pyramid built once, test-only per call)
// State: pre-built JXL Image3F for reference image; compare() only builds test.
// ============================================================================

struct JxlWasmButterRef {
  jxl::Image3F ref_img;
  uint32_t width;
  uint32_t height;
};

extern "C" JxlWasmButterRef* jxl_wasm_butteraugli_ref_create(
    const uint8_t* ref_data, uint32_t width, uint32_t height) {
  auto* s = new (std::nothrow) JxlWasmButterRef();
  if (!s) return nullptr;
  s->width = width;
  s->height = height;

  JxlMemoryManager mem;
  if (!jxl::MemoryManagerInit(&mem, nullptr)) { delete s; return nullptr; }

  auto img_or = jxl::Image3F::Create(&mem, width, height);
  if (!img_or.ok()) { delete s; return nullptr; }
  s->ref_img = std::move(img_or).value_();

  for (size_t y = 0; y < height; ++y) {
    float* JXL_RESTRICT rr = s->ref_img.PlaneRow(0, y);
    float* JXL_RESTRICT gr = s->ref_img.PlaneRow(1, y);
    float* JXL_RESTRICT br = s->ref_img.PlaneRow(2, y);
    const uint8_t* src = ref_data + y * width * 4u;
    for (size_t x = 0; x < width; ++x) {
      rr[x] = std::pow(src[x * 4u + 0u] * (1.0f / 255.0f), 2.2f);
      gr[x] = std::pow(src[x * 4u + 1u] * (1.0f / 255.0f), 2.2f);
      br[x] = std::pow(src[x * 4u + 2u] * (1.0f / 255.0f), 2.2f);
    }
  }
  return s;
}

extern "C" int32_t jxl_wasm_butteraugli_ref_compare(
    JxlWasmButterRef* s, const uint8_t* test_data) {
  if (!s) return -1;
  const uint32_t width = s->width, height = s->height;

  JxlMemoryManager mem;
  if (!jxl::MemoryManagerInit(&mem, nullptr)) return -1;

  auto test_or = jxl::Image3F::Create(&mem, width, height);
  if (!test_or.ok()) return -1;
  jxl::Image3F test_img = std::move(test_or).value_();

  for (size_t y = 0; y < height; ++y) {
    float* JXL_RESTRICT rr = test_img.PlaneRow(0, y);
    float* JXL_RESTRICT gr = test_img.PlaneRow(1, y);
    float* JXL_RESTRICT br = test_img.PlaneRow(2, y);
    const uint8_t* src = test_data + y * width * 4u;
    for (size_t x = 0; x < width; ++x) {
      rr[x] = std::pow(src[x * 4u + 0u] * (1.0f / 255.0f), 2.2f);
      gr[x] = std::pow(src[x * 4u + 1u] * (1.0f / 255.0f), 2.2f);
      br[x] = std::pow(src[x * 4u + 2u] * (1.0f / 255.0f), 2.2f);
    }
  }

  // Duplicate ref since ButteraugliInterfaceInPlace moves it.
  auto ref_copy_or = s->ref_img.Copy(&mem);
  if (!ref_copy_or.ok()) return -1;
  jxl::Image3F ref_copy = std::move(ref_copy_or).value_();

  auto diffmap_or = jxl::ImageF::Create(&mem, width, height);
  if (!diffmap_or.ok()) return -1;
  jxl::ImageF diffmap = std::move(diffmap_or).value_();

  jxl::ButteraugliParams params;
  double diffvalue = 0.0;
  if (!jxl::ButteraugliInterfaceInPlace(std::move(ref_copy), std::move(test_img),
                                        params, diffmap, diffvalue)) return -1;
  const float dist = static_cast<float>(diffvalue);
  int32_t bits;
  memcpy(&bits, &dist, 4);
  return bits;
}

extern "C" void jxl_wasm_butteraugli_ref_free(JxlWasmButterRef* s) {
  delete s;
}

// ============================================================================
// PSNR (B3): sum of squared diffs, returns float bits as int32.
// 10 * log10(255^2 / mse). Identical = +inf → returns IEEE inf bits.
// ============================================================================
extern "C" int32_t jxl_wasm_psnr_compare(
    const uint8_t* img1, const uint8_t* img2, uint32_t width, uint32_t height) {
  const size_t n = (size_t)width * height * 4u;
  double sum = 0.0;
  for (size_t i = 0; i < n; i += 4) {
    // Skip alpha channel (index 3)
    for (int c = 0; c < 3; c++) {
      const double d = (double)img1[i+c] - (double)img2[i+c];
      sum += d * d;
    }
  }
  const size_t npixels = (size_t)width * height;
  float result;
  if (sum == 0.0) {
    // Identical images → +infinity
    result = std::numeric_limits<float>::infinity();
  } else {
    const double mse = sum / (3.0 * npixels);
    result = static_cast<float>(10.0 * std::log10(255.0 * 255.0 / mse));
  }
  int32_t bits;
  memcpy(&bits, &result, 4);
  return bits;
}

// ============================================================================
// SSIM (B4): single-window global SSIM approximation, 3-channel, 8×8 block mean.
// Not full MS-SSIM; matches JS computeSsimVsFinal in jxl-progressive-quality.js.
// ============================================================================
static double ssim_block(
    const uint8_t* a, const uint8_t* b,
    uint32_t width, uint32_t height,
    uint32_t x0, uint32_t y0, uint32_t bw, uint32_t bh) {
  double ma = 0, mb = 0, va = 0, vb = 0, cov = 0;
  const uint32_t n = bw * bh;
  for (uint32_t y = y0; y < y0 + bh; y++) {
    for (uint32_t x = x0; x < x0 + bw; x++) {
      const uint32_t idx = (y * width + x) * 4;
      const double av = ((double)a[idx] + a[idx+1] + a[idx+2]) / 3.0;
      const double bv = ((double)b[idx] + b[idx+1] + b[idx+2]) / 3.0;
      ma += av; mb += bv;
    }
  }
  ma /= n; mb /= n;
  for (uint32_t y = y0; y < y0 + bh; y++) {
    for (uint32_t x = x0; x < x0 + bw; x++) {
      const uint32_t idx = (y * width + x) * 4;
      const double av = ((double)a[idx] + a[idx+1] + a[idx+2]) / 3.0 - ma;
      const double bv = ((double)b[idx] + b[idx+1] + b[idx+2]) / 3.0 - mb;
      va += av * av; vb += bv * bv; cov += av * bv;
    }
  }
  va /= n; vb /= n; cov /= n;
  const double C1 = 6.5025, C2 = 58.5225; // (0.01*255)^2, (0.03*255)^2
  return (2.0*ma*mb + C1) * (2.0*cov + C2) / ((ma*ma + mb*mb + C1) * (va + vb + C2));
}

extern "C" int32_t jxl_wasm_ssim_compare(
    const uint8_t* img1, const uint8_t* img2, uint32_t width, uint32_t height) {
  const uint32_t BLOCK = 8;
  double total = 0; uint32_t count = 0;
  for (uint32_t y = 0; y + BLOCK <= height; y += BLOCK) {
    for (uint32_t x = 0; x + BLOCK <= width; x += BLOCK) {
      total += ssim_block(img1, img2, width, height, x, y, BLOCK, BLOCK);
      count++;
    }
  }
  const float result = count > 0 ? static_cast<float>(total / count) : 1.0f;
  int32_t bits;
  memcpy(&bits, &result, 4);
  return bits;
}
```

- [ ] **Step B2: Verify bridge.cpp compiles locally (dry-run)**

```powershell
# Quick syntax check — bridge.cpp isn't a standalone; look for obvious brace errors
Select-String -Path "packages/jxl-wasm/src/bridge.cpp" -Pattern "jxl_wasm_butteraugli_ref_create|jxl_wasm_psnr_compare|jxl_wasm_ssim_compare" | Select-Object LineNumber, Line
```

Expected: 3 matches — the function definitions you just added.

- [ ] **Step B3: Commit bridge.cpp changes**

```powershell
git add packages/jxl-wasm/src/bridge.cpp
git commit -m "feat(bridge): ref-cached butteraugli + PSNR + SSIM C++ bridge fns (B2/B3/B4)"
```

---

## Task C: Rebuild WASM (Emscripten)

**Files:** No source changes — rebuilds `web/pkg` / jxl-wasm dist artifacts.

- [ ] **Step C1: Run Emscripten build**

```powershell
cmd /c "call C:\Users\User\emsdk\emsdk_env.bat >nul && node packages/jxl-wasm/scripts/build.mjs --host-toolchain"
```

Expected: Emscripten build completes, new `jxl-core.simd.js` / `.wasm` in dist (or web/pkg, check build output for output path).

If build fails, check `build.mjs` output path and error. The pre-existing WASM binary in `web/pkg` is the shipped binary; the build script may write to a separate dist dir. Inspect the output path before assuming success.

- [ ] **Step C2: Verify new exports present in output JS**

```powershell
Select-String -Path "web/pkg/jxl-core.simd.js" -Pattern "butteraugli_ref_create|psnr_compare|ssim_compare"
```

If the output path differs (check build output), adjust the path above. Expected: 3 symbol matches.

- [ ] **Step C3: Commit rebuilt WASM artifacts**

```powershell
git add web/pkg/
git commit -m "build(wasm): rebuild with ref-cached butteraugli + PSNR + SSIM bridge fns"
```

---

## Task D: Wire New Bridge into facade.ts

**Files:**
- Modify: `packages/jxl-wasm/src/facade.ts`

> **Goal:** (1) Add `ButteraugliComparatorV2` using ref-cached C++ API. (2) Add `computePsnrWasm`, `computeSsimWasm`. (3) Upgrade existing `ButteraugliComparator.compare()` to use ref-cached path when `jxl_wasm_butteraugli_ref_create` is available.

- [ ] **Step D1: Read existing ButteraugliComparator in facade.ts (lines 683–733)**

Confirm the class structure hasn't changed: `refPtr` field, `static async create()`, `compare()`, `dispose()`.

- [ ] **Step D2: Add ref-cached state to ButteraugliComparator**

Replace the class (facade.ts ~line 683–733) with this upgraded version:

```typescript
export class ButteraugliComparator {
  private refPtr = 0;       // raw pixels in WASM heap (legacy path)
  private refStatePtr = 0;  // JxlWasmButterRef* (ref-cached C++ path)

  private constructor(
    private readonly module: LibjxlWasmModule,
    private readonly width: number,
    private readonly height: number,
  ) {}

  static async create(reference: ArrayBuffer | Uint8Array, width: number, height: number): Promise<ButteraugliComparator> {
    const module = await loadLibjxlModule();
    if (!module._jxl_wasm_butteraugli_compare && !module._jxl_wasm_butteraugli_ref_create) {
      throw new CapabilityMissing("Butteraugli comparator requires a rebuilt WASM with butteraugli bridge");
    }
    const pixelSize = butteraugliPixelSize(reference, width, height, "ButteraugliComparator.create");
    const comparator = new ButteraugliComparator(module, width, height);
    const view = copyOrBorrowInput(reference, false);

    // Prefer ref-cached path (B2) — only builds test Image3F per compare call.
    if (typeof (module as any)._jxl_wasm_butteraugli_ref_create === "function") {
      const ptr = mallocOrThrow(module, pixelSize, "Butteraugli ref pixels temp");
      try {
        module.HEAPU8.set(view.subarray(0, pixelSize), ptr);
        comparator.refStatePtr = (module as any)._jxl_wasm_butteraugli_ref_create(ptr, width, height);
        if (comparator.refStatePtr === 0) throw new Error("jxl_wasm_butteraugli_ref_create failed (OOM)");
      } finally {
        module._free(ptr);
      }
    } else {
      // Legacy single-shot path: keep ref pixels in WASM heap.
      comparator.refPtr = mallocOrThrow(module, pixelSize, "Butteraugli reference");
      try {
        module.HEAPU8.set(view.subarray(0, pixelSize), comparator.refPtr);
      } catch (error) {
        comparator.dispose();
        throw error;
      }
    }
    return comparator;
  }

  compare(candidate: ArrayBuffer | Uint8Array): number {
    if (this.refStatePtr === 0 && this.refPtr === 0) {
      throw new Error("ButteraugliComparator has been disposed");
    }
    const pixelSize = butteraugliPixelSize(candidate, this.width, this.height, "ButteraugliComparator.compare");
    const ptr = mallocOrThrow(this.module, pixelSize, "Butteraugli candidate");
    try {
      const view = copyOrBorrowInput(candidate, false);
      this.module.HEAPU8.set(view.subarray(0, pixelSize), ptr);
      if (this.refStatePtr !== 0) {
        // Ref-cached path: only test Image3F built in C++.
        const bits = (this.module as any)._jxl_wasm_butteraugli_ref_compare(this.refStatePtr, ptr);
        if (bits < 0) throw new Error("Butteraugli WASM compare failed");
        return floatFromI32Bits(bits);
      } else {
        // Legacy: full double-decode per call.
        const bits = this.module._jxl_wasm_butteraugli_compare!(this.refPtr, ptr, this.width, this.height);
        if (bits < 0) throw new Error("Butteraugli WASM compare failed");
        return floatFromI32Bits(bits);
      }
    } finally {
      this.module._free(ptr);
    }
  }

  dispose(): void {
    if (this.refStatePtr !== 0) {
      (this.module as any)._jxl_wasm_butteraugli_ref_free(this.refStatePtr);
      this.refStatePtr = 0;
    }
    if (this.refPtr !== 0) {
      this.module._free(this.refPtr);
      this.refPtr = 0;
    }
  }
}
```

- [ ] **Step D3: Add computePsnrWasm and computeSsimWasm exports**

After the updated `ButteraugliComparator` class (around line 734), add:

```typescript
/**
 * WASM PSNR between two RGBA8 images. Returns dB (Infinity = identical).
 * Uses C++ bridge jxl_wasm_psnr_compare (Task B3). Falls back to null if unavailable.
 */
export async function computePsnrWasm(
  pixels1: ArrayBuffer | Uint8Array,
  pixels2: ArrayBuffer | Uint8Array,
  width: number,
  height: number,
): Promise<number | null> {
  const module = await loadLibjxlModule();
  const fn = (module as any)._jxl_wasm_psnr_compare;
  if (typeof fn !== "function") return null;
  const pixelSize = width * height * 4;
  const v1 = copyOrBorrowInput(pixels1, false);
  const v2 = copyOrBorrowInput(pixels2, false);
  const ptr1 = mallocOrThrow(module, pixelSize, "PSNR image A");
  const ptr2 = mallocOrThrow(module, pixelSize, "PSNR image B");
  try {
    module.HEAPU8.set(v1.subarray(0, pixelSize), ptr1);
    module.HEAPU8.set(v2.subarray(0, pixelSize), ptr2);
    const bits = fn(ptr1, ptr2, width, height);
    return floatFromI32Bits(bits);
  } finally {
    module._free(ptr1);
    module._free(ptr2);
  }
}

/**
 * WASM SSIM between two RGBA8 images. Returns [0,1] (1 = identical).
 * Uses C++ bridge jxl_wasm_ssim_compare (Task B4). Falls back to null if unavailable.
 */
export async function computeSsimWasm(
  pixels1: ArrayBuffer | Uint8Array,
  pixels2: ArrayBuffer | Uint8Array,
  width: number,
  height: number,
): Promise<number | null> {
  const module = await loadLibjxlModule();
  const fn = (module as any)._jxl_wasm_ssim_compare;
  if (typeof fn !== "function") return null;
  const pixelSize = width * height * 4;
  const v1 = copyOrBorrowInput(pixels1, false);
  const v2 = copyOrBorrowInput(pixels2, false);
  const ptr1 = mallocOrThrow(module, pixelSize, "SSIM image A");
  const ptr2 = mallocOrThrow(module, pixelSize, "SSIM image B");
  try {
    module.HEAPU8.set(v1.subarray(0, pixelSize), ptr1);
    module.HEAPU8.set(v2.subarray(0, pixelSize), ptr2);
    const bits = fn(ptr1, ptr2, width, height);
    return floatFromI32Bits(bits);
  } finally {
    module._free(ptr1);
    module._free(ptr2);
  }
}
```

- [ ] **Step D4: Run TypeScript type-check**

```powershell
npx tsc --noEmit -p packages/jxl-wasm/tsconfig.json
```

Expected: 0 errors. If errors in `_jxl_wasm_butteraugli_ref_create` casts, they're expected — the module interface doesn't declare the new symbols yet. The `as any` casts handle this.

- [ ] **Step D5: Commit facade.ts changes**

```powershell
git add packages/jxl-wasm/src/facade.ts
git commit -m "feat(facade): ButteraugliComparator ref-cached path + computePsnrWasm/computeSsimWasm (D2/D3/D4)"
```

---

## Task E: Add buildSeriesAsync to byte-metrics.js

**Files:**
- Modify: `web/jxl-progressive-byte-metrics.js`
- Modify: `web/jxl-progressive-byte-metrics.test.js`

> **Goal:** Export `buildSeriesAsync` which accepts a pre-inited `ButteraugliComparator` instance (from facade.ts, async-created once per ref image). Falls back to sync `createButteraugliComparer` (JS) if comparator not provided. Existing `buildSeries` stays unchanged for backwards compat.

- [ ] **Step E1: Write failing test**

Add to `web/jxl-progressive-byte-metrics.test.js`:

```js
test('buildSeriesAsync accepts prebuilt comparator and produces same shape as buildSeries', async () => {
  const ref = new Uint8Array(16).fill(128);
  const cuts = [new Uint8Array(16).fill(128), new Uint8Array(16).fill(100)];
  const bytes = [1000, 5000];
  // Pass a fake comparator duck-typed to ButteraugliComparator interface
  const fakeComparator = { compare: (p) => 0.42 };
  const { buildSeriesAsync } = await import('./jxl-progressive-byte-metrics.js');
  const built = await buildSeriesAsync(ref, cuts, bytes, 2, 2, { comparator: fakeComparator });
  expect(built.butterSeries.length).toBe(2);
  expect(built.butterSeries[0].butter).toBe(0.42); // from fakeComparator
  expect(built.qualitySeries[0].psnr).toBe(Infinity); // identical
});
```

- [ ] **Step E2: Run test to verify fail**

```powershell
bun test web/jxl-progressive-byte-metrics.test.js --test-name-pattern "buildSeriesAsync"
```

Expected: FAIL — `buildSeriesAsync is not a function`.

- [ ] **Step E3: Implement buildSeriesAsync in byte-metrics.js**

Add after the existing `buildSeries` function (end of file, before trailing newlines):

```js
/**
 * Async version of buildSeries. Accepts a pre-inited comparator (e.g. ButteraugliComparator
 * from facade.ts) to reuse ref-cached WASM state across calls. Falls back to JS
 * createButteraugliComparer if opts.comparator not provided.
 *
 * opts.comparator: object with .compare(testPixels: Uint8Array) -> number
 * opts.psnrFn: async (test, ref, w, h) -> number | null  — WASM PSNR if available
 * opts.ssimFn: async (test, ref, w, h) -> number | null  — WASM SSIM if available
 * opts.postDecodeTransform: same as buildSeries
 */
export async function buildSeriesAsync(refPixels, cutoffPixelsList, byteSizes, width, height, opts = {}) {
  if (!Array.isArray(cutoffPixelsList) || !Array.isArray(byteSizes) || cutoffPixelsList.length !== byteSizes.length) {
    throw new Error('cutoffPixelsList and byteSizes must be parallel arrays');
  }
  const n = width * height;
  if (!n || refPixels.length !== n * 4) return { qualitySeries: [], butterSeries: [], ssimSeries: [], timing: { psnrMs: 0, butterMs: 0, ssimMs: 0, totalMs: 0 } };

  performance.mark('buildSeriesAsync-start');
  const cmp = opts.comparator ?? createButteraugliComparer(refPixels, width, height);
  const { postDecodeTransform = null, psnrFn = null, ssimFn = null } = opts;
  const qualitySeries = [], butterSeries = [], ssimSeries = [];
  const timing = { psnrMs: 0, butterMs: 0, ssimMs: 0, totalMs: 0 };

  for (let i = 0; i < cutoffPixelsList.length; i++) {
    let p = cutoffPixelsList[i];
    const b = byteSizes[i];
    if (!p || p.length !== n * 4) continue;
    if (postDecodeTransform) {
      const transformed = postDecodeTransform(p, { bytes: b, width, height, index: i, layer: i >> 1 });
      if (transformed && transformed.length === p.length) p = transformed;
    }
    let t = performance.now();
    const currentPsnr = psnrFn ? (await psnrFn(p, refPixels, width, height) ?? computePsnrVsFinal(p, refPixels)) : computePsnrVsFinal(p, refPixels);
    timing.psnrMs += performance.now() - t;

    const prevPsnr = qualitySeries.length > 0 ? qualitySeries[qualitySeries.length - 1].psnr : null;
    const psnrDelta = prevPsnr != null ? Math.abs(currentPsnr - prevPsnr) : Infinity;
    const doFull = (i % 2 === 0) || (b > 100 * 1024) || psnrDelta > 0.5;
    qualitySeries.push({ bytes: b, psnr: currentPsnr });

    t = performance.now();
    butterSeries.push({ bytes: b, butter: doFull ? cmp.compare ? cmp.compare(p) : cmp(p) : null });
    timing.butterMs += performance.now() - t;

    t = performance.now();
    const currentSsim = ssimFn ? (await ssimFn(p, refPixels, width, height) ?? computeSsimVsFinal(p, refPixels, width, height)) : computeSsimVsFinal(p, refPixels, width, height);
    timing.ssimMs += performance.now() - t;
    ssimSeries.push({ bytes: b, ssim: currentSsim });
  }
  performance.measure('buildSeriesAsync', 'buildSeriesAsync-start');
  timing.totalMs = timing.psnrMs + timing.butterMs + timing.ssimMs;
  return { qualitySeries, butterSeries, ssimSeries, timing };
}
```

Note: `cmp.compare ? cmp.compare(p) : cmp(p)` handles both `ButteraugliComparator` (method) and the JS `createButteraugliComparer` return value (function).

- [ ] **Step E4: Run tests**

```powershell
bun test web/jxl-progressive-byte-metrics.test.js
```

Expected: 17/17 pass (all 16 original + 1 new).

- [ ] **Step E5: Commit**

```powershell
git add web/jxl-progressive-byte-metrics.js web/jxl-progressive-byte-metrics.test.js
git commit -m "feat(metrics): buildSeriesAsync with pre-inited ButteraugliComparator + WASM PSNR/SSIM hooks (E)"
```

---

## Task F: Wire buildSeriesAsync into paint.js

**Files:**
- Modify: `web/jxl-progressive-paint.js`

> **Goal:** (1) Import `buildSeriesAsync` and `ButteraugliComparator` (from `@casabio/jxl-wasm`). (2) Pre-init `ButteraugliComparator` once when ref pixels are known (after final JXL decode event). (3) Call `buildSeriesAsync` in the byte-cutoff probe flow. (4) Dispose old comparator when source changes.

- [ ] **Step F1: Read current paint.js imports and buildByteCutoffSeries call sites**

Grep for `buildSeries` in paint.js:
```powershell
Select-String -Path "web/jxl-progressive-paint.js" -Pattern "buildSeries|comparator|ButteraugliComparator" | Select-Object LineNumber, Line
```

Find the section where `buildSeries` is currently called (likely inside `runByteCutoffProbe` or the paint callback).

- [ ] **Step F2: Add import + module-level comparator state**

At top of file, add to existing imports:
```js
import { buildSeriesAsync } from './jxl-progressive-byte-metrics.js';
import { ButteraugliComparator } from '@casabio/jxl-wasm';
```

Add to the module-level state vars block (near `_sourcePreviewCache`):
```js
let _butterComparator = null;    // ButteraugliComparator | null — per ref image
let _butterComparatorRef = null; // identity key — Uint8Array of ref pixels
```

- [ ] **Step F3: Dispose old comparator when source changes**

In `loadFiles` and `loadRandomImages` (where `_sourcePreviewCache = null` already exists), add:
```js
if (_butterComparator) { _butterComparator.dispose(); _butterComparator = null; }
_butterComparatorRef = null;
```

- [ ] **Step F4: Lazily init comparator from final frame pixels**

In the byte-cutoff probe flow (where `runByteCutoffProbe` has ref pixels from the final decode), add before the `buildSeries` call:

```js
// Lazily init WASM butteraugli comparator once per ref image identity.
if (!_butterComparator || _butterComparatorRef !== refPixels) {
  _butterComparatorRef = refPixels;
  _butterComparator = null; // reset until create resolves
  ButteraugliComparator.create(refPixels, width, height)
    .then(cmp => { _butterComparator = cmp; })
    .catch(err => console.warn('[ProgressivePaint] ButteraugliComparator init failed:', err));
}
```

- [ ] **Step F5: Replace buildSeries call with buildSeriesAsync**

Find the existing `buildSeries(...)` call in paint.js and replace with:
```js
const { qualitySeries, butterSeries, ssimSeries, timing } = await buildSeriesAsync(
  refPixels, cutoffPixelsList, byteSizes, width, height,
  { comparator: _butterComparator ?? undefined }
);
```

If `_butterComparator` is null (still initializing), this falls back to JS `createButteraugliComparer`. On the next probe call it will have the WASM comparator ready.

- [ ] **Step F6: Verify paint.js in browser (or note UI-only)**

This is browser UI code. Type check only:
```powershell
# paint.js is plain JS — no tsc. Check no import errors in browser console.
# If dev server available: open index.html, check console for import errors.
echo "Browser-only: verify in browser console after dev server start"
```

- [ ] **Step F7: Commit**

```powershell
git add web/jxl-progressive-paint.js
git commit -m "feat(paint): pre-init ButteraugliComparator + buildSeriesAsync wiring (F)"
```

---

## Task G: Re-run Flip-flop Benchmark

**Files:**
- Modify: `benchmark/metrics-flipflop.mjs` (add WASM ref-cached variant)

- [ ] **Step G1: Add ref-cached WASM variant to benchmark**

In `benchmark/metrics-flipflop.mjs`, after the existing WASM single-shot trial, add:

```js
// Ref-cached WASM path (Task D2 — jxl_wasm_butteraugli_ref_compare)
let wasmRefCachedResult = null;
try {
  const facade2 = await import('../packages/jxl-wasm/dist/facade.js').catch(() => null)
    || await import('@casabio/jxl-wasm').catch(() => null);
  if (facade2 && facade2.ButteraugliComparator) {
    const cmpV2 = await facade2.ButteraugliComparator.create(ref, W, H);
    // Warm up to load module
    for (let i = 0; i < WARMUP; i++) for (const c of cuts) cmpV2.compare(c);
    wasmRefCachedResult = runTrials('WASM ButteraugliComparator (ref-cached C++ path B2)', () => {
      for (let i = 0; i < cuts.length; i++) {
        computePsnrVsFinal(cuts[i], ref);
        cmpV2.compare(cuts[i]);
        computeSsimVsFinal(cuts[i], ref, W, H);
      }
    }, 0, TRIALS); // already warmed up
    cmpV2.dispose();
  }
} catch (e) {
  console.log('WASM ref-cached trial skipped:', e.message);
}

if (wasmRefCachedResult) {
  const ratio2 = jsResult.mean / wasmRefCachedResult.mean;
  console.log(`Speedup ref-cached (JS/WASM-ref): ${ratio2.toFixed(2)}× — ${ratio2 > 1 ? 'WASM faster' : 'JS faster'}`);
}
```

- [ ] **Step G2: Run post-optimization benchmark**

```powershell
bun benchmark/metrics-flipflop.mjs
```

Expected speedup for ref-cached WASM butteraugli vs JS: 2–4× on 512×512 (WASM butteraugli is AVX2-vectorized by Emscripten -O3; JS XYB pyramid is scalar).

- [ ] **Step G3: Record results in plan**

Post-optimization results (fill in):  
JS mean = ___ ms  
WASM single-shot mean = ___ ms  
WASM ref-cached mean = ___ ms  
Speedup (JS → WASM-ref): ___×

- [ ] **Step G4: Commit updated benchmark**

```powershell
git add benchmark/metrics-flipflop.mjs
git commit -m "bench: update metrics-flipflop with ref-cached WASM variant (G)"
```

---

## Task H: streamIntoDecoder True Byte-Stepping (paint.js)

**Files:**
- Modify: `web/jxl-progressive-paint.js`

> **This task is independent of Tasks B-G.** `streamIntoDecoder` currently pushes full JXL bytes in one shot; `splitEncodedBytesIntoSteps` exists but is never called. True byte-stepping would make the probe reflect real network progressive delivery. Gate behind existing `byteCutoffEnabled` flag or a new checkbox.

- [ ] **Step H1: Find streamIntoDecoder and splitEncodedBytesIntoSteps in paint.js**

```powershell
Select-String -Path "web/jxl-progressive-paint.js" -Pattern "streamIntoDecoder|splitEncodedBytesIntoSteps" | Select-Object LineNumber, Line
```

- [ ] **Step H2: Wire splitEncodedBytesIntoSteps into probe flow**

In the byte-cutoff probe section of `runByteCutoffProbe`, replace the `streamIntoDecoder` call with:

```js
// True byte-stepping: push JXL bytes progressively up to each cutoff
const steps = splitEncodedBytesIntoSteps(jxlBytes, cutoffPlan);
for (const step of steps) {
  await decoder.push(step.bytes);
  // collect events at each cutoff
}
```

Exact replacement depends on current paint.js structure. Read lines around the `streamIntoDecoder` call before editing. The `splitEncodedBytesIntoSteps` signature from `jxl-byte-cutoff-probe.js` should match the cutoff plan.

> **Note:** If `splitEncodedBytesIntoSteps` requires `stepCount` that matches `cutoffPlan.steps`, ensure the plan and the step list are consistent. If the current probe already uses the cutoff plan directly, this step may be simpler.

- [ ] **Step H3: Test in browser**

Load a JXL file in the progressive paint UI. Observe that cutoff probe shows different frames at different byte sizes (vs all-or-nothing with one-shot push).

- [ ] **Step H4: Commit**

```powershell
git add web/jxl-progressive-paint.js
git commit -m "fix(paint): streamIntoDecoder true byte-stepping via splitEncodedBytesIntoSteps (H)"
```

---

## Post-Completion Verification

- [ ] Run full test suite:
  ```powershell
  bun test web/jxl-progressive-byte-metrics.test.js
  ```
  Expected: 17/17 pass.

- [ ] Run StandardMultifileTest (pre-existing WASM binary failure is known-unrelated):
  ```powershell
  node "C:\Foo\raw-converter-wasm\StandardMultifileTest.mjs"
  ```
  Expected: same pass/fail ratio as baseline (JS test changes don't affect it; WASM binary failure pre-exists).

- [ ] Rename this document:
  Rename `docs/superpowers/plans/2026-06-14-max-perf-facade-metrics.md` → `docs/superpowers/plans/2026-06-14-max-perf-facade-metrics - DONE.md`

---

## Implemented (fill in as tasks complete)

_This section to be appended by the implementing agent._

---

## Key Decision Log

| Decision | Reason |
|----------|--------|
| Keep JS `computePsnrVsFinal`/`computeSsimVsFinal` as fallback | V8 JIT optimizes tight loops well; WASM PSNR/SSIM is a bonus, not a blocker |
| Ref-cached C++ butteraugli over single-shot `ButteraugliComparator` | Existing single-shot path rebuilds ref Image3F every call — same cost as JS; ref-cached avoids it |
| `buildSeriesAsync` as new export, not modifying `buildSeries` | Backwards compat; paint.js callers opt-in; JS fallback preserved |
| Lazy `ButteraugliComparator` init in paint.js | Async init on first probe; subsequent probes benefit; no blocking of paint flow |
| Adaptive butteraugli skip stays (psnrDelta < 0.5dB) | Saves 30–50% butter calls; still applies with WASM path |
