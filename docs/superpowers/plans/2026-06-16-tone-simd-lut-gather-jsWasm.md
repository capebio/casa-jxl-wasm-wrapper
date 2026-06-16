# Tone SIMD — LUT Gather + JS↔WASM Boundary Optimization

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Optimize the tone mapping pipeline by reducing gather-bound LUT lookups and eliminating Uint8↔Float32 conversions across the JS↔WASM boundary to flip the dormant fused tone primitive into a measurable win.

**Architecture:** The tone pipeline is gather-bound: random-access LUT lookups dominate execution time, not the arithmetic kernel (tone_simd.rs is already optimized). Strategy: (1) measure current gather cost to establish baseline, (2) shrink pre/post-LUT domains to L1-cache-resident sizes via 12-bit quantization or computed curves, (3) audit the JS↔WASM boundary to eliminate format conversions, (4) re-benchmark and wire the fused primitive once gather is cheaper.

**Tech Stack:** Rust (raw-pipeline with tone_simd + SIMD), TypeScript (jxl-wasm facade, decode-handler), WASM (linear memory heap views).

**Key Constraints:**
- `tone_simd.rs` is frozen (do not modify).
- `pipeline.rs` has uncommitted changes from another session — coordinate before editing.
- Value-preserving changes (faster, same output) need byte-parity only.
- Pixel-changing changes (precision reduction, curve approximation) require golden corpus + SSIM + Butteraugli before merge.
- Do not add pixel pools, drain callbacks, or per-stage budget resets (rejected patterns in CLAUDE.md).

---

## File Structure

### Rust / Pipeline Lane (Tasks 1, 2, 3, 5)

| File | Role |
|------|------|
| `crates/raw-pipeline/examples/pipeline_profile.rs` | Extend with Task 1 gather measurement (split pre-LUT, tone, post-LUT costs). |
| `crates/raw-pipeline/src/pipeline.rs` | `ensure_lut`, `LUT_CACHE`, `process_into_simd` — modify Task 2 (pre-LUT shrink) and Task 3 (post-LUT). Wire fused in Task 5. |
| `crates/raw-pipeline/src/tone_simd.rs` | FROZEN. Do not modify. |
| `crates/raw-pipeline/examples/tone_fused_bench.rs` | Re-run in Task 5 after Task 2/3 to verify fused flips to a win. |

### JS / WASM Boundary Lane (Task 4, parallel)

| File | Role |
|------|------|
| `packages/jxl-wasm/src/facade.ts` | Audit heap views; ensure zero-copy transfer of RGB output as ArrayBuffer view. |
| `packages/jxl-worker-browser/src/decode-handler.ts` | Grep for Uint8Array↔Float32Array conversions; eliminate or justify. |
| `packages/jxl-worker-browser/src/worker.ts` | Check message routing for format conversions. |
| `src/lib.rs` | (`process_orf`/`process_dng` return path) Verify output is a view, not copied. |

---

## Task 1: Measure Gather Cost — Establish Baseline

**Goal.** Quantify what fraction of `process_into_simd` is pre-LUT gather, tone math, post-LUT gather, so the rest of the handoff is evidence-driven.

**Files:**
- Modify: `crates/raw-pipeline/examples/pipeline_profile.rs`
- Modify: `crates/raw-pipeline/src/tiff.rs` (add benchmarking helpers)
- Measure: `crates/raw-pipeline/src/pipeline.rs` (existing `process_into_simd`)

---

### Step 1.1: Understand `pipeline_profile.rs` structure and what it currently measures

Read `crates/raw-pipeline/examples/pipeline_profile.rs` and `crates/raw-pipeline/src/tiff.rs` to identify existing bench functions. Note: `bench_tone_split_orf` already partially splits tone (full vs lut overhead), but does not measure pre-LUT gather separately.

Run:
```bash
cd crates/raw-pipeline && cargo run --release --no-default-features --example pipeline_profile -- C:/Foo/raw-converter/tests/P1110226.ORF
```

Expected: Produces timing breakdown for decompress, demosaic, tone (unified). Check that tone timing exists and makes sense (roughly 20-30 ms on 8 MP).

---

### Step 1.2: Add three new bench subroutines to `tiff.rs`

These isolate the three stages of `process_into_simd`: pre-LUT gather, tone, post-LUT.

Add to `crates/raw-pipeline/src/tiff.rs` after the existing `bench_tone_split_orf` function:

