# Opus 4.7 Max — RAW → JXL Encode Deep Dive

**Date:** 2026-06-02
**Author:** Opus 4.7 (max effort)
**Scope:** Browser/WASM encode pipeline only. Tauri/native paths noted where they share code but not the primary target.
**Workload anchor:** 20–24 MP RAW (ORF / DNG / CR2) → JXL via the session-worker harness. Baseline numbers below are pulled from `benchmark/runs/session-worker-timings-2026-06-01T22-07-32-355Z.json` (Gobabeb ORF, 5240×3912 = 20.5 MP, headless Chromium, real WASM, `relaxed-simd-mt` tier).

---

## 0. Executive Summary

The biggest remaining cost in the encode pipeline is not arithmetic — it is **threads that exist but aren't used** and **layers that copy data they don't need**. The build already ships a multi-threaded `relaxed-simd-mt` tier (Emscripten `-pthread`, pool sized to `navigator.hardwareConcurrency`), and the WASM module already has a usable pthread pool, but:

- **libjxl runs single-threaded.** `bridge.cpp` never calls `JxlEncoderSetParallelRunner`. The encoder defaults to inline execution. On a typical 4–8 core machine this leaves roughly a **2–3× encode speedup** on the table.
- **The RAW pipeline runs single-threaded in WASM.** `raw-converter-wasm/Cargo.toml` declares `raw-pipeline = { ..., default-features = false }`, disabling the `parallel` feature. The same crate compiled native (Tauri) uses rayon for tonemap, demosaic, and blur. With `wasm-bindgen-rayon` on the existing pthread pool, the tonemap and demosaic passes would parallelize cleanly.
- **The pipeline always converts RGB → RGBA in JS, then libjxl strips alpha back to RGB inside the bridge** when `has_alpha=false`. Pure waste: a full 4× buffer is allocated, written, transferred, and then thrown away. The encoder facade has no `format: "rgb8"`.
- **`encode-handler` does not set `copyInput: false` on its encoder.** Every `pushPixels` therefore performs an extra full-image `.slice()` on a buffer the worker already exclusively owns — one needless copy of ~80 MiB per 20 MP frame on top of the mandatory HEAPU8.set.
- **The streaming-input encoder path is disabled the moment any ICC/EXIF/XMP is present**, which is almost always for a RAW workflow. The buffered fallback re-allocates and re-copies the whole frame inside the encoder before calling libjxl.

Combined, an honest implementation of A1 + A2 + A3 + B1–B4 below brings a current ~8.0 s end-to-end "RAW → JXL" cycle on a 20 MP ORF down to **roughly 3.5–4.5 s** — the user's "cut by 1/3 to 1/2" target — with no quality compromise, no heuristic tricks, and no change to the encoder distance/effort.

Everything below is grounded in concrete file paths and line numbers. No work is required outside this repo.

---

## 1. The Pipeline as it Stands

### 1.1 End-to-end data path (browser, per image)

```
main thread
  │ File → ArrayBuffer (already done by UI)
  ▼
[Worker A: web/worker.js + pkg/raw_converter_wasm]      ← RAW
  │ process_orf(bytes, look)                            ~3.2 s for 20 MP
  │   ├ decompress (LJPEG / split-Y)                    ~1.05–1.20 s
  │   ├ demosaic (RGGB → RGB16)                         ~0.44–0.62 s
  │   └ pipeline::process (RGB16 → RGB8 with tone)      ~1.03–1.35 s     ← single-thread
  │ result.take_rgb()                                   moves Vec<u8> across boundary
  │ rgb_to_rgba(rgb)                                    ~0.21 s          ← 4× alloc + copy
  │ rgbaBuf = rgba.buffer.slice(...)                    small (offset 0 in practice)
  │ postMessage(encode_request, [rgbaBuf])              transfer
  ▼
[main thread, jxl-scheduler]
  │ scheduler.acquireSlot → encode session opened
  │ session.pushPixels(rgbaBuf)
  ▼
[Worker B: jxl-worker-browser/encode-handler]           ← ENCODE
  │ EncodeHandler.feedEncoder → encoder.pushPixels()
  │   ├ copyOrBorrowInput(chunk, true) → .slice()       ← redundant full-image copy
  │   └ HEAPU8.set(view, ptr)                           mandatory JS → WASM copy
  │ encoder.finish()
  │ chunks() iterator:
  │   ├ jxl_wasm_enc_finish → EncodeRgba(...)           ~4.7 s @ effort 4   ← single-thread
  │   │   └ libjxl: alpha-strip → encode → outbuf
  │   └ jxl_wasm_enc_take_chunk (256 KB chunks)         per-chunk inline memcpy
  │ postMessage(encode_chunk, [chunk]) ×N               transfer back
```

For a 20 MP ORF (Gobabeb baseline run):

| Stage                       | Median ms |
|-----------------------------|-----------|
| decompressMs                |     1197  |
| demosaicMs                  |      620  |
| tonemapMs                   |     1346  |
| **rawWallMs**               |   **3174**|
| rgbaPrepMs (rgb_to_rgba)    |      211  |
| encodeMs (push + libjxl)    |     4680  |
| (decodeMs — verification only — not on real export path) | 6802 |
| **Total user-visible RAW → JXL written** | **~8.1 s** |

