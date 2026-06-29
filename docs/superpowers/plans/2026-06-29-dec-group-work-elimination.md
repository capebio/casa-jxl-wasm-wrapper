# dec_group Work-Elimination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement 7 open decoder throughput optimizations in `external/libjxl-012/lib/jxl/dec_group.cc` (and related files), verified byte-exact after each, then measure OLD vs NEW timing with a flipflop harness.

**Architecture:** Work in `external/libjxl-012/lib/jxl/` submodule, branch `Decode_12_big_imp`. Each task: make change → build native djxl → SHA-compare decode outputs vs baseline snapshot → commit. Final task builds WASM OLD and NEW and runs flipflop timing.

**Tech Stack:** C++17 with Highway SIMD (HWY), MSVC + clang-cl via `build-msvc.ps1`, native `djxl` binary for SHA verification, emscripten WASM build for flipflop timing.

---

## Background: The 7 Open Optimizations

All changes are in `external/libjxl-012/lib/jxl/`:

| # | File(s) | Summary |
|---|---------|---------|
| 1+2 | `dec_group.cc:439-585` | Component-aware qblock clear + per-channel DC-only gate |
| 3 | `dec_group.cc:280-312` | `DequantSingleBlock` template for covered_blocks==1 |
| 4 | `dec_cache.h`, `dec_group.cc` | Persistent AC-nonzero sidecar for progressive redraws |
| 7 | `dec_cache.h`, `dec_cache.cc` | Phase-separated cache allocation methods |
| 9 | `dec_group.cc`, `dec_modular.h` | JPEG `NeedsGroupRenderInput()` conditional |
| 10 | `dec_group.cc:1112-1150` | `JpegGroupParams` hoisted from per-group to per-call |

**Critical CfL invariant for #1+#2:** When X/B AC coefficients are all zero but `x_cc_mul ≠ 0`, the pixel output is NOT pure DC — it includes `x_cc_mul × Y_dequant[k]` for all k. So `dc_only[X]` is only valid when `no_cfl` OR when `dc_only[Y]` (CfL contribution from Y AC is zero). The plan respects this.

---

## File Map

| File | Role | Tasks |
|------|------|-------|
| `external/libjxl-012/lib/jxl/dec_group.cc` | Main change surface | 1,2,3,4,9,10 |
| `external/libjxl-012/lib/jxl/dec_cache.h` | GroupDecCache struct | 4,7 |
| `external/libjxl-012/lib/jxl/dec_cache.cc` | GroupDecCache::InitOnce | 7 |
| `external/libjxl-012/lib/jxl/dec_modular.h` | NeedsGroupRenderInput() | 9 |
| `tools/dec-work-elim-verify.mjs` | SHA verification harness | created in Task 0 |
| `tools/dec-work-elim-flipflop.mjs` | Timing flipflop harness | created in Task 8 |

---

## Task 0: Build Baseline + Verification Harness

**Files:**
- Create: `tools/dec-work-elim-verify.mjs`

- [ ] **Step 1: Verify native build works on current branch**

```powershell
cd C:\Foo\raw-converter-wasm
.\build-msvc.ps1 build --release -p djxl 2>&1 | Select-Object -Last 5
```

Expected: `Compiling djxl ...` then `Finished release`. If build fails, stop and fix before proceeding.

- [ ] **Step 2: Collect baseline SHA hashes for reference JXL files**

Identify 3–5 reference JXL files (use files from `web/` or test fixtures):

```powershell
# List available JXL test files
Get-ChildItem -Recurse -Filter "*.jxl" C:\Foo\raw-converter-wasm\web | Select-Object -First 8 FullName
```

Then decode each with the CURRENT (pre-change) djxl and hash the output:

```powershell
$djxl = "C:\Foo\raw-converter-wasm\target\release\djxl.exe"
$files = Get-ChildItem -Recurse -Filter "*.jxl" C:\Foo\raw-converter-wasm\web | Select-Object -First 5
foreach ($f in $files) {
  & $djxl $f.FullName "$env:TEMP\dec_verify_out.png" 2>$null
  $hash = (Get-FileHash "$env:TEMP\dec_verify_out.png" -Algorithm SHA256).Hash
  Write-Output "$hash  $($f.Name)"
}
```

**Save this output** — it is the baseline for all subsequent byte-exact checks. Paste it into a file:

```
docs/dec-work-elim-baseline-sha256.txt
```

- [ ] **Step 3: Write the verification script**

Create `tools/dec-work-elim-verify.mjs`:

```js
#!/usr/bin/env node
// Byte-exact decoder verification harness.
// Usage: node tools/dec-work-elim-verify.mjs
// Decodes reference JXL files with the current native build and compares
// SHA-256 hashes against the baseline in docs/dec-work-elim-baseline-sha256.txt.
// Exit 0 = all pass. Exit 1 = mismatch (prints diff).

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import os from 'os';

const REPO = new URL('..', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const DJXL = join(REPO, 'target', 'release', 'djxl.exe');
const BASELINE = join(REPO, 'docs', 'dec-work-elim-baseline-sha256.txt');
const TMP = join(os.tmpdir(), 'dec_verify_out.png');

const baseline = Object.fromEntries(
  readFileSync(BASELINE, 'utf8').trim().split('\n')
    .map(l => { const [hash, name] = l.split('  '); return [name.trim(), hash]; })
);

let pass = 0, fail = 0;
for (const [name, expected] of Object.entries(baseline)) {
  // Find the file anywhere under web/
  const found = execSync(`where /r "${join(REPO, 'web')}" "${name}"`, { encoding: 'utf8' }).trim().split('\n')[0];
  if (!found) { console.error(`SKIP: ${name} not found`); continue; }
  execSync(`"${DJXL}" "${found.trim()}" "${TMP}"`, { stdio: 'pipe' });
  const actual = createHash('sha256').update(readFileSync(TMP)).digest('hex').toUpperCase();
  if (actual === expected) {
    console.log(`PASS  ${name}`);
    pass++;
  } else {
    console.error(`FAIL  ${name}`);
    console.error(`  expected: ${expected}`);
    console.error(`  actual:   ${actual}`);
    fail++;
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
```

