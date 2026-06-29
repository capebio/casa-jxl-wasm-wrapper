# enc_convolve_separable5 edge-coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add byte-exact edge/geometry coverage to `Separable5` (scalar-tail Mirror elision, border horiz-dedup, dedicated tiny-height kernel, SIMD N/N+1 width-cliff) plus a swallowed-status fix, without regressing the hot full-image path.

**Architecture:** All edits in one submodule file `external/libjxl-012/lib/jxl/enc_convolve_separable5.cc`. Changes 1/3/4 are byte-exact vs the current `Separable5` (same horz function + same accumulation order; dedup only reuses an already-computed `V`, direct-index only replaces a `Mirror` that returns the same value). Change 5 is the one output change (xsize∈{N,N+1}: slow→SIMD, must match `SlowSeparable5` ≤1e-5). A native A/B harness (`tools/conv5_ab.cc`, superproject) is the test; `convolve_test.cc` gtest is authoritative correctness.

**Tech Stack:** C++17, Highway SIMD (`foreach_target`), libjxl cmake/ninja, FNV-1a hashing. Worktree `C:\Foo\rcw-conv5edge`; branch `perf/enc-conv5-edge-coverage-z3k` (both repos).

---

## Isolation / git discipline (applies to EVERY commit)

- Code edits → submodule repo `external/libjxl-012`, branch `perf/enc-conv5-edge-coverage-z3k` (off `10783f7e`).
- Harness / logs / docs → superproject, branch `perf/enc-conv5-edge-coverage-z3k` (off `b4a55047`).
- Commit each repo independently. Push after every task. NEVER commit/push to main, NEVER bump the superproject gitlink. Hand off both branch names at the end.

---

## File structure

- `external/libjxl-012/lib/jxl/enc_convolve_separable5.cc` — MODIFY (all 5 code changes).
- `tools/conv5_ab.cc` — CREATE (superproject; FNV A/B + timing harness).
- `tools/run-conv5-ab.ps1` — CREATE (superproject; build + run OLD-vs-NEW driver).
- `docs/1 rejected optimizations.md` — APPEND if anything is dropped.
- `Questions_deferred.md` — APPEND deferred items.

---

## Task 0: Build baseline (toolchain gate — no code yet)

**Files:** none (environment only).

- [ ] **Step 1: Init the submodule's own third_party deps in the worktree**

Run:
```powershell
cd C:\Foo\rcw-conv5edge\external\libjxl-012
git submodule update --init third_party/highway third_party/brotli third_party/skcms
```
Expected: three submodules checked out (highway is the only hard requirement for convolve; brotli/skcms needed by the full lib link).

- [ ] **Step 2: Configure + build `convolve_test` (MSVC via the repo helper)**

Run (from submodule worktree root):
```powershell
cd C:\Foo\rcw-conv5edge\external\libjxl-012
cmake -G Ninja -B build-ab -DCMAKE_BUILD_TYPE=RelWithDebInfo `
  -DBUILD_TESTING=ON -DJPEGXL_ENABLE_BENCHMARK=OFF `
  -DJPEGXL_ENABLE_DEVTOOLS=OFF -DJPEGXL_ENABLE_TOOLS=OFF `
  -DJPEGXL_ENABLE_DOXYGEN=OFF -DJPEGXL_ENABLE_MANPAGES=OFF
cmake --build build-ab --target convolve_test
```
If `cmake`/`ninja`/`clang` are not on PATH, run inside vcvars: `C:\Foo\raw-converter-wasm\build-msvc.ps1` is the established helper — adapt it to `cmake --build`. Expected: `build-ab/convolve_test.exe` produced.

- [ ] **Step 3: Run convolve_test → record GREEN baseline**

Run:
```powershell
C:\Foo\rcw-conv5edge\external\libjxl-012\build-ab\convolve_test.exe --gtest_filter=*Separable5*:*Convolve*
```
Expected: all PASS (it sweeps xsize 3..39 × ysize 3..15 across every compiled Highway target). Save the summary line.

- [ ] **Step 4: FALLBACK (only if cmake build is infeasible)**

Standalone compile (no cmake), per the memory "jxl-internal.lib bench recipe": compile `tools/conv5_ab.cc` directly with clang, `-I external/libjxl-012 -I external/libjxl-012/third_party/highway`, including `convolve_slow.cc` + `enc_convolve_separable5.cc` + `image.cc` as TUs, providing `jxl_export.h`/version shims. Document the exact command in `tools/run-conv5-ab.ps1`. Do NOT proceed past Task 1 until either path produces a runnable harness.

---

## Task 1: A/B harness (the test) + OLD goldens

**Files:**
- Create: `tools/conv5_ab.cc`
- Create: `tools/run-conv5-ab.ps1`

- [ ] **Step 1: Write `tools/conv5_ab.cc`**

```cpp
// A/B + correctness harness for jxl::Separable5.
// Modes:
//   fnv   : print FNV-1a of Separable5 output for each geometry config
//           (configs that must be byte-exact OLD==NEW; excludes xsize in {N,N+1}).
//   slow  : assert Separable5 matches SlowSeparable5 within 1e-5 for ALL configs,
//           incl. xsize in {N,N+1} (the width-cliff gate).
//   time  : interleaved OLD/NEW-agnostic timing on the full-image config.
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <cmath>
#include <vector>
#include "lib/jxl/base/data_parallel.h"
#include "lib/jxl/base/rect.h"
#include "lib/jxl/convolve.h"
#include "lib/jxl/image.h"
#include "lib/jxl/image_ops.h"
#include "lib/jxl/base/random.h"
#include "lib/jxl/test_memory_manager.h"  // or a local JxlMemoryManager

