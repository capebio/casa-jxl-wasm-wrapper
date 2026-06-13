# Perceptual-Metrics Kernel — Plan 2 (Browser WASM + shared SIMD headroom) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the browser path for the perceptual-metrics kernel — wasm32 v128 (+ optional relaxed-simd) SIMD, a zero-copy wasm-bindgen `PerceptualComparer`, and worker wiring — AND close the native headroom found in Plan 1 by vectorizing `pixels_to_xyb`, `downsample`, and the `1/m` reciprocal for **both** AVX2 and wasm.

**Architecture:** Plan 1 built `crates/raw-pipeline/src/perceptual/` (scalar oracle + AVX2 `scale_err`/`ssd`, runtime dispatch, `Comparer`). Plan 2 (A) adds the missing SIMD kernels (xyb gather, downsample, rcp) to AVX2 and re-benches; (B) adds `simd/wasm.rs` (v128 + relaxed) mirroring the AVX2 kernels, selected at wasm build/load time; (C) exposes `PerceptualComparer` from the `raw-converter-wasm` cdylib with a zero-copy heap input path; (D) wires the Node bench + browser worker to prefer wasm, JS as fallback. Spec: `docs/superpowers/specs/2026-06-13-perceptual-metrics-simd-kernel-design.md`. Plan 1: `docs/superpowers/plans/2026-06-13-perceptual-metrics-kernel-native.md`.

**Tech Stack:** Rust stable 1.95, `core::arch::x86_64` (AVX2) + `core::arch::wasm32` (v128 / relaxed-simd), `wasm-bindgen` 0.2, `wasm-pack` 0.14 (`--target web`), Node 20+ for parity/bench. No new crate deps.

**Why the headroom is shared:** Plan 1's AVX2 only vectorized `scale_err` → 1.83× over scalar because per-pass `pixels_to_xyb` (1 MP scalar LUT gather), `downsample` (scalar), and the per-pixel `_mm256_div_ps(1/m)` dominate (the rsqrt-vs-strict TIE proved sqrt wasn't the bottleneck). These three kernels help native and wasm equally, so they are built once per arch here.

---

## Critical environment notes (apply to every task)

- **Test invocation (native):** `raw-pipeline` is NOT a workspace member and its default features pull a heavy vendored-libjxl build. Always run from the crate dir: `cd crates/raw-pipeline && cargo test --no-default-features --lib <filter>`.
- **wasm SIMD can't be `cargo test`-ed natively.** wasm intrinsics only run in a wasm engine. Verify wasm kernels via a **Node parity harness** (Task D1) that loads the built pkg and compares against the JS reference at ≤1e-3 relative, and via `wasm-pack test --node` where noted.
- **wasm build flag:** the browser kernel needs `RUSTFLAGS="-C target-feature=+simd128"`. The shipped `raw-converter-wasm` pkg is built with `wasm-pack build --target web --out-dir pkg --release` (per CLAUDE.md). Confirm the existing build already sets `+simd128` (the demosaic wasm128 code in this crate implies it does); if not, add it via `.cargo/config.toml` `[target.wasm32-unknown-unknown] rustflags`.
- **Commits:** the repo has ~97 UNRELATED dirty files + untracked `perceptual_bench.exe` / `*_cpp_stability_bench.cpp` at repo root. NEVER `git add -A`/`.`. Always `git add <explicit paths>` and run `git status --short` to confirm before committing.
- **Parity bar:** SIMD vs scalar oracle ≤1e-4 relative (native, cargo). wasm vs JS reference ≤1e-3 relative (Node). Rust scalar vs JS ≤1e-3 (Node, Task D1) — then the JS↔kernel gate is relaxed to 1e-3.

---

# PART A — Shared SIMD headroom (native AVX2), cargo-testable

## Task A1: AVX2 `pixels_to_xyb` via gather + flip-flop-gated adoption

**Files:**
- Modify: `crates/raw-pipeline/src/perceptual/simd/avx2.rs`
- Modify: `crates/raw-pipeline/src/perceptual/xyb.rs` (expose the LUT pointer)

- [ ] **Step 1: Expose the LUT base pointer for gather**

In `crates/raw-pipeline/src/perceptual/xyb.rs`, add (the LUT is already a `&'static [f32;256]`):

```rust
/// Raw base pointer to the sqrt-linear LUT, for SIMD gather paths.
pub(crate) fn sqrt_lin_lut_ptr() -> *const f32 {
    sqrt_lin_lut().as_ptr()
}
```

- [ ] **Step 2: Write the AVX2 xyb gather + parity test**

Append to `crates/raw-pipeline/src/perceptual/simd/avx2.rs`:

```rust
/// AVX2 RGBA(u8) → planar X/Y/B using i32-gather over the sqrt-linear LUT.
/// `lut` must point to a 256-entry f32 table. Processes 8 px/iter + scalar tail.
#[target_feature(enable = "avx2")]
pub unsafe fn pixels_to_xyb_avx2(px: &[u8], n: usize, lut: *const f32, x: &mut [f32], y: &mut [f32], b: &mut [f32]) {
    let half = _mm256_set1_ps(0.5);
    let lanes = n / 8 * 8;
    let mut i = 0;
    while i < lanes {
        // Gather the 8 R/G/B bytes (stride 4) for px[i..i+8] into i32 index vectors.
        let mut ri = [0i32; 8];
        let mut gi = [0i32; 8];
        let mut bi = [0i32; 8];
        for l in 0..8 {
            let base = (i + l) * 4;
            ri[l] = *px.get_unchecked(base) as i32;
            gi[l] = *px.get_unchecked(base + 1) as i32;
            bi[l] = *px.get_unchecked(base + 2) as i32;
        }
        let r = _mm256_i32gather_ps(lut, _mm256_loadu_si256(ri.as_ptr() as *const __m256i), 4);
        let g = _mm256_i32gather_ps(lut, _mm256_loadu_si256(gi.as_ptr() as *const __m256i), 4);
        let bb = _mm256_i32gather_ps(lut, _mm256_loadu_si256(bi.as_ptr() as *const __m256i), 4);
        // X=(r-b)*0.5 ; Y=(r+b)*0.5+g ; B=b
        _mm256_storeu_ps(x.as_mut_ptr().add(i), _mm256_mul_ps(_mm256_sub_ps(r, bb), half));
        _mm256_storeu_ps(y.as_mut_ptr().add(i), _mm256_fmadd_ps(_mm256_add_ps(r, bb), half, g));
        _mm256_storeu_ps(b.as_mut_ptr().add(i), bb);
        i += 8;
    }
    // scalar tail
    let lut_s = core::slice::from_raw_parts(lut, 256);
    while i < n {
        let j = i * 4;
        let r = lut_s[px[j] as usize];
        let g = lut_s[px[j + 1] as usize];
        let bb = lut_s[px[j + 2] as usize];
        x[i] = (r - bb) * 0.5;
        y[i] = (r + bb) * 0.5 + g;
        b[i] = bb;
        i += 1;
    }
}

#[cfg(test)]
mod xyb_tests {
    use super::*;
    use crate::perceptual::xyb::{pixels_to_xyb, sqrt_lin_lut_ptr};

    #[test]
    fn xyb_avx2_matches_scalar() {
        if !(std::is_x86_feature_detected!("avx2") && std::is_x86_feature_detected!("fma")) { return; }
        let n = 1000usize; // non-multiple of 8
        let px: Vec<u8> = (0..n * 4).map(|i| (i * 37 % 256) as u8).collect();
        let (mut sx, mut sy, mut sb) = (vec![0f32; n], vec![0f32; n], vec![0f32; n]);
        pixels_to_xyb(&px, n, &mut sx, &mut sy, &mut sb);
        let (mut ax, mut ay, mut ab) = (vec![0f32; n], vec![0f32; n], vec![0f32; n]);
        unsafe { pixels_to_xyb_avx2(&px, n, sqrt_lin_lut_ptr(), &mut ax, &mut ay, &mut ab); }
        for i in 0..n {
            assert!((sx[i] - ax[i]).abs() < 1e-6, "x[{i}] {} vs {}", sx[i], ax[i]);
            assert!((sy[i] - ay[i]).abs() < 1e-6, "y[{i}] {} vs {}", sy[i], ay[i]);
            assert!((sb[i] - ab[i]).abs() < 1e-6, "b[{i}] {} vs {}", sb[i], ab[i]);
        }
    }
}
```

