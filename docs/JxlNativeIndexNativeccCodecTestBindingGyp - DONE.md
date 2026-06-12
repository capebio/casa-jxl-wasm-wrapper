# HANDOFF — jxl-native: index.ts / native.cc / codec.test.ts / binding.gyp (22-lens review)

Files reviewed (only these are in ambit):
1. `packages/jxl-native/src/index.ts`
2. `packages/jxl-native/src/native.cc`
3. `packages/jxl-native/test/codec.test.ts`
4. `packages/jxl-native/binding.gyp`

Strategic view (Lens 1): `index.ts` is the loader + type surface + thin wrapper (option normalization, decoder event-gating via `inputDone`, software seek shims). `native.cc` is a batch N-API addon: decoder accumulates bytes in `push()`, decodes everything synchronously in `close()` into a vector of napi-ref'd events; encoder pins or copies pixels in `pushPixels()`, encodes synchronously in `finish()` into one chunk. `binding.gyp` wires libjxl via pkg-config or `JXL_NATIVE_LIB_DIR`. `codec.test.ts` does small round-trips through the real codec. Data crossing JS↔C++: options object (read once at close/create), pixel ArrayBuffers (pinned zero-copy on single push), event objects with fresh ArrayBuffers back.

Cross-cutting constraint (do not violate): the batch model (all events materialized at `close()`) is deliberate — see design note at `native.cc` DecodeAll header comment. Do NOT build a push()-time decode loop. Async work below keeps batch semantics, only moves the blocking off the event loop.

Prior review overlap: `docs/HANDOFF-jxl-native-index-node-decode-handler-lens-review.md` covered an earlier revision; commit `4e7f9469` implemented much of it (NV-* markers). Items below are new against the current code.

---

## Agent 1 — native.cc: decoder-side correctness & speed

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article.

### 1.1 (P1, perf+bug) Eliminate redundant per-frame copy in animation path
`DecodeAll` non-xform animation branch (~line 1116–1122) memcpy's `main_data` into a fresh ArrayBuffer per frame. But `JXL_DEC_NEED_IMAGE_OUT_BUFFER` fires **per frame** and already allocates a fresh `main_ab` each time (~line 1027). The copy is pure waste (full frame bytes × N frames).
```cpp
} else {
  // main_ab is already a unique per-frame AB (NEED_IMAGE_OUT_BUFFER reallocates each frame)
  frame_pixels_ab = main_ab;
}
```
Verify with a 2-frame animation decode test that frame pixels differ (guards against libjxl reusing the buffer without a second NEED_IMAGE_OUT_BUFFER — if it does not refire, keep the copy and document why).

### 1.2 (P1, perf) Zero-copy single-push decoder input (mirror encoder NV-14)
`DecoderPush` (~line 1464) copies every chunk into `data->input`. The dominant call pattern (jxl-worker-node, tests) is one whole-buffer push then close. Mirror the encoder's pinned-input fast path: add `pinned_input/pinned_data/pinned_size/multi_push` to `DecoderData`; first push pins a ref instead of copying; second push falls back to copy (assign pinned bytes into `input`, then append). In `DecoderClose`, feed `JxlDecoderSetInput` the pinned pointer when present; release the ref after `DecodeAll` returns (input is fully consumed before any return — `JxlDecoderCloseInput` + batch loop guarantee). Also release in `DecoderDispose`/`DecoderFinalize`/cancel-at-close path. Saves a full input copy per decode, and makes `progressionTarget:"header"` probes near-zero-cost. Document the mutation hazard (caller must not mutate the buffer between push and close) in index.ts jsdoc — same hazard already accepted for the encoder.

### 1.3 (P1, bug) `decodeExtraChannels` default contradicts the opt-in design
`DecoderClose` reads `GetBoolProp(env, options, "decodeExtraChannels", true)` (~line 1499), but the N-20 comment above `DecodeAll` and the `DecoderOptions` jsdoc in index.ts both say opt-in. Flip the default to `false`. This changes behavior for the depth-plane test in codec.test.ts, which currently relies on the accidental default — that test must pass `decodeExtraChannels: true` explicitly (coordinate with Agent 4; it is a one-line addition there). Check `packages/jxl-worker-node/src/decode-handler.ts` for reliance on the old default before flipping; if it relies on it, have it pass the flag explicitly (request that edit at the end).