namespace {
using namespace jxl;

WeightsSeparable5 Lowpass() {
  constexpr float w0 = 0.41714928f, w1 = 0.25539268f, w2 = 0.03603267f;
  return {{HWY_REP4(w0), HWY_REP4(w1), HWY_REP4(w2)},
          {HWY_REP4(w0), HWY_REP4(w1), HWY_REP4(w2)}};
}

uint64_t Fnv(const ImageF& im) {
  uint64_t h = 1469598103934665603ull;
  for (size_t y = 0; y < im.ysize(); ++y) {
    const float* r = im.Row(y);
    const auto* b = reinterpret_cast<const uint8_t*>(r);
    for (size_t i = 0; i < im.xsize() * sizeof(float); ++i) {
      h ^= b[i]; h *= 1099511628211ull;
    }
  }
  return h;
}

struct Cfg { size_t x, y; const char* tag; };

// Geometry configs. Width values 4/5/8/9 hit the N/N+1 cliffs for
// 128-bit/256-bit targets; they are EXCLUDED from the fnv (byte-exact) set
// and included in the slow (tolerance) set.
std::vector<Cfg> Configs(bool include_cliff) {
  std::vector<Cfg> c = {
    {640, 480, "full"}, {641, 480, "full+1"}, {643, 480, "full+3"},
    {640, 1, "h1"}, {640, 2, "h2"}, {640, 3, "h3"}, {640, 4, "h4"},
    {64, 64, "sq"}, {17, 7, "narrow17"}, {33, 33, "odd"},
    {640, 5, "border-heavy"},
  };
  if (include_cliff) {
    for (size_t n : {4u, 5u, 8u, 9u, 16u, 17u})
      c.push_back({n, 32, "cliff"});
  }
  return c;
}
}  // namespace

int main(int argc, char** argv) {
  const char* mode = argc > 1 ? argv[1] : "fnv";
  JxlMemoryManager* mm = jxl::test::MemoryManager();
  const WeightsSeparable5 w = Lowpass();

  if (!strcmp(mode, "fnv") || !strcmp(mode, "slow")) {
    const bool slow = !strcmp(mode, "slow");
    for (const Cfg& cfg : Configs(/*include_cliff=*/slow)) {
      Rng rng(12345 + cfg.x * 131 + cfg.y);
      ImageF in = ImageF::Create(mm, cfg.x, cfg.y).value();
      GenerateImage(rng, &in, 0.0f, 1.0f);
      ImageF out = ImageF::Create(mm, cfg.x, cfg.y).value();
      if (!Separable5(in, Rect(in), w, nullptr, &out)) { printf("FAIL run\n"); return 2; }
      if (slow) {
        ImageF exp = ImageF::Create(mm, cfg.x, cfg.y).value();
        SlowSeparable5(in, Rect(in), w, nullptr, &exp, Rect(exp));
        double maxrel = 0;
        for (size_t y = 0; y < cfg.y; ++y)
          for (size_t x = 0; x < cfg.x; ++x) {
            float a = out.Row(y)[x], b = exp.Row(y)[x];
            double d = std::fabs(a - b) / (std::fabs(b) + 1e-6);
            if (d > maxrel) maxrel = d;
          }
        printf("%-14s %4zux%-4zu maxrel=%.2e %s\n", cfg.tag, cfg.x, cfg.y,
               maxrel, maxrel <= 1e-5 ? "OK" : "**FAIL**");
      } else {
        printf("%-14s %4zux%-4zu fnv=%016llx\n", cfg.tag, cfg.x, cfg.y,
               (unsigned long long)Fnv(out));
      }
    }
    return 0;
  }

  if (!strcmp(mode, "time")) {
    Rng rng(7);
    ImageF in = ImageF::Create(mm, 1024, 1024).value();
    GenerateImage(rng, &in, 0.0f, 1.0f);
    ImageF out = ImageF::Create(mm, 1024, 1024).value();
    const int iters = 200;
    // (timing measured by the PS driver via QPC around the whole process; this
    //  loop just does the work.)
    for (int i = 0; i < iters; ++i) Separable5(in, Rect(in), w, nullptr, &out);
    printf("done %d iters 1024x1024\n", iters);
    return 0;
  }
  printf("unknown mode\n"); return 1;
}
```

(If `test_memory_manager.h` is unavailable in the standalone fallback, substitute a trivial `JxlMemoryManager` returning malloc/free.)

- [ ] **Step 2: Write `tools/run-conv5-ab.ps1`**

```powershell
# Builds conv5_ab against the worktree libjxl, runs fnv/slow, and drives the
# OLD-vs-NEW byte-exact comparison via path-checkout + incremental rebuild.
param([string]$Mode = "fnv")
$ErrorActionPreference = "Stop"
$lib = "C:\Foo\rcw-conv5edge\external\libjxl-012"
$build = "$lib\build-ab"
# Build harness as a cmake target if added, else clang link. Document the
# exact link line discovered in Task 0 here once known.
cmake --build $build --target conv5_ab
& "$build\conv5_ab.exe" $Mode
```

- [ ] **Step 3: Wire `conv5_ab` into the cmake build**

Add to `external/libjxl-012/lib/jxl.cmake` (or the test CMakeLists) a minimal executable target `conv5_ab` linking `jxl-internal` (or `jxl_dec` + `jxl_extras_core`). Keep this edit on the SUBMODULE branch (it is a submodule file) — note it in the handoff as a build-only addition. Alternatively keep `conv5_ab.cc` fully standalone (fallback path) so no submodule CMake edit is needed; PREFER standalone to avoid touching submodule build files.

- [ ] **Step 4: Record OLD goldens**

Run:
```powershell
C:\Foo\rcw-conv5edge\tools\run-conv5-ab.ps1 fnv  > C:\Foo\rcw-conv5edge\tools\conv5_fnv_OLD.txt
```
Expected: one `fnv=...` line per non-cliff config. Commit harness + goldens on the SUPER branch.

```powershell
cd C:\Foo\rcw-conv5edge
git add "tools/conv5_ab.cc" "tools/run-conv5-ab.ps1" "tools/conv5_fnv_OLD.txt"
git commit -m "test(conv5): A/B FNV + tolerance + timing harness; OLD goldens"
git push
```

---

## Task 2: Change 1 — scalar-tail Mirror elision (byte-exact)

**Files:** Modify `external/libjxl-012/lib/jxl/enc_convolve_separable5.cc`

- [ ] **Step 1: Add the shared `ScalarPixel` helper**

Insert as a `private` static method (near `HorzConvolve`):
```cpp
  // One output pixel via the reference 25-tap accumulation. Identical order to
  // the original tail (dy outer, dx inner, mul += row[x']*wx*wy). kMirror=false
  // omits the Mirror() call for interior columns where x+dx is in-range; the
  // index — hence the value — is identical, so output is byte-exact.
  template <bool kMirror>
  static JXL_INLINE float ScalarPixel(const float* const JXL_RESTRICT rows[5],
                                      const int64_t x, const int64_t xsize,
                                      const WeightsSeparable5* weights) {
    float mul = 0.0f;
    for (int64_t dy = -kRadius; dy <= kRadius; ++dy) {
      const float wy = weights->vert[std::abs(dy) * 4];
      const float* JXL_RESTRICT clamped_row = rows[dy + 2];
      for (int64_t dx = -kRadius; dx <= kRadius; ++dx) {
        const float wx = weights->horz[std::abs(dx) * 4];
        const int64_t cx = kMirror ? Mirror(x + dx, xsize) : (x + dx);
        mul += clamped_row[cx] * wx * wy;
      }
    }
    return mul;
  }