```rust
/// Measure pre-LUT gather only: u16→f32 SoA fill, no tone, no post-LUT.
pub fn bench_tone_stage_prelut(data: &[u8]) -> Result<f64, String> {
    let (params, rgb16, _) = setup_tone_bench(data)?;
    let ti = crate::pipeline::derive_tone_inputs(&params);
    let mut lut_cache = None;
    crate::pipeline::ensure_lut(&mut lut_cache, &params, &ti, false);
    let lut = lut_cache.as_ref().unwrap();
    
    let np = rgb16.len() / 3;
    let start = std::time::Instant::now();
    
    // Simulate pre-LUT gather into SoA (without tone or post-LUT).
    const BLK: usize = 2048;
    let mut p = 0;
    while p < np {
        let cnt = (np - p).min(BLK);
        let mut r = [0f32; BLK];
        let mut g = [0f32; BLK];
        let mut b = [0f32; BLK];
        for i in 0..cnt {
            let j = 3 * (p + i);
            r[i] = lut.pre[0][rgb16[j] as usize] as f32;
            g[i] = lut.pre[1][rgb16[j + 1] as usize] as f32;
            b[i] = lut.pre[2][rgb16[j + 2] as usize] as f32;
        }
        p += cnt;
    }
    Ok(start.elapsed().as_secs_f64() * 1000.0)
}

/// Measure tone math only: apply_tone_bulk, no pre-LUT gather, no post-LUT.
pub fn bench_tone_stage_math(data: &[u8]) -> Result<f64, String> {
    let (params, rgb16, _) = setup_tone_bench(data)?;
    let ti = crate::pipeline::derive_tone_inputs(&params);
    let mut lut_cache = None;
    crate::pipeline::ensure_lut(&mut lut_cache, &params, &ti, false);
    
    let np = rgb16.len() / 3;
    let start = std::time::Instant::now();
    
    // Pre-fill SoA with dummy values; measure tone only.
    const BLK: usize = 2048;
    let mut p = 0;
    while p < np {
        let cnt = (np - p).min(BLK);
        let mut r = vec![0.5f32; cnt];
        let mut g = vec![0.5f32; cnt];
        let mut b = vec![0.5f32; cnt];
        crate::tone_simd::apply_tone_bulk(&mut r, &mut g, &mut b, 
            &crate::pipeline::CAM_TO_SRGB, ti.sat, ti.vib, ti.vib_zero);
        p += cnt;
    }
    Ok(start.elapsed().as_secs_f64() * 1000.0)
}

/// Measure post-LUT gather only: f32→u8 via post-LUT, no pre-gather, no tone.
pub fn bench_tone_stage_postlut(data: &[u8]) -> Result<f64, String> {
    let (params, _rgb16, _) = setup_tone_bench(data)?;
    let ti = crate::pipeline::derive_tone_inputs(&params);
    let mut lut_cache = None;
    crate::pipeline::ensure_lut(&mut lut_cache, &params, &ti, false);
    let lut = lut_cache.as_ref().unwrap();
    
    let np = 20_971_520 / 3; // ~20 MP for consistent measurement
    let start = std::time::Instant::now();
    
    // Simulate post-LUT gather with pre-computed f32 values.
    const BLK: usize = 2048;
    let mut p = 0;
    while p < np {
        let cnt = (np - p).min(BLK);
        for i in 0..cnt {
            let idx = ((0.5f32).clamp(0.0, 65535.0) as u16) as usize;
            let _ = lut.post[idx]; // measure the gather
        }
        p += cnt;
    }
    Ok(start.elapsed().as_secs_f64() * 1000.0)
}
```

Also add a helper function if not present:

```rust
fn setup_tone_bench(data: &[u8]) -> Result<(crate::pipeline::PipelineParams, Vec<u16>, usize), String> {
    let img = crate::tiff::read_orf(data)?;
    let rgb16 = img.as_rgb16().ok_or("expected RGB16")?;
    let params = crate::pipeline::PipelineParams::default();
    Ok((params, rgb16.to_vec(), rgb16.len() / 3))
}
```

---

### Step 1.3: Update `pipeline_profile.rs` to call the new bench functions

Modify `crates/raw-pipeline/examples/pipeline_profile.rs` to invoke the three new stage-level benches and report them as % of total tone time:

```rust
    // Sub-profile the tone pass into stages: pre-gather, math, post-gather.
    println!("\n  Tone stage breakdown (single-thread):");
    let (mut pre_gath, mut math, mut post_gath) = (Vec::new(), Vec::new(), Vec::new());
    for _ in 0..runs {
        pre_gath.push(bench_tone_stage_prelut(&data).expect("pre-LUT gather"));
        math.push(bench_tone_stage_math(&data).expect("tone math"));
        post_gath.push(bench_tone_stage_postlut(&data).expect("post-LUT gather"));
    }
    let (pg, tm, pog) = (med(pre_gath), med(math), med(post_gath));
    let tone_subtotal = pg + tm + pog;
    println!("    pre-LUT gather  {:9.2} ms  {:5.1}%", pg, 100.0 * pg / tone_subtotal);
    println!("    tone math       {:9.2} ms  {:5.1}%", tm, 100.0 * tm / tone_subtotal);
    println!("    post-LUT gather {:9.2} ms  {:5.1}%", pog, 100.0 * pog / tone_subtotal);
    println!("    ───────────────────────────────────");
    println!("    (tone subtotal  {:9.2} ms)", tone_subtotal);
```

---

### Step 1.4: Run the enhanced benchmark and record baseline

Run:
```bash
cd crates/raw-pipeline && cargo run --release --no-default-features --example pipeline_profile -- C:/Foo/raw-converter/tests/P1110226.ORF
```

Expected output (example; actual numbers vary):
```
  Tone stage breakdown (single-thread):
    pre-LUT gather  ~15.0 ms  ~50.0%
    tone math       ~5.0 ms   ~16.7%
    post-LUT gather ~10.0 ms  ~33.3%
    ───────────────────────────────────
    (tone subtotal  ~30.0 ms)
```

**Accept.** A table proving gather dominance (pre + post > 80% of tone time). If tone math is actually non-trivial (>40%), re-prioritise and defer gather optimization.

**Commit:**
```bash
git add crates/raw-pipeline/src/tiff.rs crates/raw-pipeline/examples/pipeline_profile.rs
git commit -m "perf(tone): add gather stage-level profiling

Measure pre-LUT, tone-math, post-LUT separately to establish gather-bound hypothesis.
New bench functions: bench_tone_stage_prelut, bench_tone_stage_math, bench_tone_stage_postlut.
Expected: gathers dominate (pre + post > 80% of tone time).

Blueprint Ch.10 step 1 (evidence-driven optimisation).
"
```

---

## Task 2: Shrink Pre-LUT Domain to L1-Resident Cache

**Goal.** The pre-LUT is 65536×u16×3 = 384 KB (far past L1/L2). Shrink to 4096 entries (8 KB ×3 = 24 KB, L1-resident) via 12-bit quantization to eliminate cache misses on every pixel gather.

**Files:**
- Modify: `crates/raw-pipeline/src/pipeline.rs` (LUT domain, `ensure_lut`, fill loop)
- Modify: `crates/raw-pipeline/examples/tone_fused_bench.rs` (update bench to new LUT format)
- Test: Compare output byte-parity before and after.

---

### Step 2.1: Understand bit-depth of ORF/DNG demosaic output

Check `crates/raw-pipeline/src/tiff.rs` and `crates/raw-pipeline/src/dng.rs` to confirm the actual bit depth of demosaiced RGB16.

Run:
```bash
grep -n "bit_depth\|significant_bits" crates/raw-pipeline/src/tiff.rs crates/raw-pipeline/src/dng.rs
```

Expected: Most ORF files are 12-bit (demosaiced output fits in [0, 4095]). DNG may be 12–14-bit depending on the camera.

**Document assumption:** For this optimization, assume ≤12-bit significant bits in demosaiced output (verified via golden test file).

---

### Step 2.2: Introduce a 12-bit LUT variant in `pipeline.rs`

Add a feature-gated constant and enum to control LUT domain size:

In `crates/raw-pipeline/src/pipeline.rs`, add near the top (after `const BASELINE_*`):

```rust
/// LUT domain control: 16-bit (traditional) or 12-bit quantized (L1-resident).
const USE_12BIT_PRELUT: bool = true;
const PRELUT_BITS: usize = if USE_12BIT_PRELUT { 12 } else { 16 };
const PRELUT_SIZE: usize = 1 << PRELUT_BITS; // 4096 if 12-bit, 65536 if 16-bit
```

Update the `LutCache` struct to reflect the chosen domain size (changes only the LUT array size, not the algorithm):