### 1.4 (P2, perf+quality) `transform_fused`: direct-write, rounding, branch-free interior
Three stacked improvements to the fused crop/downsample kernel (~lines 558–829):
a) **Direct write**: every call site copies `work` vector → fresh ArrayBuffer. Split into `fused_dims(info, region, ds, &dw, &dh, &eff_region)` + `transform_fused_into(src, ..., uint8_t* dest)`; call sites compute dims, `napi_create_arraybuffer(dw*dh*bpp)`, write straight in. Removes one full-frame alloc+copy per progress/final/frame event.
b) **Round-to-nearest**: `sum / cnt` truncates (darkening bias up to 1 LSB across the pyramid). Use `(sum + (cnt >> 1)) / cnt`; in the ds==2 interior where cnt==4: `(sum + 2) >> 2`.
c) **Interior fast path**: the ds==2 specialization tests `has_x1`/`row1` per pixel. Hoist: compute `interior_w = (rw / 2)` full columns and run a branchless cnt==4 loop over interior rows/columns (compiler/autovectorizer-friendly), handling the last odd column/row in an epilogue. Same structure for all three formats.

### 1.5 (P2, bug) Animation metadata edge cases
- `anim_loops`: `static_cast<int32_t>` of negative `loopCount` is assigned to `info.animation.num_loops` (uint32) → 4-billion loops. Clamp: `if (loops < 0) loops = 0;`
- `ticksPerSecond` fractional values truncate (`100.5` → 100). Encode as rational: `anim_tps_num = (uint32_t)(tps * 1000 + 0.5); anim_tps_den = 1000;`
- Decoder `animTicksPerSecond` (~line 1170) integer-divides (30000/1001 → 29). Emit a double via `napi_create_double` instead; TS type is `number`, no surface change.

### 1.6 (P2, robustness) Decompression-bomb guard
After `JxlDecoderGetBasicInfo`, `buffer_size` is allocated unchecked — a crafted 1 KB file declaring 100k×100k forces a ~40 GB allocation. Add optional `maxPixels` decoder option (default `1u << 28` = 268M px ≈ 16k×16k):
```cpp
uint64_t px = (uint64_t)basic.xsize * basic.ysize;
if (px > max_pixels) { JxlDecoderDestroy(dec); ThrowCode(env, "ImageTooLarge", "image exceeds maxPixels"); return false; }
```
Add `maxPixels?: number` to `DecoderOptions` in index.ts (request that edit at the end, or coordinate with Agent 3).

### 1.7 (P3, maintainability) RAII guard for `JxlDecoder*`
Nine manual `JxlDecoderDestroy(dec)` call sites in `DecodeAll`. Add `struct DecGuard { JxlDecoder* d; ~DecGuard() { if (d) JxlDecoderDestroy(d); } };` and delete the manual calls. Same pattern already exists for the thread runner.

### 1.8 (P3, feature, benchmark-gated) DC shortcut for `downsample: 8`
For `downsample: 8`, full AC decode runs and is then box-filtered 8×. libjxl's DC is natively 1:8; subscribing FRAME_PROGRESSION with `kDC`, flushing at DC, and downsampling the flushed buffer skips AC decode entirely (most of decode time). Propose as explicit opt-in (`dcShortcut?: boolean`), never automatic — DC is approximate. Per CLAUDE.md, do not land without benchmark numbers (compare wall time + PSNR vs current path on a corpus image). Reject if benchmark unconvincing.

### 1.9 (P3, gap to document) Animation + extraPlanes / progression labeling
- `extraPlanes` only attaches to the non-animation final event; for animation the EC buffers are overwritten per frame and never emitted. Document the gap in the DecodeAll header comment (implementing per-frame planes is out of scope).
- Progression events during animation carry no `frameIndex`; stage is labeled "pass" even under `progressiveDetail:"dcProgressive"`. Add `frameIndex` to progression events when `have_animation` (one `napi_set_named_property`), leave stage labeling as-is with a comment.

---

## Agent 2 — native.cc: encoder-side correctness & speed

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article.

### 2.1 (P2, perf) Lossless-aware output seed
N-21 seed heuristic (~line 1432) assumes ~10:1 compression. Lossless (distance 0) lands at ~2–3:1 → two or three full-buffer doubling copies on large encodes. One line:
```cpp
size_t div = (data->distance == 0.0) ? 3 : 10;
size_t h = pixel_bytes / div;
```

