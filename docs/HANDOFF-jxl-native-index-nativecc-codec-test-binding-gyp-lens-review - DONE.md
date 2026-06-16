# HANDOFF — jxl-native 22-Lens Review: index.ts / native.cc / codec.test.ts / binding.gyp

Date: 2026-06-11. Scope locked to:

1. `packages/jxl-native/src/index.ts`
2. `packages/jxl-native/src/native.cc`
3. `packages/jxl-native/test/codec.test.ts`
4. `packages/jxl-native/binding.gyp`

Context: this is the **second** lens pass over jxl-native. The first pass (`HANDOFF-jxl-native-index-node-decode-handler-lens-review.md`) produced items N-10…N-22 which **are implemented** (markers present throughout native.cc). This review found the next layer: the implementation moved but its guards, cache, tests, and build config did not move with it.

Finding IDs: **NV-x** (native v2). Severity: P0 = correctness/crash, P1 = perf/memory/contract, P2 = hygiene/feature.

---

## Strategic map (Lens 1/22)

```
codec.test.ts ──(imports)──> index.ts ──(require .node)──> native.cc ──(links)──> libjxl
                                 │                              ▲
                                 └── guards/wraps options ──────┘
binding.gyp ──(compiles/links)──> native.cc
```

Data flow: JS options object crosses N-API **once** at `createDecoder`/`createEncoder` (stored as `_options`, parsed at `close()`/`finish()`); pixel bytes cross via `ReadBytes` copy; results return as batch-materialized event/chunk lists behind an async-iterator shim. The architecture is deliberately batch (N-15 note) — nothing below proposes a streaming iterator (explicitly out of scope per existing design note in native.cc).

The dominant structural finding: **four desynchronized layers.** native.cc now supports region/downsample/ICC/EXIF/XMP, but index.ts guards still throw `CapabilityMissing` for all of them (NV-1). The test file asserts a feature set (animation, customBoxes, modular sugar, alphaDistance, brotliEffort, extraChannelPlanes) that exists in **neither** TS nor C++ (NV-3). The gyp links `jxl_threads` but native.cc never creates a parallel runner, so every decode/encode is single-threaded (NV-10).

---

## Consolidated findings

### P0

| ID | File | Finding |
|----|------|---------|
| NV-1 | index.ts | `guardDecoderOptions`/`guardEncoderOptions` throw for region/downsample/icc/exif/xmp — all **implemented** in native.cc (N-12/N-17). Stale guards block shipped features. |
| NV-2 | index.ts | `loadNativeBinding` caches the **raw** binding (line 225) but returns the adapted one → second call returns unadapted binding (no guards, no `wrapDecoder`). Inconsistent API across calls. |
| NV-3 | codec.test.ts | Massive test↔impl drift: source-grep tests assert strings absent from index.ts (`alphaDistance`, `extraChannelPlanes`, `AnimationFrame`, `frameIndex?`, `progressiveDc?: 0 \| 1 \| 2`, `id: 19`, `id: 13`…); runtime tests pass options native.cc ignores (`brotliEffort`, `modular`, `modularOptions`, `customBoxes`, `animation`, `frames`, `alphaDistance`, `extraChannelPlanes`) and assert results that can't exist (`final?.animTicksPerSecond`). Most of the suite fails against current code. Resolution: implement the missing feature set (Agents 1–3) and repair tests (Agent 4). |
| NV-4 | native.cc | **Use-after-free hazard** in progress flush (both branches, ~lines 786–813): if `SetImageOutBuffer(snap)` succeeds but `FlushImage` fails, the main buffer is never restored; `snap_ab` is unreferenced → GC can free it while libjxl keeps writing into it. Restore `main_data` unconditionally. |
| NV-5 | native.cc | **RGBA-as-RGB encode**: `EncodeAll` checks `pixels.size() < expected` (not `!=`). With `hasAlpha:false` and RGBA input (16 bytes vs expected 12), libjxl reads interleaved RGBA as RGB triplets → channel-shifted garbage. The depth-plane test does exactly this. Same bug class as the casabio_encode P0. |
| NV-6 | native.cc | Silent-failure paths: `DecodeAll` returns `false` without a pending exception on SubscribeEvents/GetBasicInfo/ImageOutBufferSize failures → `DecoderClose` returns `nullptr` with no exception → JS sees a **successful** close and an empty event stream. |

### P1