Make `xyb` reachable: it is already `mod xyb;` (private) in `perceptual/mod.rs` — change to `pub(crate) mod xyb;` so the avx2 test path `crate::perceptual::xyb::...` resolves.

- [ ] **Step 3: Run the parity test**

Run: `cd crates/raw-pipeline && cargo test --no-default-features --lib perceptual::simd::avx2::xyb_tests 2>&1 | tail -10`
Expected: PASS (gather output is bit-identical to scalar LUT — same f32 table values).

- [ ] **Step 4: Commit**

```bash
git add crates/raw-pipeline/src/perceptual/simd/avx2.rs crates/raw-pipeline/src/perceptual/xyb.rs crates/raw-pipeline/src/perceptual/mod.rs
git commit -m "feat(perceptual): AVX2 pixels_to_xyb via i32 gather + scalar-parity test"
```

---

## Task A2: AVX2 `downsample` (8-wide) + parity test

**Files:**
- Modify: `crates/raw-pipeline/src/perceptual/simd/avx2.rs`
- Modify: `crates/raw-pipeline/src/perceptual/mod.rs` (expose `downsample_inplace` shape for testing — or test via dn2)

- [ ] **Step 1: Write the AVX2 downsample + parity test**

The 2× box downsample reads rows `sy0`,`sy1` and averages horizontal pairs. Vectorize across 8 output px. Append to `avx2.rs`:

```rust
/// AVX2 2× box downsample of a single plane (w×h) into `dst` (dw×dh held in the
/// first dw*dh of the slice). Interior fast path 8 output px/iter; edges scalar.
#[target_feature(enable = "avx2")]
pub unsafe fn downsample_avx2(src: &[f32], dst: &mut [f32], w: usize, h: usize, dw: usize, dh: usize) {
    let quarter = _mm256_set1_ps(0.25);
    for y in 0..dh {
        let sy0 = y << 1;
        let sy1 = if sy0 + 1 < h { sy0 + 1 } else { h - 1 };
        let row0 = sy0 * w;
        let row1 = sy1 * w;
        let drow = y * dw;
        // Interior columns where sx1 = sx0+1 is in-bounds: x in 0..(dw - edge).
        // Last output col may need clamp when w is odd; handle the bulk 8-wide.
        let bulk = if w >= 2 { (dw.saturating_sub(1)) / 8 * 8 } else { 0 };
        let mut x = 0;
        while x < bulk {
            // Load 16 src floats per row starting at 2*x; deinterleave even/odd.
            let p00 = _mm256_loadu_ps(src.as_ptr().add(row0 + 2 * x));
            let p01 = _mm256_loadu_ps(src.as_ptr().add(row0 + 2 * x + 8));
            let p10 = _mm256_loadu_ps(src.as_ptr().add(row1 + 2 * x));
            let p11 = _mm256_loadu_ps(src.as_ptr().add(row1 + 2 * x + 8));
            // even lanes = sx0, odd lanes = sx1. Use shuffle to split.
            // even = [0,2,4,6,8,10,12,14], odd = [1,3,...,15] across the 16 floats.
            let r0_even = _mm256_shuffle_ps::<0b10_00_10_00>(p00, p01); // approx; corrected below
            let _ = (p10, p11, r0_even); // placeholder removed in real impl
            // NOTE: the lane-correct split is implemented via permutevar; see Step 1b.
            let sum = _mm256_setzero_ps();
            _mm256_storeu_ps(dst.as_mut_ptr().add(drow + x), _mm256_mul_ps(sum, quarter));
            x += 8;
        }
        // scalar remainder + clamped last column
        let mut xs = bulk;
        while xs < dw {
            let sx0 = xs << 1;
            let sx1 = if sx0 + 1 < w { sx0 + 1 } else { w - 1 };
            dst[drow + xs] = (src[row0 + sx0] + src[row0 + sx1] + src[row1 + sx0] + src[row1 + sx1]) * 0.25;
            xs += 1;
        }
    }
}
```

> **Implementation guidance (Step 1b):** the even/odd deinterleave of 16 contiguous floats into two 8-lane vectors (sx0 lanes, sx1 lanes) is the crux. Use `_mm256_permutevar8x32_ps` with index vectors, or `_mm256_shuffle_ps` + `_mm256_permute2f128_ps`, to produce `even = [s0,s2,...,s14]` and `odd = [s1,s3,...,s15]`. Then `sum = (even_row0 + odd_row0) + (even_row1 + odd_row1)`. The implementer MUST replace the placeholder `sum`/`r0_even` lines with the lane-correct deinterleave and verify against the scalar parity test below. If the 8-wide deinterleave proves not faster than scalar in the flip-flop (Task A4), fall back to keeping `downsample` scalar and delete this fn — record the decision.

- [ ] **Step 2: Parity test**

Append to `avx2.rs` (new test module or extend `xyb_tests`):

