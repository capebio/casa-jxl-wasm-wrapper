# JPEG XL Wrapper Architecture Specification

**Version:** 3.0 Final Construction Brief  
**Date:** 2026-05-21  
**Target:** Browser and server environments  
**Primary codec:** JPEG XL via raw `libjxl` bindings  
**Intended lifespan:** Multi-year foundation, designed to absorb future JPEG XL, browser, GPU, and server-runtime improvements

---

## 1. Executive Summary

This document specifies a production-grade JPEG XL wrapper for both browser and server use. The wrapper must expose JPEG XL not merely as a file conversion library, but as an adaptive image streaming runtime capable of progressive decoding, streaming encoding, thumbnail preemption, viewport-aware refinement, memory-tiered caching, GPU-conscious rendering, metadata extraction, cancellation, and policy-driven scheduling.

The central design principle is:

> Deliver useful pixels as early as possible, preserve image fidelity and metadata, avoid blocking the UI, and scale from single massive lightbox images to galleries containing hundreds of images.

JPEG XL should be treated as a progressive, metadata-rich, color-managed image format. The wrapper must preserve those properties rather than flattening JPEG XL into a conventional one-shot `decode(input) -> RGBA` abstraction.

The implementation should begin with a robust core, then evolve through compatibility layers as native browser JPEG XL support, WebCodecs, WebGPU, server runtimes, and `libjxl` itself mature.

---

## 2. Core Goals

The wrapper must support:

1. **Real progressive decode** using native `libjxl` decoder events, progression callbacks, preview images, DC frames, flush points, and staged refinement.
2. **Real streaming encode** using chunked input and output rather than one-shot in-memory conversion.
3. **Stateful decode and encode sessions** owned by workers or server-side session objects.
4. **Browser and server operation** with shared policy, metadata, streaming, and error semantics.
5. **Thumbnail preemption** so large galleries display low-resolution useful pixels for all visible or requested images before refining any one image unnecessarily.
6. **Viewport-aware refinement** for large images, microscopy, herbarium sheets, maps, chronograms, and zoomable viewers.
7. **Color fidelity**, including ICC, wide-gamut, HDR-related metadata where supported, orientation, EXIF, XMP, JUMBF, and other image metadata.
8. **Zero-copy or minimum-copy rendering** where possible through transferable objects, GPU-friendly upload paths, and bounded staging queues.
9. **Policy-driven scheduling** based on context: gallery, lightbox, archive, server batch job, thumbnail service, mobile device, poor network, or high-performance desktop.
10. **Robust cancellation and backpressure** across network, decode, staging, GPU upload, rendering, and server pipelines.
11. **Long-term extensibility**, including optional native JPEG XL paths, future progressive native browser support, WebGPU paths, and alternate server codecs.

---

## 3. Non-Goals

The first production phase should not attempt to solve every possible JPEG XL use case.

Out of scope for the initial build:

1. Full animated JPEG XL optimization.
2. Full JPEG XL editing or recomposition tools.
3. Deep color-grading or image-processing UI.
4. Exotic JPEG XL edge cases that delay the core progressive viewer, gallery, thumbnail, and server encode/decode flows.
5. Replacing all application-level image management, caching, DAM, or CDN logic.
6. Depending on `@jsquash/jxl` for the progressive path.
7. Keeping a one-shot `decode(input) -> output` API as the primary abstraction.

Animated JPEG XL should be detected early. In the first version, decode the first frame where feasible, emit an `animation_detected` warning, and terminate or degrade gracefully according to policy.

---

## 4. Primary Architectural Decision

Use raw `libjxl` bindings as the canonical implementation layer.

The wrapper should bind directly to `libjxl` because the required functionality depends on low-level access to:

- `JxlDecoder`
- `JxlEncoder`
- `JXL_DEC_BASIC_INFO`
- `JXL_DEC_PREVIEW_IMAGE`
- `JXL_DEC_FRAME`
- `JXL_DEC_FRAME_PROGRESSION`
- `JxlDecoderFlushImage()`
- `JxlDecoderGetColorAsEncodedProfile()`
- `JxlDecoderGetICCProfileSize()`
- `JxlDecoderGetColorAsICCProfile()`
- `JxlDecoderSetInput()`
- `JxlDecoderReleaseInput()`
- `JxlEncoderProcessOutput()`
- `JxlEncoderAddImageFrame()`
- `JxlEncoderAddChunkedFrame()` where available and appropriate
- `JxlThreadParallelRunner`

Higher-level convenience wrappers may be offered, but they must sit above the session runtime rather than hiding it.

---

## 5. Runtime Targets

### 5.1 Browser Runtime

The browser runtime must support:

- WebAssembly build of `libjxl`
- Dedicated Web Workers
- Optional pthread-enabled WASM workers
- Transferable `ArrayBuffer`
- `ReadableStream`
- `fetch()` streaming
- `Blob` and `File` sources
- `AbortController`
- `OffscreenCanvas` where available
- `ImageBitmap` where available
- `VideoFrame` / WebCodecs where available
- IndexedDB caching of WASM modules and derived image data
- Capability negotiation for browser differences

### 5.2 Server Runtime

The server runtime must support:

- Native `libjxl` bindings where practical
- WASM fallback where native bindings are unavailable
- Node.js and Bun compatibility where feasible
- Streaming file, object-storage, and HTTP input
- Streaming encoded output
- Batch processing
- Thumbnail extraction
- Metadata extraction
- Server-side progressive derivative generation
- Deterministic resource limits
- Worker threads or process pools
- Optional integration with queues and object storage