```

- [ ] **Step 2: Replace the `ConvolveRow` scalar tail (current lines ~226-242)**

```cpp
    // If mod = 0, the above vector was the last.
    if (kSizeModN != 0) {
      const float* JXL_RESTRICT rows[5] = {row_t2, row_t1, row_m, row_b1,
                                           row_b2};
      // Tail starts at x >= Lanes(d) > kRadius, so x-kRadius >= 0 always; only
      // the final kRadius columns can exceed xsize on the right.
      const int64_t safe_end = static_cast<int64_t>(xsize) - kRadius;
      for (; static_cast<int64_t>(x) < safe_end; ++x) {
        row_out[x] = ScalarPixel<false>(rows, x, xsize, weights);
      }
      for (; x < xsize; ++x) {
        row_out[x] = ScalarPixel<true>(rows, x, xsize, weights);
      }
    }
```

- [ ] **Step 3: Replace the `ConvolveInteriorBand` scalar tail (current lines ~382-404)**

```cpp
    // Scalar remainder: identical 25-term accumulation order to ConvolveRow.
    if (kSizeModN != 0) {
      const int64_t stride = in->PixelsPerRow();
      const int64_t safe_end = xsize - kRadius;
      for (size_t y = y0; y < y1; ++y) {
        const float* const JXL_RESTRICT row_m = rect.ConstRow(*in, y);
        const float* const JXL_RESTRICT rows[5] = {
            row_m - 2 * stride, row_m - 1 * stride, row_m, row_m + 1 * stride,
            row_m + 2 * stride};
        float* const JXL_RESTRICT row_out = out->Row(y);
        int64_t xx = x;
        for (; xx < safe_end; ++xx)
          row_out[xx] = ScalarPixel<false>(rows, xx, xsize, weights);
        for (; xx < xsize; ++xx)
          row_out[xx] = ScalarPixel<true>(rows, xx, xsize, weights);
      }
    }
```

- [ ] **Step 4: Build + convolve_test**

Run:
```powershell
cmake --build C:\Foo\rcw-conv5edge\external\libjxl-012\build-ab --target convolve_test
C:\Foo\rcw-conv5edge\external\libjxl-012\build-ab\convolve_test.exe --gtest_filter=*Separable5*
```
Expected: PASS.

- [ ] **Step 5: Byte-exact gate (FNV NEW == OLD)**

Run:
```powershell
C:\Foo\rcw-conv5edge\tools\run-conv5-ab.ps1 fnv > C:\Foo\rcw-conv5edge\tools\conv5_fnv_NEW.txt
Compare-Object (gc C:\Foo\rcw-conv5edge\tools\conv5_fnv_OLD.txt) (gc C:\Foo\rcw-conv5edge\tools\conv5_fnv_NEW.txt)
```
Expected: NO differences (all `fnv=` identical). If any differ → revert, the change is not byte-exact.

- [ ] **Step 6: Commit (submodule) + push**

```powershell
cd C:\Foo\rcw-conv5edge\external\libjxl-012
git add lib/jxl/enc_convolve_separable5.cc
git commit -m "perf(conv5): scalar-tail Mirror elision (byte-exact)"
git push -u origin perf/enc-conv5-edge-coverage-z3k
```

---

## Task 3: Change 2 — propagate RunOnPool status (correctness)

**Files:** Modify `enc_convolve_separable5.cc`

- [ ] **Step 1: Make `RunInteriorRows` return the pool status**

Replace (current ~407-423):
```cpp
  template <size_t kSizeModN>
  JXL_INLINE Status RunInteriorRows(const size_t ybegin, const size_t yend) {
    const size_t count = yend - ybegin;
    const size_t num_bands = (count + kRowsPerBand - 1) / kRowsPerBand;
    const auto process_band = [&](const uint32_t band,
                                  size_t /*thread*/) HWY_ATTR {
      const size_t b0 = ybegin + static_cast<size_t>(band) * kRowsPerBand;
      const size_t b1 = std::min(b0 + kRowsPerBand, yend);
      ConvolveInteriorBand<kSizeModN>(b0, b1);
      return true;
    };
    return RunOnPool(pool, 0, static_cast<uint32_t>(num_bands),
                     ThreadPool::NoInit, process_band, "ConvolveBands");
  }
