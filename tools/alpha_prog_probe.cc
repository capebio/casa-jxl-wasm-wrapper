// alpha_prog_probe.cc — experiment harness for alpha + progressive decode.
// Decodes a VarDCT+alpha JXL with kPasses, flushing at each
// JXL_DEC_FRAME_PROGRESSION, and prints stats (mean RGB, mean alpha, %opaque,
// %nonzero) + writes a PAM per flush so intermediate-paint validity can be
// judged numerically and visually. Pair with JXL_ALLOW_ALPHA_PROGRESSIVE to
// toggle the lifted dec_frame.h guard.
//   alpha_prog_probe <jxl> <outbase>

#include <jxl/decode.h>
#include <jxl/decode_cxx.h>
#include <jxl/resizable_parallel_runner.h>
#include <jxl/resizable_parallel_runner_cxx.h>
#include <jxl/types.h>

#include <cstdint>
#include <cstdio>
#include <string>
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

static void WritePAM(const std::string& fn, const uint8_t* buf, size_t w,
                     size_t h) {
  FILE* fp = fopen(fn.c_str(), "wb");
  if (!fp) return;
  fprintf(fp,
          "P7\nWIDTH %zu\nHEIGHT %zu\nDEPTH 4\nMAXVAL 255\nTUPLTYPE "
          "RGB_ALPHA\nENDHDR\n",
          w, h);
  fwrite(buf, 1, w * h * 4, fp);
  fclose(fp);
}

static void Stats(const uint8_t* p, size_t n, const char* label) {
  double r = 0, g = 0, b = 0, a = 0;
  size_t opaque = 0, nonzero = 0;
  for (size_t i = 0; i < n; i++) {
    uint8_t R = p[i * 4], G = p[i * 4 + 1], B = p[i * 4 + 2], A = p[i * 4 + 3];
    r += R; g += G; b += B; a += A;
    if (A == 255) opaque++;
    if (R || G || B || A) nonzero++;
  }
  printf("  %-9s meanRGB=(%5.1f,%5.1f,%5.1f) meanA=%5.1f  opaque=%5.1f%%  nonzero=%5.1f%%\n",
         label, r / n, g / n, b / n, a / n, 100.0 * opaque / n,
         100.0 * nonzero / n);
}

int main(int argc, char** argv) {
  if (argc < 3) {
    fprintf(stderr, "Usage: %s <jxl> <outbase>\n", argv[0]);
    return 1;
  }
  std::vector<uint8_t> jxl;
  if (!LoadFile(argv[1], &jxl)) { fprintf(stderr, "load fail\n"); return 1; }
  std::string base = argv[2];

  JxlResizableParallelRunnerPtr runner = JxlResizableParallelRunnerMake(nullptr);
  JxlDecoderPtr dec = JxlDecoderMake(nullptr);
  JxlDecoderSubscribeEvents(dec.get(), JXL_DEC_BASIC_INFO |
                                           JXL_DEC_FRAME_PROGRESSION |
                                           JXL_DEC_FULL_IMAGE);
  JxlDecoderSetParallelRunner(dec.get(), JxlResizableParallelRunner,
                              runner.get());
  JxlDecoderSetProgressiveDetail(dec.get(), JxlProgressiveDetail::kPasses);
  JxlDecoderSetAllowAlphaProgressive(dec.get(), JXL_TRUE);  // opt-in (this fork)

  JxlPixelFormat format = {4, JXL_TYPE_UINT8, JXL_NATIVE_ENDIAN, 0};
  std::vector<uint8_t> pixels;
  size_t xsize = 0, ysize = 0;
  int prog = 0;
  JxlDecoderSetInput(dec.get(), jxl.data(), jxl.size());
  JxlDecoderCloseInput(dec.get());
  for (;;) {
    JxlDecoderStatus st = JxlDecoderProcessInput(dec.get());
    if (st == JXL_DEC_ERROR) { fprintf(stderr, "decode error\n"); return 1; }
    if (st == JXL_DEC_SUCCESS) break;
    if (st == JXL_DEC_FULL_IMAGE) continue;
    if (st == JXL_DEC_BASIC_INFO) {
      JxlBasicInfo info;
      JxlDecoderGetBasicInfo(dec.get(), &info);
      xsize = info.xsize;
      ysize = info.ysize;
      printf("image %zux%zu, alpha=%d\n", xsize, ysize,
             info.num_extra_channels);
      JxlResizableParallelRunnerSetThreads(
          runner.get(),
          JxlResizableParallelRunnerSuggestThreads(xsize, ysize));
      continue;
    }
    if (st == JXL_DEC_NEED_IMAGE_OUT_BUFFER) {
      size_t bs;
      JxlDecoderImageOutBufferSize(dec.get(), &format, &bs);
      pixels.assign(bs, 0);
      JxlDecoderSetImageOutBuffer(dec.get(), &format, pixels.data(),
                                  pixels.size());
      continue;
    }
    if (st == JXL_DEC_FRAME_PROGRESSION) {
      prog++;
      JxlDecoderFlushImage(dec.get());
      char lbl[16];
      snprintf(lbl, sizeof(lbl), "prog%d", prog);
      Stats(pixels.data(), xsize * ysize, lbl);
      WritePAM(base + "-" + lbl + ".pam", pixels.data(), xsize, ysize);
      continue;
    }
    if (st == JXL_DEC_NEED_MORE_INPUT) break;
    fprintf(stderr, "unknown status %d\n", st);
    return 1;
  }
  Stats(pixels.data(), xsize * ysize, "final");
  WritePAM(base + "-final.pam", pixels.data(), xsize, ysize);
  printf("total progressions = %d\n", prog);
  return 0;
}
