# HANDOFF — 22-Lens Review: jxl-native/native.cc, jxl-native/index.ts, jxl-worker-node/decode-handler.ts

Date: 2026-06-10. Source: 22-lens in-memory review (strategy, API surface, pipeline stages, state machinery, data structures, hot kernels, boundaries, support code, owl, reversal, astronomy, ML/LLM, gaming, photogrammetry, butteraugli, AR, perceptual colour, pure math, hacker, re-pass, gaps, birds-eye).

## Strategic picture (Lens 1/7/22)

`native.cc` implements a **batch** codec: `push()` only appends bytes to a vector; `close()` runs the entire libjxl decode **synchronously** on the calling thread and buffers every event as a strong `napi_ref`; `events()` returns a **snapshot** iterator of whatever is buffered at call time. `index.ts` is loader + type surface. `decode-handler.ts` (node worker) assumes a **streaming** decoder (concurrent feed + event-read loops, adaptive drain, pause/resume, budget) — a protocol mirrored from the browser/WASM backend.

This batch-vs-streaming impedance mismatch produces the single most serious finding (N-1 / I-1): with the native backend, `readDecoderEvents` consumes an empty snapshot iterator before any decode happens, so **the session can complete without delivering a single frame**. Secondary consequences: the drain/EMA machinery measures ~0ms pushes (meaningless for native), budget checks fire only after the full decode has already run, and cancel/pause cannot interrupt the synchronous `close()`. Data crossing JS↔C++ is copied more than necessary: pixels are copied vector→ArrayBuffer in C, then structured-cloned again at the worker port because no transferList is passed.

Agents: 5 sessions, one file each (native.cc split across three agents by concern). IDs: `N*` = native.cc, `I*` = index.ts, `DH*` = decode-handler.ts. Priorities: P0 correctness, P1 important bug/perf, P2 valuable improvement, P3 feature/polish.

**Coordination:** the P0 event-ordering fix is implemented in `index.ts` (Agent 4) as a JS adapter; Agent 2 must NOT also implement a live iterator in C (note only). Agent 5's transferList change (DH-1) depends on `MakeArrayBuffer` staying a *regular* (transferable) ArrayBuffer — Agent 2 must not switch to `napi_create_external_arraybuffer` (external ABs are non-detachable; transfer would throw DataCloneError).

Checked against `docs/rejected optimizations.md` themes: no pixel pools, no drain callbacks in facade, no per-stage budget reset, no compactQueue threshold change proposed.

---

## Agent 1 — native.cc: correctness fixes

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

File: `packages/jxl-native/src/native.cc`. May read other files for context; defer edits elsewhere until end + approval.

### N-2 (P0) Lossless encode is not lossless
`EncodeAll` calls `JxlEncoderSetFrameLossless(frame, JXL_TRUE)` when `distance == 0`, but `JxlEncoderInitBasicInfo` leaves `uses_original_profile = JXL_FALSE`, so data still passes through XYB — output is *not* mathematically lossless (libjxl may even reject the combination). Critical for photogrammetry/digital-twin masters (Lens 14) and archival ingest.
```cpp
JxlEncoderInitBasicInfo(&info);
...
if (data->distance == 0.0) info.uses_original_profile = JXL_TRUE;
```

### N-3 (P1) Memory leak: advanced settings arrays
`CreateEncoder` does `new int32_t[len]` twice; neither `EncoderFinalize` nor `EncoderDispose` frees them. Replace raw pointers in `EncoderData` with owned vectors:
```cpp
std::vector<int32_t> advanced_setting_ids;
std::vector<int32_t> advanced_setting_values;
```
Adjust `EncodeAll` loop to use `.size()`/`[i]`. Removes the leak and the `const_cast` hack.

### N-4 (P1) `jpegReconstructionAvailable` dead ternary
`basic.uses_original_profile == JXL_FALSE ? false : false` is always false (and the source field is wrong anyway). Correct detection: subscribe `JXL_DEC_JPEG_RECONSTRUCTION` in the events mask and set `info.jpeg_reconstruction_available = true` when that status is returned (then `continue`). If JPEG reconstruction is out of scope, hard-code `false` without the misleading ternary and add a comment.