- [ ] **Step 4: Run verification against baseline (must pass)**

```powershell
node tools/dec-work-elim-verify.mjs
```

Expected: all `PASS`, `N passed, 0 failed`.

- [ ] **Step 5: Commit baseline + harness**

```powershell
git add docs/dec-work-elim-baseline-sha256.txt tools/dec-work-elim-verify.mjs
git commit -m "tools: dec-work-elim verify harness + SHA baseline"
```

---

## Task 1: #1+#2 — Component-Aware qblock Clear + Extended dc_only Gate

**Files:**
- Modify: `external/libjxl-012/lib/jxl/dec_group.cc:425-585`

This is the highest-impact change. Adds `active_x`/`active_b` flags, makes qblock clearing per-channel, extends dc_only detection to check X/B independently with correct CfL dependency, and narrows the skip-dequant gate.

- [ ] **Step 1: Write the failing test (byte mismatch)**

Before editing, confirm the current binary produces the expected baseline:

```powershell
node tools/dec-work-elim-verify.mjs
```

Expected: all PASS. This is the "green baseline" before the change.

- [ ] **Step 2: Apply the change to dec_group.cc**

In `external/libjxl-012/lib/jxl/dec_group.cc`, inside `DecodeGroupImpl`, locate the block starting at the `ACPtr qblock[3];` declaration (line ~439). Insert `active_x`/`active_b` computation and replace qblock clearing:

**Find (lines ~424-457):**
```cpp
        size_t sbx[3] = {bx >> hshift[0], bx >> hshift[1], bx >> hshift[2]};
        AcStrategy acs = acs_row[bx];
        const size_t llf_x = acs.covered_blocks_x();

        // Can only happen in the second or lower rows of a varblock.
        if (JXL_UNLIKELY(!acs.IsFirstBlock())) {
          bx += llf_x;
          continue;
        }
        const size_t log2_covered_blocks = acs.log2_covered_blocks();

        const size_t covered_blocks = 1 << log2_covered_blocks;
        const size_t size = covered_blocks * kDCTBlockSize;

        ACPtr qblock[3];
        if (accumulate) {
          for (size_t c = 0; c < 3; c++) {
            qblock[c] = dec_state->coefficients->PlaneRow(c, group_idx, offset);
          }
        } else {
          if (ac_type == ACType::k16) {
            memset(group_dec_cache->dec_group_qblock16, 0,
                   size * 3 * sizeof(int16_t));
            for (size_t c = 0; c < 3; c++) {
              qblock[c].ptr16 = group_dec_cache->dec_group_qblock16 + c * size;
            }
          } else {
            memset(group_dec_cache->dec_group_qblock, 0,
                   size * 3 * sizeof(int32_t));
            for (size_t c = 0; c < 3; c++) {
              qblock[c].ptr32 = group_dec_cache->dec_group_qblock + c * size;
            }
          }
        }
```

**Replace with:**
```cpp
        size_t sbx[3] = {bx >> hshift[0], bx >> hshift[1], bx >> hshift[2]};
        AcStrategy acs = acs_row[bx];
        const size_t llf_x = acs.covered_blocks_x();

        // Can only happen in the second or lower rows of a varblock.
        if (JXL_UNLIKELY(!acs.IsFirstBlock())) {
          bx += llf_x;
          continue;
        }
        const size_t log2_covered_blocks = acs.log2_covered_blocks();

        const size_t covered_blocks = 1 << log2_covered_blocks;
        const size_t size = covered_blocks * kDCTBlockSize;

        // Active channels: X and B are absent in subsampled positions.
        // Y (c=1) is always active (luma is never subsampled).
        const bool active_x =
            (sbx[0] << hshift[0] == bx) && (sby[0] << vshift[0] == by);
        const bool active_b =
            (sbx[2] << hshift[2] == bx) && (sby[2] << vshift[2] == by);

        ACPtr qblock[3];
        if (accumulate) {
          for (size_t c = 0; c < 3; c++) {
            qblock[c] = dec_state->coefficients->PlaneRow(c, group_idx, offset);
          }
        } else {
          // Only clear qblock planes for active channels. Inactive X/B stale
          // data is never dequantised or rendered, so clearing is wasteful.
          if (ac_type == ACType::k16) {
            if (active_x)
              memset(group_dec_cache->dec_group_qblock16 + 0 * size, 0,
                     size * sizeof(int16_t));
            memset(group_dec_cache->dec_group_qblock16 + 1 * size, 0,
                   size * sizeof(int16_t));
            if (active_b)
              memset(group_dec_cache->dec_group_qblock16 + 2 * size, 0,
                     size * sizeof(int16_t));
            for (size_t c = 0; c < 3; c++) {
              qblock[c].ptr16 = group_dec_cache->dec_group_qblock16 + c * size;
            }
          } else {
            if (active_x)
              memset(group_dec_cache->dec_group_qblock + 0 * size, 0,
                     size * sizeof(int32_t));
            memset(group_dec_cache->dec_group_qblock + 1 * size, 0,
                   size * sizeof(int32_t));
            if (active_b)
              memset(group_dec_cache->dec_group_qblock + 2 * size, 0,
                     size * sizeof(int32_t));
            for (size_t c = 0; c < 3; c++) {
              qblock[c].ptr32 = group_dec_cache->dec_group_qblock + c * size;
            }
          }
        }
```