```rust
#[cfg(test)]
mod downsample_tests {
    use super::*;
    use crate::perceptual::butteraugli::dn2;

    #[test]
    fn downsample_avx2_matches_dn2() {
        if !std::is_x86_feature_detected!("avx2") { return; }
        for (w, h) in [(64usize, 48usize), (65, 49), (2, 2), (33, 17)] {
            let src: Vec<f32> = (0..w * h).map(|i| (i as f32 * 0.013).sin()).collect();
            let (want, dw, dh) = dn2(&src, w, h);
            let mut got = vec![0f32; dw * dh];
            unsafe { downsample_avx2(&src, &mut got, w, h, dw, dh); }
            for i in 0..dw * dh {
                assert!((want[i] - got[i]).abs() < 1e-5, "({w}x{h})[{i}] {} vs {}", want[i], got[i]);
            }
        }
    }
}
```

- [ ] **Step 3: Run**

Run: `cd crates/raw-pipeline && cargo test --no-default-features --lib perceptual::simd::avx2::downsample_tests 2>&1 | tail -12`
Expected: PASS for all four dim cases (including odd w/h edge clamps).

- [ ] **Step 4: Commit**

```bash
git add crates/raw-pipeline/src/perceptual/simd/avx2.rs
git commit -m "feat(perceptual): AVX2 2x box downsample (8-wide interior, scalar edges)"
```

---

## Task A3: AVX2 `scale_err` reciprocal variant (`rcp` for 1/m)

**Files:**
- Modify: `crates/raw-pipeline/src/perceptual/simd/avx2.rs`

- [ ] **Step 1: Replace the `1/m` divide with `rcp`+Newton in the rsqrt path**

The existing `scale_err_avx2(..., rsqrt_path: bool)` uses `_mm256_div_ps(1.0, mm)` for `inv` in BOTH paths. Change so that when `rsqrt_path == true`, `inv` also uses a refined reciprocal (one Newton step), making Path B a true "all-approx" variant:

Find in `scale_err_avx2`:

```rust
        let inv = _mm256_div_ps(_mm256_set1_ps(1.0), mm);
```

Replace with:

```rust
        let inv = if rsqrt_path {
            // rcp(mm) refined: r1 = r0 * (2 - mm*r0)
            let r0 = _mm256_rcp_ps(mm);
            _mm256_mul_ps(r0, _mm256_fnmadd_ps(mm, r0, _mm256_set1_ps(2.0)))
        } else {
            _mm256_div_ps(_mm256_set1_ps(1.0), mm)
        };
```

(`_mm256_fnmadd_ps(mm, r0, 2.0) = 2 - mm*r0`, the Newton-Raphson reciprocal correction.)

- [ ] **Step 2: The existing parity test already covers this**

The Task 8 test `avx2_scale_err_matches_scalar` asserts both `false` and `true` paths within ≤1e-4 of scalar. The refined `rcp` is ~22-bit accurate — within tolerance. Run it:

Run: `cd crates/raw-pipeline && cargo test --no-default-features --lib perceptual::simd::avx2::tests::avx2_scale_err_matches_scalar 2>&1 | tail -8`
Expected: PASS (rsqrt path still ≤1e-4 with the added rcp).

- [ ] **Step 3: Commit**

```bash
git add crates/raw-pipeline/src/perceptual/simd/avx2.rs
git commit -m "feat(perceptual): AVX2 scale_err rsqrt-path also uses refined rcp for 1/m"
```

---

## Task A4: Wire xyb/downsample AVX2 into `Comparer`; re-bench; record verdict

**Files:**
- Modify: `crates/raw-pipeline/src/perceptual/mod.rs`
- Modify: `crates/raw-pipeline/examples/perceptual_flipflop.rs` (already exists)

- [ ] **Step 1: Dispatch `fill_test_xyb` and the in-place downsample to AVX2**

In `perceptual/mod.rs`, change `fill_test_xyb`:

```rust
    fn fill_test_xyb(&mut self, test: &[u8]) {
        match self.backend {
            #[cfg(target_arch = "x86_64")]
            Backend::Avx2Strict | Backend::Avx2Rsqrt => unsafe {
                simd::avx2::pixels_to_xyb_avx2(
                    test, self.n, xyb::sqrt_lin_lut_ptr(),
                    &mut self.tx, &mut self.ty, &mut self.tb,
                );
            },
            _ => xyb::pixels_to_xyb(test, self.n, &mut self.tx, &mut self.ty, &mut self.tb),
        }
    }
```

In `butteraugli()`, replace the three `downsample_inplace(...)` calls with a dispatch helper. Add:

```rust
    fn downsample_dispatch(&mut self, w: usize, h: usize, dw: usize, dh: usize) {
        let dn = dw * dh;
        match self.backend {
            #[cfg(target_arch = "x86_64")]
            Backend::Avx2Strict | Backend::Avx2Rsqrt => unsafe {
                simd::avx2::downsample_avx2(&self.tx, &mut self.dx, w, h, dw, dh);
                simd::avx2::downsample_avx2(&self.ty, &mut self.dy, w, h, dw, dh);
                simd::avx2::downsample_avx2(&self.tb, &mut self.db, w, h, dw, dh);
            },
            _ => {
                downsample_inplace(&self.tx, &mut self.dx, w, h, dw, dh);
                downsample_inplace(&self.ty, &mut self.dy, w, h, dw, dh);
                downsample_inplace(&self.tb, &mut self.db, w, h, dw, dh);
            }
        }
        self.tx[..dn].copy_from_slice(&self.dx[..dn]);
        self.ty[..dn].copy_from_slice(&self.dy[..dn]);
        self.tb[..dn].copy_from_slice(&self.db[..dn]);
    }
```

and in `butteraugli()` replace the downsample block body with:

```rust
            if s < 2 && w > 1 && h > 1 {
                let (dw, dh) = ((w >> 1).max(1), (h >> 1).max(1));
                self.downsample_dispatch(w, h, dw, dh);
                w = dw; h = dh;
            }
```

- [ ] **Step 2: Run full perceptual tests (Auto → AVX2 now covers xyb+downsample)**

Run: `cd crates/raw-pipeline && cargo test --no-default-features --lib perceptual 2>&1 | tail -20`
Expected: all pass — `identical_image_scores_perfect` and `all_matches_individual_calls` now exercise AVX2 xyb + downsample, still bit-faithful.

- [ ] **Step 3: Re-run the flip-flop bench and record**