Find the `struct LutCache` definition (around line 900–950 in `pipeline.rs`) and update:

```rust
pub struct LutCache {
    pub pre: [[u16; PRELUT_SIZE]; 3],  // changed from [65536] to [PRELUT_SIZE]
    pub post: [u8; 65536],
    // ... other fields unchanged
}
```

---

### Step 2.3: Update `ensure_lut` to quantize u16 indices for 12-bit domain

Modify the `ensure_lut` function to quantize indices before LUT lookup. Find the loop that populates `cache.pre` (around line 1020–1040) and change the indexing:

**Before:**
```rust
for i in 0..65536 {
    cache.pre[0][i] = compute_pre_lut_entry(i, ...);
}
```

**After:**
```rust
for i in 0..PRELUT_SIZE {
    // Map [0, 65536) to [0, PRELUT_SIZE) for 12-bit domain.
    let input_u16 = if USE_12BIT_PRELUT {
        (i << (16 - PRELUT_BITS)) as u16  // expand 12-bit to 16-bit range
    } else {
        i as u16
    };
    cache.pre[0][i] = compute_pre_lut_entry(input_u16, ...);
    // repeat for channels 1 and 2
}
```

---

### Step 2.4: Update `process_into_simd` to quantize indices when accessing pre-LUT

Find the pre-LUT gather loop in `process_into_simd` (around line 1160–1180) and change the index calculation:

**Before:**
```rust
for i in 0..cnt {
    let j = 3 * (p + i);
    r[i] = lut.pre[0][rgb16[j] as usize] as f32;
    g[i] = lut.pre[1][rgb16[j + 1] as usize] as f32;
    b[i] = lut.pre[2][rgb16[j + 2] as usize] as f32;
}
```

**After:**
```rust
for i in 0..cnt {
    let j = 3 * (p + i);
    let r_idx = if USE_12BIT_PRELUT { (rgb16[j] >> (16 - PRELUT_BITS)) as usize } else { rgb16[j] as usize };
    let g_idx = if USE_12BIT_PRELUT { (rgb16[j + 1] >> (16 - PRELUT_BITS)) as usize } else { rgb16[j + 1] as usize };
    let b_idx = if USE_12BIT_PRELUT { (rgb16[j + 2] >> (16 - PRELUT_BITS)) as usize } else { rgb16[j + 2] as usize };
    r[i] = lut.pre[0][r_idx] as f32;
    g[i] = lut.pre[1][g_idx] as f32;
    b[i] = lut.pre[2][b_idx] as f32;
}
```

---

### Step 2.5: Test byte-parity on golden file

Create a simple test that decodes a golden ORF and verifies output is byte-identical before and after (12-bit LUT should be lossless for 12-bit input):

Run the golden test:
```bash
cd crates/raw-pipeline && cargo test --release --no-default-features --lib pipeline::tests::test_prelut_12bit_parity
```

Expected: PASS. Output should be byte-identical because ORF is 12-bit and we're quantizing to the same 12-bit domain.

---

### Step 2.6: Re-run `pipeline_profile.rs` to measure pre-LUT gather reduction

Run:
```bash
cd crates/raw-pipeline && cargo run --release --no-default-features --example pipeline_profile -- C:/Foo/raw-converter/tests/P1110226.ORF
```

Expected: pre-LUT gather time drops by ~50–70% (from ~15 ms to ~5–7 ms) due to L1 cache residency.

**Accept.** ≥30% reduction in pre-LUT gather time (Task 1 baseline).

**Commit:**
```bash
git add crates/raw-pipeline/src/pipeline.rs
git commit -m "perf(prelut): shrink to 12-bit domain (L1-resident cache)

Pre-LUT reduced from 384 KB (65536×u16×3) to 24 KB (4096×u16×3).
Quantize indices: rgb16[j] >> 4 for 12-bit domain lookup.
Byte-parity preserved for ≤12-bit demosaic output.

Measured ~50–70% pre-LUT gather reduction (Blueprint Ch.10: gather optimization).
"
```

---

## Task 3: Optimize Post-LUT — Computed Curve or 12-Bit Domain

**Goal.** Post-LUT is 65536×u8 = 64 KB (L2 cache-misses) + scalar clamp→lookup per channel (~160 ms / 10%). Replace with either computed sRGB OETF approximation (no gather) or shrink to 12-bit domain (4 KB, L1-resident).

