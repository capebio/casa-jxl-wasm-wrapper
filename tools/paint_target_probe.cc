// paint_target_probe.cc — native validation + bench of the progressive
// paint-target schedule (JxlDecoderSetProgressivePaintTarget).
//
// For each target in {0(=per-pass),2,3,4,5,6} it decodes the input via the
// JXL_DEC_FRAME_PROGRESSION path with kPasses detail, counting progression
// events (intermediate paints) and timing first-paint + total decode. Each
// progression triggers JxlDecoderFlushImage (the force-draw that dominates
// per-paint cost). Single-threaded so the per-paint flush cost is fully visible.
//
// Build/run: see tools/build-paint-probe.ps1.

#include <jxl/decode.h>
#include <jxl/decode_cxx.h>
#include <jxl/resizable_parallel_runner.h>
#include <jxl/resizable_parallel_runner_cxx.h>
#include <jxl/types.h>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <vector>

static bool LoadFile(const char* fn, std::vector<uint8_t>* out) {
  FILE* f = fopen(fn, "rb");
  if (!f) return false;
  fseek(f, 0, SEEK_END);
  long n = ftell(f);
  fseek(f, 0, SEEK_SET);
  if (n < 0) { fclose(f); return false; }
  out->resize(static_cast<size_t>(n));
  size_t r = fread(out->data(), 1, out->size(), f);
  fclose(f);
  return r == out->size();
}

struct Result {
  int progressions = 0;
  double first_ms = 0;
  double total_ms = 0;
  uint64_t xsize = 0, ysize = 0;
  bool ok = false;
};

static double ms_since(std::chrono::steady_clock::time_point t0) {
  return std::chrono::duration<double, std::milli>(
             std::chrono::steady_clock::now() - t0)
      .count();
}

static Result RunOne(const uint8_t* jxl, size_t size, uint32_t paint_target,
                     int threads) {
  Result res;
  JxlResizableParallelRunnerPtr runner;
  JxlDecoderPtr dec = JxlDecoderMake(nullptr);
  if (JXL_DEC_SUCCESS !=
      JxlDecoderSubscribeEvents(dec.get(), JXL_DEC_BASIC_INFO |
                                               JXL_DEC_FRAME_PROGRESSION |
                                               JXL_DEC_FULL_IMAGE)) {
    return res;
  }
  if (threads != 1) {  // threads==1 => single-thread (no runner)
    runner = JxlResizableParallelRunnerMake(nullptr);
    if (JXL_DEC_SUCCESS != JxlDecoderSetParallelRunner(
                               dec.get(), JxlResizableParallelRunner,
                               runner.get())) {
      return res;
    }
  }
  JxlDecoderSetProgressiveDetail(dec.get(), JxlProgressiveDetail::kPasses);
  if (paint_target > 0) {
    if (JXL_DEC_SUCCESS !=
        JxlDecoderSetProgressivePaintTarget(dec.get(), paint_target)) {
      return res;
    }
  }
  JxlPixelFormat format = {4, JXL_TYPE_UINT8, JXL_NATIVE_ENDIAN, 0};
  std::vector<uint8_t> pixels;
  double first_ms = -1;
  auto t0 = std::chrono::steady_clock::now();
  JxlDecoderSetInput(dec.get(), jxl, size);
  JxlDecoderCloseInput(dec.get());
  for (;;) {
    JxlDecoderStatus st = JxlDecoderProcessInput(dec.get());
    if (st == JXL_DEC_ERROR) return res;
    if (st == JXL_DEC_SUCCESS) break;
    if (st == JXL_DEC_FULL_IMAGE) continue;
    if (st == JXL_DEC_BASIC_INFO) {
      JxlBasicInfo info;
      if (JXL_DEC_SUCCESS != JxlDecoderGetBasicInfo(dec.get(), &info)) return res;
      res.xsize = info.xsize;
      res.ysize = info.ysize;
      if (runner) {
        size_t t = threads > 1 ? static_cast<size_t>(threads)
                               : JxlResizableParallelRunnerSuggestThreads(
                                     info.xsize, info.ysize);
        JxlResizableParallelRunnerSetThreads(runner.get(), t);
      }
      continue;
    }
    if (st == JXL_DEC_NEED_IMAGE_OUT_BUFFER) {
      size_t bs;
      if (JXL_DEC_SUCCESS != JxlDecoderImageOutBufferSize(dec.get(), &format, &bs))
        return res;
      pixels.resize(bs);
      if (JXL_DEC_SUCCESS !=
          JxlDecoderSetImageOutBuffer(dec.get(), &format, pixels.data(),
                                      pixels.size()))
        return res;
      continue;
    }
    if (st == JXL_DEC_FRAME_PROGRESSION) {
      res.progressions++;
      JxlDecoderFlushImage(dec.get());  // force-draw: the per-paint cost
      double now = ms_since(t0);
      if (first_ms < 0) first_ms = now;
      continue;
    }
    if (st == JXL_DEC_NEED_MORE_INPUT) break;  // input closed: shouldn't happen
    return res;                                // unknown status
  }
  res.total_ms = ms_since(t0);
  res.first_ms = first_ms < 0 ? res.total_ms : first_ms;
  res.ok = true;
  return res;
}

static double median(std::vector<double> v) {
  std::sort(v.begin(), v.end());
  size_t m = v.size() / 2;
  return v.size() % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

int main(int argc, char** argv) {
  if (argc < 2) {
    fprintf(stderr, "Usage: %s <jxl> [reps]\n", argv[0]);
    return 1;
  }
  std::vector<uint8_t> jxl;
  if (!LoadFile(argv[1], &jxl)) {
    fprintf(stderr, "couldn't load %s\n", argv[1]);
    return 1;
  }
  int reps = argc > 2 ? atoi(argv[2]) : 5;
  if (reps < 1) reps = 1;
  int threads = argc > 3 ? atoi(argv[3]) : 0;  // 0=auto(suggest), 1=single, N=N

  const uint32_t targets[] = {0, 2, 3, 4, 5, 6};
  const int NT = 6;
  printf("file: %s (%.1f KiB), reps=%d, threads=%s, interleaved\n", argv[1],
         jxl.size() / 1024.0, reps,
         threads == 1 ? "1(single)" : threads == 0 ? "auto" : "N");
  std::vector<double> firsts[NT], totals[NT];
  int paints[NT] = {0};
  bool ok[NT] = {false};
  for (int j = 0; j < NT; j++) {  // warmup
    Result w = RunOne(jxl.data(), jxl.size(), targets[j], threads);
    ok[j] = w.ok;
    paints[j] = w.progressions;
  }
  for (int i = 0; i < reps; i++) {  // interleave to cancel thermal drift
    for (int j = 0; j < NT; j++) {
      if (!ok[j]) continue;
      Result r = RunOne(jxl.data(), jxl.size(), targets[j], threads);
      firsts[j].push_back(r.first_ms);
      totals[j].push_back(r.total_ms);
      paints[j] = r.progressions;
    }
  }
  printf("target    paints  first_ms   total_ms\n");
  for (int j = 0; j < NT; j++) {
    char tag[16];
    if (targets[j] == 0) snprintf(tag, sizeof(tag), "per-pass");
    else snprintf(tag, sizeof(tag), "%u", targets[j]);
    if (!ok[j]) { printf("  %-8s  DECODE FAILED\n", tag); continue; }
    printf("  %-8s  %5d   %8.1f   %8.1f\n", tag, paints[j], median(firsts[j]),
           median(totals[j]));
  }
  return 0;
}
