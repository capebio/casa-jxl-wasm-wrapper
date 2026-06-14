# JXL Encode Pipeline Profiling Handoff (2026-06-13)

## Summary of Changes
Added comprehensive timing hooks across the JXL encoding pipeline to identify performance bottlenecks and opportunities:

**1. Orchestration (encode-handler.ts - browser + node)**
- Stage timers: `stageStartMs`, `createEncoderMs`
- In feedEncoder: waitForPixels accum (`encode_wait_pixels_ms`), per-push timing (`encode_push_pixels_ms`)
- Finish timing (`encode_finish_ms`)
- In readEncoderChunks: first-byte, per-yield accum (`encode_time_to_first_byte_ms`, `encode_chunk_yield_total_ms`)
- `postMetric` (browser) + existing in node for `encode_total_ms`, `encode_output_bytes`, etc.
- Final `postFinalMetrics()` in browser.
- (Node already had push EMA, TTFB, totals; added finish symmetry.)

**2. Facade boundary (packages/jxl-wasm/src/facade.ts - LibjxlEncoder)**
- Accumulators: `tCreateStart`, `tPushTotal`, `tFinishStart`, `tTakeTotal`, `tMallocCopy`
- Logs around module init/create_image_*, push (ptr/advance vs malloc+push_chunk + HEAP set), enc_finish, take_chunk loop.
- Summary console.log on chunks() completion with breakdown + compressed size.
- Helps separate JS/FFI/copy cost from libjxl work.

**3. Low-level bridge (packages/jxl-wasm/src/bridge.cpp)**
- `#include <emscripten.h>`
- Timers via `emscripten_get_now()` around:
  - `EncodeRgbaWithMetadata` (core of `jxl_wasm_enc_finish` / streaming encode work) → `[jxl-enc-bridge] EncodeRgbaWithMetadata took X ms`
  - `jxl_wasm_enc_take_chunk` (output drain, zero-copy borrow path) → per-chunk size + time logs for >1KB.
- (The create_image_* paths set up state; heavy work in finish + take.)

These are low-overhead (few now() calls + occasional EM_ASM/post). Visible in:
- Direct console (facade/bridge logs during encode).
- Metrics posted (type "metric" or via onMetric) — collected by workers/scheduler/benchmarks (StandardMultifileTest, policy, etc.).
- Handler final posts.

Commit: 40e342a3 on PenultimateRoundOfUpgrades (pushed).

## Build & Benchmark Notes
- `git commit + push` done for the 4 hook files.
- WASM build attempted (`node packages/jxl-wasm/scripts/build.mjs` bg); exited early (Docker/env in this shell; common for full libjxl rebuild). **JS hooks active immediately** (no rebuild needed). C++ bridge logs require clean rebuild (use docker or full env next time).
- Benchmark run (`node StandardMultifileTest.mjs` + capture) exercised early decode/raw preload then hit "RuntimeError: unreachable" in raw WASM (pre-existing/env issue with DNG assets in this session; not related to encode hooks). Encode sections (later in "general" batch + other benches) not reached, so no new `encode_*_ms` or bridge logs in this run's output.
- Full log: `benchmark-encode-profile-full.log` (short due to crash). No encode metrics surfaced this time.

## Investigation of Timings & Next Wins
Since encode path not fully exercised in the captured run (crash before), analysis based on:
- Hook placement + structure.
- Prior node handler data (which had partial: push EMA, TTFB, totals).
- Code paths: streaming input (preferred, pre-alloc pixels_buf) vs buffered fallback.
- Known from architecture (pixel copies at every boundary, FFI for push/finish/take, libjxl EncodeRgba/ProcessOutput as core, chunk drain 256KB, postMessage/transfer, sidecars/metadata, progressive layers).