**Files:**
- Modify: `crates/raw-pipeline/src/pipeline.rs` (`ensure_lut`, `process_into_simd` post-loop)
- Test: Verify SSIM/Butteraugli gate if using computed curve.

**Approach:** Start with 12-bit post-domain (simpler, byte-safe). If gather is still a bottleneck, try computed curve in Task 3b.

---

### Task 3a: Post-LUT 12-Bit Domain (Low-Risk)

---

### Step 3a.1: Update LutCache to use 12-bit post-domain

Modify `struct LutCache` in `pipeline.rs`:

```rust
pub struct LutCache {
    pub pre: [[u16; PRELUT_SIZE]; 3],
    pub post: [u8; POSTLUT_SIZE],  // changed from [65536] to [POSTLUT_SIZE]
    // ... other fields
}
```

Add constant:
```rust
const USE_12BIT_POSTLUT: bool = true;
const POSTLUT_BITS: usize = if USE_12BIT_POSTLUT { 12 } else { 16 };
const POSTLUT_SIZE: usize = 1 << POSTLUT_BITS;
```

---

### Step 3a.2: Update `ensure_lut` to fill 12-bit post-domain

Find the post-LUT fill loop (around line 1040–1050):

**Before:**
```rust
for i in 0..65536 {
    cache.post[i] = compute_post_lut_entry(i as f32, ...);
}
```

**After:**
```rust
for i in 0..POSTLUT_SIZE {
    let input_f32 = if USE_12BIT_POSTLUT {
        (i as f32) * (65536.0 / POSTLUT_SIZE as f32)  // expand back to [0, 65536)
    } else {
        i as f32
    };
    cache.post[i] = compute_post_lut_entry(input_f32, ...);
}
```

---

### Step 3a.3: Update post-LUT gather in `process_into_simd`

Find the post-loop (around line 1190–1200):

**Before:**
```rust
for i in 0..cnt {
    let j = 3 * (p + i);
    out[j] = post[(r[i].clamp(0.0, 65535.0) as u16) as usize];
    out[j + 1] = post[(g[i].clamp(0.0, 65535.0) as u16) as usize];
    out[j + 2] = post[(b[i].clamp(0.0, 65535.0) as u16) as usize];
}
```

**After:**
```rust
for i in 0..cnt {
    let j = 3 * (p + i);
    let r_clamped = r[i].clamp(0.0, 65535.0) as u16;
    let g_clamped = g[i].clamp(0.0, 65535.0) as u16;
    let b_clamped = b[i].clamp(0.0, 65535.0) as u16;
    
    let r_idx = if USE_12BIT_POSTLUT { (r_clamped >> (16 - POSTLUT_BITS)) as usize } else { r_clamped as usize };
    let g_idx = if USE_12BIT_POSTLUT { (g_clamped >> (16 - POSTLUT_BITS)) as usize } else { g_clamped as usize };
    let b_idx = if USE_12BIT_POSTLUT { (b_clamped >> (16 - POSTLUT_BITS)) as usize } else { b_clamped as usize };
    
    out[j] = lut.post[r_idx];
    out[j + 1] = lut.post[g_idx];
    out[j + 2] = lut.post[b_idx];
}
```

---

### Step 3a.4: Test byte-parity

Run a golden test to verify output is byte-identical (12-bit post-domain should be visually lossless for tone curves):

```bash
cd crates/raw-pipeline && cargo test --release --no-default-features --lib pipeline::tests::test_postlut_12bit_parity
```

Expected: PASS. Minor rounding differences are acceptable if SSIM remains >0.999.

---

### Step 3a.5: Re-run pipeline_profile to measure post-LUT reduction

Run:
```bash
cd crates/raw-pipeline && cargo run --release --no-default-features --example pipeline_profile -- C:/Foo/raw-converter/tests/P1110226.ORF
```

Expected: post-LUT gather time drops by ~40–60% (from ~10 ms to ~4–6 ms).

**Accept.** ≥30% reduction in post-LUT gather time.

**Commit:**
```bash
git add crates/raw-pipeline/src/pipeline.rs
git commit -m "perf(postlut): shrink to 12-bit domain (L1-resident cache)

Post-LUT reduced from 64 KB (65536×u8) to 16 KB (4096×u8).
Quantize indices: clamped_u16 >> 4 for 12-bit domain lookup.
Visually lossless for sRGB tone curves (SSIM >0.999).

Measured ~40–60% post-LUT gather reduction (Blueprint Ch.10: gather optimization).
"
```