| ID | File | Finding |
|----|------|---------|
| NV-7 | index.ts | `wrapDecoder`: `events()` awaits `inputDone` which is only released by `close()`. Consumer calling `events()` after `cancel()` or `dispose()` (or without `close()`) **hangs forever**. Release on cancel/dispose too. |
| NV-8 | native.cc | EC distance bug: `ch_dist = (ec.distance > 0.0) ? … : -1.0f` folds **distance 0 (= lossless per the TS doc)** into −1 ("follow frame distance"). Must be `>= 0.0`. Depth test passes only because frame distance is also 0. |
| NV-9 | native.cc | `DecoderDispose`/`EncoderDispose` use `.clear()` which does **not** release capacity — a disposed encoder can pin hundreds of MB of pixel buffer until GC finalize. Use the swap idiom. (N-14 fixed the post-decode path only.) |
| NV-10 | native.cc + binding.gyp | `jxl_threads` is linked but never used: `JxlDecoderCreate(nullptr)`/`JxlEncoderCreate(nullptr)` with no parallel runner → single-threaded codec. Biggest available speed lever (Lens 15): `JxlThreadParallelRunner` makes effort-3+ encode and progressive decode scale with cores. |
| NV-11 | native.cc | `close()` after `cancel()` still runs the full decode (cancelled flag unchecked in `DecoderClose`); same for `EncoderFinish`. Wasted full-frame work. |
| NV-12 | native.cc | ICC + lossy encode: `uses_original_profile` only set for distance==0; supplying ICC with distance>0 likely fails `JxlEncoderSetICCProfile` or drops the profile. Set `uses_original_profile = JXL_TRUE` whenever ICC supplied (verify against linked libjxl version). |
| NV-13 | native.cc | region/ds progress path does ~4 full-frame copies (snap AB → work vector → crop alloc → ds alloc → out AB memcpy). Compute final dims first, fuse crop+downsample, write once. Also: no-op region (0,0,w,h) should skip entirely. |
| NV-14 | native.cc | Encoder input copy: `pushPixels` copies the whole frame into `data->pixels`. Single-push is the ~95% case → hold a `napi_ref` to the pushed buffer and pass its pointer at `finish()` (zero-copy fast path); fall back to copy on second push. |
| NV-15 | codec.test.ts | Every test hard-asserts David's machine paths (`C:\\Foo\\raw-converter\\target\\…`, `C:\\TEMP\\jxl-mt-libs`) → fails on any other machine/CI. Replace with `describe.skipIf(!process.env.JXL_NATIVE_LIB_DIR)`. |
| NV-16 | native.cc | Decode never extracts ICC (`preserveIcc` accepted, ignored). Wide-gamut JXLs decode with no profile info → colour mismatch downstream (herbarium fidelity). Subscribe `JXL_DEC_COLOR_ENCODING`, attach `iccProfile` to header event. |
| NV-17 | native.cc | Animation: all frames decode (each `NEED_IMAGE_OUT_BUFFER` allocates a new AB) but only the **last** frame is emitted; earlier frame ABs are orphaned work. No `frameIndex`/`duration`/`animTicksPerSecond`. Pairs with NV-3 animation tests. |

### P2

| ID | File | Finding |
|----|------|---------|
| NV-18 | index.ts | `wrapDecoder` extracts methods (`push: raw.push`) — fine for napi functions (data pointer travels with the function), but breaks `this` for any JS mock binding. Use delegating arrow functions. |
| NV-19 | index.ts | `DecoderOptions.extraChannels?: readonly DecodedExtraChannel[]` is meaningless decoder **input**; remove or document as reserved. |
| NV-20 | native.cc | No clamping: `effort` (should be 1–9) and `distance` (0–25) pass straight to libjxl → opaque generic failure. Clamp at parse. |
| NV-21 | native.cc | Progress/final `region` echoed as `{0,0,w,h}` — origin of the requested region is lost. Echo source coordinates `{region.x, region.y, cropped_w, cropped_h}`. |
| NV-22 | native.cc | `pixelStride` hardcoded `4` on every event. If consumers read it as bytes it is wrong for rgba16/f32. Verify meaning against jxl-core types; document as channels-per-pixel or compute bytes. |
| NV-23 | native.cc | `DecodeEvent` union declares `"error"` and `"budget_exceeded"` but native never emits either (it throws). Document the divergence in index.ts (parity note vs WASM facade). |
| NV-24 | codec.test.ts | Lossless round-trip (distance 0) asserts tolerance ≤2 — lossless must be **exact** (`toBe`). Weak assertion masks regressions. |
| NV-25 | binding.gyp | No macOS settings; no explicit C++ standard; empty `include_dirs` entry when env unset; pkg-config misses `libjxl_threads`; Windows MT/MD runtime mismatch risk against static libs undocumented. |
| NV-26 | index.ts | Packaging check: prebuilt name `jxl-native.node` (hyphen) vs gyp `jxl_native.node` (underscore); `packageRoot` is `dirname(import.meta.url)` — verify `..\prebuilds` still resolves correctly from the compiled `dist/` layout. |

---

## Agent 1 — `packages/jxl-native/src/index.ts`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Only edit `packages/jxl-native/src/index.ts`. You may read native.cc and jxl-core types for reference. Defer any edits to other files to the end and request approval first.

### 1A. Remove stale guards (NV-1) — P0

native.cc implements post-decode region crop + box downsample (N-12, `DecoderClose` ~line 1098) and ICC/EXIF/XMP boxes (N-17, `EncodeAll` ~lines 906–1029). Delete the throws:

```ts
function guardDecoderOptions(opts: DecoderOptions): void {
  if (opts.region != null) {
    const { x, y, w, h } = opts.region;
    if (w <= 0 || h <= 0 || x < 0 || y < 0) {
      throw new CapabilityMissing("region must have positive w/h and non-negative x/y");
    }
  }
  // downsample 1|2|4|8 is enforced by the type; native clamps invalid values to 1.
}

function guardEncoderOptions(_opts: EncoderOptions): void {
  // iccProfile/exif/xmp are implemented natively (N-17). No capability guards remain.
}
```

### 1B. Cache the adapted binding (NV-2) — P0

```ts
// in loadNativeBinding, replace lines ~225-226:
const adapted = adaptBindingCreators(rawBinding);
if (!custom) cachedBinding = adapted;
return adapted;
```

`adaptBindingCreators` must then preserve the patched `probe` (it already copies it) — verify the wrapped probe (N-16 path patch) lands on the adapted object, not only the raw one.

### 1C. `wrapDecoder` hang + this-binding (NV-7, NV-18) — P1

```ts
function wrapDecoder(raw: NativeDecoder): NativeDecoder {
  if ((raw as any).__jxlWrappedEvents) return raw;
  let release!: () => void;
  const inputDone = new Promise<void>((r) => (release = r));
  const w: any = {
    push: (chunk: ArrayBuffer | Uint8Array) => raw.push(chunk),
    close: async () => {
      try { await raw.close(); } finally { release(); }
    },
    cancel: async (reason?: string) => {
      try { await raw.cancel(reason); } finally { release(); }
    },
    dispose: async () => {
      try { await raw.dispose(); } finally { release(); }
    },
    events: async function* () {
      await inputDone;
      yield* raw.events ? raw.events() : [];
    },
  };
  // … keep seek shims, also via delegating arrows …
}
```

### 1D. Encoder option sugar — close the NV-3 gap TS-side

The test comment states the intended design: *"wiring via convert to adv ids (19=PROGRESSIVE_DC, 13=GROUP_ORDER) so no cc change needed."* Add typed fields and normalize them into what native.cc already understands (`advancedFrameSettings` + per-EC duck-typed `pixels`):

```ts
export interface AnimationOptions { ticksPerSecond: number; loopCount: number; }
export interface AnimationFrame {
  data: ArrayBuffer | Uint8Array;
  width: number; height: number;
  duration: number;           // in ticks
  name?: string;
}
export interface CustomBox { type: string; data: ArrayBuffer | Uint8Array; compress?: boolean; }

export interface EncoderOptions {
  // … existing fields …
  /** Per-alpha-channel distance; 0 = lossless alpha. Forwarded natively (Agent 3). */
  alphaDistance?: number;
  /** Brotli effort for modular/metadata streams (0-11). -> JXL_ENC_FRAME_SETTING_BROTLI_EFFORT (id 32). */
  brotliEffort?: number;
  /** Top-level progressiveDc convenience. -> id 19 (PROGRESSIVE_DC). */
  progressiveDc?: 0 | 1 | 2;
  /** -> id 13 (GROUP_ORDER). */
  groupOrder?: 0 | 1;
  /** Force modular (1) / VarDCT (0). -> id 11. */
  modular?: -1 | 0 | 1;
  /** -> id 27 (MODULAR_PREDICTOR), id 26 (MODULAR_GROUP_SIZE). */
  modularOptions?: { predictor?: number; groupSize?: number };
  /** Plane data, index-aligned with extraChannels. Merged into per-EC `pixels` for native. */
  extraChannelPlanes?: readonly (ArrayBuffer | Uint8Array)[];
  animation?: AnimationOptions;
  frames?: readonly AnimationFrame[];
  customBoxes?: readonly CustomBox[];
}
```

Normalizer (call inside facade `createEncoder` before invoking native):

```ts
function normalizeEncoderOptions(opts: EncoderOptions): EncoderOptions {
  const adv = [...(opts.advancedFrameSettings ?? [])];
  const map: Array<[number | undefined, number]> = [
    [opts.progressiveDc, 19], [opts.groupOrder, 13], [opts.modular, 11],
    [opts.modularOptions?.predictor, 27], [opts.modularOptions?.groupSize, 26],
    [opts.brotliEffort, 32],
  ];
  for (const [v, id] of map) if (v !== undefined) adv.push({ id, value: v });
  let extraChannels = opts.extraChannels;
  if (opts.extraChannelPlanes && extraChannels) {
    extraChannels = extraChannels.map((ec, i) =>
      opts.extraChannelPlanes![i] ? { ...ec, pixels: opts.extraChannelPlanes![i] } as any : ec);
  }
  return { ...opts, advancedFrameSettings: adv.length ? adv : undefined, extraChannels };
}
```

