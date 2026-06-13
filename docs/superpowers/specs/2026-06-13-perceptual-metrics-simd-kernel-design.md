# Shared SIMD Perceptual-Metrics Kernel — Design

**Date:** 2026-06-13
**Status:** Approved (brainstorm) — pending spec review → implementation plan
**Author:** David (with Claude)

## 1. Goal

Replace the JS perceptual-metrics path (`web/jxl-butteraugli.js`,
`web/jxl-progressive-quality.js`) with a single Rust SIMD kernel in the shared
`raw-pipeline` crate, compiled two ways:

- **Browser**: wasm-bindgen + `wasm32` v128 SIMD (the chart / byte-cutoff worker).
- **Native (Tauri / Node server ingest)**: `x86_64` AVX2+FMA (and AVX-512 where
  present), runtime-dispatched.

Optimize for **throughput at scale** (millions of images). Every % is real money.
Implementation cost is not a constraint; correctness, max speed, and a
hardware-aware selection mechanism are the priorities.

### Metrics in scope (all three)

| Metric | Current cost (1 MP, this machine) | Shape |
|--------|-----------------------------------|-------|
| Butteraugli (approx) | 333 ms / 4 passes (~83 ms/pass) — **62%** | XYB + box blur + 3-scale p-norm(p=3) |
| SSIM (global moments) | 120 ms / 4 passes | 5 deinterleaved sums per channel |
| PSNR (MSE) | 58 ms / 4 passes | sum of squared byte diffs |

`computeChannelMoments` (per-channel mu/var feature side-output) is ported too —
it shares the SSIM reduction.

## 2. Constraints

- **Browser path is mandatory** — pure-web viewer must work. WASM only (no native
  addon in browser).
- Shared core: `crates/raw-pipeline` already consumed by both the wasm crate
  (`raw-converter-wasm`, `default-features=false`) and Tauri
  (`../raw-converter-tauri/src-tauri`, `features=["simd","jxl-lowlevel","jxl-encode"]`
  + rayon). Add the kernel there — both targets inherit it with no duplication.
- Butteraugli here is a **heuristic perceptual score, not libjxl ground truth**.
  The real `jxl_wasm_butteraugli_compare` (libjxl `ButteraugliInterfaceInPlace`)
  already exists for calibration; it is a *fidelity* tool, slower per call, and is
  out of scope. This kernel is the fast approximation used for many-passes-per-ref
  chart / byte-cutoff sweeps.

## 3. Parity decision (locked)

**Rust kernel becomes the source of truth.** SIMD reassociates the p-norm /
moment reductions → not bit-identical to current JS (existing bench gate is 1e-6).
For a heuristic score this is acceptable.

- `simd/scalar.rs` (portable Rust) is the **parity oracle**.
- SIMD paths are tested against the scalar oracle at **≤1e-4 relative**
  (reassociation tolerance).
- Rust scalar is cross-checked against current JS at **≤1e-3 relative** on the
  synthetic bench workload (port-fidelity gate), then the JS↔kernel gate in
  `benchmark/metrics-micro-bench.mjs` is relaxed from 1e-6 to **1e-3**.

## 4. Architecture

### 4.1 Module layout (`crates/raw-pipeline/src/perceptual/`)

```
perceptual/
  mod.rs          // public API: Comparer, Metrics, Opts, select_backend()
  xyb.rs          // RGBA u8 -> planar X/Y/B f32 (sqrt-linear LUT)
  blur.rs         // separable box blur (mask), clamp-to-edge
  butteraugli.rs  // scaleErr + 3-scale pyramid combine
  ssim.rs         // global moment SSIM + channel moments
  psnr.rs         // MSE -> dB
  simd/
    mod.rs        // Backend trait + dispatch table + flip-flop registry
    scalar.rs     // portable reference (parity oracle + universal fallback)
    wasm.rs       // core::arch::wasm32 v128 — Path A (strict) + Path B (relaxed)
    avx2.rs       // core::arch::x86_64 AVX2+FMA — Path A + Path B (rsqrt)
    avx512.rs     // optional f32x16 path, cfg + runtime-gated
```

### 4.2 Public API