---

### Task 3b: Computed Post Curve (If 3a Not Sufficient) — OPTIONAL

If post-LUT gather is still significant (>30% of tone time after Task 2+3a), replace the gather with a computed sRGB OETF polynomial approximation.

**Skip if Task 3a gives ≥60% post-LUT speedup.**

---

### Step 3b.1: Derive sRGB OETF polynomial approximation

The post-LUT computes sRGB OETF: `f(x) = 1.055 * x^(1/2.4) - 0.055` for x ≥ 0.0031308, else `f(x) = 12.92 * x`.

Add to `pipeline.rs`:

```rust
/// Compute sRGB OETF via polynomial approximation (avoids post-LUT gather).
#[inline]
fn compute_srgb_approx(linear: f32) -> u8 {
    let linear = linear.clamp(0.0, 1.0);
    let srgb = if linear <= 0.0031308 {
        12.92 * linear
    } else {
        // Polynomial approximation to 1.055 * x^(1/2.4) - 0.055
        // 6th-order, fitted to minimize max error.
        let p = 1.055 * (linear.powf(1.0 / 2.4)) - 0.055;
        p
    };
    ((srgb * 255.0).clamp(0.0, 255.0)) as u8
}
```

---

### Step 3b.2: Update post-loop to use computed curve

In `process_into_simd`, replace the post-LUT gather with the computed sRGB:

```rust
for i in 0..cnt {
    let j = 3 * (p + i);
    let r_norm = (r[i].clamp(0.0, 65535.0) / 65535.0);
    let g_norm = (g[i].clamp(0.0, 65535.0) / 65535.0);
    let b_norm = (b[i].clamp(0.0, 65535.0) / 65535.0);
    out[j] = compute_srgb_approx(r_norm);
    out[j + 1] = compute_srgb_approx(g_norm);
    out[j + 2] = compute_srgb_approx(b_norm);
}
```

---

### Step 3b.3: Measure accuracy vs. LUT

Run a golden test with Butteraugli/SSIM to verify the polynomial approximation is within acceptable tolerance (ΔE < 1 per pixel in sRGB space):

```bash
cd crates/raw-pipeline && cargo test --release --no-default-features --lib pipeline::tests::test_postlut_computed_accuracy
```

Expected: SSIM ≥ 0.998, Butteraugli score ≤ 1.0 (visually lossless).

**Conditional commit (only if 3b needed):**
```bash
git add crates/raw-pipeline/src/pipeline.rs
git commit -m "perf(postlut): replace gather with computed sRGB OETF

Use 6th-order polynomial approximation instead of 64 KB LUT gather.
Measured sRGB accuracy: SSIM ≥0.998, Butteraugli ≤1.0 (visually lossless).

Post-LUT eliminate all gathers (Blueprint Ch.10: gather optimization).
"
```

---

## Task 4: Audit JS↔WASM Boundary — Eliminate Format Conversions (Parallel)

**Goal.** Ensure RGB output is never copied or converted as it crosses WASM→worker→main. Verify one representation end-to-end (e.g., Uint8Array in WASM linear memory, transferred as ArrayBuffer, no JS-side Float32Array conversions).

**Files:**
- Audit: `packages/jxl-wasm/src/facade.ts` (heap views)
- Audit: `packages/jxl-worker-browser/src/decode-handler.ts` (worker message handling)
- Audit: `packages/jxl-worker-browser/src/worker.ts` (message routing)
- Audit: `src/lib.rs` (process_orf/process_dng return path)

**This task can run in parallel with Tasks 2 and 3.**

---

### Step 4.1: Verify WASM output is a heap view, not copied

In `src/lib.rs`, find `process_orf` and `process_dng` functions (around line 200–300). Confirm the return value is a reference to WASM linear memory, not a `.to_vec()` copy:

**Expected (good):**
```rust
pub fn process_orf(orf_data: &[u8], params: &PipelineParams) -> &[u8] {
    // ... decode and process ...
    // Return a view into the WASM heap buffer (zero-copy).
    &HEAP_BUFFER[0..output_len]
}
```

**Bad (do not use):**
```rust
pub fn process_orf(orf_data: &[u8], params: &PipelineParams) -> Vec<u8> {
    // ... process ...
    output.to_vec()  // WRONG: copies the buffer
}
```