### 2.2 (P2, perf) Avoid zero-fill churn in the output grow loop
`out->assign(seed, 0)` memsets the seed (can be tens of MB) and each `out->resize(size*2)` memsets the new half — pure waste, libjxl overwrites it. Either: (a) keep `std::vector` but seed with `resize` once and accept it, documenting; or (b) switch the grow loop to `malloc/realloc` on a raw buffer and copy once into the final ArrayBuffer (realloc often grows in place). (b) sketch:
```cpp
size_t cap = seed; uint8_t* buf = (uint8_t*)malloc(cap);
uint8_t* next_out = buf; size_t avail = cap;
// on NEED_MORE_OUTPUT:
size_t off = next_out - buf; cap *= 2;
buf = (uint8_t*)realloc(buf, cap); next_out = buf + off; avail = cap - off;
// on SUCCESS: MakeArrayBuffer(env, buf, next_out - buf); free(buf);
```
Mind the `-fno-exceptions` build: check `malloc/realloc` for nullptr and fail with `EncodeFailed`.

### 2.3 (P2, robustness) Check the unchecked libjxl encode calls
`JxlEncoderSetFrameHeader`, `JxlEncoderSetFrameName`, `JxlEncoderSetExtraChannelDistance`, `JxlEncoderSetExtraChannelName`, `JxlEncoderAddBox`, and `JxlEncoderFrameSettingsCreate` (null check) results are ignored. On failure these silently drop metadata or crash later. Check each; on failure `JxlEncoderDestroy(enc); return false;` (matches the existing style).

### 2.4 (P2, diagnosability) Surface libjxl encoder error detail
`EncoderFinish` reports a bare `"libjxl encode failed"`. libjxl exposes `JxlEncoderGetError(enc)` (a `JxlEncoderError` enum). Thread it out of `EncodeAll` (e.g., out-param) and format into the thrown message: `"libjxl encode failed (JxlEncoderError 3)"`. Decode side already has distinct codes (InvalidJXL/TruncatedInput); this brings encode to parity.

### 2.5 (P3, correctness note) `alphaDistance > 0` with `distance == 0`
`JxlEncoderSetFrameLossless(JXL_TRUE)` is set when distance==0, then a non-zero alpha distance may be applied — libjxl's lossless flag overrides per-channel distances. If `alphaDistance > 0 && distance == 0`, skip the lossless flag (set only `SetFrameDistance(0)`), or document that alphaDistance is ignored under lossless. Pick one; add a test note for Agent 4.

### 2.6 (P3, feature) Premultiplied alpha passthrough
`info.alpha_premultiplied` is never set; premultiplied sources round-trip wrong (decoded as straight alpha). Add optional `premultipliedAlpha?: boolean` → `info.alpha_premultiplied = JXL_TRUE`. TS field addition goes through Agent 3 (request at end).

### 2.7 (P3, gap to document) `pushPixels(chunk, region)` region arg is silently ignored
The TS signature advertises region pushes; native reads only argv[0]. Until tiled encode exists, throw `CapabilityMissing`-style error from native when argc >= 2 and arg1 is an object (cheap honesty), or document loudly in index.ts. Coordinate wording with Agent 3.

---

## Agent 3 — index.ts: loader, types, wrapper

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article.

### 3.1 (P2, type bug) Header event is missing `iccProfile`
native.cc attaches `iccProfile` (ArrayBuffer) to the header event when `preserveIcc` (~line 901). The `DecodeEvent` header variant has no such field — consumers must cast. Add:
```ts
| { type: "header"; info: ImageInfo; extraChannels?: readonly DecodedExtraChannel[]; iccProfile?: ArrayBuffer }
```

### 3.2 (P2, bug) Probe wrapper drops future fields
`loadNativeBinding` rebuilds the probe result as `{ loaded, path }` (~line 283), silently discarding anything native adds later (thread count, libjxl version). Use spread: `return { ...base, path: candidate };`

### 3.3 (P2, bug) Software seek shims ignore their argument
`seekToFrame(n)` / `seekToTime(ms)` shims yield **all** events regardless of argument — a seek that doesn't seek. Filter:
```ts
w.seekToFrame = ... : async function* (frameIndex: number) {
  await inputDone;
  for await (const ev of (raw.events ? raw.events() : [])) {
    if (ev.type === "header" || ev.type === "error") { yield ev; continue; }
    if ((ev as any).frameIndex === undefined || (ev as any).frameIndex === frameIndex) yield ev;
  }
};
```
`seekToTime`: capture `animTicksPerSecond` from the final event is too late for filtering on the fly — accumulate `frameDuration` per yielded frame and convert with the first seen `animTicksPerSecond` (it rides the final event; for the shim, buffer events first since the batch is already fully materialized, then filter). Keep it simple: collect `const evs = []; for await (...) evs.push(ev);` then compute the target frame and yield header + that frame. Batch model makes this free.

