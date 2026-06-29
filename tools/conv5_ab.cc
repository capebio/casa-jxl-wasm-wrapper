// A/B + correctness harness for jxl::Separable5 (enc_convolve_separable5.cc).
//
// Modes:
//   fnv  : print FNV-1a of Separable5 output per (target, geometry) for the
//          byte-exact config set (widths that are NOT a target's N or N+1).
//          Used to assert FNV(OLD) == FNV(NEW) for byte-exact changes.
//   slow : assert Separable5 matches SlowSeparable5 within 1e-5 for ALL configs
//          incl. the N/N+1 width-cliff widths (the tolerance gate for Change 5).
//   time : full-image (1024x1024) timing; prints elapsed ms for OLD/NEW compare.
//
// Cross-target: forces each CPU-supported Highway target (+EMU128, +SCALAR) via
// SetSupportedTargetsForTest so one build covers N=16/8/4/1 region logic, the
// way convolve_test's foreach_target sweep does.
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <chrono>
#include <vector>

#include <hwy/targets.h>

#include "lib/jxl/base/random.h"
#include "lib/jxl/base/rect.h"
#include "lib/jxl/convolve.h"
#include "lib/jxl/image.h"
#include "lib/jxl/memory_manager_internal.h"

namespace {
using jxl::ImageF;
using jxl::Rect;
using jxl::Rng;
using jxl::WeightsSeparable5;

ImageF Mk(JxlMemoryManager* mm, size_t x, size_t y) {
  auto s = ImageF::Create(mm, x, y);
  if (!s.ok()) { std::fprintf(stderr, "alloc fail %zux%zu\n", x, y); std::abort(); }
  return std::move(s).value_();
}

void Fill(Rng& rng, ImageF* im) {
  for (size_t y = 0; y < im->ysize(); ++y) {
    float* r = im->Row(y);
    for (size_t x = 0; x < im->xsize(); ++x) r[x] = rng.UniformF(0.0f, 1.0f);
  }
}

WeightsSeparable5 Lowpass() {
  // Same lowpass coefficients convolve_test uses.
  const float w0 = 0.41714928f, w1 = 0.25539268f, w2 = 0.03603267f;
  WeightsSeparable5 w;
  for (int i = 0; i < 4; ++i) {
    w.horz[0 * 4 + i] = w0; w.horz[1 * 4 + i] = w1; w.horz[2 * 4 + i] = w2;
    w.vert[0 * 4 + i] = w0; w.vert[1 * 4 + i] = w1; w.vert[2 * 4 + i] = w2;
  }
  return w;
}

uint64_t Fnv(const ImageF& im) {
  uint64_t h = 1469598103934665603ull;
  for (size_t y = 0; y < im.ysize(); ++y) {
    const auto* b = reinterpret_cast<const uint8_t*>(im.Row(y));
    for (size_t i = 0; i < im.xsize() * sizeof(float); ++i) {
      h ^= b[i]; h *= 1099511628211ull;
    }
  }
  return h;
}

struct Cfg { size_t x, y; const char* tag; };

// Byte-exact configs: widths chosen to avoid any target's N or N+1
// (N in {1,4,8,16}; N+1 in {2,5,9,17}). Exercise borders, tiny height, scalar
// tail, and large interior.
std::vector<Cfg> ByteExactConfigs() {
  return {
      {640, 480, "full"},   {643, 481, "full-odd"}, {646, 480, "full+2"},
      {640, 1, "h1"},       {640, 2, "h2"},          {640, 3, "h3"},
      {640, 4, "h4"},       {64, 64, "sq64"},        {33, 33, "odd33"},
      {640, 5, "borderhvy"},{96, 12, "wide12"},      {48, 48, "sq48"},
  };
}

// Width-cliff + general tolerance configs (incl. N and N+1 for every target).
std::vector<Cfg> ToleranceConfigs() {
  std::vector<Cfg> c = ByteExactConfigs();
  for (size_t n : {1u, 2u, 4u, 5u, 8u, 9u, 16u, 17u, 18u}) {
    c.push_back({n, 32, "cliff"});
    c.push_back({n, 3, "cliftiny"});
  }
  return c;
}

const char* TargetName(int64_t t) { return hwy::TargetName(t); }

// Iterate CPU-supported targets plus the always-available portable ones.
std::vector<int64_t> TargetsToTest() {
  std::vector<int64_t> out;
  int64_t sup = hwy::SupportedTargets();  // CPU-detected best-down bitmask
  for (int64_t t : {HWY_AVX3, HWY_AVX2, HWY_SSE4, HWY_SSSE3, HWY_SSE2}) {
    if (sup & t) out.push_back(t);
  }
  out.push_back(HWY_EMU128);  // 128-bit portable (N=4) — always valid
  out.push_back(HWY_SCALAR);  // N=1 path
  return out;
}

int RunFnv(JxlMemoryManager* mm) {
  const WeightsSeparable5 w = Lowpass();
  for (int64_t target : TargetsToTest()) {
    hwy::SetSupportedTargetsForTest(target);
    for (const Cfg& c : ByteExactConfigs()) {
      Rng rng(12345 + c.x * 131 + c.y * 7);
      ImageF in = Mk(mm, c.x, c.y); Fill(rng, &in);
      ImageF out = Mk(mm, c.x, c.y);
      if (!Separable5(in, Rect(in), w, nullptr, &out)) {
        std::printf("RUN-FAIL %s %s\n", TargetName(target), c.tag); return 2;
      }
      std::printf("%-7s %-10s %4zux%-4zu fnv=%016llx\n", TargetName(target),
                  c.tag, c.x, c.y, (unsigned long long)Fnv(out));
    }
  }
  hwy::SetSupportedTargetsForTest(0);
  return 0;
}

int RunSlow(JxlMemoryManager* mm) {
  const WeightsSeparable5 w = Lowpass();
  int fails = 0;
  for (int64_t target : TargetsToTest()) {
    hwy::SetSupportedTargetsForTest(target);
    for (const Cfg& c : ToleranceConfigs()) {
      Rng rng(999 + c.x * 17 + c.y * 3);
      ImageF in = Mk(mm, c.x, c.y); Fill(rng, &in);
      ImageF out = Mk(mm, c.x, c.y);
      ImageF exp = Mk(mm, c.x, c.y);
      if (!Separable5(in, Rect(in), w, nullptr, &out)) {
        std::printf("RUN-FAIL %s %s\n", TargetName(target), c.tag); ++fails; continue;
      }
      SlowSeparable5(in, Rect(in), w, nullptr, &exp, Rect(exp));
      double maxrel = 0.0;
      for (size_t y = 0; y < c.y; ++y)
        for (size_t x = 0; x < c.x; ++x) {
          double a = out.Row(y)[x], b = exp.Row(y)[x];
          double d = std::fabs(a - b) / (std::fabs(b) + 1e-6);
          if (d > maxrel) maxrel = d;
        }
      const bool ok = maxrel <= 1e-5;
      if (!ok) ++fails;
      std::printf("%-7s %-10s %4zux%-4zu maxrel=%.2e %s\n", TargetName(target),
                  c.tag, c.x, c.y, maxrel, ok ? "OK" : "**FAIL**");
    }
  }
  hwy::SetSupportedTargetsForTest(0);
  std::printf("SLOW: %d failures\n", fails);
  return fails == 0 ? 0 : 3;
}

int RunTime(JxlMemoryManager* mm) {
  const WeightsSeparable5 w = Lowpass();
  Rng rng(7);
  ImageF in = Mk(mm, 1024, 1024); Fill(rng, &in);
  ImageF out = Mk(mm, 1024, 1024);
  const int warm = 10, iters = 200;
  for (int i = 0; i < warm; ++i) Separable5(in, Rect(in), w, nullptr, &out);
  auto t0 = std::chrono::high_resolution_clock::now();
  for (int i = 0; i < iters; ++i) Separable5(in, Rect(in), w, nullptr, &out);
  auto t1 = std::chrono::high_resolution_clock::now();
  double ms = std::chrono::duration<double, std::milli>(t1 - t0).count();
  std::printf("TIME 1024x1024 x%d: %.3f ms total, %.4f ms/iter\n", iters, ms,
              ms / iters);
  return 0;
}
}  // namespace

int main(int argc, char** argv) {
  const char* mode = argc > 1 ? argv[1] : "fnv";
  JxlMemoryManager mm;
  if (!jxl::MemoryManagerInit(&mm, nullptr)) { std::fprintf(stderr, "mm init\n"); return 1; }
  if (!std::strcmp(mode, "fnv")) return RunFnv(&mm);
  if (!std::strcmp(mode, "slow")) return RunSlow(&mm);
  if (!std::strcmp(mode, "time")) return RunTime(&mm);
  std::fprintf(stderr, "usage: conv5_ab [fnv|slow|time]\n");
  return 1;
}