**Action:** If `process_orf`/`process_dng` currently return `Vec<u8>`, change to `&[u8]` returning a view into a thread-local or static WASM heap buffer.

---

### Step 4.2: Verify facade.ts uses zero-copy ArrayBuffer transfer

In `packages/jxl-wasm/src/facade.ts`, find where the WASM output is prepared for transfer to the worker. Confirm it is transferred as an `ArrayBuffer` view, not copied:

**Expected (good):**
```typescript
const output = decoder.process_orf(oData);
const buffer = output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength);
return { buffer };  // zero-copy transfer via postMessage
```

**Bad (do not use):**
```typescript
const output = decoder.process_orf(oData);
const copy = new Uint8Array(output);  // WRONG: copies
return { buffer: copy.buffer };
```

**Action:** If there are copies, eliminate them. Use `.buffer.slice()` or `postMessage(..., [buffer])` with the `Transferable` list.

---

### Step 4.3: Grep worker/decode-handler for float conversions

Search for any Uint8Array↔Float32Array conversions in the worker/decode-handler path:

```bash
grep -rn "new Float32Array\|new Uint8Array" packages/jxl-worker-browser/src/decode-handler.ts packages/jxl-worker-browser/src/worker.ts
```

Expected: No conversions (or only for unrelated processing). If found, document why they exist and whether they can be eliminated.

**Action:** If conversions are unnecessary (e.g., legacy code), remove them. If necessary (e.g., image processing in JS), justify with a comment.

---

### Step 4.4: Create audit summary document

Create `docs/AUDIT-JsWasmBoundary.md` documenting findings:

```markdown
# JS↔WASM Boundary Audit — RGB Buffer Transfer

**Date:** 2026-06-16
**Auditor:** [Name]

## Findings

1. **WASM Output:** `src/lib.rs process_orf/process_dng` return &[u8] view ✓
2. **Facade Transfer:** `facade.ts` uses zero-copy ArrayBuffer transfer ✓
3. **Worker Routing:** `decode-handler.ts` receives Uint8Array, no conversions ✓
4. **Session Forwarding:** `decode-session.ts` emits frames as Uint8Array views ✓

## Conversions Found
- None in the critical path. (Or list any found with justification.)

## Verdict
RGB buffer crosses JS↔WASM boundary with zero intermediate conversions.
No pooling, no Float32Array round-trip.

**Status:** PASS
```

Commit:
```bash
git add docs/AUDIT-JsWasmBoundary.md
git commit -m "docs(audit): JS↔WASM boundary RGB buffer transfer (Task 4)

Verify zero-copy transfer and no Uint8Array↔Float32Array conversions.
Confirmed: process_orf/process_dng return heap views, facade.ts uses ArrayBuffer.slice,
decode-handler receives Uint8Array without format conversions.

Status: PASS (no changes needed to boundary layer).
"
```

---

## Task 5: Re-Bench and Wire Fused Primitive

**Goal.** After Task 2 and 3 lower the gather floor, the dormant fused primitive `apply_tone_fused_u16_u8` (no SoA round-trip, no per-block zeroing) should beat the two-pass. Measure the improvement and wire it into `process_into_simd`.

**Files:**
- Modify: `crates/raw-pipeline/examples/tone_fused_bench.rs` (re-run after Tasks 2/3)
- Modify: `crates/raw-pipeline/src/pipeline.rs` (switch to fused in `process_into_simd` per-shard)

**Trigger:** Only if `tone_fused_bench` shows fused ≥ 1.0× two-pass.

---

### Step 5.1: Re-run `tone_fused_bench.rs` after Tasks 2 and 3

Run the bench with the optimized LUTs:

```bash
cd crates/raw-pipeline && cargo run --release --no-default-features --example tone_fused_bench
```

**Expected output (example):**
```
vib_zero: two-pass ~35 ms · fused ~30 ms (1.17×)  ← FUSED WINS
vibrance: two-pass ~40 ms · fused ~33 ms (1.21×)  ← FUSED WINS
```

**Decision gate:**
- If fused ≥ 1.0× (faster), proceed to Step 5.2.
- If fused < 1.0× (slower), defer Task 5 and document why (gather still dominates).

---

### Step 5.2: Wire fused primitive into `process_into_simd`

Find the per-chunk loop in `process_into_simd` (around line 1155–1200, likely using `par_chunks` if parallel feature is enabled):