```

- [ ] **Step 2: Make `RunBorderRows` + `RunRows` return Status**

```cpp
  template <size_t kSizeModN>
  JXL_INLINE Status RunBorderRows(const size_t ybegin, const size_t yend) {
    for (size_t y = ybegin; y < yend; ++y) ConvolveRow<kSizeModN, true>(y);
    return true;
  }

  template <size_t kSizeModN>
  JXL_INLINE Status RunRows() {
    size_t ybegin = rect.y0();
    size_t yend = rect.y1();
    while (ybegin < yend && ybegin < kRadius) ybegin++;
    while (ybegin < yend && yend + kRadius > in->ysize()) yend--;
    if (ybegin > rect.y0())
      JXL_RETURN_IF_ERROR(RunBorderRows<kSizeModN>(0, ybegin - rect.y0()));
    if (yend > ybegin)
      JXL_RETURN_IF_ERROR(
          RunInteriorRows<kSizeModN>(ybegin - rect.y0(), yend - rect.y0()));
    if (yend < rect.y1())
      JXL_RETURN_IF_ERROR(
          RunBorderRows<kSizeModN>(yend - rect.y0(), rect.ysize()));
    return true;
  }
```

- [ ] **Step 3: Update `Run()` switch to return the Status**

```cpp
      switch (rect.xsize() % Lanes(Simd())) {
        case 0: return RunRows<0>();
        case 1: return RunRows<1>();
        default: return RunRows<2>();
      }
```
(Drop the old `RunRows<2>(); ... return true;` tail.)

- [ ] **Step 4: Build + convolve_test + FNV gate**

Run the Task 2 Step 4/5 commands. Expected: convolve_test PASS, FNV unchanged.

- [ ] **Step 5: Commit + push**

```powershell
cd C:\Foo\rcw-conv5edge\external\libjxl-012
git add lib/jxl/enc_convolve_separable5.cc
git commit -m "fix(conv5): propagate RunOnPool failure status (was swallowed)"
git push
```

---

## Task 4: Change 3 — border-row horizontal dedup (byte-exact)

**Files:** Modify `enc_convolve_separable5.cc`

- [ ] **Step 1: Extract `ComputeRowPointers` from `ConvolveRow`'s reflection block**

Add private method (moves current lines ~120-157 reflection logic, incl the `kBorderLut`):
```cpp
  // Fills rows[] = {t2, t1, m, b1, b2} for output row y, applying image-bound
  // vertical mirroring (incl. the tiny-height <=4 double-reflection LUT).
  JXL_INLINE void ComputeRowPointers(const size_t y,
                                     const float* JXL_RESTRICT rows[5]) const {
    const int64_t stride = in->PixelsPerRow();
    const float* const JXL_RESTRICT row_m = rect.ConstRow(*in, y);
    const float* row_t2 = row_m - 2 * stride;
    const float* row_t1 = row_m - 1 * stride;
    const float* row_b1 = row_m + 1 * stride;
    const float* row_b2 = row_m + 2 * stride;
    const size_t img_y = rect.y0() + y;
    if (in->ysize() <= 2 * kRadius) {  // Very special: double reflections
      static constexpr size_t kBorderLut[4 * 8] = {
          0, 0, 0, 0, 0, 0xBAD, 0xBAD, 0xBAD,  // 1 row
          1, 0, 0, 1, 1, 0,     0xBAD, 0xBAD,  // 2 rows
          1, 0, 0, 1, 2, 2,     1,     0xBAD,  // 3 rows
          1, 0, 0, 1, 2, 3,     3,     2,      // 4 rows
      };
      JXL_DASSERT(in->ysize() <= 4);
      const size_t o = in->ysize() * 8 - 6 + img_y;
      row_t2 = in->ConstRow(kBorderLut[o - 2]) + rect.x0();
      row_t1 = in->ConstRow(kBorderLut[o - 1]) + rect.x0();
      row_b1 = in->ConstRow(kBorderLut[o + 1]) + rect.x0();
      row_b2 = in->ConstRow(kBorderLut[o + 2]) + rect.x0();
    } else if (img_y < kRadius) {
      if (img_y == 0) { row_t1 = row_m; row_t2 = row_b1; }
      else { row_t2 = row_t1; }
    } else if (img_y + kRadius >= in->ysize()) {
      if (img_y + 1 == in->ysize()) { row_b1 = row_m; row_b2 = row_t1; }
      else { row_b2 = row_b1; }
    }
    rows[0] = row_t2; rows[1] = row_t1; rows[2] = row_m;
    rows[3] = row_b1; rows[4] = row_b2;
  }