- [ ] **Step 3: Replace the dc_only detection block**

**Find (lines ~465-485):**
```cpp
        // DC-only fast path: detect channels where all AC coefficients are zero.
        // Fires on ~89% X, ~86% B, and ~2-49% Y blocks in real photos.
        bool dc_only[3] = {false, false, false};
        if (JXL_LIKELY(!jpeg_data) && JXL_LIKELY(covered_blocks == 1)) {
          for (size_t c = 0; c < 3; c++) {
            if (c != 1 && !no_cfl) continue;
            bool all_zero = true;
            if (ac_type == ACType::k16) {
              const int16_t* JXL_RESTRICT p = qblock[c].ptr16;
              for (size_t k = 1; k < size; k++) {
                if (p[k]) { all_zero = false; break; }
              }
            } else {
              const int32_t* JXL_RESTRICT p = qblock[c].ptr32;
              for (size_t k = 1; k < size; k++) {
                if (p[k]) { all_zero = false; break; }
              }
            }
            dc_only[c] = all_zero;
          }
        }
```

**Replace with:**
```cpp
        // DC-only fast path: detect channels where all AC coefficients are zero.
        // Fires on ~89% X, ~86% B, and ~2-49% Y blocks in real photos.
        // X/B dc_only is valid only when no_cfl OR dc_only[Y]: with CfL active,
        // X output at AC positions = x_cc_mul * Y_dequant[k], which is nonzero
        // if Y has AC. Once Y is known DC-only, that CfL contribution is zero.
        bool dc_only[3] = {false, false, false};
        if (JXL_LIKELY(!jpeg_data) && JXL_LIKELY(covered_blocks == 1)) {
          auto scan_ac_zero = [&](size_t c) -> bool {
            if (ac_type == ACType::k16) {
              const int16_t* JXL_RESTRICT p = qblock[c].ptr16;
              for (size_t k = 1; k < size; k++) {
                if (p[k]) return false;
              }
            } else {
              const int32_t* JXL_RESTRICT p = qblock[c].ptr32;
              for (size_t k = 1; k < size; k++) {
                if (p[k]) return false;
              }
            }
            return true;
          };
          // Check Y first; its result unlocks X/B when CfL is active.
          dc_only[1] = scan_ac_zero(1);
          // X: safe to DC-fill when inactive, or when no CfL, or Y is DC-only.
          if (active_x && (no_cfl || dc_only[1])) dc_only[0] = scan_ac_zero(0);
          // B: same rule.
          if (active_b && (no_cfl || dc_only[1])) dc_only[2] = scan_ac_zero(2);
        }
```

- [ ] **Step 4: Replace the skip-dequant gate**

**Find (line ~556):**
```cpp
          // Skip dequant entirely when all three channels are DC-only.
          if (JXL_LIKELY(!(dc_only[0] && dc_only[1] && dc_only[2]))) {
```

**Replace with:**
```cpp
          // Skip dequant when Y is DC-only and all active chroma channels are
          // either inactive (subsampled) or also DC-only.
          const bool skip_dequant = dc_only[1] &&
                                    (!active_x || dc_only[0]) &&
                                    (!active_b || dc_only[2]);
          if (JXL_LIKELY(!skip_dequant)) {
```

- [ ] **Step 5: Build and verify byte-exact**

```powershell
cd C:\Foo\raw-converter-wasm
.\build-msvc.ps1 build --release -p djxl 2>&1 | Select-Object -Last 3
node tools/dec-work-elim-verify.mjs
```

Expected: build succeeds + all PASS (0 failed).

- [ ] **Step 6: Commit**

```powershell
cd C:\Foo\raw-converter-wasm\external\libjxl-012
git add lib/jxl/dec_group.cc
git commit -m "perf(dec_group): component-aware qblock clear + extended dc_only gate

- Only memset active X/B qblock planes; inactive channels under 4:2:0
  or 4:2:2 never consume their stale data (dequant skipped or inactive).
- dc_only[X/B] now checked independently: valid when no_cfl OR dc_only[Y]
  (CfL contribution from Y is zero when Y itself is DC-only).
- skip_dequant gate: dc_only[Y] && (!active_x || dc_only[X]) && (!active_b || dc_only[B])
  instead of requiring all three to be DC-only.
- Byte-exact: verified SHA-256 of decoded output unchanged across 5 reference JXL."
```

---

## Task 2: #3 — DequantSingleBlock Template Specialization

**Files:**
- Modify: `external/libjxl-012/lib/jxl/dec_group.cc:280-312, ~349-564`

For `covered_blocks == 1` (size=64, the dominant case), the compiler can constant-fold the SIMD loop count and eliminate the `LowestFrequenciesFromDC` branch. This is purely mechanical.

- [ ] **Step 1: Add DequantSingleBlock after DequantBlock**

In `dec_group.cc`, immediately after the closing `}` of `DequantBlock` (line ~312), insert:

```cpp
// Specialisation of DequantBlock for the common covered_blocks == 1 case.
// The constant kDCTBlockSize (64) lets the compiler unroll and elide the
// LowestFrequenciesFromDC branch entirely.
template <ACType ac_type>
void DequantSingleBlock(float inv_global_scale, int quant, float x_dm_multiplier,
                        float b_dm_multiplier, Vec<D> x_cc_mul, Vec<D> b_cc_mul,
                        AcStrategyType kind, const Quantizer& quantizer,
                        const size_t* sbx,
                        const float* JXL_RESTRICT* JXL_RESTRICT dc_row,
                        const float* JXL_RESTRICT biases,
                        ACPtr qblock[3], float* JXL_RESTRICT block,
                        float* JXL_RESTRICT scratch) {
  constexpr size_t kSize = kDCTBlockSize;  // 64
  const auto scaled_dequant_s = inv_global_scale / quant;
  const auto scaled_dequant_x = Set(d, scaled_dequant_s * x_dm_multiplier);
  const auto scaled_dequant_y = Set(d, scaled_dequant_s);
  const auto scaled_dequant_b = Set(d, scaled_dequant_s * b_dm_multiplier);
  const float* dequant_matrices = quantizer.DequantMatrix(kind, 0);
  for (size_t k = 0; k < kSize; k += Lanes(d)) {
    DequantLane<ac_type>(scaled_dequant_x, scaled_dequant_y, scaled_dequant_b,
                         dequant_matrices, kSize, k, x_cc_mul, b_cc_mul, biases,
                         qblock, block);
  }
  // Direct DC overwrite (no LowestFrequenciesFromDC for single-block).
  block[0]          = dc_row[0][sbx[0]];
  block[kSize]      = dc_row[1][sbx[1]];
  block[2 * kSize]  = dc_row[2][sbx[2]];
  (void)scratch;  // unused for single block
}
```

Note: `DequantSingleBlock` signature drops `size` and `covered_blocks` (both compile-time constants) and `dc_stride` (unused when `covered_blocks == 1`).

- [ ] **Step 2: Add single-block function pointer + dispatch in DecodeGroupImpl**

In `DecodeGroupImpl`, immediately after the existing `dequant_block` pointer declaration (line ~350):

```cpp
  auto dequant_block = ac_type == ACType::k16 ? DequantBlock<ACType::k16>
                                              : DequantBlock<ACType::k32>;
```

Add:

```cpp
  auto dequant_single_block =
      ac_type == ACType::k16 ? DequantSingleBlock<ACType::k16>
                             : DequantSingleBlock<ACType::k32>;
```

Then find the dequant call site (line ~556-565):

```cpp
          const bool skip_dequant = dc_only[1] &&
                                    (!active_x || dc_only[0]) &&
                                    (!active_b || dc_only[2]);
          if (JXL_LIKELY(!skip_dequant)) {
            dequant_block(
                inv_global_scale, row_quant[bx], dec_state->x_dm_multiplier,
                dec_state->b_dm_multiplier, x_cc_mul, b_cc_mul, acs.Strategy(),
                size, dec_state->shared->quantizer,
                acs.covered_blocks_y() * acs.covered_blocks_x(), sbx, dc_rows,
                dc_stride,
                dec_state->output_encoding_info.opsin_params.quant_biases, qblock,
                block, group_dec_cache->scratch_space);
          }
```

Replace the inner call with:

```cpp
          const bool skip_dequant = dc_only[1] &&
                                    (!active_x || dc_only[0]) &&
                                    (!active_b || dc_only[2]);
          if (JXL_LIKELY(!skip_dequant)) {
            if (JXL_LIKELY(covered_blocks == 1)) {
              dequant_single_block(
                  inv_global_scale, row_quant[bx], dec_state->x_dm_multiplier,
                  dec_state->b_dm_multiplier, x_cc_mul, b_cc_mul, acs.Strategy(),
                  dec_state->shared->quantizer, sbx, dc_rows,
                  dec_state->output_encoding_info.opsin_params.quant_biases,
                  qblock, block, group_dec_cache->scratch_space);
            } else {
              dequant_block(
                  inv_global_scale, row_quant[bx], dec_state->x_dm_multiplier,
                  dec_state->b_dm_multiplier, x_cc_mul, b_cc_mul, acs.Strategy(),
                  size, dec_state->shared->quantizer,
                  acs.covered_blocks_y() * acs.covered_blocks_x(), sbx, dc_rows,
                  dc_stride,
                  dec_state->output_encoding_info.opsin_params.quant_biases,
                  qblock, block, group_dec_cache->scratch_space);
            }
          }
```

- [ ] **Step 3: Build and verify byte-exact**

```powershell
.\build-msvc.ps1 build --release -p djxl 2>&1 | Select-Object -Last 3
node tools/dec-work-elim-verify.mjs
```

Expected: all PASS.

- [ ] **Step 4: Commit**

```powershell
cd C:\Foo\raw-converter-wasm\external\libjxl-012
git add lib/jxl/dec_group.cc
git commit -m "perf(dec_group): DequantSingleBlock specialisation for covered_blocks==1

Separate code path when covered_blocks==1 (size=64 constant). Compiler
constant-folds loop bound, eliminates LowestFrequenciesFromDC branch,
drops dc_stride/covered_blocks params. Byte-exact."
```

---

## Task 3: #10 — Hoist JpegGroupParams Computation (Per-Call, Not Per-Group)

**Files:**
- Modify: `external/libjxl-012/lib/jxl/dec_group.cc:1112-1150`

The comment at line 1139 already says "once per frame (not per group)" but `PrepareJpegGroupParams` is called inside `DecodeGroup` for every group. Fix: compute it once per `DecodeGroup` call by hoisting both call sites.