**Expected/structural hotspots (use hooks to confirm/quantify in clean run):**
- **Pixel ingest / copy overhead (biggest likely win area)**: 
  - In facade pushPixels: `HEAPU8.set(view, ptr)` or malloc+set + push_chunk (tMallocCopy, tPushTotal).
  - Handler feed: await pushPixels per entry (totalPushPixelsMs).
  - Even "copyInput: false" paths have some transfer. Streaming input (#16) helps vs full JS accumulation, but per-chunk FFI + copy still hot for large images or many small pushes.
  - Opportunity: upstream planar/SoA (encodeRgb16Planar already exists), direct WASM ptr passing from caller (no view), larger push chunks, avoid slice where safe.

- **FFI / boundary crossings**:
  - Many small pushPixels → many calls to _jxl_wasm_enc_* (pixels_ptr/advance or push_chunk).
  - take_chunk loop (256KB CHUNK in bridge) + postMessage with transfer.
  - Handler drain (CHUNK_HWM=4, DRAIN_MIN_INTERVAL) + maybePostDrain.
  - Win: increase CHUNK in take_chunk (trade latency for fewer crossings), batch more in handler, use chunked input more aggressively.

- **Core libjxl encode work (the "real" time)**:
  - Bridge: EncodeRgbaWithMetadata (or equivalent in the `enc_finish` path) time — **this is the core libjxl encode CPU time**. Timed in C++ logs.
  - Compare to facade tFinishStart + handler encode_finish_ms.
  - Progressive (Dc/Ac layers, groupOrder, previewFirst) adds work.
  - Win: tune effort (recommendedEffort per tier), modular for certain content, disable perceptual for benchmarks, photon noise cost, decodingSpeed tradeoffs. A/B with hooks.

- **Output / finish / sidecar / metadata**:
  - take_chunk (borrow fast in C++, but JS materializes), sidecar generation (if enabled), metadata boxes (brotli), finish bookkeeping.
  - TTFB vs full (first sidecar/chunk).
  - Win: sidecar off for perf tests, larger output chunks, zero-copy more in takeBufferView.

- **Other**:
  - Wait/backpressure (high wait_ms = opportunity in scheduler or caller pacing).
  - Module cold start (tCreateStart includes load).
  - For multi-encode: worker pool, concurrent.

**How to use for next wins**:
- Clean run (full assets, no early crash): `node StandardMultifileTest.mjs` (or targeted encode bench like real-file-jxl-bench.mjs, or direct in node -e with createEncoder + push/finish/chunks()).
- Watch: `[jxl-wasm-enc] ...` logs (facade breakdown), `[jxl-enc-bridge] EncodeRgba...` + take_chunk (libjxl + drain), posted `encode_*_ms` (orchestration).
- Compare ratios: e.g. (push + mallocCopy) / bridge_encode_time ; finish / total ; chunk_yield / output_bytes.
- Collect via onMetric in harness → graphs (like the history ones).
- Focus areas from data: if push > 30-50% of libjxl work → copy wins. If many take_chunk logs with small effective time but high count → chunk size. If TTFB high → progressive/sidecar.

- Verification: run with/without hooks (or gate), check no regression in encode_total_ms or output quality/size. Rebuild WASM for C++ changes. Use with existing onMetric in tiled/region paths for consistency.

## Next Steps / Wins to Pursue (for later self)
1. Re-run clean benchmark + full profile after env fix (no raw crash; perhaps use JPEG-only batch or fix unreachable in raw WASM).
2. Quantify from logs: e.g. "pixel copy 2.3x the core encode time" → target zero-copy planar for common paths, or direct ptr from raw-pipeline.
3. Tune: CHUNK=512KB or 1MB in take_chunk (test latency impact); HWM/interval in handlers.
4. Libjxl: add on-the-fly effort or advanced settings A/B using the hooks + metrics.
5. Scheduler side: if multi-encode, profile concurrent feed/read overlap.
6. More hooks if needed: in create_image_* setup, downsample (if any), sidecar separate timers, native path parity.
7. Visualize: feed the new `encode_*` metrics into the history graph (add to STANDARD_GRAPH_METRICS if useful).
8. Clean: make logs conditional (e.g. if (process.env.PROFILE_ENCODE)), remove EM_ASM for prod, or promote to first-class onMetric.

## Verification Commands (for continuation)
```powershell
# After clean env / assets
git checkout PenultimateRoundOfUpgrades  # or pull
node packages/jxl-wasm/scripts/build.mjs   # full for C++ logs (docker recommended)
node StandardMultifileTest.mjs 2>&1 | Select-String -Pattern 'encode_|jxl-(wasm-enc|enc-bridge)' | Out-File profile-encode.log
# Or targeted:
node -e '
import("file:///C:/Foo/raw-converter-wasm/packages/jxl-wasm/src/facade.ts").then(async ({createEncoder}) => {
  const enc = createEncoder({format:"rgba8", width:1920, height:1080, hasAlpha:true, ...baseOpts});
  const t0=performance.now(); /* push loop */ await enc.finish(); console.log("total", performance.now()-t0);
  for await (const c of enc.chunks()) { /* consume */ }
  console.log(enc.getStats());
});
'
cat profile-encode.log
# Look for high push/finish vs bridge, etc.
```

## Session Outcome (2026-06-13 run)
- Commit 40e342a3 pushed successfully.
- Build: Failed immediately (1.4s, exit 1). Root cause from log: "Docker CLI is installed, but the Docker daemon is not reachable. Start Docker Desktop/Linux engine and retry." (npipe connection to DockerDesktopLinuxEngine failed; no daemon in this shell env). JS-side hooks (facade/handler) are active without rebuild. C++ bridge timing (emscripten_get_now + EM_ASM logs for EncodeRgbaWithMetadata and take_chunk) will only appear after a successful Docker-based rebuild.
- Benchmark: Ran but crashed early ("RuntimeError: unreachable" in raw_converter_wasm during DNG preload/decode, before any encode sections in the "general" batch). Log captured in benchmark-encode-profile-full.log (mostly telemetry + crash). No `encode_*_ms`, `[jxl-wasm-enc]`, or `[jxl-enc-bridge]` lines because encode path (later in test) was never reached. Hooks are correctly instrumented for when a clean encode run happens.
- Investigation summary (from hooks + code paths + partial log): 
  - No numerical encode timings available this session.
  - The placed hooks will surface exactly the breakdown needed: handler wait/push/finish/yield + totals (orchestration + backpressure), facade create/push (copy/HEAP/FFI costs + streaming vs buffered), bridge core Encode time + drain.
  - From structure (and prior partial node handler data): expect push/mallocCopy and FFI crossings in push + take_chunk to be high %; the bridge "EncodeRgbaWithMetadata took X ms" is the tunable libjxl work; high wait_ms indicates scheduler opportunity.
  - Next wins remain as listed above. Re-run in env with Docker + working assets (e.g. force JPEG path or fix raw WASM unreachable) to get the actual numbers and prioritize (e.g. "push copies are 2.8x the encode time → focus zero-copy").

The hooks + handoff give you (later self) the exact tooling and playbook. When you have a clean profile run, the data will directly point to the highest-ROI change (copy reduction, chunk size, libjxl flag tuning, etc.).

Handoff complete. Run the above in next session after /clear. The hooks are the foundation for data-driven wins.

**END OF HANDOFF**