### 5.3 Shared Runtime Semantics

Browser and server runtimes should expose the same conceptual primitives:

- `Session`
- `DecodeSession`
- `EncodeSession`
- `ImageSource`
- `ImageSink`
- `Policy`
- `Capabilities`
- `Metadata`
- `ProgressEvent`
- `Cancellation`
- `Backpressure`
- `ErrorCode`

The browser and server implementations may differ internally, but their event protocol and high-level API should remain aligned.

---

## 6. System Architecture

### 6.1 Core Packages

Recommended package layout:

```text
packages/
  jxl-core/
    libjxl bindings and low-level codec bridge
  jxl-runtime/
    shared session, stream, metadata, policy, error, and capability abstractions
  jxl-browser/
    browser-specific worker pool, WASM loading, rendering, GPU upload, cache
  jxl-server/
    Node/Bun/native/WASM server runtime, process pool, filesystem/object storage streams
  jxl-react/
    optional React hooks and components
  jxl-cli/
    command-line testing and batch utility
  jxl-test-assets/
    conformance, fuzz, color, metadata, progressive, and stress-test files
```

### 6.2 Browser Modules

| Module | Responsibility |
|---|---|
| `jxl-core.wasm` | Raw `libjxl` WASM build. Prefer separate decoder-only, full codec, and threaded variants. |
| `jxl-worker.ts` | Owns live decode/encode sessions, `libjxl` instances, input feeding, output flushing, and session cleanup. |
| `jxl-worker-pool.ts` | Manages worker lifecycle, scheduling, priorities, concurrency, preemption, cancellation, and worker recycling. |
| `jxl-session.ts` | Browser-side facade for creating, controlling, observing, and cancelling sessions. |
| `jxl-stream.ts` | Normalizes `fetch`, `ReadableStream`, `Blob`, `File`, and memory buffers into chunked streams. |
| `jxl-policy.ts` | Chooses decode, encode, threading, memory, network, and refinement behavior. |
| `jxl-capabilities.ts` | Detects browser support for WASM SIMD, pthreads, WebCodecs, OffscreenCanvas, HDR canvas, native JXL, etc. |
| `jxl-metadata.ts` | Extracts and normalizes EXIF, XMP, ICC, JUMBF, orientation, dimensions, animation state, and custom metadata. |
| `jxl-viewport-scheduler.ts` | Schedules refinement based on viewport, zoom, pan, visible region, and predicted user movement. |
| `jxl-gpu-upload-policy.ts` | Chooses rendering transfer path, manages upload budget, texture reuse, and frame pacing. |
| `jxl-cache.ts` | Caches previews, DC frames, partial refinements, metadata, and derived thumbnails. |
| `jxl-telemetry.ts` | Records timing, memory, dropped frames, cancellation, decode, upload, and network performance. |

### 6.3 Server Modules

| Module | Responsibility |
|---|---|
| `jxl-native-bridge` | Optional native `libjxl` binding. Preferred for heavy server workloads. |
| `jxl-wasm-server` | WASM fallback for server environments without native binding. |
| `jxl-server-worker-pool` | Thread/process pool for batch decode, encode, metadata extraction, and thumbnails. |
| `jxl-object-stream` | Streams from local files, HTTP, S3-compatible object stores, and database blobs. |
| `jxl-derivative-service` | Generates thumbnails, previews, DC proxies, web derivatives, archival variants. |
| `jxl-server-policy` | Chooses effort, concurrency, memory limits, output profiles, and derivative strategy. |
| `jxl-server-cache` | Optional cache of derived images and extracted metadata. |

---

## 7. Layering Rules

1. Application code should not call `libjxl` directly.
2. Browser main thread must never call `libjxl` directly.
3. Browser codec state must live inside workers.
4. Server codec state must live inside isolated session objects, worker threads, or process pools.
5. Sessions are one logical image operation each.
6. Session objects own cancellation, lifecycle, metadata, and progress events.
7. Transport, decode, staging, upload, and rendering must be backpressure-aware.
8. The wrapper should emit meaningful partial results as soon as they are available.
9. Color and metadata must be surfaced early and preserved unless the caller explicitly opts out.
10. Policy objects must be injectable and replaceable.

---

## 8. Capability Negotiation

Every runtime should begin with a capability probe.

Example capability object:

```ts
export interface JxlCapabilities {
  runtime: 'browser' | 'node' | 'bun' | 'deno' | 'edge' | 'unknown';
  nativeJxlDecode: boolean;
  nativeJxlEncode: boolean;
  nativeProgressiveJxl: boolean;
  wasm: boolean;
  wasmSimd: boolean;
  wasmThreads: boolean;
  sharedArrayBuffer: boolean;
  crossOriginIsolated: boolean;
  webCodecs: boolean;
  videoFrame: boolean;
  imageBitmap: boolean;
  offscreenCanvas: boolean;
  webGpu: boolean;
  webGl2: boolean;
  hdrCanvas: boolean;
  displayP3Canvas: boolean;
  performanceMemory: boolean;
  schedulerPostTask: boolean;
  requestIdleCallback: boolean;
  isInputPending: boolean;
  indexedDb: boolean;
  readableStream: boolean;
  transferableStreams: boolean;
}
```