Verify the setting IDs against the `jxl/encode.h` actually linked (`JXL_ENC_FRAME_SETTING_BROTLI_EFFORT = 32`, `MODULAR_PREDICTOR = 27`, `MODULAR_GROUP_SIZE = 26` in libjxl ≥0.8; the values already in `JxlFrameSetting` (PATCHES=8, GROUP_ORDER-adjacent 16–19) are consistent with this enum). Extend the `JxlFrameSetting` const with `GROUP_ORDER: 13`, `BROTLI_EFFORT: 32`, `MODULAR_GROUP_SIZE: 26`, `MODULAR_PREDICTOR: 27`.

`alphaDistance`, `animation`/`frames`, `customBoxes` need native.cc support (Agent 3) — add the types now, document "requires native ≥0.2".

### 1E. Decode event fields for animation parity (with Agent 2)

Add to `progress`/`final` variants: `frameIndex?: number; frameDuration?: number; frameName?: string; animTicksPerSecond?: number;`. Document that native populates them only for animated codestreams.

### 1F. Hygiene

- Remove `DecoderOptions.extraChannels` (NV-19) or mark `/** reserved; ignored by native */`.
- Doc-comment on `DecodeEvent`: native backend throws instead of emitting `"error"`, and never emits `"budget_exceeded"` (NV-23).
- Verify prebuilt filename convention vs gyp target name (NV-26): `prebuilds/<platform>-<arch>/jxl-native.node` vs `build/Release/jxl_native.node`. If the packaging script outputs underscore, fix `resolvePrebuiltBinary`.

Success criteria: the four source-grep test blocks in codec.test.ts pass (`bun test packages/jxl-native/test/codec.test.ts -t "in native index.ts"`); `tsc --noEmit` clean; no behavioral change for already-working option sets.

---

## Agent 2 — `packages/jxl-native/src/native.cc` (decoder side)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Only edit native.cc, decoder-side functions (`DecodeAll`, `DecoderClose`, `DecoderDispose`, `crop_to_region`, `box_downsample_inplace`, event builders). **Run before Agent 3** (same file). Preserve the batch/iterator model — do not build a streaming decode loop (explicit prior constraint).

### 2A. Fix the flush UAF (NV-4) — P0

Both progress branches (~lines 786–813). Restore the main buffer unconditionally, and only keep the snap AB if the flush fully succeeded:

```cpp
void* snap = nullptr;
napi_value snap_ab;
napi_create_arraybuffer(env, main_size, &snap, &snap_ab);
bool flushed = JxlDecoderSetImageOutBuffer(dec, &pf, snap, main_size) == JXL_DEC_SUCCESS &&
               JxlDecoderFlushImage(dec) == JXL_DEC_SUCCESS;
// ALWAYS point libjxl back at the long-lived main buffer before any continue.
JxlDecoderSetImageOutBuffer(dec, &pf, main_data, main_size);
if (flushed) { /* build event from snap_ab / run crop+ds */ }
```

(If the first `SetImageOutBuffer(snap)` failed, the restore call may return an error because main is still set — that is harmless; ignore its status.)

### 2B. No silent false (NV-6) — P0

Either add `ThrowCode(env, "DecodeFailed", "…")` before every bare `return false` in `DecodeAll`, or centralize in `DecoderClose`:

```cpp
if (!DecodeAll(env, data, format, target, emit_every_pass, decode_extra, prog_detail,
               has_region ? &reg : nullptr, downsample)) {
  bool pending = false;
  napi_is_exception_pending(env, &pending);
  if (!pending) ThrowCode(env, "DecodeFailed", "libjxl decode failed (internal)");
  return nullptr;
}
```

Also clear+shrink `data->input` on the failure path (currently only cleared on success).

### 2C. Honor cancel at close (NV-11) — P1

Top of `DecoderClose` after the `closed` check:

```cpp
if (data->cancelled) {
  std::vector<uint8_t>().swap(data->input);
  return Undefined(env);
}
```

### 2D. Real memory release in dispose (NV-9) — P1

```cpp
static napi_value DecoderDispose(napi_env env, napi_callback_info info) {
  …
  for (napi_ref ref : data->events) napi_delete_reference(env, ref);
  data->events.clear();
  std::vector<uint8_t>().swap(data->input);   // clear() keeps capacity; swap frees it
  …
}
```

### 2E. Parallel runner (NV-10) — P1, biggest speed win

`jxl_threads` is already linked (gyp). In `DecodeAll`:

```cpp
#include <jxl/thread_parallel_runner.h>
// after JxlDecoderCreate:
void* runner = JxlThreadParallelRunnerCreate(nullptr, JxlThreadParallelRunnerDefaultNumWorkerThreads());
if (runner) JxlDecoderSetParallelRunner(dec, JxlThreadParallelRunner, runner);
// destroy AFTER JxlDecoderDestroy at every exit path:
JxlThreadParallelRunnerDestroy(runner);
```

There are ~8 exit paths — introduce a small RAII guard struct (or a single `cleanup:` pattern) so no path leaks the runner. Linux pkg-config builds may need `libjxl_threads` added (Agent 5 handles gyp; if missing, guard with `__has_include(<jxl/thread_parallel_runner.h>)`).