Run: `cd /c/Foo/raw-converter-wasm && (cd crates/raw-pipeline && cargo run --release --no-default-features --example perceptual_flipflop) > "docs/Benchmark results/perceptual-flipflop-native-headroom-$(date +%Y-%m-%dT%H-%M-%S).txt" 2>&1`
Expected: avx2-strict now well above 1.83× over scalar (xyb+downsample no longer scalar). Note the new ms/pass; compare against the Plan 1 ~9.3 ms.

If `avx2-rsqrt` now beats `avx2-strict` past the noise margin (the rcp-for-1/m may tip it), promote it: change `detect_native`'s native branch to `prefer_rsqrt = true` and update the comment in `mod.rs` citing the new results file. Otherwise keep strict.

- [ ] **Step 4: Commit**

```bash
git add crates/raw-pipeline/src/perceptual/mod.rs "docs/Benchmark results/" crates/raw-pipeline/src/perceptual/simd/mod.rs
git commit -m "perf(perceptual): dispatch AVX2 xyb+downsample in Comparer; re-bench headroom"
```

---

# PART B — Browser wasm32 SIMD

## Task B1: wasm v128 `scale_err` + `pixels_to_xyb` + `downsample`

**Files:**
- Create: `crates/raw-pipeline/src/perceptual/simd/wasm.rs`
- Modify: `crates/raw-pipeline/src/perceptual/simd/mod.rs`

- [ ] **Step 1: Write the wasm v128 kernels**

Create `crates/raw-pipeline/src/perceptual/simd/wasm.rs`. Mirrors the scalar oracle; v128 is 4-wide f32. wasm SIMD has no gather, so xyb does scalar LUT loads then vector arithmetic.

```rust
//! wasm32 v128 SIMD kernels (4-wide f32). Mirrors the scalar oracle; verified
//! against the JS reference in Node (wasm intrinsics can't run under `cargo test`).
//! The whole module requires the build to enable `+simd128`.
#![cfg(target_arch = "wasm32")]

use core::arch::wasm32::*;

/// 4-wide horizontal sum.
#[inline]
fn hsum(v: v128) -> f32 {
    f32x4_extract_lane::<0>(v) + f32x4_extract_lane::<1>(v)
        + f32x4_extract_lane::<2>(v) + f32x4_extract_lane::<3>(v)
}

/// wasm v128 scale error (p=3). `relaxed` selects relaxed-simd FMA where available
/// (caller guarantees the build enables it); otherwise strict mul+add.
pub fn scale_err_wasm(
    mask: &[f32], rx: &[f32], ry: &[f32], rb: &[f32],
    tx: &[f32], ty: &[f32], tb: &[f32], n: usize,
    kx: f32, ky: f32, kb: f32,
) -> f32 {
    let vkx = f32x4_splat(kx);
    let vky = f32x4_splat(ky);
    let vkb = f32x4_splat(kb);
    let v2 = f32x4_splat(2.0);
    let v015 = f32x4_splat(0.15);
    let veps = f32x4_splat(1e-12);
    let one = f32x4_splat(1.0);
    let mut acc = f32x4_splat(0.0);
    let lanes = n / 4 * 4;
    let mut i = 0;
    unsafe {
        while i < lanes {
            let m = v128_load(mask.as_ptr().add(i) as *const v128);
            let mm = f32x4_max(f32x4_add(f32x4_mul(m, v2), v015), v015);
            let inv = f32x4_div(one, mm);
            let ex = f32x4_mul(f32x4_sub(v128_load(rx.as_ptr().add(i) as *const v128), v128_load(tx.as_ptr().add(i) as *const v128)), inv);
            let ey = f32x4_mul(f32x4_sub(v128_load(ry.as_ptr().add(i) as *const v128), v128_load(ty.as_ptr().add(i) as *const v128)), inv);
            let eb = f32x4_mul(f32x4_sub(v128_load(rb.as_ptr().add(i) as *const v128), v128_load(tb.as_ptr().add(i) as *const v128)), inv);
            let e2 = f32x4_add(f32x4_add(f32x4_mul(vkx, f32x4_mul(ex, ex)), f32x4_mul(vky, f32x4_mul(ey, ey))), f32x4_mul(vkb, f32x4_mul(eb, eb)));
            let root = f32x4_sqrt(f32x4_add(e2, veps));
            acc = f32x4_add(acc, f32x4_mul(e2, root));
            i += 4;
        }
    }
    let mut sum = hsum(acc) as f64;
    while i < n {
        let m = (mask[i] * 2.0 + 0.15).max(0.15);
        let inv = 1.0 / m;
        let ex = (rx[i] - tx[i]) * inv;
        let ey = (ry[i] - ty[i]) * inv;
        let eb = (rb[i] - tb[i]) * inv;
        let e2 = kx * ex * ex + ky * ey * ey + kb * eb * eb;
        sum += (e2 * (e2 + 1e-12).sqrt()) as f64;
        i += 1;
    }
    ((sum / n as f64).powf(1.0 / 3.0)) as f32
}

/// wasm v128 RGBA→planar XYB. Scalar LUT loads (no wasm gather) + vector arithmetic.
pub fn pixels_to_xyb_wasm(px: &[u8], n: usize, lut: &[f32; 256], x: &mut [f32], y: &mut [f32], b: &mut [f32]) {
    let half = f32x4_splat(0.5);
    let lanes = n / 4 * 4;
    let mut i = 0;
    unsafe {
        while i < lanes {
            let mut r = [0f32; 4]; let mut g = [0f32; 4]; let mut bb = [0f32; 4];
            for l in 0..4 {
                let j = (i + l) * 4;
                r[l] = lut[*px.get_unchecked(j) as usize];
                g[l] = lut[*px.get_unchecked(j + 1) as usize];
                bb[l] = lut[*px.get_unchecked(j + 2) as usize];
            }
            let rv = v128_load(r.as_ptr() as *const v128);
            let gv = v128_load(g.as_ptr() as *const v128);
            let bv = v128_load(bb.as_ptr() as *const v128);
            v128_store(x.as_mut_ptr().add(i) as *mut v128, f32x4_mul(f32x4_sub(rv, bv), half));
            v128_store(y.as_mut_ptr().add(i) as *mut v128, f32x4_add(f32x4_mul(f32x4_add(rv, bv), half), gv));
            v128_store(b.as_mut_ptr().add(i) as *mut v128, bv);
            i += 4;
        }
    }
    while i < n {
        let j = i * 4;
        let r = lut[px[j] as usize]; let g = lut[px[j + 1] as usize]; let bb = lut[px[j + 2] as usize];
        x[i] = (r - bb) * 0.5; y[i] = (r + bb) * 0.5 + g; b[i] = bb;
        i += 1;
    }
}

/// wasm v128 2× box downsample — scalar (the gather/deinterleave overhead in v128
/// rarely beats scalar at 4-wide; kept scalar unless the Node flip-flop shows a win).
pub fn downsample_wasm(src: &[f32], dst: &mut [f32], w: usize, h: usize, dw: usize, dh: usize) {
    for y in 0..dh {
        let sy0 = y << 1;
        let sy1 = (sy0 + 1).min(h - 1);
        for x in 0..dw {
            let sx0 = x << 1;
            let sx1 = (sx0 + 1).min(w - 1);
            dst[y * dw + x] = (src[sy0 * w + sx0] + src[sy0 * w + sx1] + src[sy1 * w + sx0] + src[sy1 * w + sx1]) * 0.25;
        }
    }
}
```