Capabilities should drive policy. Do not hard-code a single browser behavior.

### 8.1 Browser Compatibility Modes

| Mode | Typical Runtime | Behavior |
|---|---|---|
| `full` | Chrome/Edge desktop with cross-origin isolation | WASM SIMD, pthreads, OffscreenCanvas, WebCodecs if available. |
| `reduced-threading` | Firefox or non-isolated Chrome | SIMD if available, no pthreads, more worker-level parallelism. |
| `compatibility` | Safari desktop | Conservative memory, fewer transfer assumptions, no mandatory pthreads. |
| `mobile-minimal` | Mobile Safari / lower-end Android | Preview/DC first, aggressive cancellation, low concurrency, strict memory budget. |
| `server-native` | Node/Bun with native binding | Native `libjxl`, worker threads/process pool, filesystem/object streaming. |
| `server-wasm` | Server without native binding | WASM fallback, smaller concurrency, strong memory limits. |

---

## 9. Public API Shape

### 9.1 Core Session API

```ts
const session = jxl.decode(source, {
  mode: 'gallery-thumbnail' | 'lightbox' | 'metadata-only' | 'server-derivative' | 'archive',
  signal,
  policy,
  viewport,
  desiredStages: ['metadata', 'preview', 'dc', 'refine', 'final'],
});

session.on('metadata', handleMetadata);
session.on('progress', handleProgressiveFrame);
session.on('warning', handleWarning);
session.on('error', handleError);
session.on('complete', handleComplete);

session.updateViewport({ x, y, width, height, zoom });
session.setPriority('high');
session.pause();
session.resume();
session.cancel();
```

### 9.2 Promise Convenience API

A convenience API may exist, but it must be implemented on top of sessions.

```ts
const image = await jxl.decodeFinal(source, {
  colorManagement: 'preserve',
  output: 'imageBitmap',
});
```

This is useful for tests and simple consumers but must not become the core abstraction.

### 9.3 Encode API

```ts
const encodeSession = jxl.encode(pixelSource, {
  effort: 7,
  distance: 1.0,
  progressive: true,
  lossless: false,
  colorProfile: 'preserve',
  metadata: inputMetadata,
  streaming: true,
  policy,
});

encodeSession.on('chunk', ({ bytes }) => sink.write(bytes));
encodeSession.on('progress', handleEncodeProgress);
encodeSession.on('complete', handleEncodeComplete);
encodeSession.on('error', handleEncodeError);
```

### 9.4 Server Derivative API

```ts
await jxlServer.createDerivatives({
  source,
  outputs: [
    { name: 'preview', stage: 'preview' },
    { name: 'dc', stage: 'dc' },
    { name: 'thumb_512', width: 512, effort: 3 },
    { name: 'display_2048', width: 2048, effort: 5 },
  ],
  metadata: 'preserve',
  sink,
  policy,
});
```

---

## 10. Decode Design

### 10.1 Decode Session Flow

1. Create session and assign session ID.
2. Probe capabilities and choose policy.
3. Normalize source into a chunked stream.
4. Allocate worker or server codec instance.
5. Initialize `JxlDecoder`.
6. Subscribe to early events:
   - basic info
   - color encoding
   - ICC profile
   - preview image
   - frame header
   - frame progression
7. Begin feeding chunks.
8. Emit metadata as soon as available.
9. Emit preview if available.
10. Emit DC or low-resolution frame as soon as possible.
11. Continue progressive refinement according to policy.
12. Stop, pause, refine, or cancel based on viewport, visibility, priority, and backpressure.
13. Emit final image if requested and feasible.
14. Release decoder state, input buffers, staging buffers, and worker allocation.

### 10.2 Progressive Stages

Use a richer stage ladder than merely preview/refine/final.

```ts
type DecodeStage =
  | 'metadata'
  | 'basic_info'
  | 'preview'
  | 'dc'
  | 'low_ac'
  | 'medium_ac'
  | 'high_ac'
  | 'visually_lossless'
  | 'final';
```

The wrapper may map internal `libjxl` progression details onto these normalized stages.

### 10.3 Animation Handling

Initial policy:

1. Detect `have_animation` during basic info.
2. Emit metadata with `hasAnimation: true`.
3. Decode first frame if policy allows.
4. Emit `warning: animation_not_optimized`.
5. Stop unless caller explicitly requests experimental animation behavior.

Future policy should allow animated JXL decode once project priorities require it.

---

## 11. Thumbnail Preemption Queue

Thumbnail preemption is mandatory for gallery use.

When a batch of images is requested:

1. First pass: extract only embedded preview or DC frame for every visible/requested image.
2. Paint all low-resolution thumbnails.
3. Only then refine images according to visibility, priority, and idle budget.

### 11.1 Required Behavior

For 50 visible thumbnails:

- All 50 should reach `preview` or `dc` before any single image monopolizes refinement.
- Hidden images should be paused or deprioritized.
- Cancelled images must abort their network stream where possible.
- Refinement should follow viewport visibility and user interaction.

### 11.2 Priority Classes

```ts
type Priority =
  | 'critical-visible'
  | 'visible'
  | 'near-viewport'
  | 'prefetch'
  | 'background'
  | 'paused';
```

Priority must be dynamic, not fixed at session start.

---

## 12. Viewport-Aware Region of Interest Refinement

Large image viewing must not require full-frame refinement before visible detail appears.

The wrapper should support viewport-aware scheduling:

1. Display whole-image preview or DC quickly.
2. Track viewport rectangle and zoom level.
3. Refine visible region first.
4. Refine a margin around the viewport second.
5. Refine offscreen regions only when idle or explicitly requested.

### 12.1 Viewport Priority Model

```text
Priority 0: visible viewport at current zoom
Priority 1: predictive margin around viewport
Priority 2: recently viewed areas
Priority 3: whole-frame refinement
Priority 4: offscreen preload
```

### 12.2 Use Cases

This is essential for:

- herbarium sheets
- high-resolution botanical images
- microscopy
- pollen imaging
- maps
- chronograms
- gigapixel-like viewers
- long time-lapse sequences
- tiled lightbox inspection

If `libjxl` does not provide all desired ROI behavior directly, implement practical approximations:

- decode lower-resolution whole frame first
- defer full-resolution output conversion
- crop/refine/upload only visible areas where possible
- integrate future ROI/tile improvements later

---

## 13. Threading and Concurrency Policy

### 13.1 Browser Threading Dichotomy

Use two different strategies depending on context.

#### Gallery / Many Thumbnails

- Use JavaScript worker pool.
- One worker handles one active image session.
- Use single-threaded internal `libjxl` decode per worker where this avoids thread oversubscription.
- Optimize for fairness and early previews across many files.

#### Lightbox / One Massive Image

- Use one primary WASM worker.
- Permit internal `libjxl` multithreading through `JxlThreadParallelRunner` if supported.
- Optimize for fastest refinement of the currently visible image.

### 13.2 Server Concurrency

Server policy should consider:

- CPU core count
- memory limit
- queue depth
- input source latency
- output sink speed
- whether native or WASM codec is used
- whether job is interactive or batch

Server jobs should use worker threads or process pools for isolation.

### 13.3 Worker Recycling

Workers should be recycled after:

- N completed decodes
- M megabytes processed
- fatal codec error
- memory growth beyond threshold
- suspected fragmentation
- configurable idle timeout

This prevents long-running browser galleries and server workers from accumulating memory and state problems.

---

## 14. Streaming and Transport Design

### 14.1 Input Sources

Support:

- `ArrayBuffer`
- `Uint8Array`
- `Blob`
- `File`
- `ReadableStream<Uint8Array>`
- `fetch(url)`
- HTTP Range requests where useful
- local filesystem streams on server
- object storage streams on server

### 14.2 Adaptive Chunk Sizing

Chunk size should be adaptive.

| Context | Suggested Chunk Size |
|---|---:|
| Fast local file | 512 KB - 2 MB |
| Fast WiFi / LAN | 256 KB - 1 MB |
| Normal 4G | 64 KB - 256 KB |
| Poor mobile network | 16 KB - 64 KB |
| Thumbnail preemption | Smaller chunks until preview/DC is reached |
| Server batch | Larger chunks, constrained by memory and throughput |

Policy should adjust based on:

- measured throughput
- RTT
- decode backlog
- UI activity
- cancellation likelihood
- stage target

### 14.3 Network Cancellation

Cancellation must propagate all the way down:

1. Application cancels session.
2. Session aborts policy queues.
3. Worker destroys decoder.
4. Stream controller stops feeding chunks.
5. `AbortController` aborts `fetch()` where possible.
6. Staging and upload queues drop obsolete work.

### 14.4 HTTP Range Requests

For remote files, consider range-aware fetch strategies:

- fetch header and early codestream bytes first
- stop after preview/DC for thumbnails
- resume later for refinement
- use cache validation where supported

Do not make range logic mandatory for correctness. It should be an optimization layer.

---

## 15. Backpressure Pipeline

All decode pipelines must be bounded.

Recommended browser pipeline:

```text
network/source stream
  -> decoder input queue
  -> libjxl decoder
  -> progressive output queue
  -> staging/conversion queue
  -> GPU upload queue
  -> renderer
```

Recommended server pipeline:

```text
input stream
  -> decoder/encoder session
  -> transform queue
  -> output stream / object storage / response
```

Each queue must have:

- maximum size
- priority behavior
- drop/replace behavior for stale progressive frames
- cancellation handling
- telemetry

### 15.1 Drop Policy

For progressive frames:

- Never queue unlimited intermediate refinements.
- If a newer refinement supersedes an older one and the older one has not been rendered, drop the older one.
- Keep metadata and final events reliable.
- Prefer latest useful visual state over complete delivery of every intermediate visual state.

---

## 16. GPU and Rendering Strategy

The wrapper must include an explicit GPU upload and rendering policy.

### 16.1 Output Types

Possible browser outputs:

```ts
type BrowserImageOutput =
  | ImageBitmap
  | VideoFrame
  | OffscreenCanvas
  | HTMLCanvasElement
  | Uint8ClampedArray
  | Uint8Array
  | GpuTextureHandle
  | JxlProgressiveFrame;
```

`Uint8Array`/RGBA output should be treated as a fallback or server/test path, not the preferred browser display path.

### 16.2 GPU Upload Rules

The wrapper should:

- prefer transferable visual objects over copied pixel buffers
- throttle GPU uploads during scroll or pointer interaction
- reuse textures where possible
- avoid uploading frames that have already been superseded
- support mipmap or pyramid-like strategies for zoomable views
- maintain a texture memory budget
- evict offscreen textures before decoded CPU buffers where policy allows

### 16.3 Rendering Modes