### 2F. ICC extraction on decode (NV-16) — P1

When `_options.preserveIcc` is true (thread a `bool preserve_icc` parameter into `DecodeAll`):

```cpp
if (preserve_icc) events |= JXL_DEC_COLOR_ENCODING;
…
if (status == JXL_DEC_COLOR_ENCODING) {
  size_t icc_size = 0;
  if (JxlDecoderGetICCProfileSize(dec, JXL_COLOR_PROFILE_TARGET_DATA, &icc_size) == JXL_DEC_SUCCESS && icc_size > 0) {
    icc_bytes.resize(icc_size);
    JxlDecoderGetColorAsICCProfile(dec, JXL_COLOR_PROFILE_TARGET_DATA, icc_bytes.data(), icc_size);
  }
  continue;
}
```

Note: older libjxl (<0.9) takes an extra `JxlPixelFormat*` first arg on both calls — match the headers actually in `JXL_NATIVE_INCLUDE_DIR`. `COLOR_ENCODING` fires **after** `BASIC_INFO`, where the header event is currently pushed — when `preserve_icc`, defer the header-event push until COLOR_ENCODING is handled (or the first NEED_IMAGE_OUT_BUFFER, whichever comes first), then attach `iccProfile` as an ArrayBuffer property on the header event. Keep `target == Header` early-exit semantics intact (exit after the deferred push).

### 2G. Fuse the region/downsample copy chain (NV-13) — P1

Final + progress xform path currently: snap → `work` vector copy → crop alloc → ds alloc → out AB memcpy (≈4 full-frame copies). Replace with: compute `(out_w, out_h)` from region∩frame then ceil-div by ds; allocate the destination AB once; write crop+box-average directly from the source buffer into it (one fused pass). Also early-out: if region covers the full frame, treat as no region; if ds==1 and no region, current N-13 direct path already applies. In `box_downsample` loops, hoist row base pointers and drop the always-true `cnt > 0` branch for interior pixels; specialize ds==2 (the common pyramid case) with a flat 2×2 kernel.

### 2H. Animation events (NV-17) — P2, pairs with NV-3 tests

Subscribe `JXL_DEC_FRAME`; on each frame: `JxlDecoderGetFrameHeader` → `duration`, `JxlDecoderGetFrameName`; count `frame_index`. Emit each completed `JXL_DEC_FULL_IMAGE` (except the last) as a `"progress"` event with `frameIndex`/`frameDuration`/`frameName`, and the last as `"final"` carrying the same fields plus `animTicksPerSecond = basic.animation.tps_numerator / max(1, basic.animation.tps_denominator)`. Non-animated codestreams: zero overhead (only subscribe FRAME when `basic.have_animation` — note FRAME must be subscribed before processing starts, so subscribe it unconditionally but make the handler a no-op for still images; measure that this does not regress the still path).

### 2I. Small fixes

- Region echo (NV-21): set `rgn.x/y` to `region->x/y`, `w/h` to cropped dims, in both progress and final emit sites.
- `pixelStride` (NV-22): confirm against jxl-core/WASM facade. If it means channels-per-pixel, leave 4 and add a comment; if bytes, emit `4 * BytesPerChannel(format)`.

Success criteria: existing round-trip tests pass; region/downsample decode via index.ts (guards now removed by Agent 1) returns correct dims; valgrind/ASan run of a progressive decode with forced flush failure shows no invalid writes; decode of a large image shows multi-core utilization.

---

## Agent 3 — `packages/jxl-native/src/native.cc` (encoder side)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Only edit native.cc, encoder-side functions (`EncodeAll`, `CreateEncoder`, `EncoderPushPixels`, `EncoderFinish`, `EncoderDispose`, `EncoderData`). **Run after Agent 2** (same file).

### 3A. Pixel size strict check + RGBA strip fast path (NV-5) — P0

In `EncoderFinish` (so a proper JS error can be thrown) before `EncodeAll`:

```cpp
const size_t bpc = BytesPerChannel(data->format);
const uint32_t ch = 3u + (data->has_alpha ? 1u : 0u);
const size_t expected = (size_t)data->width * data->height * ch * bpc;
if (data->pixels.size() != expected) {
  const size_t rgba_size = (size_t)data->width * data->height * 4u * bpc;
  if (!data->has_alpha && data->pixels.size() == rgba_size) {
    // Common case: RGBA input, alpha unwanted. Strip in place (single forward pass, safe overlap).
    uint8_t* p = data->pixels.data();
    const size_t px = (size_t)data->width * data->height;
    for (size_t i = 0; i < px; ++i)
      memmove(p + i * 3 * bpc, p + i * 4 * bpc, 3 * bpc);
    data->pixels.resize(expected);
  } else {
    return ThrowCode(env, "PixelSizeMismatch", "pushPixels byte length does not match width*height*channels*bpc");
  }
}
```