### 3.4 (P2, validation) Real `guardEncoderOptions`
Currently empty. Add cheap early checks producing clear errors instead of late native `EncodeFailed`:
- `width`/`height`: positive integers.
- `extraChannelPlanes` longer than `extraChannels`, or planes provided with no `extraChannels`: throw (today: silently dropped, ~line 316).
- `frames` present but `animation` missing ticksPerSecond: fine natively (defaults), but `frames` with zero entries + `animation` set → native encodes nothing then fails; throw early.
- Keep `CapabilityMissing` as the error class for consistency with `guardDecoderOptions`, but note in jsdoc it doubles as a validation error (changing the class would break catch sites).

### 3.5 (P3, behavior) Explicit custom path should not silently fall back
When `options.prebuiltPath` is supplied, candidates still include the default source build — a user pinning an exact binary can silently get a different one. If a custom path is given, try only the supplied path(s):
```ts
const candidates = custom
  ? [options.prebuiltPath, options.sourcePath].filter((p): p is string => p !== undefined)
  : [resolvePrebuiltBinary(), resolveSourceBinary()];
```

### 3.6 (P3, perf nit) Double normalization/guarding through the facade
`loadNativeBinding` returns an adapted binding (guards + wraps); `createNativeCodecFacade` then guards/normalizes again. Idempotent (the `id`-dedupe and `__jxlWrappedEvents` flag make the second pass a no-op) but wasteful and confusing. Mark adapted bindings (`(adapted as any).__jxlAdapted = true`) and have `createNativeCodecFacade` pass through when set.

### 3.7 (P3, docs) Document the two sharp edges
jsdoc on `NativeDecoder.events()`: iterating before `close()`/`cancel()`/`dispose()` awaits forever (batch model — `inputDone` gate). jsdoc on `pushPixels`/`push` zero-copy: the buffer is pinned, caller must not mutate it until `finish()`/`close()` resolves. Both are real footguns that cost users debugging time; neither is in the types today.

---

## Agent 4 — codec.test.ts: fix the suite, then widen it

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article.