| Mode | Use Case |
|---|---|
| `bitmap-transfer` | General browser display path. |
| `canvas-2d` | Compatibility fallback. |
| `webgl2-texture` | Large galleries, zoomable viewers, tiled rendering. |
| `webgpu-texture` | Future high-performance path. |
| `raw-buffer` | Server, tests, custom processing. |

---

## 17. Color Management

Color handling is a first-class requirement.

The wrapper must:

1. Extract color encoding as early as possible.
2. Extract ICC profile where available.
3. Preserve original color metadata by default.
4. Expose color metadata to the caller.
5. Avoid silently converting wide-gamut images to washed-out sRGB.
6. Support explicit conversion policies.
7. Record whether output was preserved, converted, approximated, or unsupported.

### 17.1 Color Policy

```ts
type ColorPolicy =
  | 'preserve'
  | 'convert-to-srgb'
  | 'convert-to-display-p3'
  | 'raw'
  | 'auto';
```

Default:

```ts
colorPolicy: 'preserve'
```

### 17.2 Metadata Fields

```ts
interface JxlColorMetadata {
  colorSpaceName?: 'srgb' | 'display-p3' | 'rec2020' | 'gray' | 'unknown';
  iccProfile?: Uint8Array;
  iccHash?: string;
  hasWideGamut: boolean;
  hasHdrMetadata: boolean;
  transferFunction?: string;
  renderingIntent?: string;
  outputColorStatus: 'preserved' | 'converted' | 'approximated' | 'unsupported';
}
```

---

## 18. Metadata Pipeline

The wrapper must expose metadata independently of full image decode.

### 18.1 Required Metadata

Extract where available:

- dimensions
- orientation
- bit depth
- alpha information
- animation flag
- number of frames where known
- intrinsic preview availability
- color encoding
- ICC profile
- EXIF
- XMP
- JUMBF
- original JPEG reconstruction metadata if relevant
- custom application metadata

### 18.2 Metadata Events

Metadata should emit progressively:

```ts
session.on('metadata', event => {
  // basic info may arrive before EXIF/XMP
});
```

Metadata must not require full pixel decode.

### 18.3 Metadata Preservation on Encode

Encoding must default to preserving source metadata unless caller explicitly strips or modifies it.

```ts
type MetadataPolicy =
  | 'preserve'
  | 'strip-private'
  | 'strip-all'
  | 'replace'
  | 'merge';
```

For Casabio-like biodiversity workflows, preservation of timestamp, camera, geolocation, lens, and specimen/observation metadata is often critical.

---

## 19. Memory Management

### 19.1 Memory Tiering

Represent image state in tiers.

| Tier | Meaning |
|---|---|
| T0 | Metadata only |
| T1 | Embedded preview |
| T2 | DC / low-resolution whole image |
| T3 | Partial refinement / viewport refinement |
| T4 | Full decoded CPU bitmap |
| T5 | GPU texture resident |
| T6 | Encoded derivative cached |

### 19.2 Eviction Policy

Under memory pressure:

1. Drop hidden GPU textures.
2. Drop stale progressive refinements.
3. Drop full CPU bitmaps if GPU or lower tier is sufficient.
4. Retain metadata and preview/DC where possible.
5. Cancel background refinements.
6. Recycle workers if memory growth persists.

### 19.3 WASM Memory

Browser WASM builds should avoid uncontrolled memory-growth jank.

Recommendations:

- Use initial memory appropriate to mode.
- Use smaller decoder-only builds for thumbnails.
- Use larger threaded builds for lightbox mode.
- Avoid keeping full-size RGBA buffers longer than necessary.
- Release input buffers after `JxlDecoderReleaseInput()`.
- Track high-water marks.

Example starting values:

| Mode | Initial Memory |
|---|---:|
| Thumbnail worker | 32-64 MB |
| Gallery worker | 64-128 MB |
| Lightbox worker | 128-512 MB |
| Server WASM worker | configurable, usually 256 MB+ |

These are policy defaults, not hard-coded constants.

---

## 20. Encode Design

### 20.1 Encode Flow

1. Create encode session.
2. Normalize pixel source.
3. Normalize metadata and color profile.
4. Choose encode policy.
5. Initialize `JxlEncoder`.
6. Feed frame or chunks.
7. Pump output with `JxlEncoderProcessOutput()`.
8. Emit output chunks immediately.
9. Flush and finalize.
10. Release resources.

### 20.2 Encode Profiles

| Profile | Use Case | Typical Behavior |
|---|---|---|
| `thumbnail-fast` | Small derivatives | Low effort, fast, progressive optional. |
| `viewer-balanced` | Web display | Balanced effort, good compression, progressive enabled. |
| `archive` | Preservation | Higher effort, metadata preserved, color preserved. |
| `lossless` | Scientific/specimen preservation | Lossless, metadata preserved. |
| `near-lossless` | High-quality web archive | Low distance, high fidelity. |
| `server-batch` | Bulk conversion | Throughput balanced against CPU budget. |

### 20.3 Encoding API Parameters

```ts
interface JxlEncodeOptions {
  profile?: 'thumbnail-fast' | 'viewer-balanced' | 'archive' | 'lossless' | 'near-lossless' | 'server-batch';
  effort?: number;
  distance?: number;
  lossless?: boolean;
  progressive?: boolean;
  modular?: boolean | 'auto';
  qualityHint?: 'smallest' | 'balanced' | 'fastest' | 'scientific';
  colorPolicy?: ColorPolicy;
  metadataPolicy?: MetadataPolicy;
  orientationPolicy?: 'preserve' | 'normalize';
  signal?: AbortSignal;
}
```