- [ ] **Step 1: Hoist JpegGroupParams computation to top of DecodeGroup**

In `dec_group.cc` find `Status DecodeGroup(`. Before the `render_from_stored_coefficients` check, compute jpeg params once:

**Find (line ~1112):**
```cpp
  const bool render_from_stored_coefficients =
      draw == kDraw && num_passes == 0 && !dec_state->coefficients->IsEmpty();
  if (render_from_stored_coefficients) {
    const JpegGroupParams* jpeg_params_ptr = nullptr;
    JpegGroupParams jpeg_params;
    if (jpeg_data) {
      JXL_ASSIGN_OR_RETURN(
          jpeg_params,
          PrepareJpegGroupParams(frame_header, *dec_state, *jpeg_data));
      jpeg_params_ptr = &jpeg_params;
    }
    return HWY_DYNAMIC_DISPATCH(DecodeGroupFromStoredCoefficients)(
        frame_header, group_dec_cache, dec_state, thread, group_idx,
        render_pipeline_input, jpeg_data, jpeg_params_ptr);
  }
```

And further down (line ~1139):
```cpp
    // Compute JPEG params once per frame (not per group); null when no JPEG.
    const JpegGroupParams* jpeg_params_ptr = nullptr;
    JpegGroupParams jpeg_params;
    if (jpeg_data) {
      JXL_ASSIGN_OR_RETURN(jpeg_params,
                           PrepareJpegGroupParams(frame_header, *dec_state,
                                                  *jpeg_data));
      jpeg_params_ptr = &jpeg_params;
    }
```

**Replace BOTH occurrences** by hoisting to a single computation before the `render_from_stored_coefficients` check:

```cpp
  // PrepareJpegGroupParams is invariant across groups; compute once per call.
  const JpegGroupParams* jpeg_params_ptr = nullptr;
  JpegGroupParams jpeg_params;
  if (jpeg_data) {
    JXL_ASSIGN_OR_RETURN(
        jpeg_params,
        PrepareJpegGroupParams(frame_header, *dec_state, *jpeg_data));
    jpeg_params_ptr = &jpeg_params;
  }

  const bool render_from_stored_coefficients =
      draw == kDraw && num_passes == 0 && !dec_state->coefficients->IsEmpty();
  if (render_from_stored_coefficients) {
    return HWY_DYNAMIC_DISPATCH(DecodeGroupFromStoredCoefficients)(
        frame_header, group_dec_cache, dec_state, thread, group_idx,
        render_pipeline_input, jpeg_data, jpeg_params_ptr);
  }
```

Then remove the second `JpegGroupParams jpeg_params; if (jpeg_data) { ... }` block that was inside the `draw == kDraw` branch.

- [ ] **Step 2: Build and verify byte-exact**

```powershell
.\build-msvc.ps1 build --release -p djxl 2>&1 | Select-Object -Last 3
node tools/dec-work-elim-verify.mjs
```

Expected: all PASS.

- [ ] **Step 3: Commit**

```powershell
cd C:\Foo\raw-converter-wasm\external\libjxl-012
git add lib/jxl/dec_group.cc
git commit -m "perf(dec_group): hoist JpegGroupParams from per-branch to per-call

PrepareJpegGroupParams is invariant across all code paths within one
DecodeGroup call. Compute once, share across stored-coeff and bitstream
branches. Resolves existing TODO comment."
```

---

## Task 4: #9 — JPEG NeedsGroupRenderInput Conditional

**Files:**
- Modify: `external/libjxl-012/lib/jxl/dec_modular.h`
- Modify: `external/libjxl-012/lib/jxl/dec_group.cc` (idct_stride setup for JPEG)

This avoids the unnecessary `render_pipeline_input.GetBuffer()` call for the JPEG path when modular reconstruction uses the full image (most JPEG lossless roundtrips). Low-risk, API-additive only.

- [ ] **Step 1: Add NeedsGroupRenderInput() to ModularFrameDecoder**

In `external/libjxl-012/lib/jxl/dec_modular.h`, find the `class ModularFrameDecoder` declaration. Add a public method:

```cpp
  // Returns true when DecodeGroup() needs a valid RenderPipelineInput.
  // False when full_image is used: modular output goes through image planes,
  // not the pipeline input buffers, and JPEG reconstruction does not use
  // idct_row either.
  bool NeedsGroupRenderInput() const { return !use_full_image_; }
```

(Check the exact field name — it may be `use_full_image` not `use_full_image_`. Match the existing naming convention.)

- [ ] **Step 2: Verify the guard in dec_group.cc**

In `DecodeGroupImpl`, the `idct_row` setup is:

```cpp
    for (size_t c = 0; c < 3; c++) {
      const auto& buffer = render_pipeline_input.GetBuffer(c);
      idct_row[c] = buffer.second.Row(buffer.first, sby[c] * kBlockDim);
      if (jpeg_data) { ... }
    }
```

When `jpeg_data` is non-null, `idct_row[c]` is set but never used (JPEG writes to `jpeg_row[c]` instead). Add a guard:

**Find the idct_row setup inside the `for (size_t by ...)` loop:**
```cpp
    float* JXL_RESTRICT idct_row[3];
    int16_t* JXL_RESTRICT jpeg_row[3];
    for (size_t c = 0; c < 3; c++) {
      const auto& buffer = render_pipeline_input.GetBuffer(c);
      idct_row[c] = buffer.second.Row(buffer.first, sby[c] * kBlockDim);
      if (jpeg_data) {
```