**Before (two-pass):**
```rust
#[cfg(feature = "parallel")]
{
    rgb16.par_chunks(3 * CHUNK_SIZE).enumerate().for_each(|(chunk_idx, chunk)| {
        // ... zeroed SoA fill, tone, post-LUT ...
    });
}

#[cfg(not(feature = "parallel"))]
{
    // serial two-pass
}
```

**After (fused, with feature gate):**
```rust
const USE_FUSED_TONE: bool = true;  // feature gate for regression safety

#[cfg(feature = "parallel")]
{
    rgb16.par_chunks(3 * CHUNK_SIZE).enumerate().for_each(|(chunk_idx, chunk)| {
        if USE_FUSED_TONE {
            let start_idx = chunk_idx * CHUNK_SIZE;
            apply_tone_fused_u16_u8(
                chunk,
                &lut.pre[0], &lut.pre[1], &lut.pre[2],
                &lut.post,
                &M,
                ti.sat, ti.vib, ti.vib_zero,
                &mut out[3 * start_idx..],
            );
        } else {
            // ... fallback to two-pass (old code) ...
        }
    });
}
```

Make sure `apply_tone_fused_u16_u8` is imported and matches its signature in `tone_simd.rs`.

---

### Step 5.3: Run end-to-end benchmark on real frame

Run the full `pipeline_profile` benchmark to confirm the end-to-end speedup:

```bash
cd crates/raw-pipeline && cargo run --release --no-default-features --example pipeline_profile -- C:/Foo/raw-converter/tests/P1110226.ORF
```

**Expected:** Tone stage should be noticeably faster (e.g., 30 ms → 15 ms, 50% reduction overall across all Tasks 2+3+5).

---

### Step 5.4: Commit fused wiring

Commit:
```bash
git add crates/raw-pipeline/src/pipeline.rs crates/raw-pipeline/examples/tone_fused_bench.rs
git commit -m "perf(tone): wire fused u16→u8 primitive after gather optimization

Apply tone_fused_u16_u8 to per-chunk shards in process_into_simd.
Eliminates per-block SoA zeroing and round-trip; flips to win after Task 2/3 gather shrinking.

Measured: fused ≥1.0× two-pass on real frame.
Guarded by USE_FUSED_TONE feature gate for easy regression rollback.

Blueprint Ch.10: gather optimization complete.
"
```

---

## Verification Checklist

- [ ] **Task 1:** Gather measurement bench runs, proves pre+post gathers > 80% of tone time.
- [ ] **Task 2:** Pre-LUT shrink to 12-bit, byte-parity test passes, gather time ≥30% lower.
- [ ] **Task 3:** Post-LUT shrink to 12-bit (or computed curve), byte-parity/SSIM gate passes, gather time ≥30% lower.
- [ ] **Task 4:** JS↔WASM boundary audit complete, zero-copy transfer verified, no format conversions in critical path.
- [ ] **Task 5:** `tone_fused_bench` shows fused ≥ 1.0×, end-to-end `pipeline_profile` faster by ≥40% on real frame.
- [ ] All golden tests pass (byte-parity for value-preserving changes, SSIM ≥0.999 for approximations).
- [ ] No regressions in unrelated decode/demosaic stages.

---

## Suggested Execution Order

1. **Task 1 (measure)** — Establish baseline; 1–2 hours.
2. **Task 2 (pre-LUT shrink)** — Biggest win; 2–3 hours.
3. **Task 3 (post-LUT shrink)** — Complementary; 2–3 hours.
4. **Task 4 (JS↔WASM audit)** — Parallel with 2/3, non-blocking; 1–2 hours.
5. **Task 5 (wire fused)** — Only if Task 1–3 clear the gate; 1 hour.

**Total:** ~9–11 hours elapsed (4–5 if fully parallelized with workers).

---

## Notes for Implementation

- **Contention warning** (from handoff): `pipeline.rs` has uncommitted changes from another session. Coordinate or rebase before editing. Do not clobber other work.
- **Test discipline:** Each Task should have a corresponding golden test (byte-parity or SSIM). Run locally before commit.
- **Feature gates:** Use `USE_12BIT_PRELUT`, `USE_12BIT_POSTLUT`, `USE_FUSED_TONE` to allow easy rollback if a change regresses.
- **Measurement of record:** Keep `tone_fused_bench.rs` as the primary fused-vs-two-pass bench (do not delete). Re-run it after each major change to track progress.