### N-5 (P1) EC `data` property never read (short-circuit on napi_ok)
`napi_get_property` returns `napi_ok` even when the property is absent (value = undefined), so in `CreateEncoder`:
```cpp
if ((napi_get_property(env, item, MakeString(env, "pixels"), &datav) == napi_ok ||
     napi_get_property(env, item, MakeString(env, "data"), &datav) == napi_ok)) {
```
the second arm never evaluates — a plane supplied as `data` is silently dropped. Same latent misuse pattern at the `advancedFrameSettings` and `extraChannels` reads (harmless there only because `napi_is_array(undefined)` is false). Use the existing `GetProp` helper (which checks `napi_has_named_property`):
```cpp
napi_value datav;
if (GetProp(env, item, "pixels", &datav) || GetProp(env, item, "data", &datav)) { ... }
```

### N-6 (P1) Extra-channel names ≥ 32 chars dropped entirely
`char nm[32]` — `JxlDecoderGetExtraChannelName` fails when the buffer is smaller than `name_length + 1`, so long names vanish (botanical channel names like `"chlorophyll_fluorescence_730nm"` are 30+ chars — Lens 12/16). Size dynamically:
```cpp
std::vector<char> nm(ei.name_length + 1, '\0');
if (JxlDecoderGetExtraChannelName(dec, i, nm.data(), nm.size()) == JXL_DEC_SUCCESS) {
  d.name.assign(nm.data(), ei.name_length);
}
```

### N-7 (P1) `quality` not mapped to distance
`CreateEncoder` only uses `quality` to pick a default of 0.0 vs 1.0 (`>= 100`). quality=50 encodes at distance 1.0. libjxl provides the mapping:
```cpp
double quality = GetNullableNumberProp(env, args[0], "quality", -1.0);
double default_distance = (quality < 0.0) ? 1.0
    : static_cast<double>(JxlEncoderDistanceFromQuality(static_cast<float>(quality)));
data->distance = GetNullableNumberProp(env, args[0], "distance", default_distance);
```
(`JxlEncoderDistanceFromQuality` exists in libjxl ≥ 0.10 — verify against the vendored version; otherwise implement the documented piecewise mapping.)

### N-8 (P2) `hasAlpha: false` encode path likely broken
With `has_alpha=false`, `num_extra_channels` may be 0 but `JxlPixelFormat{4, ...}` still declares 4 interleaved channels and `expected` is computed ×4. libjxl rejects 4-channel input when the image declares no alpha. Verify against vendored libjxl; if confirmed, either repack RGBA→RGB (tight 3-channel) before `AddImageFrame` when `!has_alpha && extra_ec_count == 0`, or document that RGBA input requires `hasAlpha: true`.

### N-9 (P3) Silent failures on frame settings
Returns of `JxlEncoderFrameSettingsSetOption` (effort, advanced settings) are ignored — an out-of-range effort or bad advanced id silently degrades. Check returns; on failure destroy encoder and return false (caller throws "libjxl encode failed"; optionally include which setting in the message — see N-19/Agent 3 error granularity).

---

## Agent 2 — native.cc: decode pipeline performance & options

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