**Replace with:**
```cpp
    float* JXL_RESTRICT idct_row[3];
    int16_t* JXL_RESTRICT jpeg_row[3];
    for (size_t c = 0; c < 3; c++) {
      if (JXL_LIKELY(!jpeg_data)) {
        const auto& buffer = render_pipeline_input.GetBuffer(c);
        idct_row[c] = buffer.second.Row(buffer.first, sby[c] * kBlockDim);
      } else {
        idct_row[c] = nullptr;  // JPEG path never uses idct_row
      }
      if (jpeg_data) {
```

This avoids buffer lookups on the JPEG path without changing JPEG output.

- [ ] **Step 3: Build and verify byte-exact**

```powershell
.\build-msvc.ps1 build --release -p djxl 2>&1 | Select-Object -Last 3
node tools/dec-work-elim-verify.mjs
```

Expected: all PASS. Note: if your reference JXL files don't include JPEG-reconstructable files, this is structurally correct but the test coverage is limited. That's acceptable.

- [ ] **Step 4: Commit**

```powershell
cd C:\Foo\raw-converter-wasm\external\libjxl-012
git add lib/jxl/dec_group.cc lib/jxl/dec_modular.h
git commit -m "perf(dec_group): skip idct_row buffer lookup on JPEG reconstruction path

JPEG writes to jpeg_row[c], never idct_row. Add NeedsGroupRenderInput()
predicate to ModularFrameDecoder for future per-group input elision."
```

---

## Task 5: #7 — Phase-Separated GroupDecCache Allocation

**Files:**
- Modify: `external/libjxl-012/lib/jxl/dec_cache.h`
- Modify: `external/libjxl-012/lib/jxl/dec_cache.cc`

Refactor `InitOnce` into two concern-separated methods so callers that don't need entropy predictors (stored-coefficient redraws) don't allocate them. Low code-risk: purely additive API, same logic.

- [ ] **Step 1: Add EnsureEntropyPredictors and EnsureRenderWorkspace to dec_cache.h**

In `dec_cache.h`, find `struct GroupDecCache`. Replace the `Status InitOnce(...)` declaration with three declarations:

```cpp
  // Allocates entropy predictor planes (num_nzeroes) for the given pass count.
  // Called before any entropy-coded group decode. No-op if already large enough.
  Status EnsureEntropyPredictors(JxlMemoryManager* memory_manager,
                                 size_t num_passes);

  // Allocates dequant/scratch arena sized for the given used_acs bitmask.
  // Called before any group that needs dequantisation or transform scratch.
  // No-op if the existing arena is large enough.
  Status EnsureRenderWorkspace(JxlMemoryManager* memory_manager,
                               size_t used_acs);

  // Convenience: calls both of the above. Preserves the existing call sites.
  Status InitOnce(JxlMemoryManager* memory_manager, size_t num_passes,
                  size_t used_acs) {
    JXL_RETURN_IF_ERROR(EnsureEntropyPredictors(memory_manager, num_passes));
    JXL_RETURN_IF_ERROR(EnsureRenderWorkspace(memory_manager, used_acs));
    return true;
  }
```

- [ ] **Step 2: Split InitOnce in dec_cache.cc into the two new methods**

In `dec_cache.cc`, split `GroupDecCache::InitOnce` body into two functions:

```cpp
Status GroupDecCache::EnsureEntropyPredictors(JxlMemoryManager* memory_manager,
                                              size_t num_passes) {
  for (size_t i = 0; i < num_passes; i++) {
    if (num_nzeroes[i].xsize() == 0) {
      JXL_ASSIGN_OR_RETURN(
          num_nzeroes[i],
          Image3<uint8_t>::Create(memory_manager, kGroupDimInBlocks,
                                  kGroupDimInBlocks));
    }
  }
  return true;
}

Status GroupDecCache::EnsureRenderWorkspace(JxlMemoryManager* memory_manager,
                                            size_t used_acs) {
  size_t max_block_area = 0;
  for (uint8_t o = 0; o < AcStrategy::kNumValidStrategies; ++o) {
    AcStrategy acs = AcStrategy::FromRawStrategy(o);
    if ((used_acs & (1 << o)) == 0) continue;
    size_t area =
        acs.covered_blocks_x() * acs.covered_blocks_y() * kDCTBlockSize;
    max_block_area = std::max(area, max_block_area);
  }
  if (max_block_area > max_block_area_) {
    AlignedMemory new_memory;
    JXL_ASSIGN_OR_RETURN(
        new_memory,
        AlignedMemory::Create(memory_manager,
                              max_block_area * 7 * sizeof(float)));
    float_memory_ = std::move(new_memory);
    max_block_area_ = max_block_area;
  }
  dec_group_block = float_memory_.address<float>();
  scratch_space = dec_group_block + max_block_area_ * 3;
  dec_group_qblock = float_memory_.address<int32_t>() + max_block_area_ * 3;
  dec_group_qblock16 = float_memory_.address<int16_t>() + max_block_area_ * 6;
  return true;
}
```

Remove the old `GroupDecCache::InitOnce` body (now replaced by `InitOnce` inline in the header calling both methods).

- [ ] **Step 3: Build and verify byte-exact**

```powershell
.\build-msvc.ps1 build --release -p djxl 2>&1 | Select-Object -Last 3
node tools/dec-work-elim-verify.mjs
```

Expected: all PASS.

- [ ] **Step 4: Commit**