---

## 21. Policy Engine

The policy engine determines behavior from context.

### 21.1 Policy Inputs

- runtime capabilities
- source type
- file size
- dimensions
- network quality
- device memory
- CPU cores
- current UI interaction
- viewport visibility
- zoom level
- priority
- battery/mobile hints where available
- server queue load
- caller objective

### 21.2 Policy Outputs

- worker count
- internal thread count
- chunk size
- desired decode stages
- color behavior
- metadata behavior
- GPU output type
- refinement priority
- memory budget
- cache behavior
- cancellation aggressiveness
- encode effort

### 21.3 Example Modes

```ts
type JxlMode =
  | 'gallery-thumbnail'
  | 'gallery-refine'
  | 'lightbox'
  | 'zoomable-large-image'
  | 'metadata-only'
  | 'server-thumbnail'
  | 'server-archive-encode'
  | 'server-batch-convert'
  | 'chronogram'
  | 'scientific-inspection';
```

---

## 22. Frame-Time Aware Scheduling

Browser decode must respect UI frame budget.

Use where available:

- `scheduler.postTask()`
- `requestIdleCallback()`
- `navigator.scheduling.isInputPending()`
- `PerformanceObserver`
- `IntersectionObserver`

### 22.1 Interaction Policy

During active scroll, pan, zoom, typing, or pointer movement:

- restrict refinement
- prioritize visible previews
- reduce GPU uploads
- drop stale frames
- defer full-resolution work

When idle:

- refine visible images
- prefetch near-viewport images
- complete final decodes if requested
- write cache entries

---

## 23. Visibility-Aware Scheduling

Every visual browser session should be tied to visibility state.

### 23.1 Intersection Behavior

| Visibility | Behavior |
|---|---|
| Visible | Preview/DC/refine according to priority. |
| Near viewport | Preview/DC and optionally low refinement. |
| Far offscreen | Metadata or preview only. |
| Hidden after visible | Pause refinement, keep low tier cached. |
| Removed from DOM | Cancel unless explicitly retained. |

### 23.2 Speculative Decode

Speculative decode should support:

- near-viewport prefetch
- hover intent
- likely next image in lightbox
- likely next/previous chronogram frame
- recently inspected taxon/specimen sequence

Speculative work must always be lower priority than visible work.

---

## 24. Cache Design

### 24.1 Cacheable Items

- metadata
- ICC profile
- embedded preview
- DC frame
- thumbnails
- viewport refinement tiles or regions
- server derivatives
- encoded output chunks where useful

### 24.2 Browser Cache

Use layered caching:

- in-memory LRU for active session data
- IndexedDB for previews/DC/metadata
- optional Cache API for fetched source files or derivatives

### 24.3 Server Cache

Use:

- filesystem cache
- object storage
- database records for metadata
- content-addressed keys
- source ETag/version awareness

### 24.4 Cache Keys

Cache keys should include:

- source identifier
- content hash or ETag
- transformation parameters
- color policy
- metadata policy
- target dimensions
- decode stage
- wrapper version
- libjxl version

---

## 25. Error Handling

### 25.1 Error Principles

- Errors must be normalized.
- Errors must not poison the worker pool.
- Failed sessions must release resources.
- Partial useful results may still be emitted before final failure.
- Errors must include stage and recoverability.

### 25.2 Error Codes

```ts
type JxlErrorCode =
  | 'unsupported_runtime'
  | 'wasm_load_failed'
  | 'native_binding_failed'
  | 'invalid_input'
  | 'truncated_input'
  | 'decode_failed'
  | 'encode_failed'
  | 'metadata_failed'
  | 'color_profile_failed'
  | 'animation_unsupported'
  | 'out_of_memory'
  | 'cancelled'
  | 'timeout'
  | 'gpu_upload_failed'
  | 'worker_crashed'
  | 'server_resource_limit';
```

### 25.3 Warning Codes

```ts
type JxlWarningCode =
  | 'metadata_partial'
  | 'icc_profile_approximated'
  | 'wide_gamut_not_displayable'
  | 'hdr_not_displayable'
  | 'animation_first_frame_only'
  | 'native_path_unavailable_using_wasm'
  | 'pthreads_unavailable'
  | 'gpu_path_unavailable_using_canvas'
  | 'range_request_unavailable';
```

---

## 26. Security and Isolation

### 26.1 Browser Security

- Treat all image files as untrusted input.
- Decode only inside workers.
- Consider worker recycling after failures.
- Use strict CSP-compatible loading where feasible.
- For WASM pthreads, document cross-origin isolation requirements.
- Avoid exposing raw internal pointers or memory views after session termination.

### 26.2 Server Security

- Apply maximum file size limits.
- Apply maximum pixel count limits.
- Apply maximum metadata size limits.
- Apply decode and encode timeouts.
- Isolate native codec crashes using process pools where appropriate.
- Reject or sandbox suspicious malformed inputs.
- Avoid trusting embedded metadata.

---

## 27. Build Strategy

### 27.1 WASM Builds

Produce multiple builds:

| Build | Purpose |
|---|---|
| `jxl-decoder-tiny.wasm` | Metadata, preview, DC, thumbnails. Small initial browser payload. |
| `jxl-decoder-full.wasm` | Full browser decode. |
| `jxl-decoder-threaded.wasm` | Lightbox/high-performance decode with pthreads. |
| `jxl-codec-full.wasm` | Decode and encode in browser. |
| `jxl-server-wasm.wasm` | Server WASM fallback. |

### 27.2 Recommended WASM Features

- WASM SIMD where available.
- Pthreads where available and permitted.
- Streaming compilation.
- IndexedDB module caching.
- Configurable initial memory.
- Avoid assuming `ALLOW_MEMORY_GROWTH` is free; it may cause jank.

### 27.3 Native Server Build

Where feasible, provide native bindings to system `libjxl` or vendored known-good builds.

Server build must expose:

- version info
- feature info
- encoder support
- decoder support
- thread support
- metadata box support

---

## 28. Message Protocol

### 28.1 Decode Request

```ts
interface DecodeRequest {
  type: 'decode_start';
  sessionId: string;
  sourceRef: SourceRef;
  mode: JxlMode;
  desiredStages: DecodeStage[];
  priority: Priority;
  policy?: Partial<JxlPolicy>;
  viewport?: ViewportState;
}
```

### 28.2 Decode Progress

```ts
interface DecodeProgressEvent {
  type: 'decode_progress';
  sessionId: string;
  stage: DecodeStage;
  w?: number;
  h?: number;
  downsamplingRatio?: number;
  color?: JxlColorMetadata;
  metadata?: Partial<JxlMetadata>;
  output?: BrowserImageOutput | ServerImageOutput;
  byteOffset?: number;
  bytesTotal?: number;
  isFinalForStage?: boolean;
  timestamp: number;
}
```

### 28.3 Metadata Event

```ts
interface MetadataEvent {
  type: 'metadata';
  sessionId: string;
  metadata: Partial<JxlMetadata>;
  completeness: 'partial' | 'complete';
}
```

### 28.4 Control Messages

```ts
type SessionControlMessage =
  | { type: 'pause'; sessionId: string }
  | { type: 'resume'; sessionId: string }
  | { type: 'cancel'; sessionId: string }
  | { type: 'set_priority'; sessionId: string; priority: Priority }
  | { type: 'update_viewport'; sessionId: string; viewport: ViewportState }
  | { type: 'request_stage'; sessionId: string; stage: DecodeStage };
```

---

## 29. React Integration

React integration should be optional and thin.

Recommended hooks:

```ts
useJxlImage(source, options)
useJxlMetadata(source, options)
useJxlGallery(items, options)
useJxlLightbox(source, options)
useJxlEncode(input, options)
```

Recommended components:

```tsx
<JxlImage />
<JxlProgressiveImage />
<JxlGallery />
<JxlLightboxImage />
```

React should not own codec logic. It should subscribe to the runtime.

---

## 30. Server Integration Patterns

### 30.1 Derivative Generation Service

A server service may generate:

- metadata JSON
- embedded preview extraction
- DC proxy image
- thumbnails
- display-size derivatives
- archive recompression
- lossless preservation copies

### 30.2 HTTP Streaming Endpoint

Potential API:

```http
GET /images/:id.jxl/metadata
GET /images/:id.jxl/preview
GET /images/:id.jxl/dc
GET /images/:id.jxl/derivative?w=1024&profile=viewer
POST /images/encode-jxl
```

### 30.3 Hybrid Browser/Server Strategy

The browser should be able to:

- decode original JXL directly where appropriate
- request server-generated derivatives on weak clients
- request metadata only first
- fall back from browser decode to server derivative when capability or memory is insufficient

This should be policy-driven.

---

## 31. Native Browser JPEG XL Future Path

The wrapper must be ready for future native browser JPEG XL support.

If native support becomes available:

1. Detect native decode.
2. Detect whether native progressive events are exposed.
3. Use native `<img>`/`ImageDecoder`/future APIs where they outperform WASM.
4. Continue using WASM where native support lacks metadata, progressive control, ROI, or consistent behavior.
5. Keep the same public session API.

The wrapper is not merely a polyfill. It is a runtime with scheduling and metadata semantics. Native support may become one backend among several.

---

## 32. Telemetry

Telemetry is required for tuning.

Track:

- time to metadata
- time to preview
- time to DC
- time to first visible pixels
- time to final
- decode time per stage
- GPU upload time
- dropped progressive frames
- cancellation count
- memory high-water mark
- WASM memory growth events
- worker crashes
- queue depth
- network throughput
- cache hit/miss
- server job duration
- server memory use

Telemetry should be optional at runtime but easy to enable.

---

## 33. Testing Strategy

### 33.1 Test Categories

1. Unit tests for session state machines.
2. Unit tests for policy decisions.
3. WASM/native binding smoke tests.
4. Progressive decode tests.
5. Streaming input tests.
6. Truncated input tests.
7. Cancellation tests.
8. Backpressure tests.
9. Metadata extraction tests.
10. Color profile tests.
11. Wide-gamut visual tests.
12. Server encode/decode tests.
13. Worker crash recovery tests.
14. Memory pressure tests.
15. Gallery stress tests.
16. Lightbox massive-image tests.
17. Mobile compatibility tests.
18. Safari compatibility tests.
19. Fuzz tests with malformed inputs.
20. Regression tests for real-world image sets.

### 33.2 Required Test Fixtures

Maintain a fixture suite containing:

- small JXL files
- large JXL files
- files with embedded preview
- files without embedded preview
- progressive files
- non-progressive files
- wide-gamut files
- ICC-heavy files
- EXIF/XMP/JUMBF files
- alpha-channel files
- grayscale files
- high-bit-depth files
- animated JXL files
- truncated files
- malformed files
- original-JPEG-reconstruction files
- microscopy-like large images
- herbarium-sheet-like large images
- chronogram/time-lapse sequences

### 33.3 Performance Tests

Minimum performance scenarios:

1. 50-image gallery on desktop.
2. 100-image gallery on desktop.
3. 50-image gallery on mid-range Android.
4. Single huge lightbox image.
5. Rapid scroll cancellation.
6. Poor network simulation.
7. Server batch encode of 1,000 images.
8. Server thumbnail extraction from large originals.
9. Repeated worker recycle test.

---

## 34. Success Criteria

### 34.1 Browser Gallery

A gallery of 50 images must show all visible images at preview or DC stage before any one image is unnecessarily fully refined.

### 34.2 Browser Lightbox

A large image must show useful pixels quickly, then refine the visible viewport ahead of offscreen regions.

### 34.3 Cancellation

When an image is scrolled away or cancelled:

- decode work stops
- network fetch aborts where possible
- queued GPU uploads are dropped
- session resources are released

### 34.4 Color

Wide-gamut and ICC-tagged images must not silently become washed-out. The wrapper must preserve, convert, or explicitly report approximation/unsupported status.

### 34.5 Metadata

Metadata must be available without full image decode where possible.

### 34.6 Server

Server runtime must process large images in bounded memory and stream output without requiring full-file buffering.

### 34.7 Stability

One bad file must not crash or poison the whole worker pool.

### 34.8 Extensibility

Adding a future native JPEG XL backend or WebGPU rendering path must not require rewriting public APIs.

---

## 35. Implementation Phases

### Phase 1: Core Runtime

- Build low-level `libjxl` bridge.
- Implement decode sessions.
- Implement metadata/basic info extraction.
- Implement preview/DC/final decode events.
- Implement cancellation.
- Implement browser worker.
- Implement minimal server decode.
- Implement normalized errors.

### Phase 2: Browser Progressive Viewer

- Worker pool.
- Thumbnail preemption queue.
- Progressive event protocol.
- Basic `ImageBitmap`/canvas rendering.
- Capability negotiation.
- Basic telemetry.

### Phase 3: Server Encode and Derivatives

- Streaming encoder.
- Server worker pool.
- Thumbnail/preview derivative generation.
- Metadata preservation.
- CLI utilities.

### Phase 4: Advanced Scheduling

- Viewport-aware refinement.
- Visibility-aware network and decode scheduling.
- Frame-time aware throttling.
- Backpressure queues.
- Memory tiering and eviction.

### Phase 5: Color, GPU, and Large Image Optimization

- Strong color pipeline.
- ICC preservation/conversion tests.
- GPU upload policy.
- Texture reuse.
- WebGL/WebGPU optional paths.
- Zoomable large-image support.

### Phase 6: Hardening and Future Backends

- Native browser JXL path if available.
- Native server binding optimization.
- Animation support if required.
- More ROI/tile optimizations.
- Expanded conformance and fuzz testing.

---

## 36. Development Principles

1. Prefer sessions over one-shot APIs.
2. Prefer progressive usefulness over theoretical completeness.
3. Prefer bounded queues over uncontrolled throughput.
4. Prefer policy decisions over hard-coded behavior.
5. Prefer metadata preservation by default.
6. Prefer color correctness over convenience.
7. Prefer graceful degradation over brittle feature assumptions.
8. Prefer measurable telemetry over intuition.
9. Prefer worker/process isolation for untrusted inputs.
10. Keep the public API stable while backends evolve.

---

## 37. Hand-Off Checklist

Before implementation begins, confirm:

- [ ] Target package structure is accepted.
- [ ] Browser and server runtimes are both required from the start.
- [ ] Raw `libjxl` binding strategy is accepted.
- [ ] WASM build matrix is accepted.
- [ ] Native server binding is optional but architecturally allowed.
- [ ] Session API is the primary abstraction.
- [ ] One-shot API is only a convenience layer.
- [ ] Thumbnail preemption is mandatory.
- [ ] Viewport-aware refinement is a design requirement.
- [ ] Metadata preservation is default.
- [ ] ICC/color pipeline is non-optional.
- [ ] Animation is graceful-degrade in the first phase.
- [ ] Worker recycling and failure isolation are required.
- [ ] Telemetry hooks are required.
- [ ] Test fixture suite will be maintained.

---

## 38. Final Architectural Summary

This wrapper should not be built as a simple JPEG XL decoder. It should be built as a long-lived adaptive image runtime.

Its defining capabilities are:

- progressive decode
- streaming encode
- metadata-first operation
- preview/DC-first visual response
- fair gallery scheduling
- viewport-aware refinement
- browser/server parity
- color correctness
- bounded memory
- cancellation and backpressure
- GPU-conscious rendering
- long-term backend flexibility

The first version should be conservative and robust. Later versions can improve animation, ROI, WebGPU, native browser integration, and server acceleration without changing the conceptual API.

The implementation is successful when JPEG XL feels immediate in the browser, efficient on the server, faithful to the original image, and flexible enough to remain useful as the JPEG XL ecosystem improves over the coming years.