In `simd/mod.rs` add:

```rust
#[cfg(target_arch = "wasm32")]
pub mod wasm;
```

and extend `Backend` + `detect_native` is x86-only; add a wasm constructor:

```rust
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Backend {
    Scalar = 0,
    Avx2Strict = 1,
    Avx2Rsqrt = 2,
    WasmSimd = 3,
}

/// Backend for the current build. On wasm with simd128 we always use WasmSimd
/// (compile-time target feature); without it, Scalar.
#[cfg(target_arch = "wasm32")]
pub fn detect_wasm() -> Backend {
    #[cfg(target_feature = "simd128")]
    { Backend::WasmSimd }
    #[cfg(not(target_feature = "simd128"))]
    { Backend::Scalar }
}
```

- [ ] **Step 2: Confirm it compiles for wasm**

Run: `cd crates/raw-pipeline && RUSTFLAGS="-C target-feature=+simd128" cargo build --no-default-features --lib --target wasm32-unknown-unknown 2>&1 | tail -15`
Expected: compiles clean (no host execution). If `wasm32-unknown-unknown` target is missing: `rustup target add wasm32-unknown-unknown`.

- [ ] **Step 3: Commit**

```bash
git add crates/raw-pipeline/src/perceptual/simd/wasm.rs crates/raw-pipeline/src/perceptual/simd/mod.rs
git commit -m "feat(perceptual): wasm32 v128 scale_err + xyb + downsample kernels"
```

---

## Task B2: Wire wasm backend into `Comparer`

**Files:**
- Modify: `crates/raw-pipeline/src/perceptual/mod.rs`

- [ ] **Step 1: Resolve `WasmSimd` in `new()` and add wasm dispatch arms**

In `Comparer::new`, extend backend resolution:

```rust
        let backend = match opts.backend {
            BackendChoice::ForceScalar => Backend::Scalar,
            BackendChoice::Force(id) => match id {
                1 => Backend::Avx2Strict,
                2 => Backend::Avx2Rsqrt,
                3 => Backend::WasmSimd,
                _ => Backend::Scalar,
            },
            BackendChoice::Auto => {
                #[cfg(target_arch = "x86_64")]
                { detect_native(false) }
                #[cfg(target_arch = "wasm32")]
                { simd::detect_wasm() }
                #[cfg(not(any(target_arch = "x86_64", target_arch = "wasm32")))]
                { Backend::Scalar }
            }
        };
```

Add `#[cfg(target_arch = "wasm32")] Backend::WasmSimd => ...` arms to `scale_err_dispatch`, `fill_test_xyb`, `downsample_dispatch`, `psnr`, and `ssim`:

```rust
            // in scale_err_dispatch match:
            #[cfg(target_arch = "wasm32")]
            Backend::WasmSimd => simd::wasm::scale_err_wasm(&lvl.mask, &lvl.x, &lvl.y, &lvl.b, tx, ty, tb, cur_n, k.kx, k.ky, k.kb),
```
```rust
            // in fill_test_xyb match:
            #[cfg(target_arch = "wasm32")]
            Backend::WasmSimd => simd::wasm::pixels_to_xyb_wasm(test, self.n, xyb::sqrt_lin_lut(), &mut self.tx, &mut self.ty, &mut self.tb),
```
```rust
            // in downsample_dispatch match:
            #[cfg(target_arch = "wasm32")]
            Backend::WasmSimd => {
                simd::wasm::downsample_wasm(&self.tx, &mut self.dx, w, h, dw, dh);
                simd::wasm::downsample_wasm(&self.ty, &mut self.dy, w, h, dw, dh);
                simd::wasm::downsample_wasm(&self.tb, &mut self.db, w, h, dw, dh);
            }
```
For `psnr` and `ssim`, the wasm arm uses the scalar oracle (no wasm PSNR/SSIM SIMD in this plan — they are smaller and the deinterleave dominates): add `#[cfg(target_arch = "wasm32")] Backend::WasmSimd =>` arms that call the same code as the `_ =>` scalar arm, OR simply ensure the `_ =>` arm catches `WasmSimd` (it does, since the match arms for avx2 are cfg-gated to x86_64 — on wasm only Scalar and WasmSimd exist, and WasmSimd falls through to `_`). **Verify** the `_ =>` fallthrough handles `WasmSimd` for psnr/ssim so no arm is unreachable.

`sqrt_lin_lut()` (returning `&'static [f32;256]`) must be `pub(crate)` — confirm.

- [ ] **Step 2: Compile for both targets**

Run: `cd crates/raw-pipeline && cargo test --no-default-features --lib perceptual 2>&1 | tail -6` (native still green)
Run: `cd crates/raw-pipeline && RUSTFLAGS="-C target-feature=+simd128" cargo build --no-default-features --lib --target wasm32-unknown-unknown 2>&1 | tail -8` (wasm compiles)
Expected: native tests pass; wasm builds.

- [ ] **Step 3: Commit**

```bash
git add crates/raw-pipeline/src/perceptual/mod.rs
git commit -m "feat(perceptual): wire WasmSimd backend into Comparer dispatch"
```

---

# PART C — wasm-bindgen binding (zero-copy)

## Task C1: `PerceptualComparer` wasm-bindgen wrapper

**Files:**
- Modify: `src/lib.rs` (the `raw-converter-wasm` cdylib crate root)

- [ ] **Step 1: Add the binding**

In `C:\Foo\raw-converter-wasm\src\lib.rs`, add (uses `raw_pipeline::perceptual`):