```powershell
cd C:\Foo\raw-converter-wasm\external\libjxl-012
git add lib/jxl/dec_cache.h lib/jxl/dec_cache.cc
git commit -m "refactor(dec_cache): split InitOnce into EnsureEntropyPredictors + EnsureRenderWorkspace

Separates entropy predictor allocation from render workspace allocation so
callers that only need one (e.g., stored-coeff redraws skip entropy planes)
can call the narrower method. InitOnce() preserved as a convenience wrapper.
No behavioral change."
```

---

## Task 6: #4 — Persistent AC-Nonzero Sidecar for Progressive Redraws

**Files:**
- Modify: `external/libjxl-012/lib/jxl/dec_cache.h` (add sidecar field)
- Modify: `external/libjxl-012/lib/jxl/dec_group.cc` (populate on decode, use on redraw)

This enables the stored-coefficient render path (`DecodeGroupFromStoredCoefficients`) to skip dequant for all-AC-zero blocks without re-scanning the coefficient image. Effect only visible in progressive decode scenarios.

- [ ] **Step 1: Add the sidecar field to PassesDecoderState in dec_cache.h**

In `dec_cache.h`, find `struct PassesDecoderState`. After `std::unique_ptr<ACImage> coefficients`:

```cpp
  // Per-block AC-occupancy sidecar for the coefficient store. One uint8_t per
  // block: bit 0 = X has nonzero AC, bit 1 = Y has nonzero AC, bit 2 = B has
  // nonzero AC. OR'd across all accumulated passes. Valid only when
  // !coefficients->IsEmpty(). Index: group_idx * group_blocks + block_offset.
  // Allocated lazily alongside coefficients in DecodeGroup.
  std::vector<uint8_t> ac_occupancy;
```

- [ ] **Step 2: Populate sidecar during accumulate-mode decode in DecodeGroupImpl**

In `dec_group.cc`, inside `DecodeGroupImpl`, in the `if constexpr (kReadCoefficients)` block — just after `offset += size;` (line ~463), add population when accumulate mode is on:

```cpp
        offset += size;

        // Populate AC-occupancy sidecar for progressive redraw optimisation.
        if (kReadCoefficients && accumulate) {
          // Block index within this group: offset was just advanced by size,
          // so the current block started at offset - size.
          const size_t block_start = offset - size;
          uint8_t mask = 0;
          if (ac_type == ACType::k16) {
            for (size_t k = covered_blocks; k < size; k++) {
              if (qblock[0].ptr16[k]) mask |= 0x1;
              if (qblock[1].ptr16[k]) mask |= 0x2;
              if (qblock[2].ptr16[k]) mask |= 0x4;
              if (mask == 0x7) break;  // all channels nonzero, early exit
            }
          } else {
            for (size_t k = covered_blocks; k < size; k++) {
              if (qblock[0].ptr32[k]) mask |= 0x1;
              if (qblock[1].ptr32[k]) mask |= 0x2;
              if (qblock[2].ptr32[k]) mask |= 0x4;
              if (mask == 0x7) break;
            }
          }
          // OR into sidecar to accumulate across passes.
          if (block_start < dec_state->ac_occupancy.size()) {
            dec_state->ac_occupancy[block_start / kDCTBlockSize] |= mask;
          }
        }
```

Note: the sidecar is indexed by `block_start / kDCTBlockSize` (coefficient offset → block index). This requires the sidecar to be pre-sized.

- [ ] **Step 3: Pre-size the sidecar in DecodeGroup**

In `dec_group.cc`, find `Status DecodeGroup(...)`. After the `group_dec_cache->InitOnce(...)` call, add sidecar sizing when accumulate mode is active:

```cpp
  // Pre-size the AC-occupancy sidecar when coefficients are being accumulated.
  // Total coefficient count for this group drives the block count.
  if (!dec_state->coefficients->IsEmpty()) {
    const size_t group_coeff_count =
        dec_state->coefficients->PlaneRow(0, group_idx, 0) == nullptr
            ? 0
            : /* compute per-group block count */ 0;  // see note below
    // Simpler: size globally on first call.
    // Total groups × max blocks per group is an overestimate but safe.
    const size_t total_blocks =
        dec_state->shared->frame_dim.num_groups *
        kGroupDimInBlocks * kGroupDimInBlocks;
    if (dec_state->ac_occupancy.size() < total_blocks) {
      dec_state->ac_occupancy.assign(total_blocks, 0);
    }
  }
```

> **Implementation note:** The sidecar indexing (`block_start / kDCTBlockSize`) uses the flat coefficient offset within the group. Verify this matches how coefficients are stored by `ACImageT::PlaneRow`. If the offset resets to 0 per group, the sidecar index needs to be `group_idx * max_blocks_per_group + block_start / kDCTBlockSize`. Adjust accordingly before committing.

- [ ] **Step 4: Use sidecar in DecodeGroupFromStoredCoefficients (future use)**

This step is a no-op in the code (the sidecar is populated but not yet consumed in this task). Add a TODO comment in `DecodeGroupFromStoredCoefficients` body:

```cpp
  // TODO: use dec_state->ac_occupancy[...] to skip dequant for
  // all-AC-zero blocks in stored-coefficient redraws.
```

- [ ] **Step 5: Build and verify byte-exact**

```powershell
.\build-msvc.ps1 build --release -p djxl 2>&1 | Select-Object -Last 3
node tools/dec-work-elim-verify.mjs
```

Expected: all PASS. The sidecar adds overhead during accumulate-mode encode (populate pass) but does not change output.

- [ ] **Step 6: Commit**