### 4.1 (P0, bug) Env assertions make the suite unrunnable without machine-specific vars
Every codec test opens with `expect(process.env.JXL_NATIVE_INCLUDE_DIR).toBe(nativeIncludeDir)` where `nativeIncludeDir = env || "C:\\Foo\\raw-converter\\target\\..."`. When the env var is **unset**, the expectation compares `undefined` to the hard-coded default → guaranteed failure on any machine without those exact vars. These assertions test nothing about the codec (they're build-time inputs, irrelevant at test time). Remove them all. Replace availability gating with a real probe:
```ts
let available = true;
try { loadNativeBinding(); } catch { available = false; }
const codecTest = available ? test : test.skip;
```
Use `codecTest(...)` for round-trip tests so the suite passes (skipped) where the addon isn't built, and actually runs where it is.

### 4.2 (P1, bug) Lossless round-trip must be exact
First test encodes with `distance: 0` (+ `uses_original_profile` set natively) yet tolerates `|diff| <= 2`. Lossless means byte-exact; the tolerance would mask a regression in the lossless path (e.g., accidental XYB transform). Change to `expect(decoded[i]).toBe(pixels[i])`. If it fails, that is a real finding — report it, don't restore the tolerance.

### 4.3 (P2) Strengthen the animation test
Asserts only `frameIndex >= 0`. Add: events contain a progress event with `frameIndex: 0`, `frameDuration: 10`, `frameName: "f1"`; final has `frameIndex: 1`, `frameDuration: 20`; decoded final pixels ≈ frame2 (lossless → exact).

### 4.4 (P2) Coordinate with Agent 1.3: depth-plane test must opt in
When `decodeExtraChannels` defaults to `false`, add `decodeExtraChannels: true` to the decoder options of the "encodes with extraChannels depth plane" test. (If Agent 1 rejected 1.3, skip this.)

### 4.5 (P2) Missing coverage — add these tests (each small, same harness style)
- **RGB strip fast path**: `hasAlpha: false` with 4-channel RGBA input → encodes, decodes, RGB matches (exercises the memmove strip, ~native.cc:1679).
- **rgba16 round-trip**: 16-bit lossless in/out exact (exercises bpc=2 paths incl. transform if region used).
- **Region + downsample decode**: encode 8×8 gradient, decode `region {x:2,y:2,w:4,h:4}, downsample: 2` → final 2×2, `region` echoed on event, pixel values = rounded 2×2 box means.
- **Progressive events**: encode with `progressive: true`, decode with `emitEveryPass: true, progressiveDetail: "passes"` → at least one `progress` event precedes `final`.
- **Error codes**: wrong byte length → throws code `PixelSizeMismatch`; truncated JXL (slice valid file in half) → `TruncatedInput`; 3-char custom box type → `InvalidBoxType`.
- **ICC round-trip**: encode with a small synthetic ICC buffer, decode `preserveIcc: true` → header event `iccProfile` byte-equal.
- **Cancel semantics**: decoder cancel then close → events() empty; encoder cancel then finish → throws `Cancelled`.
- **Multi-push equivalence**: pushing a file in 3 chunks decodes identically to one push (exercises the pinned→copy fallback once Agent 1.2 lands).

### 4.6 (P3) Source-grep tests are weak
The `readFileSync`-and-`toContain` blocks assert source text, not behavior — they pass if a field is renamed in semantics but not in name, and fail on harmless reformatting. Keep one as a smoke test if you like, but the real protection is type-checking: a `tsc --noEmit` compile of a snippet that constructs `EncoderOptions`/`DecodeEvent` with the asserted fields. Low priority; do after 4.1–4.5.

---

## Agent 5 — binding.gyp: portability & build hygiene

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article.

### 5.1 (P2) rpath for non-Windows `JXL_NATIVE_LIB_DIR` builds
Linking shared libjxl from a custom dir works at build time, then fails at `require()` unless `LD_LIBRARY_PATH` is set. Inside the existing `OS!='win' and JXL_NATIVE_LIB_DIR` condition add:
```json
"ldflags": [ "<!(node -p \"'-Wl,-rpath,' + process.env.JXL_NATIVE_LIB_DIR\")" ],
"xcode_settings": { "OTHER_LDFLAGS": [ "<!(node -p \"'-Wl,-rpath,' + process.env.JXL_NATIVE_LIB_DIR\")" ] }
```

### 5.2 (P2) Empty `-I` when JXL_NATIVE_INCLUDE_DIR unset
`include_dirs` always evaluates `node -p "... || ''"` → an empty include entry on machines without the var. Move it into a condition like the lib dir:
```json
[ "'<!(node -p \"process.env.JXL_NATIVE_INCLUDE_DIR ? 1 : 0\")'=='1'",
  { "include_dirs": [ "<!(node -p \"process.env.JXL_NATIVE_INCLUDE_DIR\")" ] } ]
```
(The `__has_include` guards in native.cc make the headerless build a clean scaffold fallback, so absence is legitimate.)

### 5.3 (P3) Windows defines: `NOMINMAX` (+ optional `/std`)
native.cc uses `std::min/std::max`; Node's headers can pull in windows.h. Add `"defines": ["NOMINMAX"]` to the `OS=='win'` block to immunize against the min/max macros. Optionally pin `"AdditionalOptions": ["/std:c++17"]` under VCCLCompilerTool for parity with modern libjxl headers.

### 5.4 (P3) Escape hatches: extra libs + opt-in arch flags
- Static libjxl builds sometimes need additional libs (`lcms2`/`skcms` depending on cmake flags). Add an env-gated passthrough: when `JXL_NATIVE_EXTRA_LIBS` is set, append `<!@(node -p \"process.env.JXL_NATIVE_EXTRA_LIBS\")` to `libraries` (both OS branches).
- Local-only performance build: when `JXL_NATIVE_ARCH_NATIVE=1`, add `-O3 -march=native` (POSIX) / `/arch:AVX2` (MSVC). Never default-on (prebuilds must stay portable). This is what lets Agent 1.4's interior loop actually vectorize.

### 5.5 (P3, note) Double-link when pkg-config and JXL_NATIVE_LIB_DIR both resolve
Both POSIX conditions can fire, yielding `-ljxl` twice. Benign (linker dedupes) but confusing; add a one-line comment, or make the pkg-config branch conditional on the env var being absent.

---

## Agent 6 — native.cc: async decode/encode (event-loop liberation) — ARCHITECTURAL

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article.

### 6.1 (P0 by impact, large) Move libjxl work off the JS thread with `napi_create_async_work`
Today `DecoderClose` and `EncoderFinish` run the **entire** libjxl decode/encode synchronously on the calling thread. In jxl-worker-node that thread is a worker (tolerable); used directly (server-side ingest, CLI batch), a 50 MP decode freezes the event loop for hundreds of ms — timers, sockets, other sessions all stall. The TS contract already anticipates this: `close(): void | Promise<void>` and the index.ts wrapper `await`s it.

Plan (keeps the batch model intact — this is NOT a push()-time decode loop):
1. Split `DecodeAll` into a **pure-C++ phase** (no `napi_env`): decode into plain structs — `std::vector<uint8_t>` pixel buffers, `ImageInfo`, frame metadata, icc bytes, error code/message. The existing logic already computes everything from `data->input` + options; options must be **snapshotted at close()-call time** into a plain struct (they're currently read from the `_options` JS property — read them on the JS thread before queuing, which also fixes the latent "JS can mutate _options" hazard).
2. `DecoderClose` queues that phase via `napi_create_async_work`, returns a promise (`napi_create_promise`).
3. The complete callback (JS thread) materializes napi events from the plain structs — exactly the existing `MakeImageEventWithAB`/`RefValue` code, but copying from the C++ buffers into fresh ArrayBuffers (one copy; the direct-write optimization 1.4a doesn't compose with this — accept the copy, it buys a free event loop) — then resolves the deferred.
4. Same treatment for `EncoderFinish` (simpler: one output buffer).
5. Guard: reject a second `close()` while work is queued; `cancel()` before completion sets the flag — check it at the start of the execute callback and at completion (cheap cooperative cancel between the queue and the run; mid-decode cancel stays unsupported, as in WASM).

Sequencing: coordinate with Agent 1 — land Agent 1's items first (they're inside the code you'll be restructuring), or rebase them into the split. If you judge the restructuring risk too high for the current milestone, the fallback is to document the blocking behavior prominently in index.ts and Headline Features — but the async version is the single highest-leverage change in this package and is precisely what makes native worth choosing over WASM on servers. This is a Headline Features candidate.

---

## What implementing this achieves

The headline change is Agent 6: today the native addon does all of its libjxl work synchronously on the calling JavaScript thread, which means any direct server-side use — a herbarium ingest service, a batch pyramid builder, an occurrence-record thumbnailer — freezes its entire event loop for the duration of every decode and encode. Moving that work onto libuv's thread pool while keeping the deliberate batch-event model turns the native package from "fast but only safe inside a dedicated worker" into a first-class server codec that can saturate all cores from a single Node process. Combined with the thread-parallel runner already wired into libjxl, one process can decode several large JXLs concurrently without a worker-pool layer on top.

The decode path also gets meaningfully cheaper per call. Zero-copy pinned input (1.2) removes a full file copy from every decode and makes header-only probes nearly free; the redundant animation frame copy (1.1) and the transform work-vector double-copy (1.4a) each remove a full-frame memcpy per event; the rounded, branch-free 2×2 kernel (1.4b/c) both fixes a systematic darkening bias in every pyramid level built through this path and opens the inner loop to autovectorization — directly relevant given the pyramid is the platform's primary image structure. The decompression-bomb guard (1.6) closes a real robustness hole for a system that ingests files from the public.

Correctness and trust improvements concentrate in the tests and types: the suite currently cannot pass on any machine without two machine-specific environment variables (4.1), and its lossless round-trip tolerates errors that lossless must never produce (4.2) — fixing those converts the tests from decoration into a regression net, and the added coverage (strip path, region/downsample, progressive events, error codes, ICC) exercises exactly the branches the last two feature commits added. The type-level fixes (header `iccProfile`, honest seek shims, real encoder validation) mean consumers stop discovering native behavior by casting and crashing.

Finally, the build file changes (rpath, conditional includes, NOMINMAX, env-gated arch flags and extra libs) are small but remove the classic "links on the build machine, fails to load everywhere else" failure mode, and give local performance builds the compiler latitude (AVX2/`-march=native`) that the new branch-free kernels need to pay off. Together the set tightens every layer of the package — loader, types, kernels, codec lifecycle, tests, and build — without disturbing the deliberate batch-iterator architecture that the rest of the pipeline already depends on.