```

- [ ] **Step 2: Add `BorderColumn` (deduped 5-horz + vertical combine)**

```cpp
  // One output SIMD column with horizontal-convolution dedup: reflected source
  // rows often alias, so each distinct row is convolved once. Vertical combine
  // is identical to ConvolveRow's, so output is byte-exact.
  template <size_t kSizeModN, int kRegion>
  JXL_MAYBE_INLINE V BorderColumn(const float* const JXL_RESTRICT rows[5],
                                  const int64_t x, const int64_t xsize,
                                  const V wh0, const V wh1, const V wh2,
                                  const V wv0, const V wv1, const V wv2,
                                  const I ml1, const I ml2) const {
    const V h2 = HorzPick<kSizeModN, kRegion>(rows[2], x, xsize, wh0, wh1, wh2,
                                              ml1, ml2);
    const V h1 = (rows[1] == rows[2]) ? h2
                 : HorzPick<kSizeModN, kRegion>(rows[1], x, xsize, wh0, wh1,
                                                wh2, ml1, ml2);
    const V h3 = (rows[3] == rows[2])   ? h2
                 : (rows[3] == rows[1]) ? h1
                 : HorzPick<kSizeModN, kRegion>(rows[3], x, xsize, wh0, wh1,
                                                wh2, ml1, ml2);
    const V h0 = (rows[0] == rows[2])   ? h2
                 : (rows[0] == rows[1]) ? h1
                 : (rows[0] == rows[3]) ? h3
                 : HorzPick<kSizeModN, kRegion>(rows[0], x, xsize, wh0, wh1,
                                                wh2, ml1, ml2);
    const V h4 = (rows[4] == rows[2])   ? h2
                 : (rows[4] == rows[1]) ? h1
                 : (rows[4] == rows[3]) ? h3
                 : (rows[4] == rows[0]) ? h0
                 : HorzPick<kSizeModN, kRegion>(rows[4], x, xsize, wh0, wh1,
                                                wh2, ml1, ml2);
    const V conv0 = Mul(h2, wv0);
    const V conv1 = MulAdd(Add(h1, h3), wv1, conv0);
    const V conv2 = MulAdd(Add(h0, h4), wv2, conv1);
    return conv2;
  }