File: `packages/jxl-native/src/native.cc`. Coordinate: do NOT implement a live event iterator (Agent 4 fixes ordering in index.ts) and do NOT switch `MakeArrayBuffer` to external ArrayBuffers (breaks Agent 5's transferList — external ABs are non-detachable).

### N-10 (P1) DC/early-exit: decode stops doing wasted work
`progressionTarget: "dc"` currently decodes the *entire* image anyway (DC progress event emitted, then full passes + final). Thumbnail/embedding/AR-preview paths (Lenses 12/13/16) pay full price. After emitting the progression event:
```cpp
if (status == JXL_DEC_FRAME_PROGRESSION && info_known && !pixels.empty()) {
  ...emit "progress" event...
  if (!emit_every_pass && strcmp(progression_target, "dc") == 0) {
    JxlDecoderDestroy(dec);
    return true;  // DC is the requested terminal stage
  }
  continue;
}
```
Note the handler treats only `final`/`header` as terminal-event types; with the Agent 4 adapter the iterator simply ends after the progress event — verify the node handler ends the session cleanly (see DH-4) or emit the DC frame as type `"final"` with `stage: "dc"` instead. Pick the variant matching browser-backend semantics.

### N-11 (P1) `progressiveDetail` option ignored; `pass` target gets DC-only detail
Handler passes `progressiveDetail?: "dc"|"lastPasses"|"passes"|"dcProgressive"`; native never reads it and always calls `JxlDecoderSetProgressiveDetail(dec, kDC)` — so `emitEveryPass`/`progressionTarget:"pass"` never see per-pass events. Map:
```cpp
std::string detail = GetStringProp(env, options, "progressiveDetail", "");
JxlProgressiveDetail jd = kDC;
if (detail == "lastPasses") jd = kLastPasses;
else if (detail == "passes") jd = kPasses;
else if (detail == "dcProgressive") jd = kDCProgressive;
else if (emit_every_pass || strcmp(progression_target, "pass") == 0) jd = kLastPasses;
JxlDecoderSetProgressiveDetail(dec, jd);
```
(Verify enum members against vendored `jxl/decode.h`.)

### N-12 (P1) `region` / `downsample` silently ignored — full frame returned
`DecoderOptions` promises ROI + 1/2/4/8 downsample; native decodes full-res, no `region` field on events — callers (pyramid tile decode) can misinterpret a full frame as a cropped one. Implement post-decode crop (simple row memcpy) and integer box downsample, gated by a fast path:
```cpp
// after decode, before MakeImageEvent("final", ...)
if (region != nullptr) crop_rows(pixels, info, *region, bytes_per_pixel);   // memcpy per row
if (downsample > 1)    box_downsample(pixels, info, downsample, format);    // SoA-free integer mean
```
Update `info.width/height` and set `region` on the emitted event. If you judge downsample out of scope, at minimum **throw** for unsupported values rather than silently ignoring — silent wrong output is the worst of the three options. (Crop applies to progress flushes too; acceptable to crop only `final` first and document.)

### N-13 (P2) Eliminate the progress-event double copy
Each progression event does: `flushed` vector alloc + libjxl flush into it + `MakeArrayBuffer` memcpy into a fresh AB = 2 full-frame copies per pass; `final` pays 1. Create the ArrayBuffer first and let libjxl write straight into it:
```cpp
void* ab_data = nullptr; napi_value ab;
napi_create_arraybuffer(env, pixels.size(), &ab_data, &ab);
if (JxlDecoderSetImageOutBuffer(dec, &pf, ab_data, pixels.size()) == JXL_DEC_SUCCESS &&
    JxlDecoderFlushImage(dec) == JXL_DEC_SUCCESS) {
  ...build event reusing `ab` instead of MakeArrayBuffer(...)...
  JxlDecoderSetImageOutBuffer(dec, &pf, pixels.data(), pixels.size());
}
```
Same idea for the final image: at `JXL_DEC_NEED_IMAGE_OUT_BUFFER`, allocate the napi ArrayBuffer and decode directly into it (keep size in a local; drop the `pixels` vector for the final buffer). Regular ABs stay transferable downstream. For 100 MP RGBA16 this removes ~800 MB of memcpy per decode.

### N-14 (P2) Free input + working buffers promptly
After `DecodeAll` returns inside `DecoderClose`, the (possibly multi-hundred-MB) `data->input` vector lives until `dispose()`/GC finalize. Add at end of successful `DecoderClose`:
```cpp
data->input.clear();
data->input.shrink_to_fit();
```
Optionally accept an `expectedSize` hint in options → `input.reserve()` in `CreateDecoder` to avoid regrowth copies during push (push currently amortized-copies the whole stream ~1× extra).

### N-15 (P2) Buffered-event memory blow-up with emitEveryPass
Every pass event holds a full-frame ArrayBuffer via strong ref until dispose: N passes × frame bytes held simultaneously (e.g., 10 passes × 400 MB). With the batch design this is inherent; mitigate by (a) honoring N-11 so passes are only produced when requested, and (b) documenting the cost in a comment + in `index.ts` docs. A streaming/live-iterator native redesign (decode incrementally inside `push()`, async-work decode off-thread, cancellation between `ProcessInput` calls) is the long-term fix — **do not build it now**; record as a design note at the top of `DecodeAll` so future agents see batch-mode is a known, deliberate constraint.

### N-16 (P3) Misc decode hygiene
- `Probe.path` returns the literal "libjxl native", not a path — rename key or return module path.
- `Version` returns a static string; append runtime `JxlDecoderVersion()` (uint32 maj×1e6+min×1e3+patch) for diagnosability.
- `info.bits_per_sample = BitsForFormat(format)` reports *output* depth, masking source depth; report `basic.bits_per_sample` and let format describe the buffer (verify consumers in jxl-core types first; if parity with WASM facade requires output-depth, leave + comment).

---

## Agent 3 — native.cc: encoder features & metadata

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

File: `packages/jxl-native/src/native.cc`. May propose matching type additions in index.ts but defer those edits to Agent 4 / final approval.

### N-17 (P1) `iccProfile` / `exif` / `xmp` options silently dropped
`EncoderOptions` declares them; native never reads them; every encode stamps sRGB. Wide-gamut ProPhoto/AdobeRGB masters get wrong colour — a prerequisite gap for the perceptual-colour roadmap (Lens 17) and herbarium colour fidelity. In `CreateEncoder` read the three buffers via `ReadBytes` into `EncoderData`; in `EncodeAll`:
```cpp
if (!data->icc.empty()) {
  if (JxlEncoderSetICCProfile(enc, data->icc.data(), data->icc.size()) != JXL_ENC_SUCCESS) { ...fail... }
} else {
  JxlColorEncodingSetToSRGB(&color, JXL_FALSE);
  JxlEncoderSetColorEncoding(enc, &color);
}
if (!data->exif.empty() || !data->xmp.empty()) {
  JxlEncoderUseBoxes(enc);
  if (!data->exif.empty()) JxlEncoderAddBox(enc, "Exif", data->exif.data(), data->exif.size(), JXL_FALSE);
  if (!data->xmp.empty())  JxlEncoderAddBox(enc, "xml ", data->xmp.data(), data->xmp.size(), JXL_FALSE);
  JxlEncoderCloseBoxes(enc);
}
```
Caveat: the `Exif` box payload requires a 4-byte big-endian TIFF-header offset prefix (usually `00 00 00 00`) — prepend if caller supplies raw EXIF. EXIF carries GPS — georeferenced occurrences depend on it surviving transcode (Lens 12/14).

### N-18 (P2) `progressive` option ignored
Map `progressive: true` to frame settings (this is what makes the *decoder's* progression events exist at all for our own encodes):
```cpp
if (GetBoolProp(env, args[0], "progressive", false)) {
  JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_PROGRESSIVE_AC, 1);
  JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_QPROGRESSIVE_AC, 1);
  JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_PROGRESSIVE_DC, 1);
}
```
`previewFirst`/`chunked` remain unimplemented — add a one-line comment each stating so (silent ignoring is the bug, not the absence).

### N-19 (P2) Error granularity across the boundary
Decode/encode failures all throw `"libjxl decode failed"` → handler reports `code: "Internal"`. Use `napi_throw_error(env, "<code>", msg)` with distinct codes: `"InvalidJXL"` (DEC_ERROR), `"TruncatedInput"` (NEED_MORE_INPUT after close), `"EncodeFailed"`, `"UnsupportedOptions"`. The `code` argument surfaces as `err.code` in JS. Handler-side mapping is DH-5 (Agent 5, deferred/approval).

### N-20 (P3) Decode-side extra-channel planes (`extraPlanes`)
`DecodeEvent.final.extraPlanes?: ArrayBuffer[]` exists in the TS surface but native never extracts plane data — depth maps (photogrammetry, Lens 14) and thermal layers (ecology, Lens 12/16) are decoded by libjxl then discarded. At `JXL_DEC_NEED_IMAGE_OUT_BUFFER`, additionally for each EC `i`:
```cpp
size_t ec_size = 0;
if (JxlDecoderExtraChannelBufferSize(dec, &pf_ec, &ec_size, i) == JXL_DEC_SUCCESS) {
  ec_planes[i].resize(ec_size);
  JxlDecoderSetExtraChannelBuffer(dec, &pf_ec, ec_planes[i].data(), ec_size, i);
}
```
with `pf_ec = {1, dt_from_bits(ec.bits_per_sample), JXL_NATIVE_ENDIAN, 0}`; attach as `extraPlanes` array of ArrayBuffers on the `final` event. Gate behind an opt-in decoder option (e.g. `decodeExtraChannels: true`) so the common RGBA path pays nothing.

### N-21 (P3) Encoder output-buffer growth
`out->assign(65536, 0)` + doubling-with-copy on every `NEED_MORE_OUTPUT`. Total copy cost is amortized O(n) but the final `MakeArrayBuffer` adds one more full copy. Cheap wins: seed size from a heuristic (`expected_pixels_bytes / 10` clamped to ≥64 KiB) to skip most doublings for large encodes; keep the rest as-is (simplicity beats a chunk-list here since encode output crosses the port once).

### N-22 (P3) Trivia roll-up (apply opportunistically, no behavior change)
- `JxlExtraTypeFromString(ec.type)` called twice per EC in spot setup — hoist.
- `MakeString` temporaries inside `napi_get_property` loops — switch to `GetProp`/`napi_get_named_property` (also fixes the N-5 pattern).
- `strcmp` chains for `progression_target` evaluated per call site — parse once to an enum at `DecoderClose`.
- Decode `DecodedExtra` type-mapping `if/else` chain duplicates `JxlExtraTypeName` — unify via one table (Lens 19: branches→data).

---

## Agent 4 — index.ts: loader + P0 event-ordering adapter

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

File: `packages/jxl-native/src/index.ts`. May read `native.cc`, `backend-selector.ts`, browser handler for parity; defer edits elsewhere.

### I-1 (P0) events() snapshot races the handler — sessions deliver zero frames
Native `events()` snapshots `data->events` at call time. `decode-handler.run()` starts `readDecoderEvents(decoder)` concurrently with `feedDecoder` — at that moment no events exist, the snapshot iterator is immediately `done`, and every event later buffered by `close()` is never read. The session then ends without posting `decode_header`/`decode_final` (consumer hangs or gets a bare session-end). **First verify** whether `jxl-worker-node/src/backend-selector.ts` already wraps the native decoder to reorder this; if it does, document and skip. If not, fix here by wrapping:
```ts
export function createDecoder(options: DecoderOptions): NativeDecoder {
  const raw = createNativeCodecFacade(loadNativeBinding()).createDecoder(options);
  let release!: () => void;
  const inputDone = new Promise<void>((r) => (release = r));
  return {
    push: (chunk) => raw.push(chunk),
    close: async () => {
      try { await raw.close(); } finally { release(); }  // close() runs the batch decode
    },
    cancel: (reason) => { release(); return raw.cancel(reason); },
    dispose: () => { release(); return raw.dispose(); },
    events: async function* () {
      await inputDone;          // native buffers all events until close(); wait, then drain
      yield* raw.events();
    },
  };
}
```
Apply the same wrapper inside `createNativeCodecFacade` so all construction paths get it. A close() that throws still releases (finally) so the event loop ends instead of hanging; the error propagates from `feedDecoder` and fails the session with the native error (code per N-19).

### I-2 (P1) Cache the loaded binding
`createDecoder`/`createEncoder` call `loadNativeBinding()` per invocation: candidate path resolution, `require` (cached but not free), `probe()` ensure-check — per decoded tile in pyramid workloads. Cache:
```ts
let cachedBinding: NativeBinding | null = null;
export function loadNativeBinding(options: NativeLoaderOptions = {}): NativeBinding {
  const custom = options.prebuiltPath !== undefined || options.sourcePath !== undefined;
  if (!custom && cachedBinding) return cachedBinding;
  ...
      ensureBindingLoaded(binding, candidate);
      if (!custom) cachedBinding = binding;
      return binding;
  ...
}
```

### I-3 (P2) Guard silently-unsupported options at the boundary
Until N-12/N-17 land, callers requesting `region`, `downsample > 1`, `iccProfile`, `exif`, `xmp` get silently wrong output. In the wrapper, throw `CapabilityMissing` (decode: region/downsample; encode: icc/exif/xmp) OR — if scheduler fallback-to-WASM on CapabilityMissing exists — let that reroute. Verify the fallback path before choosing throw vs. warn. Remove guards as native support lands (coordinate with Agents 2/3).

### I-4 (P3) Loader hygiene
- Hoist `require("node:fs")` out of `fileExists` → top-level `import { accessSync } from "node:fs"`.
- `String(import.meta.url)` — drop redundant `String()` (×2).
- `CapabilityMissing`: use native ES2022 `super(message, { cause })` and drop the manual field.

### I-5 (P3) Extend `JxlFrameSetting` constants
Single PATCHES entry today. Add the ids the pipeline already discusses (values per `jxl/encode.h` — verify against vendored header): `EFFORT: 0`? — no; only frame-setting ids actually useful via the escape hatch: `MODULAR`, `PROGRESSIVE_AC`, `QPROGRESSIVE_AC`, `PROGRESSIVE_DC`, `RESPONSIVE`, `EPF`, `GABORISH`, `DECODING_SPEED`, `PHOTON_NOISE`. `DECODING_SPEED` (0–4) is the practical Butteraugli-adjacent lever available at this layer (Lens 15): it trades density for decode speed without touching the perceptual loop. Document each with one line.

---

## Agent 5 — jxl-worker-node/decode-handler.ts

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

File: `packages/jxl-worker-node/src/decode-handler.ts`. Compare against `jxl-worker-browser/src/decode-handler.ts` for parity before each change; defer protocol-type edits (jxl-core) to end + approval.

### DH-1 (P1) postMessage without transferList — full-frame copy per event
Browser handler transfers pixel buffers; node handler structured-clones them (`progress`, `final`, `budget_exceeded`). For a 4000×3000 RGBA16 frame that is ~96 MB cloned per event. Transfer when the Buffer owns its whole ArrayBuffer (never transfer pooled-slab views):
```ts
private postWithPixels(msg: object, pixels: Buffer): void {
  const ab = pixels.buffer;
  const owns = pixels.byteOffset === 0 && pixels.byteLength === ab.byteLength;
  this.port.postMessage(msg, owns ? [ab] : []);
}
```
Use in all three paths. Buffers arriving from the native binding wrap a dedicated per-frame ArrayBuffer (whole-AB view) → transferred; `Buffer.from(arrayBuffer)` views in `toBuffer` preserve that. Small pooled Buffers (e.g. a hypothetical WASM-backend path) fall back to clone. Note: after transfer the local Buffer is detached — ensure no code touches `pixels` after post (currently none does). Do NOT add any buffer reuse/pooling on top (rejected R1-2/R2-2/DH-2).

### DH-2 (P2) `progressiveDetail !== null` lets `undefined` through
```ts
...(this.opts.progressiveDetail !== null ? { progressiveDetail: this.opts.progressiveDetail } : {}),
```
When the field is `undefined` this spreads `{ progressiveDetail: undefined }` — an own-property that breaks `'progressiveDetail' in options` checks in facades. Use `!= null`.

### DH-3 (P2) Session can end without a terminal port message
If `decoder.events()` ends without `final`/`error`/`budget_exceeded` (e.g. native DC early-exit per N-10, or a backend bug), `run()`'s `finally` calls `finishSession(this.state)` with a non-terminal state — `onSessionEnd` fires but no `decode_*` terminal message is posted; upstream consumers awaiting `decode_final` hang. Guard (verify exact browser-handler behavior first and mirror it):
```ts
} finally {
  if (!this.ended) {
    this.failSession("Internal", "decoder event stream ended without a terminal event");
  }
  await this.disposeActiveDecoder();
}
```
(`failSession` already routes through `finishSession`; the old `finishSession(this.state)` call becomes redundant.)

### DH-4 (P2) Document the native-batch reality at the constants block
With the native backend, `push()` is a memcpy (~0 ms) and the entire decode runs inside `close()`: the EMA/adaptive-HWM drain machinery governs nothing, pause/cancel cannot interrupt the synchronous decode (messages queue on the port), and budget is only checked once events flow *after* the decode completes. This is acceptable but must be visible — add a short comment where `HWM_BASE` etc. are declared, e.g. "Adaptive drain is meaningful for streaming backends (WASM); the batch native backend decodes inside close(), so these gates are inert there." Prevents future "tune the HWM for native" work. No code change.

### DH-5 (P3, defer until N-19 lands — request approval)
`run()`'s catch maps every throw to `code: "Internal"`. Once native throws coded errors:
```ts
this.failSession((err as NodeJS.ErrnoException)?.code ?? "Internal",
                 err instanceof Error ? err.message : String(err));
```
Keeps `"InvalidJXL"`/`"TruncatedInput"` distinguishable for retry/fallback policy upstream.

### DH-6 (P3) Trivia
- `onChunk`: compute `chunk instanceof ArrayBuffer` once into a local instead of three times.
- `case "progress"` reassigns `this.state = "progressive"` every event — guard or leave (zero cost; parity with browser decides).

---

## Closing overview

Implementing this set first makes the native backend *correct*: today a node worker using jxl-native can complete a decode session without delivering a single frame (I-1), "lossless" masters are silently transcoded through XYB (N-2), regions and downsamples are silently ignored (N-12), quality settings don't map (N-7), and ICC/EXIF/GPS metadata is stripped on encode (N-17). For a biodiversity platform whose value rests on archival fidelity, georeferenced occurrences, and trustworthy colour, these are not optimizations — they are the difference between the native path being usable or quietly destructive. The leak and dead-code fixes (N-3/N-4/N-5/N-6) harden long-running ingest processes that may push thousands of images through one worker.

The second tier converts the native path from "works" to "fast and lean": decoding directly into JS-owned ArrayBuffers (N-13), transferring rather than cloning frames across the worker port (DH-1), DC early-exit (N-10) and honored progressive detail (N-11), prompt input-buffer release (N-14), and a cached binding (I-2) together eliminate several full-frame memcpys and an entire wasted full-resolution decode on every thumbnail/preview request. For pyramid ingest and ML preprocessing — where thousands of tiles and DC-level embeddings dominate — this compounds into a directly measurable throughput and memory-ceiling win on the node side, mirroring gains already banked in the browser pipeline.

The third tier opens roadmap doors without committing to them: extra-channel plane decode (N-20) gives photogrammetry depth maps and ecological thermal layers a path out of the codestream; progressive-encode mapping (N-18) and the widened `JxlFrameSetting` surface (I-5, incl. `DECODING_SPEED` as the practical decode-cost lever at this layer) make our own files stream the way the viewer expects; coded errors end-to-end (N-19/DH-5) let the scheduler distinguish "corrupt file" from "native missing" and fall back intelligently. The deliberate non-decision is also recorded: the batch-vs-streaming design of native.cc stays, documented in place (N-15/DH-4), so future reviewers stop rediscovering it — and if real-time AR demands an interruptible, incremental native decoder later, that becomes a planned redesign rather than an accident waiting in a `close()` call.