```rust
pub struct Opts {
    pub weights: [f32; 3],          // default [4,2,1]
    pub k: Kweights,                // kX=24, kY=12, kB=4
    pub backend: BackendChoice,     // Auto | ForceScalar | Force(id)  (for flip-flop)
}

pub struct Metrics { pub butteraugli: f32, pub ssim: f32, pub psnr: f32,
                     pub moments: ChannelMoments }

pub struct Comparer { /* ref XYB pyramid + ref Y masks + ref SSIM/PSNR partial
                         sums + reusable test-side scratch + chosen backend */ }

impl Comparer {
    pub fn new(ref_rgba: &[u8], w: usize, h: usize, opts: Opts) -> Self;
    pub fn butteraugli(&mut self, test_rgba: &[u8]) -> f32;
    pub fn ssim(&self, test_rgba: &[u8]) -> f32;
    pub fn psnr(&self, test_rgba: &[u8]) -> f32;
    /// FUSED: single deinterleave pass feeds XYB conversion + SSIM + PSNR.
    pub fn all(&mut self, test_rgba: &[u8]) -> Metrics;
}
```

**Precompute in `new()`** (constant per reference, the chart runs many tests/ref):
ref XYB 3-scale pyramid, ref-Y box-blur masks per scale, ref SSIM sums
(`sumB`, `sumBB` per channel), ref PSNR baseline. Matches existing `prepRef`
WeakMap intent but owned by the struct.

**`all()` fusion** is the throughput win: each test RGBA pixel is read **once**
and drives XYB (→butteraugli), the SSIM cross/auto moments, and the PSNR squared
diff simultaneously — one memory-bandwidth pass instead of three.

### 4.3 Browser binding + zero-copy heap (`raw-converter-wasm/src/lib.rs`)

```rust
#[wasm_bindgen]
pub struct PerceptualComparer { inner: Comparer, in_ptr: *mut u8, in_cap: usize }

#[wasm_bindgen]
impl PerceptualComparer {
    #[wasm_bindgen(constructor)]
    pub fn new(ref_rgba: &[u8], w: usize, h: usize) -> PerceptualComparer;
    /// Grow-only input buffer in wasm heap; JS writes RGBA into HEAPU8 at ptr.
    pub fn input_ptr(&mut self, len: usize) -> *mut u8;
    pub fn all_at(&mut self) -> JsValue;   // {butteraugli, ssim, psnr, moments}
    pub fn butteraugli(&mut self, test: &[u8]) -> f32; // convenience (copying) path
}
```

Zero-copy contract mirrors `packages/jxl-wasm/src/facade.ts`: JS calls
`input_ptr(len)` → writes pixels straight into the returned heap view → calls
`all_at()`. Eliminates the per-call 3× `Float32Array(n)` JS allocations
(~12 MB/MP GC churn) and avoids a redundant ArrayBuffer copy.

### 4.4 Native binding (Tauri / bench)

Direct Rust API; no wrapper. Tauri batch ingest already rayon-parallel across
images — it calls `Comparer::all()` per image inside its existing pool.

## 5. SIMD strategy — hand intrinsics per arch (locked choice)

Hand-written `core::arch` intrinsics (not `std::simd`, not `wide`) for max control.
`scalar.rs` is the portable oracle/fallback.

### 5.1 Hot kernels

- **xyb deinterleave**: RGBA u8 → planar f32 via sqrt-linear LUT. SIMD gather is
  the bottleneck; vectorize the post-LUT arithmetic (`(r-b)*0.5`, `(r+b)*0.5+g`)
  and the RGBA→planar shuffle.
- **scaleErr** (butteraugli inner loop, dominant): per pixel
  `e = (rC - tC) * inv_m; e2 = kX·ex² + kY·ey² + kB·eb²; sum += e2·sqrt(e2)`.
  Vectorize across 4 (wasm) / 8 (avx2) / 16 (avx512) pixels. `inv_m` precomputed
  reciprocal (kills 3 divides/px). p-norm uses `f32x4.sqrt` / `_mm256_sqrt_ps`.
- **ssim/psnr**: deinterleaved horizontal reductions — straightforward wide
  accumulate + final horizontal sum.

### 5.2 Two competing pathways per runtime (flip-flop 10× selection)

The hot kernel ships **two candidate vector implementations per arch**, A/B-selected
by the project's standard 10× flip-flop benchmark (alternate A,B,A,B… to cancel
thermal/scheduler noise; accept the faster **only if it clears the noise margin**,
else keep the simpler — the established "dead tie → reject" rule). The loser is
retained behind a feature flag (cheap re-bench), not deleted.

| Runtime | Path A | Path B |
|---------|--------|--------|
| wasm32  | v128 strict: full `f32x4.sqrt`, `mul`+`add` | relaxed-simd: `f32x4.relaxed_madd` (FMA) + reciprocal-estimate+Newton for `/m`, `rsqrt`+refine for p-norm |
| x86_64  | AVX2: `f32x8`, `_mm256_sqrt_ps`, `_mm256_fmadd_ps` | AVX2+`_mm256_rsqrt_ps`+Newton; **AVX-512 `f32x16`** variant when `avx512f` detected |