```rust
use wasm_bindgen::prelude::*;
use raw_pipeline::perceptual::{Comparer, Opts, Metrics};

#[wasm_bindgen]
pub struct PerceptualComparer {
    inner: Comparer,
    n: usize,
    scratch: Vec<u8>, // grow-only RGBA input staging for the zero-copy path
}

#[wasm_bindgen]
impl PerceptualComparer {
    #[wasm_bindgen(constructor)]
    pub fn new(ref_rgba: &[u8], width: usize, height: usize) -> PerceptualComparer {
        let n = width * height;
        let inner = Comparer::new(ref_rgba, width, height, Opts::default());
        PerceptualComparer { inner, n, scratch: vec![0u8; n * 4] }
    }

    /// Copying convenience path: pass an RGBA slice, get all three metrics as a
    /// JS object {butteraugli, ssim, psnr}.
    pub fn all(&mut self, test_rgba: &[u8]) -> JsValue {
        let m = self.inner.all(test_rgba);
        metrics_to_js(&m)
    }

    pub fn butteraugli(&mut self, test_rgba: &[u8]) -> f32 { self.inner.butteraugli(test_rgba) }
    pub fn ssim(&self, test_rgba: &[u8]) -> f32 { self.inner.ssim(test_rgba) }
    pub fn psnr(&self, test_rgba: &[u8]) -> f32 { self.inner.psnr(test_rgba) }
}

fn metrics_to_js(m: &Metrics) -> JsValue {
    let o = js_sys::Object::new();
    let _ = js_sys::Reflect::set(&o, &"butteraugli".into(), &JsValue::from_f64(m.butteraugli as f64));
    let _ = js_sys::Reflect::set(&o, &"ssim".into(), &JsValue::from_f64(m.ssim as f64));
    let _ = js_sys::Reflect::set(&o, &"psnr".into(), &JsValue::from_f64(m.psnr as f64));
    o.into()
}
```

If `src/lib.rs` already has `use wasm_bindgen::prelude::*;`, do not duplicate it. Confirm `js-sys` is a dependency (it is, per root Cargo.toml).

- [ ] **Step 2: Build the wasm package**

Run: `wasm-pack build --target web --out-dir pkg --release 2>&1 | tail -20`
Expected: builds; `pkg/` contains `PerceptualComparer` in the generated `.d.ts`. Confirm: `grep -c PerceptualComparer pkg/*.d.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/lib.rs
git commit -m "feat(wasm): PerceptualComparer wasm-bindgen wrapper (copying API)"
```

> Do NOT commit the rebuilt `pkg/` here unless the repo already tracks `pkg/` artifacts — check `git status pkg/` and `.gitignore`. If `pkg/` is gitignored, leave it. If tracked (shipped `web/pkg`), the integration task (D3) handles the shipped copy.

---

## Task C2: Zero-copy heap input path

**Files:**
- Modify: `src/lib.rs`

- [ ] **Step 1: Add `input_ptr` + `all_at`**

Append to the `#[wasm_bindgen] impl PerceptualComparer`:

```rust
    /// Returns a pointer into the wasm heap staging buffer of `len` bytes. JS writes
    /// the test RGBA directly here (no ArrayBuffer copy across the boundary), then
    /// calls `all_at`. Grows the buffer if needed; the returned pointer is valid
    /// until the next `input_ptr` call.
    pub fn input_ptr(&mut self, len: usize) -> *mut u8 {
        if self.scratch.len() < len {
            self.scratch.resize(len, 0);
        }
        self.scratch.as_mut_ptr()
    }

    /// Compute all three metrics over the bytes previously written into the staging
    /// buffer via `input_ptr`. `len` must equal what was passed to `input_ptr`.
    pub fn all_at(&mut self, len: usize) -> JsValue {
        // SAFETY: caller wrote `len` valid bytes into scratch via the input_ptr view.
        let test = &self.scratch[..len];
        // Comparer::all needs &mut self; split the borrow by computing into a temp.
        let m = self.inner.all(test);
        metrics_to_js(&m)
    }
```

> **Borrow note:** `self.inner.all(&self.scratch[..len])` borrows `self.scratch` (shared) and `self.inner` (mut) — disjoint fields, but the borrow checker needs them split. If it complains, take `let test = std::mem::take(&mut self.scratch);` then `let m = self.inner.all(&test[..len]); self.scratch = test;` (swap back), or store scratch in a separate `Rc`/raw split. The implementer picks whichever compiles cleanly; the `mem::take`+restore is simplest and allocation-free.

- [ ] **Step 2: Rebuild + smoke-test the zero-copy path in Node**

Create a throwaway check (do not commit): build, then in Node load `pkg`, construct a comparer on a small ref, call `input_ptr(len)`, write into `new Uint8Array(memory.buffer, ptr, len)`, call `all_at(len)`, confirm it returns finite numbers and `psnr === Infinity` when test == ref.

Run: `wasm-pack build --target web --out-dir pkg --release 2>&1 | tail -5` then the Node smoke script (Task D1 will formalize this).
Expected: identical-image → `psnr: Infinity`, `ssim ≈ 1`, `butteraugli ≈ 0`.

- [ ] **Step 3: Commit**

```bash
git add src/lib.rs
git commit -m "feat(wasm): zero-copy heap input path (input_ptr/all_at) for PerceptualComparer"
```

---

# PART D — Node bench, wasm flip-flop, worker wiring, verification

## Task D1: Extend `metrics-micro-bench.mjs` — JS vs wasm timing + parity, relax gate

**Files:**
- Modify: `benchmark/metrics-micro-bench.mjs`
- Create: `benchmark/perceptual-wasm-parity.mjs`

- [ ] **Step 1: Write a Node parity harness for the wasm kernel**

Create `benchmark/perceptual-wasm-parity.mjs` that:
1. imports the JS reference (`web/jxl-butteraugli.js`, `web/jxl-progressive-quality.js`),
2. imports the built `pkg` wasm (`../pkg/raw_converter_wasm.js` — confirm the exact generated name via `ls pkg/*.js`), initialising with `await init()`,
3. builds the synthetic 1280×800 workload + 4 passes (reuse the generator from `metrics-micro-bench.mjs` — import or copy `makeImage`/`makePasses`),
4. for each pass computes JS butteraugli/ssim/psnr and wasm `PerceptualComparer.all()`, asserts relative diff ≤1e-3, and prints per-pass ms for JS vs wasm.

Complete code:

```js
// Node parity + timing: JS reference vs wasm PerceptualComparer. ≤1e-3 relative.
import { pathToFileURL } from 'url';
import { readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');

const butt = await import(pathToFileURL(join(repo, 'web/jxl-butteraugli.js')).href);
const qual = await import(pathToFileURL(join(repo, 'web/jxl-progressive-quality.js')).href);

// locate the generated wasm js entry in pkg/
const pkgDir = join(repo, 'pkg');
const entry = readdirSync(pkgDir).find(f => f.endsWith('.js') && !f.endsWith('_bg.js'));
const wasm = await import(pathToFileURL(join(pkgDir, entry)).href);
await wasm.default(); // init()

const W = 1280, H = 800, N = W * H;
function rng(seed){let s=seed>>>0||1;return()=>{s^=s<<13;s>>>=0;s^=s>>17;s^=s<<5;s>>>=0;return s/0xffffffff;};}
function makeImage(){const r=rng(0xC0FFEE);const p=new Uint8Array(N*4);for(let i=0,j=0;i<N;i++,j+=4){const x=i%W,y=(i/W)|0;p[j]=(x*255/W+40*Math.sin(y/17)+r()*8)&255;p[j+1]=(y*255/H+40*Math.sin(x/23)+r()*8)&255;p[j+2]=((x+y)*127/(W+H)+30*Math.sin((x+2*y)/31))&255;p[j+3]=255;}return p;}
function makePass(ref,amp){const r=rng(0xBADF00D^amp);const p=new Uint8Array(ref);if(amp>0)for(let j=0;j<p.length;j+=4){for(let c=0;c<3;c++)p[j+c]=Math.max(0,Math.min(255,p[j+c]+(r()-0.5)*2*amp))|0;}return p;}

const ref = makeImage();
const passes = [24,12,5,0].map(a => makePass(ref, a));
const refXyb = butt.pixelsToXyb(ref, N);
const cmp = new wasm.PerceptualComparer(ref, W, H);

const rel = (a,b) => (a===b?0:Math.abs(a-b)/Math.max(Math.abs(a),Math.abs(b),1e-12));
let worst = 0, fails = 0;
let jsMs = 0, wasmMs = 0;
for (const p of passes) {
  let t = performance.now();
  const jb = butt.computeButteraugliVsFinal(refXyb, p, W, H);
  const js = qual.computeSsimVsFinal(ref, p, W, H);
  const jp = qual.computePsnrVsFinal(ref, p);
  jsMs += performance.now() - t;

  t = performance.now();
  const m = cmp.all(p);
  wasmMs += performance.now() - t;

  for (const [k, jv, wv] of [['butt',jb,m.butteraugli],['ssim',js,m.ssim],['psnr',jp,m.psnr]]) {
    if (!Number.isFinite(jv) && !Number.isFinite(wv)) continue; // both Inf (identical)
    const d = rel(jv, wv);
    worst = Math.max(worst, d);
    if (d > 1e-3) { fails++; console.error(`PARITY ${k}: js=${jv} wasm=${wv} rel=${d}`); }
  }
}
console.log(`JS ${jsMs.toFixed(1)} ms | wasm ${wasmMs.toFixed(1)} ms | speedup ${(jsMs/wasmMs).toFixed(2)}x`);
console.log(`Parity worst rel ${worst.toExponential(2)} (gate 1e-3) — ${fails===0?'PASS':fails+' FAIL'}`);
process.exit(fails === 0 ? 0 : 1);
```

- [ ] **Step 2: Build pkg then run the harness**

Run: `wasm-pack build --target web --out-dir pkg --release 2>&1 | tail -3 && node benchmark/perceptual-wasm-parity.mjs 2>&1 | grep -vE "Warning|Reparsing|eliminate|trace" | tail -8`
Expected: `Parity ... PASS`, and a wasm speedup over JS (target ≥4×). If parity FAILS, the wasm port diverges from JS beyond 1e-3 — debug before proceeding (likely an XYB or scale_err discrepancy).

- [ ] **Step 3: Relax the JS↔baseline gate in `metrics-micro-bench.mjs`**

In `benchmark/metrics-micro-bench.mjs`, the parity loop currently uses tolerance `1e-6` (line ~149: `if (d > 1e-6)`). Change the comparison threshold to `1e-3` and update the printed `(tolerance 1e-6)` text to `(tolerance 1e-3)`, since the kernel is now the source of truth and SIMD reassociation legitimately drifts beyond 1e-6.

- [ ] **Step 4: Commit**

```bash
git add benchmark/perceptual-wasm-parity.mjs benchmark/metrics-micro-bench.mjs
git commit -m "test(perceptual): Node JS-vs-wasm parity harness + relax bench gate to 1e-3"
```

---

## Task D2: wasm flip-flop (strict v128 vs relaxed-simd) — evaluate, gate

**Files:**
- Create: `benchmark/perceptual-wasm-flipflop.mjs` (only if a relaxed build is produced)
- Modify: build config if relaxed is adopted

- [ ] **Step 1: Decide whether relaxed-simd is worth a second artifact**

Relaxed-simd (`f32x4_relaxed_madd`) needs `RUSTFLAGS="-C target-feature=+simd128,+relaxed-simd"` and engine support (Chrome/FF 2023+, broad by 2026 but not universal). Producing a second pkg artifact + a load-time probe is only justified if relaxed beats strict past the noise margin.

Build a relaxed variant into a separate dir:
Run: `RUSTFLAGS="-C target-feature=+simd128,+relaxed-simd" wasm-pack build --target web --out-dir pkg-relaxed --release 2>&1 | tail -3`

Add a relaxed `scale_err_wasm_relaxed` in `wasm.rs` guarded by `#[cfg(target_feature = "relaxed-simd")]` that swaps the `e2`/`acc` mul-adds for `f32x4_relaxed_madd`, dispatched when built with the feature. (If the implementer judges this exceeds value, record the deferral and skip — strict v128 is the shipped default.)

- [ ] **Step 2: 10× flip-flop in Node (only if relaxed built)**

If a relaxed artifact exists, write `benchmark/perceptual-wasm-flipflop.mjs` modeled on Task D1: load both `pkg` (strict) and `pkg-relaxed`, time `all()` over the workload in alternating rounds (A,B,A,B…), print median + noise margin + verdict. Accept relaxed only if it clears the margin AND you note the engine-support caveat.

- [ ] **Step 3: Record verdict + commit**

```bash
mkdir -p "docs/Benchmark results"
# capture whichever ran:
node benchmark/perceptual-wasm-flipflop.mjs > "docs/Benchmark results/perceptual-wasm-flipflop-$(date +%Y-%m-%dT%H-%M-%S).txt" 2>&1 || true
git add crates/raw-pipeline/src/perceptual/simd/wasm.rs "docs/Benchmark results/" benchmark/perceptual-wasm-flipflop.mjs 2>/dev/null
git commit -m "bench(perceptual): wasm strict-vs-relaxed flip-flop verdict (or deferral)"
```

---

## Task D3: Wire `jxl-frame-stats-worker.js` to prefer wasm, JS fallback

**Files:**
- Modify: `web/jxl-frame-stats-worker.js`
- Reference (read): `packages/jxl-wasm/src/facade.ts` (zero-copy heap pattern), `web/pkg` (shipped wasm)