(Numbers are wall-clock from a fresh headless Chromium with the actual `pkg/raw_converter_wasm_bg.wasm` and the real `relaxed-simd-mt` libjxl tier.)

### 1.2 What is already good — do not redo

The codebase has been through three rounds of micro-optimisation and one round of boundary-cost auditing. The following are *already done* and should not be re-attacked:

- Streaming-output chunking (`enc_take_chunk` 256 KB) — fine size, ownership steal already done.
- Hidden-class hardening on hot session/scheduler call sites.
- `copyWithin` queue compaction in encode-handler.
- `mallocAndCopy` helper and TextEncoder hoisting for animation marshaling.
- Pre-allocated drain/chunk message objects in encode-handler.
- Adaptive HWM backpressure for chunk queue.
- The Phase 2A RGB→RGBA-in-WASM experiment (`take_rgba`). **It regressed on browser** and the recommendation in `docs/suggested-settings.md` is to stay on the JS conversion path — that recommendation stands.

The wins below are all in areas the prior campaigns deliberately deferred or did not yet touch.

---

## 2. Strategic Finds (Tier A — architectural, each >10% of total time)

### A1. Wire `JxlEncoderSetParallelRunner` to a `JxlThreadParallelRunner`

**Where:** `packages/jxl-wasm/src/bridge.cpp`, every `JxlEncoderCreate(nullptr)` site — at minimum the four hot ones in `EncodeRgbaWithMetadata` (line 415), `EncodeRgbaWithGainMap` (line 573), `EncodeRgbaWithExtraChannels` (line 730), and `jxl_wasm_transcode_jpeg_to_jxl[_v2]` (line 2664 / 2723). The same fix is needed on the decode side (`JxlDecoderCreate` in `DecodeRgba` and friends) but is out of scope for this document.

**The problem.** `bridge.cpp` does not include `<jxl/thread_parallel_runner.h>` and never registers a parallel runner. libjxl falls back to its inline runner, meaning the encoder runs single-threaded **even though the WASM module is built with `-pthread`, `-sUSE_PTHREADS=1`, `-sPTHREAD_POOL_SIZE=navigator.hardwareConcurrency`** (see `dist/build-manifest.json`). The pool exists; nothing in libjxl pulls from it.

**The fix.** Add to `bridge.cpp`:

```cpp
#include <jxl/thread_parallel_runner.h>
#include <jxl/thread_parallel_runner_cxx.h>

// Cache a single per-WASM-instance runner — JxlThreadParallelRunnerCreate
// internally spawns worker pthreads, which on the Emscripten build come from
// the pre-sized pthread pool (-sPTHREAD_POOL_SIZE=navigator.hardwareConcurrency).
// Spawning the runner once per encode would burn 50–100 ms per image; cache it.
static void* g_runner = nullptr;
static void* GetSharedRunner() {
  if (g_runner == nullptr) {
    // 0 = let libjxl pick based on hardware_concurrency; passes through to
    // emscripten's std::thread::hardware_concurrency in our build.
    g_runner = JxlThreadParallelRunnerCreate(nullptr, 0);
  }
  return g_runner;
}
```

Then at every `JxlEncoderCreate` site immediately after the null-check:

```cpp
if (JxlEncoderSetParallelRunner(enc, JxlThreadParallelRunner, GetSharedRunner())
    != JXL_ENC_SUCCESS) {
  JxlEncoderDestroy(enc); return MakeError(/* new code */);
}
```

Same thing on `JxlDecoderSetParallelRunner` for the matching decode functions.

**Expected impact.** libjxl's own benchmarks show 2.5–3.5× encode speedup on 4-core machines for effort 4–7 on 20 MP frames. Our `encodeMs ≈ 4680` should fall to **~1500–1900 ms**. This is the single highest-value change in the entire pipeline.

**Risks.**
- The `scalar` and `simd` tiers are built without `-pthread`; on those tiers `JxlThreadParallelRunnerCreate` either fails or returns a 1-thread runner. Gate the runner creation behind a compile-time `#ifdef __EMSCRIPTEN_PTHREADS__`, fall back to `nullptr` (inline runner) on non-pthread builds. The scalar/simd code paths already accept the slower performance — they exist for browsers without COOP/COEP.
- Be careful that **all** worker handlers funnel through the same WASM instance. They already do (one module per worker). The shared runner must not leak across module instances — using a `static` inside the WASM module is correct.
- libjxl thread runners use `pthread_create` which on Emscripten requires the call to happen *off* the main thread of the page. We are already inside a Web Worker (`jxl-worker-browser`), so this is fine — but verify in tests that a unit test which loads the module inside the test thread does not deadlock.

**Verification.**
- `benchmark/session-worker-timings-browser.js` median `encodeMs` over the 30-file Gobabeb set before/after.
- Add an `encodeMetrics.runnerThreads` field (read via `JxlThreadParallelRunnerDefaultNumWorkerThreads`) to the harness so we can confirm the right number of threads is active.

### A2. Turn on the `parallel` feature for the RAW pipeline in the browser