The flip-flop harness lives at `benchmark/perceptual-flipflop.mjs` (wasm) and
`crates/raw-pipeline/benches/perceptual_flipflop.rs` (native, criterion or manual
10× alternation matching existing `bench(raw-pipeline)` style).

### 5.3 Hardware selector + fallback chain (`select_backend()`)

- **Compile-time** `cfg(target_arch)` splits wasm vs native.
- **Native runtime probe**: `is_x86_feature_detected!` → `avx512f ▸ avx2 ▸ sse2 ▸ scalar`.
  Chosen via `#[target_feature(enable=...)]` fns behind safe dispatch.
- **WASM**: build tier (simd128 on/off, driven by `jxl-capabilities`) +
  load-time relaxed-simd probe. (simd128 is a compile-time target feature; the
  no-simd tier is a separate scalar-wasm artifact, same model as jxl-core
  simd/scalar tiers.)
- **Optional one-shot micro-calibration**: at startup run both retained candidates
  on a fixed small buffer, cache the faster id. Covers CPUs where rsqrt-approx
  unpredictably wins/loses. If calibration is skipped, the static chain above is used.

## 6. Threading

Kernel is **single-thread SIMD per call**. Parallelism is **across images** at the
caller:
- Native: Tauri/Node batch ingest already rayon-parallel across images.
- Browser: the scheduler/worker pool already fans out across images/charts.

This avoids per-call sync overhead — throughput-optimal for millions of images.
`wasm-bindgen-rayon` (already a dep, `parallel-wasm` feature) is left as a lever
for single very large images; **not wired in this work**.

## 7. JS role after this work

JS metrics demoted, **not deleted**:

1. **No-WASM guard** — only essential path when WASM is disabled by CSP
   (`script-src` without `wasm-unsafe-eval`), a locked-down webview, or
   instantiation failure. Rust scalar-wasm covers no-SIMD, so this is the sole
   irreducible JS use, and it is statistically rare at scale.
2. **Dev-time differential oracle** — independent impl to catch Rust port bugs via
   cross-impl agreement; retire after the kernel is trusted.

`web/jxl-frame-stats-worker.js` selects the wasm `PerceptualComparer` when the
capability tier exposes it, else falls back to the JS functions. No public API
break.

## 8. Testing & verification

- **Rust unit tests**: each metric, scalar vs SIMD ≤1e-4 rel on random + edge
  buffers (1px, 1-wide, degenerate pyramid, all-equal, max-contrast).
- **Port-fidelity**: Rust scalar vs current JS ≤1e-3 rel on the synthetic
  `metrics-micro-bench` workload.
- **Flip-flop benches**: pick winning vector path per arch with noise margin
  reported; record verdicts in `docs/Benchmark results/` (matches existing
  practice).
- **`benchmark/metrics-micro-bench.mjs`**: extended to load the wasm pkg, report
  JS-vs-wasm timing + score parity (gate relaxed to 1e-3).
- **No regression**: `StandardMultifileTest.mjs` clean.

## 9. Success criteria

- Browser wasm128: butteraugli **≥4× faster** (≤~20 ms/pass at 1 MP); SSIM/PSNR
  ≥3×; `all()` fused path beats summed separate calls.
- Native AVX2+FMA: butteraugli **≥8×/core**, scaling ×cores across images.
- Scores within ≤1e-3 rel of the JS reference (heuristic-equivalent).
- Hardware selector picks a valid backend on AVX-512 / AVX2 / SSE / scalar / wasm
  simd128 / wasm scalar without panics; verified fallback chain.
- `StandardMultifileTest.mjs` green; flip-flop verdicts recorded.

## 10. Out of scope

- Replacing the libjxl ground-truth butteraugli bridge (different tool).
- WASM threads / `wasm-bindgen-rayon` wiring for single-image parallelism.
- GPU (WebGPU/CUDA) paths.
- Porting non-metric chart code.

## 11. Open risks

- **relaxed-simd availability**: not all wasm engines enable it; the strict v128
  Path A is the guaranteed baseline, relaxed Path B is opportunistic via probe.
- **rsqrt accuracy**: reciprocal/rsqrt+Newton must stay within the ≤1e-4 SIMD
  tolerance vs scalar; if it can't, Path B loses on parity not just speed and is
  dropped for that arch.
- **simd128 build split**: shipping a scalar-wasm tier means a second artifact;
  confirm the existing build (`packages/jxl-wasm` / `raw-converter-wasm` pkg)
  already emits simd vs scalar tiers and reuse that mechanism.
```
