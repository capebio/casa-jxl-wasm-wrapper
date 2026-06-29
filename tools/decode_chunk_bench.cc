// Chunked streaming-decode microbench for the sparse ProcessSections change.
//
// A one-shot djxl decode calls FrameDecoder::ProcessSections only ~1-2 times
// (all sections available at once => every group runnable), so it cannot show
// the sparse-dispatch change. This harness feeds the codestream in small chunks
// via JxlDecoderSetInput/ReleaseInput, which drives many ProcessInput cycles
// with few runnable groups each — the path the change targets.
//
// It also FNV-1a hashes the decoded pixels so the same binary doubles as a
// byte-exact oracle (OLD vs NEW must print identical hashes).
//
// Usage: decode_chunk_bench <file.jxl> <chunk_bytes> <reps> <threads> <label>
//   threads=0 => no parallel runner (serial).

#include <jxl/decode.h>
#include <jxl/decode_cxx.h>
#include <jxl/resizable_parallel_runner.h>
#include <jxl/resizable_parallel_runner_cxx.h>
#include <jxl/thread_parallel_runner.h>
#include <jxl/thread_parallel_runner_cxx.h>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <vector>

static std::vector<uint8_t> ReadFile(const char* path) {
  FILE* f = fopen(path, "rb");
  if (!f) {
    fprintf(stderr, "cannot open %s\n", path);
    exit(2);
  }
  fseek(f, 0, SEEK_END);
  long n = ftell(f);
  fseek(f, 0, SEEK_SET);
  std::vector<uint8_t> v(n);
  if (fread(v.data(), 1, n, f) != (size_t)n) {
    fprintf(stderr, "short read %s\n", path);
    exit(2);
  }
  fclose(f);
  return v;
}

static uint64_t Fnv1a(const uint8_t* p, size_t n) {
  uint64_t h = 1469598103934665603ull;
  for (size_t i = 0; i < n; i++) {
    h ^= p[i];
    h *= 1099511628211ull;
  }
  return h;
}

// Streaming decode of `data` fed `chunk` bytes at a time. Returns elapsed
// microseconds; writes the pixel FNV hash + geometry through out params.
static double DecodeOnce(const std::vector<uint8_t>& data, size_t chunk,
                         void* runner, JxlParallelRunner runner_fn,
                         uint64_t* hash_out, uint32_t* w_out, uint32_t* h_out,
                         uint32_t* c_out) {
  auto t0 = std::chrono::steady_clock::now();
  JxlDecoderPtr dec = JxlDecoderMake(nullptr);
  if (runner_fn) {
    if (JxlDecoderSetParallelRunner(dec.get(), runner_fn, runner) !=
        JXL_DEC_SUCCESS) {
      fprintf(stderr, "set runner failed\n");
      exit(3);
    }
  }
  if (JxlDecoderSubscribeEvents(dec.get(), JXL_DEC_BASIC_INFO |
                                               JXL_DEC_FULL_IMAGE) !=
      JXL_DEC_SUCCESS) {
    fprintf(stderr, "subscribe failed\n");
    exit(3);
  }

  const uint8_t* base = data.data();
  const size_t total = data.size();
  size_t offset = 0;  // bytes fully consumed by the decoder
  size_t fed = 0;     // bytes made available so far
  JxlDecoderSetInput(dec.get(), base, 0);

  JxlBasicInfo info{};
  JxlPixelFormat fmt{};
  std::vector<uint8_t> pixels;
  bool have_info = false;

  for (;;) {
    JxlDecoderStatus st = JxlDecoderProcessInput(dec.get());
    if (st == JXL_DEC_ERROR) {
      fprintf(stderr, "decode error\n");
      exit(4);
    } else if (st == JXL_DEC_NEED_MORE_INPUT) {
      size_t remaining = JxlDecoderReleaseInput(dec.get());
      offset = fed - remaining;
      if (fed >= total) {
        fprintf(stderr, "unexpected truncation (offset=%zu total=%zu)\n",
                offset, total);
        exit(4);
      }
      fed = std::min(total, fed + chunk);
      JxlDecoderSetInput(dec.get(), base + offset, fed - offset);
    } else if (st == JXL_DEC_BASIC_INFO) {
      if (JxlDecoderGetBasicInfo(dec.get(), &info) != JXL_DEC_SUCCESS) {
        fprintf(stderr, "basic info failed\n");
        exit(4);
      }
      have_info = true;
      uint32_t nch = info.num_color_channels + (info.alpha_bits > 0 ? 1 : 0);
      fmt = {nch, JXL_TYPE_UINT8, JXL_NATIVE_ENDIAN, 0};
      pixels.assign((size_t)info.xsize * info.ysize * nch, 0);
    } else if (st == JXL_DEC_NEED_IMAGE_OUT_BUFFER) {
      if (JxlDecoderSetImageOutBuffer(dec.get(), &fmt, pixels.data(),
                                      pixels.size()) != JXL_DEC_SUCCESS) {
        fprintf(stderr, "set out buffer failed\n");
        exit(4);
      }
    } else if (st == JXL_DEC_FULL_IMAGE) {
      break;  // single image
    } else if (st == JXL_DEC_SUCCESS) {
      break;
    } else {
      fprintf(stderr, "unexpected status %d\n", (int)st);
      exit(4);
    }
  }
  auto t1 = std::chrono::steady_clock::now();
  if (!have_info) {
    fprintf(stderr, "no basic info\n");
    exit(4);
  }
  *hash_out = Fnv1a(pixels.data(), pixels.size());
  *w_out = info.xsize;
  *h_out = info.ysize;
  *c_out = fmt.num_channels;
  return std::chrono::duration<double, std::micro>(t1 - t0).count();
}

int main(int argc, char** argv) {
  if (argc < 6) {
    fprintf(stderr,
            "usage: %s <file.jxl> <chunk_bytes> <reps> <threads> <label>\n",
            argv[0]);
    return 1;
  }
  const char* path = argv[1];
  size_t chunk = (size_t)strtoull(argv[2], nullptr, 10);
  int reps = atoi(argv[3]);
  int threads = atoi(argv[4]);
  const char* label = argv[5];
  if (chunk == 0) chunk = 1 << 30;
  if (reps < 1) reps = 1;

  std::vector<uint8_t> data = ReadFile(path);

  void* runner = nullptr;
  JxlParallelRunner runner_fn = nullptr;
  JxlThreadParallelRunnerPtr trunner;
  if (threads > 0) {
    trunner = JxlThreadParallelRunnerMake(nullptr, (size_t)threads);
    runner = trunner.get();
    runner_fn = JxlThreadParallelRunner;
  }

  std::vector<double> times;
  times.reserve(reps);
  uint64_t hash = 0, hash0 = 0;
  uint32_t w = 0, h = 0, c = 0;
  for (int r = 0; r < reps; r++) {
    double us = DecodeOnce(data, chunk, runner, runner_fn, &hash, &w, &h, &c);
    if (r == 0) hash0 = hash;
    if (hash != hash0) {
      fprintf(stderr, "NONDETERMINISTIC hash across reps!\n");
      return 5;
    }
    times.push_back(us);
  }
  std::sort(times.begin(), times.end());
  double mn = times.front();
  double med = times[times.size() / 2];
  printf("%s file=%s chunk=%zu threads=%d reps=%d wxh=%ux%u ch=%u "
         "min_ms=%.3f med_ms=%.3f hash=%016llx\n",
         label, path, chunk, threads, reps, w, h, c, mn / 1000.0, med / 1000.0,
         (unsigned long long)hash);
  return 0;
}