```

- [ ] **Step 3: Rewrite `ConvolveRow` body to use `ComputeRowPointers` + `BorderColumn`**

Replace the reflection block + the three column loops (current ~118-223) with:
```cpp
  template <size_t kSizeModN, bool kBorder>
  JXL_NOINLINE void ConvolveRow(const uint32_t y) {
    const D d;
    const size_t xsize = rect.xsize();
    float* const JXL_RESTRICT row_out = out->Row(y);
    const float* JXL_RESTRICT rows[5];
    ComputeRowPointers(y, rows);
    const float* const JXL_RESTRICT row_t2 = rows[0];
    const float* const JXL_RESTRICT row_t1 = rows[1];
    const float* const JXL_RESTRICT row_m = rows[2];
    const float* const JXL_RESTRICT row_b1 = rows[3];
    const float* const JXL_RESTRICT row_b2 = rows[4];

    const V wh0 = LoadDup128(d, weights->horz + 0 * 4);
    const V wh1 = LoadDup128(d, weights->horz + 1 * 4);
    const V wh2 = LoadDup128(d, weights->horz + 2 * 4);
    const V wv0 = LoadDup128(d, weights->vert + 0 * 4);
    const V wv1 = LoadDup128(d, weights->vert + 1 * 4);
    const V wv2 = LoadDup128(d, weights->vert + 2 * 4);
    const I ml1 = MirrorLanes<1>();
    const I ml2 = MirrorLanes<2>();
    (void)kBorder;

    size_t x = 0;
    for (; x < kRadius; x += Lanes(d)) {
      Store(BorderColumn<kSizeModN, 0>(rows, x, xsize, wh0, wh1, wh2, wv0, wv1,
                                       wv2, ml1, ml2), d, row_out + x);
    }
    for (; x + Lanes(d) + kRadius <= xsize; x += Lanes(d)) {
      Store(BorderColumn<kSizeModN, 1>(rows, x, xsize, wh0, wh1, wh2, wv0, wv1,
                                       wv2, ml1, ml2), d, row_out + x);
    }
#if HWY_TARGET == HWY_SCALAR
    while (x < xsize) {
#else
    if (kSizeModN < kRadius) {
#endif
      Store(BorderColumn<kSizeModN, 2>(rows, x, xsize, wh0, wh1, wh2, wv0, wv1,
                                       wv2, ml1, ml2), d, row_out + x);
      x += Lanes(d);
    }

    if (kSizeModN != 0) {
      const int64_t safe_end = static_cast<int64_t>(xsize) - kRadius;
      for (; static_cast<int64_t>(x) < safe_end; ++x)
        row_out[x] = ScalarPixel<false>(rows, x, xsize, weights);
      for (; x < xsize; ++x)
        row_out[x] = ScalarPixel<true>(rows, x, xsize, weights);
    }
  }
```
(`row_t2..row_b2` locals kept only if referenced elsewhere; otherwise drop them — `BorderColumn`/`ScalarPixel` take `rows`.)

- [ ] **Step 4: Build + convolve_test + FNV gate**

Run Task 2 Step 4/5. Expected: convolve_test PASS; FNV unchanged (dedup is bit-identical).

- [ ] **Step 5: Commit + push**

```powershell
cd C:\Foo\rcw-conv5edge\external\libjxl-012
git add lib/jxl/enc_convolve_separable5.cc
git commit -m "perf(conv5): border-row horizontal-conv dedup (byte-exact)"
git push
```

---

## Task 5: Change 4 — dedicated tiny-height kernel (byte-exact)

**Files:** Modify `enc_convolve_separable5.cc`

- [ ] **Step 1: Add `RunTinyHeight` (cross-row reuse via the LUT)**

```cpp
  // ysize <= 2*kRadius: every output row is a border row sharing the same <=4
  // source rows. Convolve each source row once per SIMD column, then form all
  // output rows from the kBorderLut mapping. Same combine as ConvolveRow ->
  // byte-exact.
  template <size_t kSizeModN>
  JXL_INLINE Status RunTinyHeight() {
    const D d;
    const int64_t xsize = rect.xsize();
    const size_t ysz = in->ysize();
    static constexpr size_t kBorderLut[4 * 8] = {
        0, 0, 0, 0, 0, 0xBAD, 0xBAD, 0xBAD,
        1, 0, 0, 1, 1, 0,     0xBAD, 0xBAD,
        1, 0, 0, 1, 2, 2,     1,     0xBAD,
        1, 0, 0, 1, 2, 3,     3,     2,
    };
    const V wh0 = LoadDup128(d, weights->horz + 0 * 4);
    const V wh1 = LoadDup128(d, weights->horz + 1 * 4);
    const V wh2 = LoadDup128(d, weights->horz + 2 * 4);
    const V wv0 = LoadDup128(d, weights->vert + 0 * 4);
    const V wv1 = LoadDup128(d, weights->vert + 1 * 4);
    const V wv2 = LoadDup128(d, weights->vert + 2 * 4);
    const I ml1 = MirrorLanes<1>();
    const I ml2 = MirrorLanes<2>();

    const auto column = [&](auto region_tag, const int64_t x) HWY_ATTR {
      constexpr int kRegion = decltype(region_tag)::value;
      V hrow[4];
      for (size_t j = 0; j < ysz; ++j) {
        hrow[j] = HorzPick<kSizeModN, kRegion>(in->ConstRow(j) + rect.x0(), x,
                                               xsize, wh0, wh1, wh2, ml1, ml2);
      }
      for (size_t img_y = 0; img_y < ysz; ++img_y) {
        const size_t o = ysz * 8 - 6 + img_y;
        const V h0 = hrow[kBorderLut[o - 2]];
        const V h1 = hrow[kBorderLut[o - 1]];
        const V h2 = hrow[img_y];
        const V h3 = hrow[kBorderLut[o + 1]];
        const V h4 = hrow[kBorderLut[o + 2]];
        const V conv0 = Mul(h2, wv0);
        const V conv1 = MulAdd(Add(h1, h3), wv1, conv0);
        const V conv2 = MulAdd(Add(h0, h4), wv2, conv1);
        Store(conv2, d, out->Row(img_y) + x);
      }
    };

    int64_t x = 0;
    for (; x < kRadius; x += Lanes(d))
      column(std::integral_constant<int, 0>{}, x);
    for (; x + Lanes(d) + kRadius <= xsize; x += Lanes(d))
      column(std::integral_constant<int, 1>{}, x);
    if (kSizeModN < kRadius) {
      column(std::integral_constant<int, 2>{}, x);
      x += Lanes(d);
    }
    if (kSizeModN != 0) {
      const int64_t safe_end = xsize - kRadius;
      const int64_t stride = in->PixelsPerRow();
      for (size_t img_y = 0; img_y < ysz; ++img_y) {
        const float* JXL_RESTRICT rows[5];
        ComputeRowPointers(img_y, rows);
        (void)stride;
        float* const JXL_RESTRICT row_out = out->Row(img_y);
        int64_t xx = x;
        for (; xx < safe_end; ++xx)
          row_out[xx] = ScalarPixel<false>(rows, xx, xsize, weights);
        for (; xx < xsize; ++xx)
          row_out[xx] = ScalarPixel<true>(rows, xx, xsize, weights);
      }
    }
    return true;
  }
```
NOTE: if the generic lambda + `HWY_ATTR` proves troublesome under `foreach_target`, replace `column` with an explicit `template <int kRegion> void TinyColumn(...)` private method and call `TinyColumn<0/1/2>(x)`. Functionally identical; prefer whichever compiles cleanly on all targets.

- [ ] **Step 2: Dispatch tiny-height from `Run()`**

In `Run()`, inside the `if (rect.xsize() >= min_width)` block, before the existing switch:
```cpp
      if (in->ysize() <= 2 * kRadius) {
        switch (rect.xsize() % Lanes(Simd())) {
          case 0: return RunTinyHeight<0>();
          case 1: return RunTinyHeight<1>();
          default: return RunTinyHeight<2>();
        }
      }
```

- [ ] **Step 3: Build + convolve_test + FNV gate (tiny configs h1..h4 must match)**

Run Task 2 Step 4/5. Expected: convolve_test PASS; FNV for `h1`,`h2`,`h3`,`h4`,`border-heavy` identical OLD==NEW.

- [ ] **Step 4: Commit + push**

```powershell
cd C:\Foo\rcw-conv5edge\external\libjxl-012
git add lib/jxl/enc_convolve_separable5.cc
git commit -m "perf(conv5): dedicated tiny-height (ysize<=4) cross-row-reuse kernel"
git push
```

---

## Task 6: Change 5 — SIMD N/N+1 width-cliff (within 1e-5; the one output change)

**Files:** Modify `enc_convolve_separable5.cc`

- [ ] **Step 1: Add `HorzConvolveOnlyVector` (single vector spans the row)**

```cpp
  // The whole row fits in one vector: mirror the LEFT edge via Neighbors and the
  // RIGHT edge the same way HorzConvolveLast<kSizeModN> does (kSizeModN==0 for
  // xsize==N; ==1 for xsize==N+1, where the right neighbor vector is LoadU(row+1)).
  template <size_t kSizeModN>
  static JXL_MAYBE_INLINE V HorzConvolveOnlyVector(
      const float* const JXL_RESTRICT row, const int64_t x, const int64_t xsize,
      const V wh0, const V wh1, const V wh2, const I ml1, const I ml2) {
    const D d;
    const V c = LoadU(d, row + x);
    const V mul0 = Mul(c, wh0);
    const V l1 = Neighbors::FirstL1(c);
    const V l2 = Neighbors::FirstL2(c);
    const size_t N = Lanes(d);
    V r1, r2;
    if (kSizeModN == 0) {  // xsize == N
      r1 = TableLookupLanes(c, ml1);
      r2 = TableLookupLanes(c, ml2);
    } else {               // xsize == N+1
      const V last = LoadU(d, row + xsize - N);  // == row + 1
      r1 = last;
      r2 = TableLookupLanes(last, ml1);
    }
    const V mul1 = MulAdd(Add(l1, r1), wh1, mul0);
    const V mul2 = MulAdd(Add(l2, r2), wh2, mul1);
    return mul2;
  }
```
(Gated implicitly: only called from non-scalar `Run()` branches.)

- [ ] **Step 2: Add `RunNarrow` (single column + optional last scalar pixel)**

```cpp
  // xsize in {N, N+1} (kSizeModN in {0,1}). Single SIMD column for the whole
  // width; vertical mirroring per output row via ComputeRowPointers (covers
  // borders AND tiny-height). For N+1 the final pixel uses the scalar tail.
  template <size_t kSizeModN>
  JXL_INLINE Status RunNarrow() {
    const D d;
    const int64_t xsize = rect.xsize();
    const V wh0 = LoadDup128(d, weights->horz + 0 * 4);
    const V wh1 = LoadDup128(d, weights->horz + 1 * 4);
    const V wh2 = LoadDup128(d, weights->horz + 2 * 4);
    const V wv0 = LoadDup128(d, weights->vert + 0 * 4);
    const V wv1 = LoadDup128(d, weights->vert + 1 * 4);
    const V wv2 = LoadDup128(d, weights->vert + 2 * 4);
    const I ml1 = MirrorLanes<1>();
    const I ml2 = MirrorLanes<2>();
    for (size_t y = 0; y < rect.ysize(); ++y) {
      const float* JXL_RESTRICT rows[5];
      ComputeRowPointers(y, rows);
      const V h2 = HorzConvolveOnlyVector<kSizeModN>(rows[2], 0, xsize, wh0, wh1,
                                                     wh2, ml1, ml2);
      const V h1 = (rows[1] == rows[2]) ? h2
                   : HorzConvolveOnlyVector<kSizeModN>(rows[1], 0, xsize, wh0,
                                                       wh1, wh2, ml1, ml2);
      const V h3 = (rows[3] == rows[2])   ? h2
                   : (rows[3] == rows[1]) ? h1
                   : HorzConvolveOnlyVector<kSizeModN>(rows[3], 0, xsize, wh0,
                                                       wh1, wh2, ml1, ml2);
      const V h0 = (rows[0] == rows[2])   ? h2
                   : (rows[0] == rows[1]) ? h1
                   : (rows[0] == rows[3]) ? h3
                   : HorzConvolveOnlyVector<kSizeModN>(rows[0], 0, xsize, wh0,
                                                       wh1, wh2, ml1, ml2);
      const V h4 = (rows[4] == rows[2])   ? h2
                   : (rows[4] == rows[1]) ? h1
                   : (rows[4] == rows[3]) ? h3
                   : (rows[4] == rows[0]) ? h0
                   : HorzConvolveOnlyVector<kSizeModN>(rows[4], 0, xsize, wh0,
                                                       wh1, wh2, ml1, ml2);
      const V conv0 = Mul(h2, wv0);
      const V conv1 = MulAdd(Add(h1, h3), wv1, conv0);
      const V conv2 = MulAdd(Add(h0, h4), wv2, conv1);
      Store(conv2, d, out->Row(y));
      if (kSizeModN == 1) {  // xsize == N+1: final pixel via scalar 25-tap
        out->Row(y)[xsize - 1] =
            ScalarPixel<true>(rows, xsize - 1, xsize, weights);
      }
    }
    return true;
  }
```

- [ ] **Step 3: Dispatch from `Run()` (non-scalar, before SlowSeparable5 fallback)**

Replace the `else { return SlowSeparable5(...); }` tail:
```cpp
#if HWY_TARGET != HWY_SCALAR
    const size_t N = Lanes(Simd());
    if (rect.xsize() == N || rect.xsize() == N + 1) {
      JXL_ENSURE(SameSize(rect, *out));
      return rect.xsize() == N ? RunNarrow<0>() : RunNarrow<1>();
    }
#endif
    return SlowSeparable5(*in, rect, *weights, pool, out, Rect(*out));
```

- [ ] **Step 4: Build + convolve_test + width-cliff tolerance gate**

Run:
```powershell
cmake --build C:\Foo\rcw-conv5edge\external\libjxl-012\build-ab --target convolve_test
C:\Foo\rcw-conv5edge\external\libjxl-012\build-ab\convolve_test.exe --gtest_filter=*Separable5*
C:\Foo\rcw-conv5edge\tools\run-conv5-ab.ps1 slow
```
Expected: convolve_test PASS; `slow` mode prints `OK` (maxrel ≤ 1e-5) for ALL configs incl `cliff 4x32`, `5x32`, `8x32`, `9x32`, `16x32`, `17x32`. Also re-run `fnv` and confirm the non-cliff configs STILL match OLD goldens (this change must not touch them).

- [ ] **Step 5: Commit + push**

```powershell
cd C:\Foo\rcw-conv5edge\external\libjxl-012
git add lib/jxl/enc_convolve_separable5.cc
git commit -m "perf(conv5): SIMD path for xsize==N and N+1 (was SlowSeparable5)"
git push
```

---

## Task 7: Full-image timing flipflop + keep/drop decision

**Files:** none (measurement); results → commit message / FINDINGS note.

- [ ] **Step 1: Time NEW (full branch) full-image path**

Run:
```powershell
$o = Measure-Command { C:\Foo\rcw-conv5edge\external\libjxl-012\build-ab\conv5_ab.exe time }
"NEW 1024x1024 x200: $($o.TotalMilliseconds) ms"
```
Record. (For lower noise, run 3× and take the median; the PS driver may instead wrap QPC inside the exe.)

- [ ] **Step 2: Time OLD via path-checkout + incremental rebuild**

Run:
```powershell
cd C:\Foo\rcw-conv5edge\external\libjxl-012
git stash --include-untracked  # not needed if all committed; otherwise skip
git checkout 10783f7e -- lib/jxl/enc_convolve_separable5.cc
cmake --build build-ab --target conv5_ab convolve_test
$o = Measure-Command { build-ab\conv5_ab.exe time }; "OLD: $($o.TotalMilliseconds) ms"
git checkout perf/enc-conv5-edge-coverage-z3k -- lib/jxl/enc_convolve_separable5.cc
cmake --build build-ab --target conv5_ab convolve_test
```
Expected: OLD and NEW within noise on the full-image hot path (the edge changes are off it; Change 1's scalar-tail elision touches ≤N-1 px/row).

- [ ] **Step 3: WASM timing for Change 1 (deployment target) — if feasible**

If a WASM build of the harness is quick via emsdk, compare OLD/NEW full-image there too (the "measure real WASM" rule). Otherwise note that Changes 1/3/4 are byte-exact-by-construction on all targets and full-image timing is dominated by the unchanged y-ring interior, so WASM is expected neutral; record the assumption explicitly.

- [ ] **Step 4: Keep/drop (rules 9/10)**

- If full-image timing is non-regressing (within noise) → KEEP all changes (Change 1 is theoretically better and byte-exact → rule 10 keeps it).
- If any change regresses the hot path → revert that commit and append to `docs/1 rejected optimizations.md` with the measured numbers and reason.

---

## Task 8: Logs, finalize, handoff

**Files:**
- Append: `Questions_deferred.md`
- Append (if needed): `docs/1 rejected optimizations.md`

- [ ] **Step 1: Append deferred items to `Questions_deferred.md`**

```
## 2026-06-29 enc_convolve_separable5 (branch perf/enc-conv5-edge-coverage-z3k)
- Parallelize butteraugli Blur (currently Separable5 called with pool=nullptr).
  Behavioral; butteraugli.cc change; out of conv5 scope.
- In-place Separable5 variant (butteraugli guards `&in != out` today) to drop a
  temp image.
- Weight-family dispatch (identity / 3-tap / 1-D) — needs coefficient telemetry
  before adding branches/codesize across Highway targets.
```

- [ ] **Step 2: Commit super-branch artifacts (logs + any harness goldens NEW)**

```powershell
cd C:\Foo\rcw-conv5edge
git add "Questions_deferred.md" "docs/1 rejected optimizations.md" tools\conv5_fnv_*.txt
git commit -m "docs(conv5): defer butteraugli-parallel/in-place/weight-dispatch; record A/B results"
git push
```

- [ ] **Step 3: Final verification sweep**

Run:
```powershell
C:\Foo\rcw-conv5edge\external\libjxl-012\build-ab\convolve_test.exe --gtest_filter=*Separable5*:*Convolve*
C:\Foo\rcw-conv5edge\tools\run-conv5-ab.ps1 slow
```
Expected: convolve_test all PASS; `slow` all OK.

- [ ] **Step 4: Confirm isolation invariants**

```powershell
cd C:\Foo\rcw-conv5edge; git log --oneline -1; git rev-parse --abbrev-ref HEAD
cd external\libjxl-012; git log --oneline -1; git rev-parse --abbrev-ref HEAD
git branch --contains HEAD   # must NOT list main
```
Expected: both on `perf/enc-conv5-edge-coverage-z3k`; submodule HEAD not on main; gitlink in super NOT bumped (`git -C C:\Foo\rcw-conv5edge status` shows external/libjxl-012 modified pointer is NOT staged/committed).

- [ ] **Step 5: Handoff report**

Report to the integrator: both pushed branch names (`perf/enc-conv5-edge-coverage-z3k` in super + submodule), the 5 changes, verification results (convolve_test PASS, FNV byte-exact for changes 1/3/4, width-cliff ≤1e-5, full-image timing non-regressing), and that main is untouched + gitlink unbumped.

---

## Self-review notes

- **Spec coverage:** Change 1 → Task 2; Change 2 → Task 3; Change 3 → Task 4; Change 4 → Task 5; Change 5 → Task 6; verification (convolve_test + FNV + slow + timing) → Tasks 1/7; deferred → Task 8. All spec sections mapped.
- **Type consistency:** `ScalarPixel<bool>`, `BorderColumn<kSizeModN,kRegion>`, `HorzPick<kSizeModN,kRegion>` (pre-existing), `ComputeRowPointers`, `RunTinyHeight<kSizeModN>`, `HorzConvolveOnlyVector<kSizeModN>`, `RunNarrow<kSizeModN>` — names/signatures consistent across tasks. `RunRows/RunInteriorRows/RunBorderRows` all return `Status` after Task 3.
- **Ordering:** Task 2 (ScalarPixel) and Task 4 (ComputeRowPointers) define helpers reused by Tasks 5/6 — done before their consumers. Task 3 (Status) before dispatch edits add new `return Run*<>()` callers.
- **Risk:** native build (Task 0) is the gate; standalone fallback documented. The generic-lambda in RunTinyHeight has an explicit method fallback noted.