Then `EncodeAll`'s internal check becomes `data->pixels.size() != expected → return false`. (Animation path NV-17/3E validates per-frame sizes the same way.)

### 3B. EC distance 0 = lossless (NV-8) — P1

```cpp
float ch_dist = (ec.distance >= 0.0) ? static_cast<float>(ec.distance) : -1.0f;
```

### 3C. alphaDistance (NV-3 feature) — P1

`EncoderData`: `double alpha_distance = -1.0;` — parse in `CreateEncoder`: `data->alpha_distance = GetNullableNumberProp(env, args[0], "alphaDistance", -1.0);` — apply in `EncodeAll` after `SetFrameDistance`:

```cpp
if (data->has_alpha && data->alpha_distance >= 0.0) {
  JxlEncoderSetExtraChannelDistance(frame, 0, static_cast<float>(data->alpha_distance));
}
```

(Alpha is always EC index 0 when `has_alpha`; user ECs start at `alpha_ec_count` — existing convention.)

### 3D. ICC + lossy (NV-12) and clamps (NV-20)

```cpp
if (data->distance == 0.0 || !data->icc.empty()) info.uses_original_profile = JXL_TRUE;
```
Verify against the linked libjxl: if `SetICCProfile` succeeds with XYB (uses_original_profile false) in your version and round-trips the profile, reject this item with that evidence instead.

Clamps in `CreateEncoder`: `effort` → clamp to [1,9]; `distance` → clamp to [0.0, 25.0] (after the quality-derived default).

### 3E. Animation encode (NV-3 tests) — P2

`EncoderData` additions:

```cpp
struct FrameDesc { std::vector<uint8_t> pixels; uint32_t duration = 0; std::string name; };
std::vector<FrameDesc> frames;
bool has_animation = false;
uint32_t anim_tps_num = 0, anim_tps_den = 1; int32_t anim_loops = 0;
```

Parse `animation: {ticksPerSecond, loopCount}` and `frames: [{data, duration, name}]` in `CreateEncoder` (reuse `ReadBytes` for `data`). In `EncodeAll`, when `has_animation && !frames.empty()`:

```cpp
info.have_animation = JXL_TRUE;
info.animation.tps_numerator = data->anim_tps_num;
info.animation.tps_denominator = data->anim_tps_den;
info.animation.num_loops = data->anim_loops;
…
for (size_t fi = 0; fi < data->frames.size(); ++fi) {
  JxlFrameHeader fh;
  JxlEncoderInitFrameHeader(&fh);
  fh.duration = data->frames[fi].duration;
  fh.is_last = (fi + 1 == data->frames.size());
  JxlEncoderSetFrameHeader(frame, &fh);
  if (!data->frames[fi].name.empty())
    JxlEncoderSetFrameName(frame, data->frames[fi].name.c_str());
  if (JxlEncoderAddImageFrame(frame, &pf, data->frames[fi].pixels.data(),
                              /*validated size*/ frame_expected) != JXL_ENC_SUCCESS) { … }
}
```

Single-frame path unchanged when `frames` absent. The test calls `finish()` with **no** `pushPixels` when `frames` supplied — make the empty-`pixels` + frames-present combination valid.

### 3F. customBoxes (NV-3 tests) — P2

Parse `customBoxes: [{type, data, compress}]` (4-char `type`; validate length==4, else throw `InvalidBoxType`). In the existing `UseBoxes` block (extend its condition to `|| !data->custom_boxes.empty()`):

```cpp
for (const auto& b : data->custom_boxes) {
  JxlEncoderAddBox(enc, b.type.c_str(), b.data.data(), b.data.size(),
                   b.compress ? JXL_TRUE : JXL_FALSE);
}
```

### 3G. Parallel runner for encode (NV-10) — P1

Same as Agent 2E but `JxlEncoderSetParallelRunner(enc, JxlThreadParallelRunner, runner)`; RAII-destroy on all exits.

### 3H. Zero-copy single-push fast path (NV-14) — P1, contained-unsafe

`EncoderData`: add `napi_ref pinned_input = nullptr; void* pinned_data = nullptr; size_t pinned_size = 0; bool multi_push = false;`. In `EncoderPushPixels`: first push → store ref to the ArrayBuffer (for a typed array, ref the TA itself and record data pointer + byte length from `napi_get_typedarray_info`; V8 backing stores do not move). Second push → materialize the pinned bytes into `data->pixels`, append new bytes, set `multi_push`, drop the ref. In `EncodeAll`/`EncoderFinish` use `pinned_data/pinned_size` when set, else `pixels`. Delete the ref in `EncoderDispose`/`EncoderFinalize` and immediately after `EncodeAll` returns. Caveat documented in code: caller must not mutate the buffer between `pushPixels` and `finish` (same contract as structured-clone-free WASM facade writes). Note: the NV-5 RGBA-strip fast path must fall back to the copy path (cannot strip in a caller-owned buffer).

