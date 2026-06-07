# Opus 4.8 Suspicions — Leads for Progressive-Streaming Bug/Improvement Hunt

**Date:** 2026-06-06
**Scope:** Initial suspicions to chase in the next task (bugs + improvements across the JPEG XL pipeline, focus = progressive streaming). These are *leads*, not confirmed defects. Each notes where to look and how to confirm. Cross-check against `docs/rejected optimizations.md` before acting — several adjacent ideas are already rejected (see CLAUDE.md "Recurring False Claims").

## A. Flush / progression correctness (highest interest)

1. **Opportunistic flush coupled to input generation** (`bridge.cpp:2041`). Primary perf root cause (see Findings). Also a *correctness* smell: it conflates "stream paused needing input" with "new progressive stage available." Confirm whether any opportunistic snapshot is byte-identical to the prior one (wasted pass). The page already computes `uniqueFrameHashes` / `visibleProgressFrames` — compare pass count vs unique-hash count for this run; if unique ≪ total, many passes are duplicates.

2. **`flush_count == 0` all-zero guard scans 82 MB** (`bridge.cpp:1949-1962`). Only runs on first flush, so cheap in aggregate, but verify the guard can't wrongly reject a legitimate first DC pass that happens to be near-black (dark image). Edge case: very dark/low-key photo → first flush rejected → first visible pass delayed.

3. **`stage` labeling assumes first flush == DC** (`facade.ts:1175`, `:1267`: `flushCount === 1 ? "dc" : "pass"`). If the opportunistic path fires before the true DC pass is complete, the "dc" label may attach to a partial sub-DC snapshot. Verify against `intendedDownsamplingRatio` telemetry (`jxl-single-progressive.js:942`).

4. **`is_last_frame` / final detection vs opportunistic flush.** `final_ready` is set on both `JXL_DEC_SUCCESS` (`:2053`) and `JXL_DEC_FULL_IMAGE` (`:2149`). Confirm an opportunistic flush can't race ahead and mark a pass final prematurely, or conversely that the genuine final FULL_IMAGE write always lands intact (the comment at `:1920-1931` describes a *previously fixed* red-garbage bug from buffer flip-flop — regression-test this path).

## B. Chunking / feed layer

5. **Fixed 32 KB steady chunk** (`jxl-single-progressive.js:13`) doesn't scale with encoded size — over-slices large files. Improvement candidate (Findings #2). Check whether the worker path (`decodeProgressivelyViaWorker`, `:727`) and the scheduler apply any coalescing that would change effective chunk size vs the main-thread path.

6. **First-paint ramp gating uses `passCount`** (`:975`: ramp only while `passCount === 0`). If the first real pass is slow to arrive, the ramp may exhaust into 32 KB chunks before first paint, or conversely keep emitting tiny chunks. Verify ramp→steady transition timing.

7. **`exactBuffer` / `.slice()` copies on every push** (`facade.ts:115` notes a `copyOnPush` flag). Confirm the progressive page isn't paying a defensive per-chunk slice it could skip (caller controls buffer lifetime here).

## C. WASM variant selection (perf, possibly silent)

8. **Is `relaxed-simd-mt` actually selected, or is it falling back to `scalar`?** (`facade.ts` capability cache.) Threaded variants need COOP/COEP headers. If the dev server / page isn't sending `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`, SharedArrayBuffer is unavailable and decode silently runs single-threaded scalar — which would roughly explain the ~1 s/render absolute cost. **Confirm first**: it changes the math for every other perf lead. Check the served headers and log which `.wasm` the facade loaded.

## D. Memory / buffer churn

9. **Double 82 MB hand-off per pass** (bridge `memcpy` at `:1945` + JS `takeBuffer` at `facade.ts:1268`). ~9.6 GB of copies across the run. Improvement (Findings #3/#4): skip copy when no new groups committed; consider single-buffer hand-off for intermediates.

10. **`memset(s->pixels, 0, ...)` zeroes 82 MB on buffer (re)alloc** (`bridge.cpp:2139`). Should be once per frame (only when buffer grows), but verify it isn't re-firing on `NEED_IMAGE_OUT_BUFFER` more than necessary (e.g. if libjxl re-requests the buffer per progressive stage).

11. **`thinRetainedPassPixels` budget = 64 MB** (`jxl-single-progressive.js:948`) but a *single* full-res pass is 82 MB. So retention thinning triggers after the first full-res pass regardless — confirm intended, and that dropped intermediates still export correct stats (the comment at `:961` claims so; verify hashes survive).

## E. Cross-layer invariants to re-verify (per CLAUDE.md)

12. Confirm none of the proposed flush/chunk changes leak backpressure into the facade or add per-stage budget resets — those are explicitly rejected (CLAUDE.md "Layer Invariants"). The flush rate-limit belongs in the bridge/decode-handler, not the session/facade.

13. Confirm the worker decode path (`decodeProgressivelyViaWorker`) preserves the same flush semantics as main-thread (`decodeProgressively`) — divergence between the two would produce inconsistent pass counts/timings depending on the "use worker" toggle.

## Suggested first move for the next task

Build an instrumented WASM (temporary timers around `JxlDecoderFlushImage` + the two memcpys; counters for flushes vs genuine `FRAME_PROGRESSION`; log selected `.wasm` variant). Re-run this exact `P2200608.ORF` case. That single run resolves leads #1, #8, #9, #13 quantitatively and tells us whether the win is "rate-limit flush" (#1), "wrong WASM variant" (#8), or both.
