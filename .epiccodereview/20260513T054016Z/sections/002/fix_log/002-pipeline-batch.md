# Fix Log — src/pipeline.rs

**Date**: 2026-05-13  
**File**: `src/pipeline.rs`  
**Verification**: `cargo check --target wasm32-unknown-unknown` — clean (0 errors, 0 new warnings)

---

## 002-performance-b2c3d4e5 [HIGH] — LUT rebuild cost

**Assessment**: The task analysis itself concluded caching requires JS-side changes (ADR). The direct in-Rust fix is to ensure `linear_to_srgb` is inlined into the build loop to eliminate call overhead.

**Applied**: Changed `#[inline]` to `#[inline(always)]` on `linear_to_srgb`. Added a comment documenting the JS-level caching opportunity (keying on tone params eliminates all LUT rebuilds on re-renders).

---

## 002-performance-a1b2c3d4 [HIGH] — separable_blur allocations + vectorization

**Applied**:

1. Extracted `separable_blur_into(src, w, h, kernel, &mut temp: &mut [u16])` — horizontal-pass-only helper that writes into a caller-supplied buffer. Channel accumulation now uses a fixed `[0f32; 3]` array with the channel index explicit inside the kernel loop (`acc[0] += ...; acc[1] += ...; acc[2] += ...`), enabling LLVM to vectorize across channels.

2. `separable_blur` updated to use `separable_blur_into` for its horizontal pass; vertical pass converted to the same channel-array pattern.

3. `apply_unsharp_masks` now allocates a single `scratch: Vec<u16>` before both unsharp-mask calls and reuses it via `apply_unsharp_mask_with_scratch`. Peak allocation drops from 4 full-image buffers to 2.

4. **Clamp bug fixed**: `apply_unsharp_mask` was clamping to `0..4095`; corrected to `0..65535` (values are 16-bit throughout the pipeline).

---

## 002-performance-c9d0e1f2 [MEDIUM] — build_post_lut powf cost

**Assessment**: All proposed sqrt-chain approximations in the task spec were either inaccurate for 8-bit output or equivalent in cost to `powf` (which LLVM maps to a wasm32 intrinsic). The task itself concluded "keep powf".

**Applied**: Same as b2c3d4e5 — `#[inline(always)]` on `linear_to_srgb` is the sound fix here. No additional change needed.

---

## 002-performance-d4e5f6a7 [MEDIUM] — Channel-interleaved loop order

**Applied**: Fixed as part of 002-performance-a1b2c3d4. Both horizontal and vertical passes of `separable_blur` (and `separable_blur_into`) now use a `[0f32; 3]` accumulator with explicit per-channel indexing inside the kernel loop, which gives LLVM the structure needed for SIMD vectorization.

---

## 002-performance-c3d4e5f6 [MEDIUM] — apply_unsharp_masks buffer count

**Applied**: Fixed as part of 002-performance-a1b2c3d4. Shared `scratch` buffer across both texture and clarity passes.

---

## 002-performance-b8c9d0e1 [MEDIUM] — Unconditional vibrance luma/pixel_sat computation

**Applied**: Hoisted `vib_zero = vib.abs() < 1e-6` before the pixel loop. Inside the loop, `scale` is computed via an `if vib_zero { sat } else { ... }` branch. When vibrance is 0 (the common case for users who haven't touched the slider), the four `max/min/div/clamp` operations for `pixel_sat` and `vib_w` are skipped for every pixel.

Note: `luma` computation is retained in both branches because it is always needed for the `r2/g2/b2` chroma scaling regardless of vibrance.

---

## 002-contracts-s1t2u3 [LOW] — apply_orientation silent pass-through

**Applied**: Added doc comment to `apply_orientation` enumerating which orientations are handled (3, 6, 8) and explicitly documenting that 1, 2, 4, 5, 7 pass through as-is, with the rationale that mirror/transpose variants are rare in Olympus ORF.

---

## 002-performance-f2a3b4c5 [LOW] — rotate_180 per-byte copy

**Applied**: Replaced the three individual byte assignments in `rotate_180`'s inner loop with `dst_row[c*3..c*3+3].copy_from_slice(&s_row[sc*3..sc*3+3])`. This is both cleaner and lets the compiler emit a 3-byte `memcpy` intrinsic or a 32-bit load/store rather than three separate byte ops.