### 3I. Hygiene

- `EncoderFinish`: early-return `Undefined` (or throw `Cancelled`) when `data->cancelled` (NV-11).
- `EncoderDispose`: swap idiom for `pixels`, `icc`, `exif`, `xmp`, EC plane vectors (NV-9).
- Optional: skip the `out->assign(seed, 0)` zero-fill by using `resize` once — same cost; leave unless switching to a non-zeroing buffer.

Success criteria: codec.test.ts runtime suites (lossless RT, alphaDistance, depth-plane EC, modular, patches, customBoxes, animation) pass against the rebuilt addon; RGBA-with-hasAlpha:false produces correct colours (compare against WASM facade output on the same input); encode of a 24MP image shows multi-core utilization and one fewer full-frame copy on single-push.

---

## Agent 4 — `packages/jxl-native/test/codec.test.ts`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Only edit the test file. Run **after** Agents 1–3 so assertions target what actually landed. If an Agent 1–3 item was rejected, delete/skip the corresponding test with a comment pointing at the rejection log entry.

1. **Kill machine-path asserts (NV-15).** Delete every `expect(process.env.JXL_NATIVE_INCLUDE_DIR).toBe(nativeIncludeDir)` / `LIB_DIR` pair and the two consts. Gate instead:

```ts
const hasNative = !!process.env.JXL_NATIVE_LIB_DIR;
describe.skipIf(!hasNative)("@casabio/jxl-native real codec", () => { … });
```

Apply to all runtime describes. Source-grep describes need no gate (no addon required).

2. **Tighten lossless (NV-24).** First round-trip test uses distance 0 → assert exact: `expect(decoded[i]).toBe(pixels[i])` (drop the ≤2 tolerance; keep a separate lossy test with tolerance if desired).

3. **Fix the depth-plane test.** Decoder must opt in: add `decodeExtraChannels: true` to its `createDecoder` options (cast or extend type — it is declared native-only in DecoderOptions). The encoder side keeps `extraChannelPlanes` (Agent 1 sugar merges into per-EC `pixels`). With Agent 3A landed, `hasAlpha:false` + RGBA pixels is auto-stripped; otherwise switch the fixture to 12 RGB bytes.