- [ ] **Step 1: Add a wasm-first comparer with graceful JS fallback**

`handleChartRequest` currently uses `createButteraugliComparer` (JS). Add a wasm path that constructs `PerceptualComparer` from the shipped `web/pkg` when available, falling back to the JS functions on any load/instantiation error or when the capability tier lacks wasm SIMD.

Edit the top of `web/jxl-frame-stats-worker.js`:

```js
// Optional wasm-accelerated metrics; JS remains the fallback (no-WASM / old tiers).
let wasmMetrics = null;
async function ensureWasmMetrics() {
  if (wasmMetrics !== null) return wasmMetrics;
  try {
    const mod = await import('./pkg/raw_converter_wasm.js'); // confirm generated name
    await mod.default();
    wasmMetrics = mod;
  } catch {
    wasmMetrics = false; // mark unavailable; use JS
  }
  return wasmMetrics;
}
```

In `handleChartRequest`, make it async and prefer wasm:

```js
async function handleChartRequest(id, data) {
  const { ref, refWidth, refHeight, passes } = data;
  try {
    const refPx = new Uint8Array(ref);
    const n = refWidth * refHeight;
    const wm = await ensureWasmMetrics();
    let scoreAll;
    if (wm && data.includeButter !== 'approx') {
      const cmp = new wm.PerceptualComparer(refPx, refWidth, refHeight);
      scoreAll = (px) => {
        const len = px.length;
        const ptr = cmp.input_ptr(len);
        new Uint8Array(wm.__wasm.memory.buffer, ptr, len).set(px); // confirm memory accessor
        return cmp.all_at(len); // {butteraugli, ssim, psnr}
      };
    }
    const refXyb = pixelsToXyb(refPx, n);
    const cmp = createButteraugliComparer(refPx, refWidth, refHeight);
    const values = passes.map(p => {
      if (!p) return null;
      const px = new Uint8Array(p.buf);
      if (scoreAll) {
        const m = scoreAll(px);
        return { index: p.index, psnr: m.psnr, ssim: m.ssim, butt: m.butteraugli,
                 moments: computeChannelMoments(px, refWidth, refHeight) };
      }
      const rec = {
        index: p.index,
        psnr: computePsnrVsFinal(refPx, px),
        ssim: computeSsimVsFinal(refPx, px, refWidth, refHeight),
        moments: computeChannelMoments(px, refWidth, refHeight),
      };
      rec.butt = (data.includeButter === false) ? null
        : (data.includeButter === 'approx') ? computeButteraugliApproxVsFinal(refXyb, px, refWidth, refHeight)
        : cmp(px);
      return rec;
    });
    self.postMessage({ id, ok: true, type: 'chart', values });
  } catch (error) {
    self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}
```

> The exact wasm memory accessor (`wm.__wasm.memory` vs an exported `memory`) depends on the wasm-pack `--target web` output — the implementer MUST confirm the generated accessor (check `pkg/*.js` for `export ... memory` or a `wasm` binding) and use the correct one. If the zero-copy heap write is awkward from the worker, fall back to the copying `cmp.all(px)` API (still faster than JS) and note it.

- [ ] **Step 2: Verify the worker still passes its tests / smoke path**

Run: `node StandardMultifileTest.mjs 2>&1 | tail -20` (the project's no-regression gate).
Expected: no new failures vs baseline. If the worker is exercised by a specific test, run that too.

- [ ] **Step 3: Commit**

```bash
git add web/jxl-frame-stats-worker.js
git commit -m "feat(web): frame-stats worker prefers wasm PerceptualComparer, JS fallback"
```

---

## Task D4: Final verification + self-review

**Files:** none (verification)

- [ ] **Step 1: Native suite + clippy**

Run: `cd crates/raw-pipeline && cargo test --no-default-features --lib 2>&1 | tail -6`
Run: `cd crates/raw-pipeline && cargo clippy --no-default-features --lib 2>&1 | grep -i perceptual | head`
Expected: all tests pass; no perceptual clippy warnings.

- [ ] **Step 2: wasm build + parity + speedup**

Run: `wasm-pack build --target web --out-dir pkg --release 2>&1 | tail -3 && node benchmark/perceptual-wasm-parity.mjs 2>&1 | tail -4`
Expected: parity PASS (≤1e-3), wasm speedup ≥4× over JS reported.

- [ ] **Step 3: No-regression gate**

Run: `node StandardMultifileTest.mjs 2>&1 | tail -15`
Expected: clean (compare to pre-change baseline).

- [ ] **Step 4: Final commit**

```bash
git add -A -- crates/raw-pipeline/src/perceptual benchmark/perceptual-wasm-parity.mjs
git commit -m "test(perceptual): Plan 2 full verification — native + wasm green" || echo "nothing to commit"
```

---

## Self-Review (author checklist — completed during writing)

- **Spec coverage:** wasm v128 scale_err/xyb/downsample (B1) + dispatch (B2); relaxed-simd Path B gated by flip-flop (D2); zero-copy wasm-bindgen binding (C1/C2) = spec §4.3; Node JS-vs-wasm parity + gate relax (D1) = spec §3/§8; worker wiring + JS fallback (D3) = spec §7; shared headroom xyb-gather/downsample/rcp (A1–A4) = spec §5.1 + the Plan-1 finding. Hardware/tier selection (B1 `detect_wasm`, C build flags) = spec §5.3. Native AVX-512 remains out (no hardware). GPU/planar = spec §11 future, not here.
- **Placeholder scan:** the only non-literal code is the `downsample_avx2` deinterleave (A2 Step 1b, explicitly flagged with implementation guidance + a parity test that gates correctness, and a documented scalar-fallback escape) and the wasm memory-accessor in D3 (flagged: confirm generated name, with a copying-API fallback). These are marked decisions, not silent gaps.
- **Type consistency:** `Backend::{Scalar,Avx2Strict,Avx2Rsqrt,WasmSimd}`; `pixels_to_xyb_avx2(px,n,lut_ptr,x,y,b)` vs `pixels_to_xyb_wasm(px,n,&lut,x,y,b)` (ptr on native for gather, slice on wasm); `scale_err_wasm(...)` no `rsqrt_path` arg (wasm strict default); `PerceptualComparer::{new,all,butteraugli,ssim,psnr,input_ptr,all_at}`; `sqrt_lin_lut`/`sqrt_lin_lut_ptr` both `pub(crate)`.

---

## Execution Handoff

After Plan 2 lands: `superpowers:finishing-a-development-branch` to integrate (squash-merge collapses the empty Task-9 marker commit from Plan 1). Then the spec §11 future items (planar decoder output, GPU compute batch) are separate specs if pursued.