```powershell
cd C:\Foo\raw-converter-wasm\external\libjxl-012
git add lib/jxl/dec_cache.h lib/jxl/dec_group.cc
git commit -m "feat(dec_group): persistent AC-occupancy sidecar for progressive redraws

Adds ac_occupancy vector to PassesDecoderState. During accumulate-mode
decode, records per-block nonzero-AC bitmask (bits 0/1/2 = X/Y/B).
OR'd across passes. Enables future DecodeGroupFromStoredCoefficients
optimisation to skip dequant for all-AC-zero blocks. No output change."
```

---

## Task 7: Commit Submodule Bump to Superproject

After all 6 optimization tasks pass verification, record the submodule HEAD in the superproject.

- [ ] **Step 1: Bump submodule in superproject**

```powershell
cd C:\Foo\raw-converter-wasm
git add external/libjxl-012
git commit -m "chore: bump libjxl-012 to dec-group work-elimination optimizations (#1+#2 component-aware qblock, #3 DequantSingleBlock, #4 AC-occupancy sidecar, #7 phase-split cache, #9 JPEG idct guard, #10 JpegGroupParams hoist)"
```

---

## Task 8: Flipflop Timing Harness (OLD vs NEW)

**Files:**
- Create: `tools/dec-work-elim-flipflop.mjs`
- Build target: `packages/jxl-wasm/` WASM (OLD = pre-Task-1 commit, NEW = current HEAD)

- [ ] **Step 1: Snapshot the OLD WASM binary**

Build WASM at the baseline commit (before Task 1 changes):

```powershell
# Get the commit hash before Task 1
$old_sha = git log --oneline | Where-Object { $_ -match "SHA baseline" } | Select-Object -First 1
# Alternatively: find the commit just before Task 1's change
git log --oneline external/libjxl-012 | head -8
```

Build OLD WASM using Emscripten (see CLAUDE.md build instructions):

```powershell
$env:JXL_WASM_WORKDIR = "$env:TEMP\jxl-wasm-work"
cmd /c "call C:\Users\User\emsdk\emsdk_env.bat >nul && node packages/jxl-wasm/scripts/build.mjs --host-toolchain" 2>&1 | Select-Object -Last 10
```

Copy the OLD build outputs:

```powershell
Copy-Item packages/jxl-wasm/dist/jxl-core.dec.simd-mt.wasm tools/dec-work-elim-old.wasm
Copy-Item packages/jxl-wasm/dist/jxl-core.dec.simd-mt.js   tools/dec-work-elim-old.js
```

- [ ] **Step 2: Build NEW WASM at current HEAD**

(current HEAD already has all 6 optimizations committed)

```powershell
$env:JXL_WASM_WORKDIR = "$env:TEMP\jxl-wasm-work-new"
cmd /c "call C:\Users\User\emsdk\emsdk_env.bat >nul && node packages/jxl-wasm/scripts/build.mjs --host-toolchain" 2>&1 | Select-Object -Last 10
```

Copy NEW outputs:

```powershell
Copy-Item packages/jxl-wasm/dist/jxl-core.dec.simd-mt.wasm tools/dec-work-elim-new.wasm
Copy-Item packages/jxl-wasm/dist/jxl-core.dec.simd-mt.js   tools/dec-work-elim-new.js
```

- [ ] **Step 3: Write the flipflop harness**

Create `tools/dec-work-elim-flipflop.mjs` using the `flipflop` skill for the actual timing script. The flipflop should:
- Use 5 JXL files of different sizes (small/medium/large, 4:4:4 and 4:2:0 if available)
- Alternate OLD→NEW→OLD→NEW... (interleaved) to cancel thermal drift
- Run N=10 reps per size
- Report per-file median decode time for OLD and NEW with Δ%

```powershell
# Invoke the flipflop skill after creating the WASM artifacts
# node tools/dec-work-elim-flipflop.mjs
```

Refer to existing flipflop harnesses (`tools/enc-sha-flipflop.mjs`, `packages/jxl-wasm/test/`) for the WASM loading pattern.

- [ ] **Step 4: Run flipflop and record results**

```powershell
node tools/dec-work-elim-flipflop.mjs | Tee-Object docs/dec-work-elim-flipflop-results.txt
```

Expected: ≥0% improvement on 4:2:0 images (main beneficiary of component-aware qblock). 4:4:4 improvement smaller (mainly DC-only path + DequantSingleBlock constant folding).

- [ ] **Step 5: Commit harness + results**

```powershell
git add tools/dec-work-elim-flipflop.mjs docs/dec-work-elim-flipflop-results.txt
git commit -m "tools: dec-group work-elimination OLD vs NEW flipflop timing harness + results"
```

---

## Self-Review

**Spec coverage:**
- #1 component-aware qblock clear → Task 1 Step 2 ✓
- #2 per-channel DC-only gate → Task 1 Steps 3-4 ✓
- #3 DequantSingleBlock specialization → Task 2 ✓
- #4 persistent AC-occupancy sidecar → Task 6 ✓
- #7 phase-separated cache allocation → Task 5 ✓
- #9 JPEG NeedsGroupRenderInput → Task 4 ✓
- #10 JpegGroupParams hoist → Task 3 ✓
- Harness → Task 0 ✓
- Flipflop timing → Task 8 ✓

**Placeholder scan:** All steps have exact code. Task 6 Step 3 has an inline "implementation note" about sidecar indexing — this is a real ambiguity that requires checking the ACImageT layout before committing, not a missing placeholder.

**Type consistency:** `active_x`/`active_b` defined as `bool` in Task 1, used as `bool` in all subsequent gates. `ac_occupancy` as `std::vector<uint8_t>` in Task 6, indexed consistently. No type drift.