4. **Source-grep → keep but align.** After Agent 1, the grep strings exist. Longer term, replace `readFileSync` greps with type-level checks (`expectTypeOf<EncoderOptions>().toHaveProperty("alphaDistance")` style via bun's `expectTypeOf` or a `tsc` fixture) — greps break on comment reflow.

5. **New regression tests** (each maps to a fix):
   - `events()` after `cancel()` resolves (empty ok) instead of hanging — NV-7.
   - `close()` after `cancel()` returns without decoding (assert no `final` event, fast) — NV-11.
   - Region + downsample decode through the public facade: encode an 8×8 gradient, decode `{region:{x:2,y:2,w:4,h:4}, downsample:2}` → expect 2×2 output and correct corner means — NV-1/NV-13.
   - Truncated input: push half the codestream, `close()` rejects with `TruncatedInput` — locks N-19 behavior.
   - Garbage input: `close()` rejects with `InvalidJXL`, and a second `loadNativeBinding()` call still returns a guarded facade (locks NV-2).
   - hasAlpha:false RGBA strip: encode RGBA fixture with `hasAlpha:false`, decode, compare RGB against source RGB exactly (distance 0) — NV-5.
   - `alphaDistance: 0` with lossy frame (`distance: 1`): alpha must round-trip exactly while RGB may differ — NV-8/3C (the current alphaDistance test hides the EC-distance bug because frame distance is also 0).

Success criteria: `bun test packages/jxl-native/test/codec.test.ts` green on this machine with env set, and all tests skip (not fail) on a machine without `JXL_NATIVE_LIB_DIR`.

---

## Agent 5 — `packages/jxl-native/binding.gyp`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Only edit binding.gyp.

1. **Explicit C++17** (needed for `__has_include` portability and future libjxl headers):

```json
"cflags_cc": ["-std=c++17", "-fno-exceptions"],
"xcode_settings": {
  "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
  "GCC_ENABLE_CPP_EXCEPTIONS": "NO",
  "MACOSX_DEPLOYMENT_TARGET": "11.0"
},
"msvs_settings": { "VCCLCompilerTool": { "ExceptionHandling": 1, "AdditionalOptions": ["/std:c++17"] } }
```

(Move existing win `msvs_settings` into this; keep `ExceptionHandling: 1` — MSVC STL needs it even with the C N-API.)

2. **macOS condition block**: currently only `OS!='win'` (covers mac via pkg-config) — add the `xcode_settings` above at target level; pkg-config path works on mac with brew libjxl.

3. **pkg-config: include threads lib** (Agent 2E/3G link `JxlThreadParallelRunner`):

```json
"cflags_cc": ["<!@(pkg-config --cflags libjxl libjxl_threads 2>/dev/null || true)"],
"libraries": ["<!@(pkg-config --libs libjxl libjxl_threads 2>/dev/null || true)"]
```

4. **Empty include-dir guard**: `"<!(node -p \"process.env.JXL_NATIVE_INCLUDE_DIR || '.'\")"` — avoids an empty `-I` entry; `.` is inert.

5. **Windows runtime note**: static libs in `C:\TEMP\jxl-mt-libs` are (per dir name) /MT; node-gyp defaults to /MD → LNK2038 risk. If the prebuilt libs are /MT, add under the win+libdir condition:

```json
"msvs_settings": { "VCCLCompilerTool": { "RuntimeLibrary": 0 } }
```

(0 = /MT release.) Verify against an actual `node-gyp rebuild` on this machine before committing — if the current build already links clean, the libs are /MD-compatible; reject this item with that evidence.

6. Optional: `"defines": ["NODE_ADDON_API_DISABLE_DEPRECATED"]` is N/A (plain node_api.h) — do not add node-addon-api; the file is intentionally C-API only.

Success criteria: `node-gyp rebuild` succeeds on win (env dirs set) and on linux/mac with pkg-config libjxl; the threads symbols resolve.

---

## Lens-sourced notes that produced no agent item (logged, not actionable)

- **Lens 9/10 (owl/reverse):** push-after-close and close-without-push both error correctly (N-19 `TruncatedInput` covers empty+closed). Cancel-after-close is a silent no-op — acceptable for batch model.
- **Lens 13 (gaming):** the batch event list is effectively a replay buffer; frame-by-frame animation events (2H) give it scrubbing semantics — `seekToFrame` shims in index.ts become real once 2H lands (software seek = filter by frameIndex). No extra work item beyond 2H.
- **Lens 14/16 (photogrammetry/AR):** depth/thermal extra-plane decode already gated in (N-20); ICC extraction (2F) + EXIF GPS boxes (already encoded, N-17) complete the field-capture metadata chain. Decode-side box *reading* (Exif/xml out) is a future item — deliberately not in this pass (decoder binding stays pixel-focused; same rationale as JPEG-reconstruction exclusion).
- **Lens 15 (Butteraugli):** distance/effort mapping is the only Butteraugli touchpoint in these files; the real lever here is NV-10 threading (Butteraugli inner loops parallelize in libjxl) and `DECODING_SPEED` already exposed via JxlFrameSetting.
- **Lens 17 (non-Riemannian colour):** these files only need to not destroy the inputs that model requires: ICC preservation both directions (2F, 3D) and ≥16-bit formats (already present). LUT engine itself lives in raw-pipeline, out of scope.
- **Lens 18 (mathematics):** box filter is a separable kernel — the fused crop+ds pass (2G) subsumes the separability win at these sizes; no further asymptotic gains available in a batch copy pipeline.
- **Lens 21 (unilluminated rooms):** the three dark rooms were threading (now NV-10), animation (NV-17/3E), and colour management (NV-16/NV-12) — all converted to agent items above.

---

## Overview — what implementing this achieves

The P0 set restores truthfulness across the package's four layers. Today the TypeScript loader actively blocks features the C++ already ships (region, downsample, ICC, EXIF, XMP), returns a differently-behaving binding depending on call order, and the test suite both fails on any machine but one and asserts an API that exists nowhere. After Agents 1–4, the option surface, the native implementation, and the tests describe the same codec: region/downsample decode become reachable, lossless really means lossless (exact-match tests, per-channel distance-0 fix, alpha-distance control), and two genuine memory-safety hazards (the flush-path use-after-free and the silent-failure close) are closed before they ever fire in production.

The performance items convert linked-but-dormant capacity into wall-clock wins. Wiring `JxlThreadParallelRunner` into both codec directions is the single largest lever — libjxl's decode, encode, and Butteraugli-driven distance loops all scale near-linearly with cores, and the library is already in the link line. The fused crop+downsample pass removes roughly three full-frame copies from every region/pyramid-tile decode, the single-push zero-copy path removes a full-frame copy from the dominant encode pattern, and the dispose/swap fixes stop disposed sessions from pinning hundreds of megabytes until garbage collection. For the pyramid-gallery ingest path — where RAW decode is the known cost center and native encode is the sidecar builder — these compound directly into ingest throughput.

The feature items (animation frames, custom boxes, modular/brotli/progressive sugar, ICC extraction, alpha distance) complete API parity with the WASM facade and serve the platform's longer arcs: ICC round-tripping and 16-bit paths protect the colour fidelity the non-Riemannian perceptual model will depend on; depth/thermal extra planes plus EXIF-GPS boxes make the native encoder a complete vehicle for georeferenced, photogrammetry-ready specimen captures; custom boxes give the biodiversity platform a forward-compatible container slot (e.g. a `casb` occurrence-metadata box) without forking the format. The net effect is a native backend that is no longer a fast-but-untrustworthy sibling of the WASM path, but the reference implementation the rest of the pipeline can schedule onto whenever it is present.