**Where:** `raw-converter-wasm/Cargo.toml` line 13. Currently:

```toml
raw-pipeline = { path = "crates/raw-pipeline", default-features = false }
```

This disables both `parallel` and `jxl-encode`. The `jxl-encode` disable is correct (native libjxl can't cross-compile to wasm32-unknown-unknown). The `parallel` disable is **historical** — see the top-of-file note: *"wasm32 ships without rayon-style threading by default — keep single-thread for now to avoid the COOP/COEP hosting requirement."* COOP/COEP is now a hosting requirement we already meet (the harness sets the headers, and production needs them for the existing JXL MT tier anyway).

**The problem.** `pipeline::process`, `apply_unsharp_masks` → `separable_blur_*`, and `downscale_*` all have first-class `#[cfg(feature = "parallel")]` rayon paths (e.g. `pipeline.rs:227` for blur, `pipeline.rs:295` for the second blur pass, `pipeline.rs:509` for tonemap, `pipeline.rs:713`/`pipeline.rs:787` for downscale). The browser build silently selects the `#[cfg(not(feature = "parallel"))]` arm and runs serially.

The bench shows `tonemapMs ≈ 1346` for 20 MP. This is the LUT + matrix + tone-math pass that is embarrassingly per-pixel parallel. Even a naive 4-way split gives ~3.5× speedup; rayon will likely do better.

**The fix.** Adopt `wasm-bindgen-rayon`:

1. Add a `parallel-wasm` feature to `raw-converter-wasm/Cargo.toml`:

   ```toml
   [features]
   default = []
   parallel-wasm = ["raw-pipeline/parallel", "dep:wasm-bindgen-rayon"]

   [dependencies]
   raw-pipeline = { path = "crates/raw-pipeline", default-features = false }
   wasm-bindgen-rayon = { version = "1", optional = true }
   ```

2. Expose `init_thread_pool` in `src/lib.rs`:

   ```rust
   #[cfg(feature = "parallel-wasm")]
   pub use wasm_bindgen_rayon::init_thread_pool;
   ```

3. Build with `wasm-pack build --target web --release -- --features parallel-wasm`.

4. In `web/worker.js`, after `init()`, before the first `process_orf`, call `await wasm.initThreadPool(navigator.hardwareConcurrency)`. The RAW worker is itself already a Web Worker spawned by the main thread, which is the supported wasm-bindgen-rayon topology.

**Expected impact.** Tonemap drops from ~1346 ms → **~400–500 ms** on a 4-core machine. Demosaic similarly: ~620 ms → ~250 ms. Decompress is largely sequential (predictive LJPEG) so probably no change. Net RAW pipeline: 3174 ms → **~1700–1900 ms**.

**Risks.**
- The page must serve COOP/COEP headers (`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`). The repo already requires these for `relaxed-simd-mt` libjxl, so production is unchanged. Lab tools that don't set these would fall back — gate behind a runtime check before calling `initThreadPool`.
- `wasm-bindgen-rayon` produces a thread pool of "real" Web Workers spawned by the RAW worker, which only works in browsers where nested workers are supported. All major browsers do today.
- The LUT cache in `LUT_CACHE.with(...)` is `thread_local!`. Under rayon, each worker thread builds its own LUT first-call. The clone-on-publish step (`pipeline.rs:486`) is already in place and correct.

**Verification.**
- `benchmark/session-worker-timings-browser.js` median `tonemapMs` + `demosaicMs` over Gobabeb.
- Confirm `phaseMs.tonemap + phaseMs.demosaic ≈ rawWallMs - decompressMs` still holds.

### A3. Add `format: "rgb8"` end-to-end — stop the mandatory RGBA round-trip

**Where:**
- TypeScript: `packages/jxl-wasm/src/facade.ts` — `EncoderOptions.format` type, `expectedPixelBytes`, the `fmt` index that already maps `rgba8|rgba16|rgbaf32 → 0|1|2`.
- C++: `packages/jxl-wasm/src/bridge.cpp` — `EncodeRgbaWithMetadata` already handles `has_alpha=false` by allocating a fresh RGB scratch buffer and copying every pixel out (lines 476–491). We extend the format index so the caller can declare *"the input is already RGB"*, skipping the strip.
- web/worker.js — feed `result.take_rgb()` (3 bytes/pixel) through, drop the `rgb_to_rgba` call.
- Tests update.

**The problem.** Every RAW pipeline output is RGB. The session protocol has no RGB format. So every RAW → JXL path goes:

1. `process_orf` produces RGB8 (`n * 3` bytes).
2. `rgb_to_rgba(rgb)` allocates `n * 4` bytes and writes alpha=255 for every pixel (~210 ms on 20 MP).
3. The 4× buffer is transferred to the encode worker.
4. `copyOrBorrowInput` makes another full-image slice (~80 MiB).
5. `HEAPU8.set` copies the 4× buffer into the WASM heap.
6. libjxl, observing `has_alpha=false`, allocates an RGB scratch buffer and copies all RGB lanes out of the RGBA buffer (`bridge.cpp:476–491`).
7. Encodes from the RGB scratch buffer.

**Three full-image copies and one full-image allocation that exist solely to round-trip through an alpha channel that nothing wants.**

**The fix.** Add `"rgb8"` (and `"rgb16"`, `"rgbf32"` for symmetry — both very small follow-ups) as a top-level format. The bridge already has `num_channels = has_alpha ? 4 : 3` (line 470); the work is:

- In TS: extend the `Format` union, set `expectedPixelBytes` to `w * h * 3` for `rgb8`, route the bridge call to a new `_jxl_wasm_encode_rgb8[_with_metadata][_x]` (or simply pass a new `fmt=3` byte to existing fns — note that `fmt` is already overloaded for `rgba16`/`rgbaf32` so a new index is cleaner). The cleanest path is to add a `num_channels` parameter to the bridge fn and tie `format` → `(num_channels, bits, exp_bits)`.
- In C++: drop the alpha-strip branch entirely when `num_channels=3`. The encoder pipeline already understands 3-channel pixel formats — it just needs to be told.
- In `web/worker.js`: replace

  ```js
  rgba = rgb_to_rgba(result.take_rgb());                            // ← delete
  const rgbaBuf = rgba.buffer.slice(...);                           // ← delete
  postMessage({ ..., rgba: rgbaBuf, ... }, [rgbaBuf]);
  ```

  with

  ```js
  const rgb = result.take_rgb();
  const rgbBuf = rgb.buffer.slice(rgb.byteOffset, rgb.byteOffset + rgb.byteLength);
  postMessage({ ..., pixels: rgbBuf, format: 'rgb8', width: w, height: h, ... }, [rgbBuf]);
  ```

- Update the rotation branch the same way (`rotate_rgb8` already returns RGB).
- `encode-session.ts` passes `format` through unchanged.

**Expected impact.** Direct savings:

| Cost item                                | Before (20 MP) | After |
|------------------------------------------|----------------|-------|
| `rgb_to_rgba` in JS                      | ~210 ms        | 0     |
| Transfer buffer size                     | 80 MiB         | 60 MiB (−25%) |
| `copyOrBorrowInput` slice in handler     | ~25 ms (in a future B1 world it is 0 already, but the data being smaller still helps the next step) | proportionally less |
| `HEAPU8.set` (mandatory JS→WASM)         | ~40 ms         | ~30 ms (−25%) |
| Bridge alpha-strip copy in EncodeRgba    | ~25 ms         | 0     |

Net: **~250–300 ms saved per 20 MP image**, plus a measurable cut in peak memory.

This change also unlocks A2's value: `pipeline::process` already writes RGB8 directly, so we are removing the only consumer of `rgb_to_rgba` on the encode path. The native code (`process_rgba`) already proves the rest of the system understands RGB-output flows.

**Risks.**
- Decode side currently always returns RGBA8. If the user re-decodes their freshly-written JXL (the benchmark does this for verification), the decode worker assumes RGBA. Decoder format selection is independent — there is no behavioural coupling. The benchmark's `decodeMs` measurement is unaffected.
- `JxlBasicInfo.num_color_channels = 3` and `alpha_bits = 0` are already what the bridge writes when `has_alpha=false`. No metadata change.
- Lossless modular distance=0 paths: confirm the pixel format `{3, JXL_TYPE_UINT8, ...}` is accepted by `JxlEncoderAddImageFrame` in modular mode. libjxl docs say yes; verify with a single round-trip test.

**Verification.**
- New unit test in `packages/jxl-wasm/test/`: round-trip RGB8 → JXL → decode-to-RGBA8, assert pixel parity ignoring alpha.
- Session-worker harness `rgbaPrepMs` should fall to ~0 (becomes an `rgbPrepMs` of essentially the take_rgb cost only, which is small).

---

## 3. Tactical Finds (Tier B — each 2–8% of total time, cumulatively meaningful)

### B1. Set `copyInput: false` on the encoder in `encode-handler`

**Where:** `packages/jxl-worker-browser/src/encode-handler.ts`, line 130 — the `encoderOpts` object passed to `this.wasm.createEncoder(...)`. Add `copyInput: false`.

**The problem.** `LibjxlEncoder.pushPixels` (facade.ts:1809) calls `copyOrBorrowInput(chunk, this.options.copyInput !== false)`. The default of `copyInput` is undefined, which is *not* `false`, so the helper does `value.slice()` — a full copy. The encode handler has already received the buffer via a transfer in `postMessage`, owns it exclusively, and immediately writes it into WASM heap. There is nothing to protect against.

**The fix.** One word change — declare `copyInput: false` in the encoder options. The downstream code is already correct: `copyOrBorrowInput(view, false)` returns the underlying Uint8Array directly.

**Expected impact.** Eliminates one full-image `.slice()` per `pushPixels` call. For a single 20 MP RGBA push that is roughly **40–60 ms** of allocator + memcpy time, plus one fewer ~80 MiB allocation peak. After A3 (RGB8) it becomes 30–45 ms but is still pure win.

**Risks.** None I can see. Re-check the buffered-fallback path inside facade.ts (lines 2007–2017) — it stores the borrowed view in `pixelChunks[]` and then copies into a single big malloc on encode. If the underlying ArrayBuffer were detached before that copy (it cannot be — encode-handler owns it until `chunks()` consumes), the access would throw. Verify the existing animation/sidecar tests pass with `copyInput: false`.

### B2. `enc_take_chunk` should return a window, not an inline-copied buffer

**Where:** `packages/jxl-wasm/src/bridge.cpp` line 2491. Function `jxl_wasm_enc_take_chunk`.

**The problem.** `MakeBuffer(s->outbuf + s->taken, take, ...)` allocates `sizeof(JxlWasmBuffer) + take` and `memcpy`s `take` bytes from `outbuf` into the inline tail (line 119). The JS side then reads the inline tail through wasm-bindgen, performing yet another copy. The outbuf is freed only after the *last* chunk is taken (line 2502).

So each 256 KB output chunk is memcpy'd C-side → C-side, then memcpy'd C-side → JS-side. For a 1 MB JXL output (typical for 20 MP at distance 1.0) that is ~4× 256 KB of pure-overhead inline memcpys.

**The fix.** Return a *view* JxlWasmBuffer that points directly into `outbuf + taken` without inline copying. Mark the buffer as "view" so `FreeBufferNoChain` does not call `free(out + 1)` on it. The outbuf itself lives until `enc_free`. Concretely:

```cpp
JxlWasmBuffer* chunk = static_cast<JxlWasmBuffer*>(calloc(1, sizeof(JxlWasmBuffer)));
if (chunk == nullptr) return nullptr;
chunk->data = s->outbuf + s->taken;  // view, do not free
chunk->size = take;
chunk->bits_per_sample = 8;
// FreeBufferNoChain already correctly skips free() when data != reinterpret_cast<uint8_t*>(buf + 1)
// AND data is non-null — extend the check to "data is null OR data is inline" via a flag,
// or set a new `view` bit in the existing reserved space. Cleanest is a new sentinel:
// store the inline marker by setting data = (uint8_t*)(chunk + 1) only when inline.
```

The existing `FreeBufferNoChain` already does `if (buf->data != reinterpret_cast<uint8_t*>(buf + 1)) free(buf->data);` — it would call `free(outbuf + offset)` on a view, which is wrong. Either (a) add an explicit `is_view` flag in the JxlWasmBuffer struct, or (b) use a small custom free function only inside `enc_take_chunk` consumers. (a) is cleaner.

The "free outbuf when last chunk is taken" logic in lines 2502–2507 must move to `enc_free`, since views are still in flight on the JS side at that point — but views from `enc_take_chunk` are read synchronously inside `chunks()` (the iterator pulls one at a time and yields the data immediately), so it would also be safe to leave it where it is.

**Expected impact.** Saves ~1 MiB of unnecessary memcpy per encode. ~5–15 ms per image. Small, but the change is essentially free.

**Risks.** Lifetime confusion. Keep this surgical and document in the struct comment that view-mode JxlWasmBuffer does not own `data`.

### B3. Teach the streaming-input encoder about metadata so RAW → JXL stays on it

**Where:**
- `packages/jxl-wasm/src/bridge.cpp` — `jxl_wasm_enc_finish` (line 2622) currently calls `EncodeRgba` with all metadata params as null. Replace with `EncodeRgbaWithMetadata` so the path can carry ICC/EXIF/XMP. Add a `jxl_wasm_enc_create_image_y_with_metadata` (or extend the existing `_y` variant) that takes ICC/EXIF/XMP pointers and stores them in `JxlWasmEncState` to be used at finish-time.
- `packages/jxl-wasm/src/facade.ts` — `LibjxlEncoder.initModule` line 1864 currently disables streaming input when `hasMetadataOpts` is true. Once the bridge can carry metadata in the streaming-input state, drop the `!hasMetadataOpts` gate.

**The problem.** The streaming-input encoder is the cleanest path: pixels stream from JS into a single pre-allocated WASM buffer, no JS-side accumulation, no `pixelChunks[]`, no second big malloc in encode. But the moment any ICC/EXIF/XMP is present — i.e. essentially every RAW encode — the facade falls back to the buffered path. The buffered path allocates `pixelByteTotal` again inside `chunks()` (facade.ts:2007) and `HEAPU8.set`s every previously-accumulated chunk into it (line 2012). Two full-image buffers live simultaneously during the copy.

**The fix.** Extend `JxlWasmEncState` with `icc`, `exif`, `xmp` byte buffers (stored as separate mallocs at create-image-time, freed at enc_free). At enc_finish, call `EncodeRgbaWithMetadata` with the stored values.

**Expected impact.**
- Removes the second `_malloc(pixelByteTotal)` and the per-chunk `HEAPU8.set` loop entirely.
- Saves the peak-memory overlap of two ~80 MiB pixel buffers (improves on memory-constrained devices).
- Saves ~40–80 ms for a 20 MP image (the copy-into-big-buffer loop).

**Risks.** Streaming-input also currently doesn't carry `boxOpts`/animation/extra-channels/gain-map/sidecar paths — those legitimately need the buffered-then-everything-at-once flow. The fix only needs to handle the *metadata* gate (ICC/EXIF/XMP). The other paths should keep their existing fall-throughs.

### B4. Pack ICC/EXIF/XMP marshaling into one malloc

**Where:** `packages/jxl-wasm/src/facade.ts` lines 1946–1951, 1946 in animation, 2036–2044 in gain-map, 2081–2086 in extra-channels, 2251–2253 in standard metadata. Each blob is independently `_malloc`-ed and `HEAPU8.set`-ed.

**The problem.** Three small mallocs + three small HEAPU8.set + three small _frees per encode. On a hot batch (many files per second) the malloc churn matters; on a single-encode this is small but the call sites also duplicate the same pattern five times.

**The fix.** Helper `mallocAndCopyMany(module, views: Uint8Array[]) → { basePtr, offsets[], free() }` that does one `_malloc(totalSize)` and one or three `HEAPU8.set` calls (still N sets, but on one allocation). The existing `mallocAndCopy` helper is the right shape — extend to many.

**Expected impact.** ~1–3 ms per encode. Real value is **code-quality**: collapses ~50 lines of repetition across five sites into a single call.

### B5. Make `rgb_to_rgba` (and its WASM equivalent) unsafe + SIMD

**Where:** `src/lib.rs` line 1119. Also `crates/raw-pipeline/src/pipeline.rs` if `process_rgba` is ever wired up (it currently isn't called from browser).

**The problem.** The current loop:

```rust
for _ in 0..n {
    out[di] = rgb[si];
    out[di + 1] = rgb[si + 1];
    out[di + 2] = rgb[si + 2];
    si += 3;
    di += 4;
}
```

Every read and write goes through `core::slice::index::SliceIndex` bounds checks. The output is already zeroed (`vec![255u8; n*4]` writes 255 to every byte; we then overwrite RGB). The function is the entire bottleneck for `rgbaPrepMs` (~210 ms on 20 MP) — but **after A3 this function is removed from the encode path entirely**. Keep this finding for any remaining consumer (display / canvas paint) but mark it as low priority once A3 lands.

**The fix (only if A3 is not adopted, or for non-encode callers):**

```rust
pub fn rgb_to_rgba(rgb: &[u8]) -> Vec<u8> {
    let n = rgb.len() / 3;
    let mut out = Vec::with_capacity(n * 4);
    unsafe {
        out.set_len(n * 4);
        let src = rgb.as_ptr();
        let dst = out.as_mut_ptr();
        for i in 0..n {
            let s = src.add(i * 3);
            let d = dst.add(i * 4);
            *d         = *s;
            *d.add(1)  = *s.add(1);
            *d.add(2)  = *s.add(2);
            *d.add(3)  = 255;
        }
    }
    out
}
```

For the SIMD-MT WASM tier, use `std::arch::wasm32::*` (with `#[cfg(target_feature = "simd128")]`) to load 16 RGB bytes (covering 5⅓ RGBA pixels = inconvenient) — actually for RGB→RGBA, the common trick is a 4-pixel block: load 12 bytes (3 lanes RGB), shuffle to insert alpha, store 16 bytes. The codebase doesn't currently use `std::arch::wasm32` SIMD, so this is a meaningful first introduction. Save for after A1/A2/A3 land.

**Expected impact.** Standalone, ~210 ms → ~30–40 ms for 20 MP. But **superseded by A3** for the encode path.

### B6. Warm the encoder during RAW work — overlap createEncoder with `process_orf`

**Where:** session creation in the main thread (where `encode_request` is constructed) and `EncodeSessionImpl` constructor (`encode-session.ts:50`). The acquire-slot already happens at construction time; what doesn't happen until later is the WASM module load + `_jxl_wasm_enc_create_image_y` allocation inside the worker.

**The problem.** Currently the RAW worker decides the user wants an encode only after RAW finishes — then the encode session is built, the encode worker is acquired, the encode WASM module is loaded (if cold), and only then `_jxl_wasm_enc_create_image_y` runs. On a cold worker the module load is ~150–300 ms; the pixel-buffer alloc is small but not free.

**The fix.** When the UI triggers a RAW encode, kick off the EncodeSession creation in parallel with `process_orf`. The session constructor already does the right thing: it acquires the slot and posts `MsgEncodeStart` immediately. The encode worker can run `createEncoder` and load the module while RAW is still in flight. When the first `pushPixels` arrives, the encoder is already warm.

The path of least resistance:

```js
// In the page (main.js) just before posting the RAW request:
const encodeSession = jxl.createEncodeSession({
  format: 'rgb8', width: estimatedW, height: estimatedH,
  hasAlpha: false, distance, effort, exif, xmp, iccProfile,
});
// Hold the session in a Map keyed by task id, deliver pixels when RAW finishes.
```

Width/height of the final image are known from the EXIF orientation in the RAW header before pipeline runs — `decode_orf_raw` already parses them. If exact dims are needed, defer session creation until after `decode_orf_raw` (~50 ms in, well before the ~3 s `process_orf` call) and have RAW signal "header ready" before continuing.

**Expected impact.** Saves cold-start module load on the first image of a session — typically 150–300 ms. Subsequent images don't benefit since the worker is warm. Useful for batch UX (first export becomes much snappier) and total first-image latency.

**Risks.** Width/height must be known. If we kick off the encoder *before* RAW orientation is resolved and then need a portrait/landscape swap, we have to cancel and re-acquire. Defer to the "header ready" path described above to avoid that pitfall.

### B7. Drop the per-`pushPixels` Promise chain microtask

**Where:** `facade.ts:1814` — `this.pendingPushPromise = pushTask.catch(...)` after the await.

**The problem.** Each `pushPixels` allocates a fresh Promise, chains off `pendingPushPromise`, awaits it, and re-stores. For a single big push this is one microtask, negligible. For the buffered path's eventual pre-malloc loop or for callers that chunk into many small pieces this is N microtasks. After A3 (RGB8) and B3 (streaming-with-metadata), a 20 MP encode is a single push: this is a non-issue. Note in case the chunking strategy ever changes.

**Expected impact.** None for current workloads. Listed for completeness.

---

## 4. Already-Considered-and-Rejected (do not redo)

Cross-check against `docs/rejected optimizations.md` and `docs/rejected optimizations_backup.md`:

- Pixel buffer pool for output — rejected (transferred ArrayBuffers detach). Still applies.
- Drain callback on JxlDecoder — wrong layer.
- Soft preemption via yield message — WASM is synchronous mid-push.
- Per-stage budget reset — silently changes semantics.

**None** of A1, A2, A3, B1, B2, B3, B4, B6 has been previously proposed or rejected. They are *new attack surface*. B5 is partially the territory of the rejected Phase 2A `take_rgba` — but B5 is for non-encode consumers only and is subsumed by A3 on the encode path.

---

## 5. Operational Plan (Strategic → Operational)

Land in this order. Each step is independently verifiable; do not bundle.

### Step 1 — A1 (libjxl parallel runner)

1. Add `#include <jxl/thread_parallel_runner.h>` + `<jxl/thread_parallel_runner_cxx.h>` to `bridge.cpp`.
2. Add `GetSharedRunner()` static helper guarded by `#ifdef __EMSCRIPTEN_PTHREADS__`.
3. After every `JxlEncoderCreate(nullptr)`, call `JxlEncoderSetParallelRunner(enc, JxlThreadParallelRunner, GetSharedRunner())`. Five call sites in `bridge.cpp`.
4. Mirror on `JxlDecoderSetParallelRunner` for symmetry (out of strict scope but trivial).
5. Build: `node packages/jxl-wasm/scripts/build.mjs`. Verify all four tiers compile.
6. Bench: 30-file Gobabeb run pre- and post-, compare median `encodeMs`. Expect 2–3× improvement on `relaxed-simd-mt` and `simd-mt`; unchanged on `simd` / `scalar`.

**Stop condition before continuing:** at least 1.8× encode speedup confirmed in the harness on the MT tier. If less, profile thread utilisation before moving on.

### Step 2 — A3 (RGB8 format end-to-end)

1. Extend `Format` union and `expectedPixelBytes` in TS.
2. Extend bridge signatures to take a `num_channels` parameter (or add `_rgb8` variants — both work; `num_channels` parameter is fewer functions).
3. Remove the alpha-strip branch in `EncodeRgbaWithMetadata` etc. for `num_channels == 3`.
4. Add round-trip unit test.
5. Wire `web/worker.js` rotation and non-rotation paths to send `format: 'rgb8'`.
6. Bench: 30-file Gobabeb. Expect `rgbaPrepMs` → 0, total `-200 ms` per image.

### Step 3 — A2 (rayon in RAW)

1. Add `parallel-wasm` feature, `wasm-bindgen-rayon` dep.
2. Re-export `init_thread_pool`.
3. `web/worker.js`: call `await wasm.initThreadPool(navigator.hardwareConcurrency || 4)` after `init()`.
4. Build with `--features parallel-wasm`.
5. Bench: `tonemapMs`, `demosaicMs`, `rawWallMs` over Gobabeb.

### Step 4 — B1 (`copyInput: false`)

One-word change in `encode-handler.ts`. Bench `encodeMs` push portion if you can isolate it (the `encodeMs` field in the harness already covers it).

### Step 5 — B3 (streaming-input with metadata)

1. Extend `JxlWasmEncState` with three byte-buffer fields.
2. Add `jxl_wasm_enc_create_image_with_metadata` (or extend `_y` variant).
3. Have `enc_finish` call `EncodeRgbaWithMetadata` instead of `EncodeRgba`.
4. Drop the `!hasMetadataOpts` gate in `facade.ts:1866`.

### Step 6 — B2 (zero-copy `enc_take_chunk`)

Add `view` flag to `JxlWasmBuffer`. Update `FreeBufferNoChain`. Make `enc_take_chunk` return a view. Move outbuf-free into `enc_free`. Test cancellation paths.

### Step 7 — B4 (pack metadata marshaling)

`mallocAndCopyMany` helper. Replace five call sites.

### Step 8 — B6 (warm encoder during RAW)

Coordinate UI-side. Lower priority — only matters for cold first image.

### Step 9 — B5 (only if any non-encode consumer of `rgb_to_rgba` remains)

Unsafe SIMD. Final polish.

---

## 6. Estimated Cumulative Impact (20 MP ORF, MT tier, 4–8 cores)

| Step | Change | rawWallMs | rgbaPrepMs | encodeMs | Cum. total ms | Cum. saving |
|------|--------|-----------|------------|----------|---------------|-------------|
|      | Baseline (today, Gobabeb median) | 3174 | 211 | 4680 | **8065** | — |
| 1    | + A1 parallel encoder            | 3174 |  211 | ~1700 | **5085** | −2980 ms |
| 2    | + A3 RGB8 format                  | 3174 |   ~5 | ~1700 | **4879** | −3186 ms |
| 3    | + A2 rayon in RAW                 | ~1900 |   ~5 | ~1700 | **3605** | −4460 ms |
| 4    | + B1 copyInput:false              | ~1900 |   ~5 | ~1640 | **3545** | −4520 ms |
| 5    | + B3 streaming-input + metadata   | ~1900 |   ~5 | ~1580 | **3485** | −4580 ms |
| 6    | + B2 zero-copy take_chunk         | ~1900 |   ~5 | ~1570 | **3475** | −4590 ms |

**Net: 8065 ms → ~3475 ms. 57% faster. The user's "1/3 to 1/2 cut" is comfortably exceeded.**

(Numbers above are conservative point-estimates anchored to the per-stage benchmark medians and to published libjxl parallel speedups at effort 4. Actual reductions will vary by hardware and image. The 30-file Gobabeb harness gives stable enough statistics to verify each step in isolation.)

---

## 7. Verification Strategy

For every step:

1. **Targeted** — `node benchmark/targeted-wasm-timings.mjs` on a single CR2 to confirm direction.
2. **Browser/WASM** — `benchmark/session-worker-timings-browser.js` over 30-file Gobabeb to confirm magnitude.
3. **Round-trip** — encode → decode → pixel parity test (Format-specific; RGB8 needs alpha-ignoring compare).
4. **Memory** — peak heap in browser dev tools for a single 20 MP encode pre- and post-.
5. **Tests** — `pnpm test` in the workspace. Encode-handler tests should be unchanged.

For A1 specifically, instrument an `encodeMetrics.runnerThreads` field by exposing `JxlThreadParallelRunnerDefaultNumWorkerThreads` through the bridge; the harness can record it and assert it is `> 1` on the MT tier.

For A2 specifically, instrument `rawMetrics.threads` to confirm rayon is actually scheduling on N > 1 workers (it will trivially be `rayon::current_num_threads()`).

For A3 specifically, add `bytesIngestedAtEncoder` to the encode session stats and confirm it falls to 75% of the previous value.

---

## 8. Out of Scope (Deliberately)

- **Decode-side wins.** Decode is roughly as expensive as encode (`decodeMs ≈ 6802` on the bench), and most of the same arguments apply (single-threaded decoder, RGBA-only). The bench harness re-decodes for verification — production export doesn't. If we eventually want to attack decode, A1's parallel-runner fix mirrors directly onto `JxlDecoderSetParallelRunner`, and B2 mirrors onto every `MakeBuffer` site in the decode flow. Worth its own deep-dive after the encode wins land.
- **GPU offload (WebGPU).** A separable blur or tonemap kernel on WebGPU would crush the remaining single-thread blur/clarity cost, but the architectural change is large and the COOP/COEP + adapter-availability matrix is non-trivial. Defer.
- **Per-row streaming from RAW into the encoder.** Would unlock pipelined RAW || encode overlap. Major surgery to `pipeline::process` (which currently produces a whole RGB buffer in one shot). Not justified until A1/A2/A3 results plateau.
- **Effort/distance tuning.** Out of scope by explicit instruction — no quality compromises.
- **Native (Tauri) path optimisations.** The handoff `docs/HANDOFF-tauri-predator-mode.md` already owns that beat.

---

## 9. Risks Watchlist

| Risk                                                            | Mitigation                                                                                                  |
|-----------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------|
| COOP/COEP not set in some lab/test page                         | Runtime check before `initThreadPool` / before requesting MT tier. Existing tier selector already does this. |
| pthread runner creation deadlocks on main thread                 | Always create from the worker; gate `GetSharedRunner` with the `__EMSCRIPTEN_PTHREADS__` define.            |
| RGB8 format breaks a lossless modular round-trip                 | Add a focused unit test before unblocking the worker change.                                                |
| `process_rgba` (native) drifts from `process` (browser) outputs  | Both share `apply_tone_math` and the LUT cache; the difference is only the trailing `255` write.            |
| Streaming-input encoder with metadata changes compressed bytes   | None — the libjxl call sequence is identical; ICC/EXIF/XMP attachment is order-independent before `CloseInput`. |
| `enc_take_chunk` view aliasing outlives outbuf                   | Yields are synchronous inside the `chunks()` generator; the worker holds the view only long enough to `postMessage(..., [transfer])` which immediately detaches.   |

---

## 10. One-Sentence Hand-off

> **Wire libjxl to the pthread pool, enable rayon on the RAW pipeline, stop converting RGB → RGBA before the encoder — those three changes alone get the user's target. Everything else is polish.**
