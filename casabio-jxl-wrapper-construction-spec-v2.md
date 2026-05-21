# Casabio JXL Wrapper — Construction Specification v2

**Date:** 2026-05-21
**Status:** Final pre-build pass, revision 2.1. Ready for parallel agent execution.
**Supersedes:** Browser-Only Raw libjxl Wrapper for Progressive JXL (v1, 2026-05-21)
**Revision 2.1:** Incorporates WASM performance guidance — Relaxed SIMD tier, PGO pipeline, module caching, explicit chunk sizing, build-tier throughput ratios.
**Owner:** David Gwynne-Evans, Casabio NPC

---

## 0. Document Purpose

This is the construction brief handed to three coding agents (Claude, Codex, Gemini) in a single parallel session. It must be complete enough that no agent needs to ask the user clarifying questions.

### What changed from v1

| Area | v1 | v2 |
|---|---|---|
| Scope | Browser only | Browser **and** server, single API surface |
| Native fallback | Excluded | Server uses native libjxl via N-API; browser stays WASM |
| Tile / region decode | Absent | First-class for large raws |
| Color management / ICC | Absent | Mandatory round-trip, treated as a correctness requirement |
| Metadata (EXIF/XMP) | Absent | Preserved through encode and decode |
| 16-bit and HDR | Absent | Supported end-to-end |
| WASM build pipeline | Implicit | Explicit: SIMD+threads primary, SIMD-only and scalar fallbacks |
| Cross-origin isolation | Absent | COOP/COEP requirement called out with a fallback path |
| OPFS caching | Absent | Added as the persistent layer; in-memory LRU kept for hot previews |
| Capability detection | Absent | Explicit matrix and runtime probe |
| Performance targets | Vague | Specific p50/p95 numbers per workload |
| Public TypeScript API | Implicit | Specified as a contract section (Section 5) |
| Versioning / evolution | Absent | semver policy and libjxl pinning rule |
| Telemetry | Absent | Optional `onMetric` callback and `performance.mark` hooks |
| WASM build matrix | (v1: implicit) | Four tiers including Relaxed-SIMD primary; PGO pipeline; IndexedDB module cache |
| Task ownership | N/A | Explicit per-section assignment with dependency graph |

### What stays from v1

The session model, decode/encode flow shapes, preview-first scheduling intent, worker isolation, error normalization, the message protocol skeleton, and the rejection of one-shot stateless decode all stay. v2 extends and tightens; it does not redesign.

---

## 1. Goals

1. Show useful pixels before the full file is on disk, on both viewer and gallery surfaces.
2. Stream encoded bytes out before the full input pipeline is done, so uploads on slow links surface progress immediately.
3. Cut large-raw end-to-end decode below current 10 s figures (targets in Section 22).
4. One coherent session API for browser and server callers — same lifecycle, same events, same cancellation semantics, same error taxonomy.
5. Preserve scientific fidelity: ICC profiles, EXIF/XMP, bit depth, alpha, and color space must round-trip when callers ask.
6. Be cleanly versioned and stable enough to be extended over the next several years as libjxl evolves.

## 2. Non-Goals

- Animated JXL (defer to a later phase).
- Re-encoding JPEG-1 to lossless JXL (separate pipeline; this wrapper exposes the codec, the lossless-from-JPEG flow is a thin caller on top).
- Building a new image processing library (no resize, no rotate, no color grading; we hand off RGBA / RGBA16 / float buffers).
- Worker management for non-codec work.
- A polyfill for browsers without WebAssembly. Capability detection short-circuits with a clean error.

## 3. Constraints

**Shared:**
- TypeScript-first public surface. ESM modules. No CommonJS in published packages.
- No runtime dependency on `@jsquash/jxl`. v1 prohibited it; v2 keeps that prohibition.
- libjxl is pinned to a single commit per release (Section 19).
- All long-running operations are cancellable via `AbortSignal`.

**Browser:**
- WASM in a dedicated worker; main thread never calls libjxl.
- SIMD-threaded WASM is the primary target. Cross-origin isolation (COOP `same-origin`, COEP `require-corp`) required for `SharedArrayBuffer`. Fallback path runs scalar-or-SIMD without threads when isolation is unavailable.
- All inter-worker buffers transferred, not copied, except where the platform forbids it.
- No reliance on browsers having native JXL `<img>` support — capability detection may *use* it as a fast path, but the wrapper must not require it.

**Server (Node ≥ 22 LTS):**
- Native libjxl via N-API is the primary path; WASM build available as a fallback for environments where the native module cannot be installed.
- Worker threads (`node:worker_threads`) host codec sessions. Same session lifecycle as browser.
- `Readable` / `Writable` adapters on top of the same chunk protocol as the browser stream adapters.

## 4. Architecture

### 4.1 Module Map

```
packages/
  jxl-core/                # Pure TS: types, session contracts, protocol, errors
  jxl-wasm/                # libjxl built to WASM + JS glue (Emscripten output)
  jxl-native/              # N-API binding to system/vendored libjxl (server)
  jxl-worker-browser/      # DedicatedWorker that owns WASM codec sessions
  jxl-worker-node/         # node:worker_threads host for native or WASM
  jxl-session/             # Session facade used by callers; routes to a worker
  jxl-stream/              # ReadableStream / Blob / fetch / Node Readable adapters
  jxl-policy/              # Policy presets: viewer, gallery, thumbnail, export
  jxl-scheduler/           # Pool, priority, budgets, preemption
  jxl-cache/               # OPFS + in-memory LRU (browser), fs + LRU (node)
  jxl-capabilities/        # Runtime feature probe
  jxl-test-corpus/         # Fixture loader + sample manifest
  jxl-bench/               # Benchmark harness
```

### 4.2 Layering Rules

- **Callers** import only `jxl-session`, `jxl-stream`, `jxl-policy`, `jxl-capabilities`.
- `jxl-session` is the only module that talks to `jxl-worker-*`.
- Workers are the only modules that talk to `jxl-wasm` or `jxl-native`.
- `jxl-core` has no runtime dependencies and is importable from every other package.
- No circular imports. Build will enforce.

### 4.3 Browser Data Flow

```
caller ──► jxl-session ──► jxl-scheduler ──► jxl-worker-browser ──► jxl-wasm
                                                       │
caller ◄── progress events ◄────────── (transferred buffers) ◄──────┘
```

### 4.4 Server Data Flow

```
caller ──► jxl-session ──► jxl-scheduler ──► jxl-worker-node ──► jxl-native (primary)
                                                       │              └──► jxl-wasm (fallback)
caller ◄── progress events ◄────────── (Buffers) ◄────┘
```

### 4.5 Shared Contracts

Browser and server differ only in transport. The session, policy, error, and event types in `jxl-core` are identical. Callers write code once.

---

## 5. Public API Surface (TypeScript)

This section is the contract. Agents implementing other sections build to these types verbatim.

```ts
// jxl-core/src/types.ts

export type PixelFormat =
  | "rgba8"     // 4 channels, 8-bit, premultiplied alpha = false
  | "rgba16"    // 4 channels, 16-bit
  | "rgbaf32";  // 4 channels, 32-bit float (linear)

export interface ImageInfo {
  width: number;
  height: number;
  bitsPerSample: 8 | 16 | 32;
  hasAlpha: boolean;
  hasAnimation: boolean;
  iccProfile?: Uint8Array;          // present when the file carries one
  colorSpace?: ColorSpaceHint;      // hint derived when no ICC is present
  exif?: Uint8Array;                // raw EXIF box
  xmp?: Uint8Array;                 // raw XMP box
  jpegReconstructionAvailable: boolean;
}

export type ColorSpaceHint =
  | "srgb" | "display-p3" | "rec2020-pq" | "rec2020-hlg" | "linear-srgb" | "unknown";

export type DecodeStage =
  | "header"       // ImageInfo available
  | "dc"           // first useful low-frequency preview
  | "pass"         // intermediate progressive refinement
  | "final";       // full image complete

export interface DecodeFrameEvent {
  stage: DecodeStage;
  info: ImageInfo;
  pixels: ArrayBuffer;              // transferred
  format: PixelFormat;
  region?: Region;                  // present for tile/region decodes
  pixelStride: number;              // bytes per row (may exceed width * channels * bpc/8)
}

export interface Region {
  x: number; y: number; w: number; h: number;
}

export interface DecodeOptions {
  // What the caller wants out
  format: PixelFormat;              // requested output format
  preserveIcc?: boolean;            // default true
  preserveMetadata?: boolean;       // default true (EXIF + XMP)
  region?: Region;                  // crop decode
  downsample?: 1 | 2 | 4 | 8;       // request power-of-two downsample if codestream supports
  // Progression
  progressionTarget?: "header" | "dc" | "pass" | "final"; // earliest stage to *stop*
  emitEveryPass?: boolean;          // default true for viewer, false for thumbnail
  // Scheduling
  priority?: "visible" | "near" | "background";
  budgetMs?: number;
  signal?: AbortSignal;
  // Telemetry
  onMetric?: (m: CodecMetric) => void;
}

export interface DecodeSession {
  readonly id: string;
  // Stream the bytes in; resolves when worker has accepted the chunk
  push(chunk: ArrayBuffer | Uint8Array): Promise<void>;
  // Signal end of input
  close(): Promise<void>;
  // Iterate frames as they emit
  frames(): AsyncIterable<DecodeFrameEvent>;
  // Await final completion; rejects on error or abort
  done(): Promise<ImageInfo>;
  // Cancel and release codec resources
  cancel(reason?: string): Promise<void>;
}

export interface EncodeOptions {
  format: PixelFormat;
  width: number;
  height: number;
  hasAlpha: boolean;
  // Color and metadata
  iccProfile?: Uint8Array;          // attach to output
  exif?: Uint8Array;
  xmp?: Uint8Array;
  // Quality knobs
  distance?: number;                // libjxl distance; 0 = lossless
  quality?: number;                 // 0–100, mapped via JxlEncoderDistanceFromQuality
  effort?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  // Progressive / streaming
  progressive?: boolean;            // enable progressive frames
  previewFirst?: boolean;           // bias for early bytes over compression
  chunked?: boolean;                // use JxlEncoderAddChunkedFrame for large inputs
  // Scheduling
  priority?: "visible" | "near" | "background";
  signal?: AbortSignal;
  onMetric?: (m: CodecMetric) => void;
}

export interface EncodeSession {
  readonly id: string;
  // Push pixels (one or many chunks for chunked encodes)
  pushPixels(chunk: ArrayBuffer, region?: Region): Promise<void>;
  // Signal end of pixel input
  finish(): Promise<void>;
  // Iterate output byte chunks as they emit
  chunks(): AsyncIterable<ArrayBuffer>;
  // Await completion; resolves with total bytes written
  done(): Promise<number>;
  cancel(reason?: string): Promise<void>;
}

export type CodecMetric =
  | { name: "time_to_header_ms"; value: number }
  | { name: "time_to_first_pixel_ms"; value: number }
  | { name: "time_to_final_ms"; value: number }
  | { name: "time_to_first_byte_ms"; value: number }
  | { name: "input_bytes"; value: number }
  | { name: "output_bytes"; value: number }
  | { name: "peak_memory_bytes"; value: number };
```

The top-level entry points:

```ts
// jxl-session/src/index.ts

export interface JxlContext {
  decode(opts: DecodeOptions): DecodeSession;
  encode(opts: EncodeOptions): EncodeSession;
  capabilities(): Capabilities;
  shutdown(): Promise<void>;
}

export function createBrowserContext(opts?: ContextOptions): JxlContext;
export function createNodeContext(opts?: ContextOptions): JxlContext;
```

`ContextOptions` includes worker pool size, memory caps, cache configuration, and a `wasmUrl` override for self-hosting. Defaults must be sensible for both surfaces.

---

## 6. WASM Build Pipeline

This section is the single largest reason raws currently take >10 s. Treat it as a correctness section, not an optimization. The build matrix, optimization passes, and module loading strategy in this section are the highest-ROI changes available; SIMD and Relaxed SIMD alone typically account for 2–3× decode throughput on pixel-heavy workloads.

### 6.1 Build Matrix

Four artifacts per release, selected at runtime by `jxl-capabilities`:

| Build | Threads | SIMD | Relaxed SIMD | Target |
|---|---|---|---|---|
| `jxl-core.relaxed-simd-mt.wasm` | yes (`-pthread`) | yes (`-msimd128`) | yes (`-mrelaxed-simd`) | Modern Chromium and Firefox with COOP/COEP — primary path |
| `jxl-core.simd-mt.wasm` | yes (`-pthread`) | yes (`-msimd128`) | no | Safari and any engine with uneven Relaxed-SIMD support |
| `jxl-core.simd.wasm` | no | yes | no | Browsers without cross-origin isolation |
| `jxl-core.scalar.wasm` | no | no | no | Compatibility / restricted contexts |

The matrix can collapse to three tiers if Relaxed-SIMD support converges across major engines; until then, keeping a non-relaxed MT tier protects Safari users from a perf cliff caused by falling all the way back to single-threaded.

### 6.2 Emscripten Flags (canonical)

```
-O3
-msimd128                             # all simd builds
-mrelaxed-simd                        # only for relaxed-simd-mt build
-pthread                              # only for *-mt builds
-sUSE_PTHREADS=1                      # only for *-mt builds
-sPTHREAD_POOL_SIZE=navigator.hardwareConcurrency
-sENVIRONMENT=web,worker
-sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createJxlModule
-sALLOW_MEMORY_GROWTH=1
-sINITIAL_MEMORY=33554432             # 32 MiB initial; grows
-sMAXIMUM_MEMORY=4294967296           # 4 GiB cap; review for memory64 later
-sFILESYSTEM=0
-sASSERTIONS=0
-sINVOKE_RUN=0
-sEXPORTED_RUNTIME_METHODS=['cwrap','HEAPU8','HEAP16','HEAPU16','HEAPF32']
-sEXPORTED_FUNCTIONS=@exports.txt     # explicit export allowlist
-flto
-fno-rtti -fno-exceptions             # libjxl already disables; confirm
```

### 6.3 Symbol Trim

Produce `exports.txt` listing only the libjxl symbols we actually call (decoder API, encoder API, version, memory manager hooks). Trim removes JPEG-1 transcoding paths if the caller does not opt into them — saves ~30% of binary size.

### 6.4 Size Budget

- `relaxed-simd-mt`: ≤ 1.6 MiB compressed.
- `simd-mt`: ≤ 1.5 MiB compressed.
- `simd`: ≤ 1.3 MiB compressed.
- `scalar`: ≤ 1.0 MiB compressed.

Relaxed SIMD adds ~80–120 KiB over plain SIMD-MT in practice. If actual is materially higher, the trim list (Section 6.3) needs revisiting. If any build exceeds budget, file-size diagnostic must list contributing object files so the trim list can be tuned.

### 6.5 Reproducibility

Build in a pinned container. Output hash recorded in `jxl-wasm/build-manifest.json`. Manifest is committed.

### 6.6 Profile-Guided Optimization

PGO is opt-in per release, not run on every build. It is worth the CI cost when:

- A libjxl version bump lands.
- The hot-loop audit (Section 6.7) surfaces a regression.
- A benchmark target (Section 22) is missed by more than 10%.

Pipeline:

1. Build with `-fprofile-generate` against the `relaxed-simd-mt` tier.
2. Run the PGO training corpus — a curated subset of `jxl-test-corpus` covering the workloads in Section 22, weighted toward viewer and gallery paths. Selection lives at `jxl-test-corpus/pgo-manifest.json`.
3. Build with `-fprofile-use` consuming the profile data.
4. Verify the size budget still holds; PGO can grow code by 5–15%.
5. Record the profile hash in `build-manifest.json` so reproducibility is preserved.

PGO applied only to the primary `relaxed-simd-mt` tier. Other tiers ship without PGO to keep the matrix manageable.

### 6.7 Hot-Loop Audit (informational)

Do not pre-optimize. Build, measure, then optimize loops that matter. Expected hotspots in libjxl on Casabio workloads, in rough order of cost on raw images:

1. Pixel unpack / RGBA swizzle on output
2. Color space conversion (XYB ↔ RGB, ICC application)
3. Inverse transforms (DCT, modular)
4. Alpha premultiply / unpremultiply at the boundary
5. Downsampling and DC-pass extraction
6. Row-by-row copies between WASM heap and transfer buffers

T-BENCH must produce a profile artifact for the top three workloads so future work has a concrete starting point. Hand-tuning libjxl internals is out of scope for the first build; upstream that work to libjxl rather than carrying patches locally if a real win is found.

Concrete invariants that aid autovectorization on the wrapper side:

- Output buffers aligned to 16 bytes.
- Pixel strides padded to multiples of 16 bytes where the format permits.
- Loops over contiguous memory; no scattered writes from JS into the WASM heap.

### 6.8 Module Loading and Caching

Compiling a 1.5+ MiB WASM module on cold load is meaningful latency. The loader uses, in order of preference:

1. `WebAssembly.compileStreaming(fetch(url))` for first compile.
2. Persistent cache: store the compiled `WebAssembly.Module` in IndexedDB keyed by `${buildId}:${wasmSha}`, where `buildId` comes from `build-manifest.json`. Compiled modules are structured-cloneable; the IndexedDB path skips recompilation entirely on subsequent loads.
3. On cache miss or version mismatch, fall back to step 1 and write the result.

The Cache API is used for the raw `.wasm` bytes (so HTTP cache headers play correctly), IndexedDB for the compiled module. Both keys include the SHA from `build-manifest.json` so a toolchain bump invalidates cleanly with no manual cache busting.

Server-side, the WASM fallback path compiles once at worker startup and reuses the module across sessions in that worker. No persistent cache needed.

---

## 7. Threading & Cross-Origin Isolation

### 7.1 Browser Requirement

`SharedArrayBuffer` requires the document to be cross-origin isolated:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Casabio's web shell must serve these headers in any document that loads `jxl-core.simd-mt.wasm`. The wrapper detects isolation and falls back automatically; integration step (Section 25, T-INT) must confirm headers in deployed environments.

### 7.2 Worker Topology

- One *codec worker* per active session, sourced from a pool (Section 12).
- Inside the codec worker, libjxl spawns its own thread pool when `-pthread` is enabled.
- Pool size for libjxl internal threads: `min(4, navigator.hardwareConcurrency - 1)`. Higher counts hurt latency under contention.
- Workers are reused; codec instances are not. A poisoned codec triggers worker destruction.

### 7.3 Server Topology

- One `node:worker_threads` worker per concurrent session up to the pool cap (default `os.cpus().length - 1`).
- Native libjxl runs on the worker thread directly; no nested thread pool unless the caller opts in.

---

## 8. Color, Metadata, and Bit Depth

This was the most consequential v1 omission. Casabio is a biodiversity platform; an image that loses its EXIF GPS, ICC profile, or 16-bit dynamic range is a scientific defect, not a UX inconvenience.

### 8.1 Requirements

- **ICC profiles**: round-trip byte-exact on decode and encode when `preserveIcc: true` (default). The decoder uses `JxlDecoderGetICCProfile` for the original profile and exposes it on `ImageInfo`; the encoder accepts an ICC blob and attaches it via `JxlEncoderSetICCProfile`.
- **EXIF and XMP**: extracted as raw boxes during decode; re-attached during encode when supplied. Never parsed or modified by this wrapper.
- **Bit depth**: 8, 16, and 32-bit float supported on both ends. Output format is whatever the caller requests; if requested format has fewer bits than the source, the decoder downconverts and a `format_downcast` metric is emitted.
- **Alpha**: never premultiplied at the wrapper boundary. Callers that need premultiplied alpha do it themselves.
- **Color space hints**: when no ICC is present, the wrapper exposes `colorSpace: ColorSpaceHint` derived from JXL color encoding metadata. This is a hint, not a guarantee.

### 8.2 Tests for this section are non-optional

The test corpus (Section 21) must include ICC-tagged sRGB, Display-P3, and Rec.2020 fixtures with EXIF and XMP, at 8 and 16 bits, with and without alpha. Round-trip equality is part of the pass criterion.

---

## 9. Tile and Region Decode

Large raws decoded as a single full-resolution frame are the dominant cause of the >10 s observation when the caller only needs a viewport-sized region or a smaller display size.

### 9.1 Region Decode

- Accept `region: Region` in `DecodeOptions`. The decoder clips to the region using libjxl frame box parsing where the codestream allows.
- When the codestream is not tile-coded, fall back to full-frame decode and crop, but emit a `metric: region_fallback_full_frame` so the caller can detect inefficiency.

### 9.2 Downsample at Decode

- Accept `downsample: 1 | 2 | 4 | 8`. Pass through to libjxl as the requested image scale where supported; otherwise downsample post-decode in the worker.
- Thumbnail policy defaults to `downsample: 4` or `downsample: 8` depending on container size.

### 9.3 DC-Only Stop

- For thumbnail and gallery contexts, `progressionTarget: "dc"` plus `downsample: 8` should produce a usable preview in tens of milliseconds for typical raws.

This subsystem is the single biggest expected win for the gallery surface.

---

## 10. Decode Design

### 10.1 Session States

```
created → headers → progressive → final
                 ↘ cancelled
                 ↘ error
                 ↘ budget_exceeded
```

`headers` is reached when `ImageInfo` is available. Callers commonly use header info to allocate display surfaces before any pixel arrives.

### 10.2 Flow

1. `decode()` returns a `DecodeSession` immediately; no I/O yet.
2. Caller awaits `push(chunk)` or wires a `ReadableStream` via `jxl-stream`.
3. Worker creates a libjxl decoder, subscribes to `JXL_DEC_BASIC_INFO`, `JXL_DEC_COLOR_ENCODING`, `JXL_DEC_FRAME`, `JXL_DEC_FULL_IMAGE`, `JXL_DEC_FRAME_PROGRESSION`.
4. On `JXL_DEC_FRAME_PROGRESSION`, worker calls `JxlDecoderFlushImage()` and transfers the RGBA buffer.
5. Worker continues to ingest and refine until final, cancel, or budget.

### 10.3 Progression Policy

| Caller context | Default `progressionTarget` | `emitEveryPass` | Notes |
|---|---|---|---|
| Thumbnail list | `dc` | `false` | One useful preview, then stop unless promoted |
| Gallery (near-viewport) | `dc` | `false` | DC only; promote to viewer on tap |
| Viewer (visible) | `final` | `true` | Refine while visible |
| Export | `final` | `false` | No intermediates needed |
| Background prefetch | `dc` | `false` | Lowest priority, easily preempted |

### 10.4 Cancellation

- `cancel()` on the session sends `decode_cancel` to the worker and resolves once codec teardown finishes.
- `AbortSignal` passed in `DecodeOptions` triggers the same path.
- A cancelled session's pixel buffers in transit are discarded by the caller.

---

## 11. Encode Design

### 11.1 Session States

```
created → configured → streaming → finalising → done
                                ↘ cancelled
                                ↘ error
```

### 11.2 Flow

1. `encode()` returns an `EncodeSession` immediately.
2. Worker configures `JxlEncoderFrameSettings` from `quality`/`distance`/`effort`/`progressive`.
3. For `chunked: false`, worker uses `JxlEncoderAddImageFrame`.
4. For `chunked: true`, worker uses `JxlEncoderAddChunkedFrame` and ingests pushed pixel regions as they arrive.
5. Output pumped via `JxlEncoderSetOutputProcessor` so bytes emit as they are produced; `chunks()` async-iterates the emissions.

### 11.3 Quality Mapping

- `distance` is the canonical knob. `quality` (0–100) maps through `JxlEncoderDistanceFromQuality()`.
- `effort` defaults: `2` for thumbnails, `4` for viewer-quality, `7` for archival. Effort 9 is reserved for explicit caller request because of its cost.

### 11.4 Preview-First

When `previewFirst: true`:

- Enable progressive output.
- Bias the encoder toward early DC.
- Expose the first complete pass as the "usable" point in `onMetric` (`time_to_first_byte_ms`).
- Continue refining unless the caller cancels.

This is the upload-on-slow-link path. The UI can show "uploaded" once the first usable preview is on the server.

### 11.5 Raw-Specific Path

Large raw inputs (multi-hundred-megapixel, 16-bit) must:

- Use `chunked: true`.
- Use `format: "rgba16"` end-to-end (no 8-bit downconvert at the wrapper).
- Hold no more than two tile-sized scratch buffers at a time inside the encoder worker.

---

## 12. Scheduler, Priority, Budgets

### 12.1 Worker Pool

- Default pool size browser: `min(4, navigator.hardwareConcurrency - 1)`.
- Default pool size server: `os.cpus().length - 1`.
- Pool overridable via `ContextOptions.poolSize`.
- Workers are warm — created at first use, kept alive for `idleTimeoutMs` (default 30 s).
- Idle workers terminated on pool size pressure.

### 12.2 Priority Lanes

`visible` > `near` > `background`. The scheduler maintains three queues. A `visible` job entering the queue preempts any `background` job currently bound to a worker:

- Preemption: send `decode_cancel`, wait for ack, reassign worker to the visible job.
- Preempted background work re-queues with a fresh session id; partial frames discarded.

### 12.3 Budgets

- `budgetMs` is enforced per-stage transition, not as a wall-clock timer across the whole decode.
- When exceeded between stages, the session emits `decode_budget_exceeded` with the best frame so far.
- Caller may resume by issuing a new session with `progressionTarget: "final"` if they want to keep going.

### 12.4 Dedupe

- The scheduler keys in-flight sessions by source identity (URL hash or content hash). A second request for the same key returns a fan-out subscription to the existing session, not a second decode.

---

## 13. Memory and Buffer Management

- All inter-worker buffers are `ArrayBuffer` and **transferred**.
- Decoder writes directly into a worker-owned scratch buffer; on flush, the buffer is detached and transferred to the main thread.
- Encoder output chunks are sized to ~64 KiB targets; smaller chunks acceptable on flush. This matches typical HTTP/2 frame sizes for upload paths.
- Decoder input chunks pushed from `jxl-stream` adapters target 256 KiB to 1 MiB. Smaller chunks cross the JS-WASM boundary more often and lose throughput; larger chunks delay the first useful pass.
- Soft per-worker memory cap: 256 MiB browser default, 1 GiB server default; configurable.
- On cap breach, the worker fails the active session with `OutOfMemory`, destroys its codec instance, and is recycled.
- `ImageBitmap` interop: when `format: "rgba8"` and the caller is the main thread, the worker may emit an `ImageBitmap` instead of `ArrayBuffer` if the platform supports `createImageBitmap` from a buffer cheaply. This skips a copy into the canvas.
- Memory64: documented as a future option for >4 GiB working sets; not in scope for this build. The build manifest reserves a `memory64: false` field for forward signalling.

---

## 14. Caching

### 14.1 Layers

| Layer | Browser | Server |
|---|---|---|
| Hot in-memory LRU | yes | yes |
| Persistent | OPFS | filesystem path |

### 14.2 Keys

`sha256(sourceBytes) + ":" + outputDescriptor` where `outputDescriptor` encodes format, downsample, region (if any), and stage. DC previews and final frames have distinct keys.

### 14.3 What Gets Cached

- Final thumbnails (high reuse).
- Final viewer frames (medium reuse).
- DC previews for items currently in or near the viewport.
- Intermediate progressive passes are *not* cached.

### 14.4 Eviction

- LRU with byte-size cap. Default 128 MiB browser hot, 1 GiB OPFS, configurable.
- Server filesystem cache size configurable; no default eviction (caller's housekeeping).

---

## 15. Server-Side Path

### 15.1 Why Native

A single 200 MP raw decoded in WASM under Node is currently bound by single-threaded WASM execution and lacks SIMD on some Node builds. Native libjxl via N-API is 5–10x faster on the workloads Casabio ingests.

### 15.2 Binding Surface

`jxl-native` exposes the same C functions used by the WASM glue, behind the same TypeScript-level API. The worker host (`jxl-worker-node`) selects native or WASM at startup based on `require()` success and a `JXL_FORCE_WASM` environment variable for testing.

### 15.3 Build

- Prebuilt binaries for Linux x64, Linux arm64, macOS arm64, macOS x64, Windows x64. CI publishes via `prebuildify` or equivalent.
- Source fallback: `node-gyp` build using vendored libjxl source matching the WASM commit pin.

### 15.4 Worker Threads vs Child Processes

Worker threads chosen: lower handoff cost, shared `Buffer` ownership, simpler lifecycle. Child processes considered and rejected for codec work; appropriate only if a hard sandbox is needed later.

### 15.5 Stream Adapters

`jxl-stream` exposes `fromNodeReadable(stream)` and `toNodeWritable(stream)` in addition to the browser `ReadableStream` variants.

---

## 16. Message Protocol

The protocol is otherwise the v1 protocol, with additions called out below. Keys are snake_case to keep the worker boundary boring.

### 16.1 Decode (additions only)

Main → worker:

```json
{ "type": "decode_start", "sessionId": "123",
  "format": "rgba8", "region": null, "downsample": 1,
  "progressionTarget": "final", "emitEveryPass": true,
  "preserveIcc": true, "preserveMetadata": true,
  "priority": "visible", "budgetMs": null }
```

Worker → main:

```json
{ "type": "decode_header", "sessionId": "123", "info": { "...": "ImageInfo" } }
```

Plus all v1 `decode_progress`, `decode_final`, `decode_error`, `decode_cancelled`, `decode_budget_exceeded`.

### 16.2 Encode (additions only)

Main → worker `encode_start` adds `chunked`, `previewFirst`, `iccProfile` (transferable), `exif`, `xmp`.

Worker → main `encode_first_byte_ready` (informational; used for `time_to_first_byte_ms`).

### 16.3 Backpressure and Chunk Sizing

- `push` and `pushPixels` return a promise that resolves when the worker queue depth is below a high-water mark (default 4 chunks).
- Stream adapters target a 256 KiB to 1 MiB chunk size on the input side. Below 256 KiB the JS-WASM boundary cost dominates; above 1 MiB the time to first useful pass grows for no benefit.
- Callers can chain `await` to apply natural backpressure on `ReadableStream` consumers. Default high-water mark plus chunk size gives a ~1–4 MiB in-flight window per session, which is the sweet spot for both gallery and viewer workloads.

---

## 17. Capability Detection

`jxl-capabilities` runs at context creation and exposes:

```ts
export interface Capabilities {
  wasm: boolean;
  wasmSimd: boolean;
  wasmRelaxedSimd: boolean;    // requires wasmSimd; available on many engines as of 2026
  wasmThreads: boolean;        // requires SAB + crossOriginIsolated
  crossOriginIsolated: boolean;
  sharedArrayBuffer: boolean;
  offscreenCanvas: boolean;
  imageBitmap: boolean;
  nativeJxlDecoder: boolean;   // browser: <img> source type test; node: native module present
  selectedWasmBuild: "relaxed-simd-mt" | "simd-mt" | "simd" | "scalar" | "none";
  libjxlVersion: string;
}
```

The probe uses `wasm-feature-detect` (or equivalent inlined checks) and a 1-pixel JXL test image for native browser support detection. Relaxed SIMD detection includes a small runtime instruction probe, since flag advertisement and actual execution have diverged historically.

**Determinism note for Relaxed SIMD.** Relaxed SIMD instructions (relaxed FMA, relaxed swizzle out-of-bounds behavior, relaxed dot product accumulation order) are implementation-defined within bounds. libjxl's math is tolerant of this within the codec's own precision budget — the codec is not bit-exact across builds in the general case, and Relaxed SIMD does not change that contract materially. Callers requiring bit-exact reproducibility across machines (forensic, regulatory) should pin `selectedWasmBuild` away from `relaxed-simd-mt` via a future `ContextOptions.preferDeterministic: true` flag (not in scope for this build; recorded as a follow-up).

---

## 18. Error Handling

### 18.1 Error Taxonomy

```ts
export type JxlErrorCode =
  | "MalformedCodestream"
  | "TruncatedStream"
  | "UnsupportedFeature"
  | "OutOfMemory"
  | "BudgetExceeded"
  | "Cancelled"
  | "WorkerCrashed"
  | "CapabilityMissing"
  | "ConfigError"
  | "Internal";

export class JxlError extends Error {
  readonly code: JxlErrorCode;
  readonly sessionId?: string;
  readonly partial?: DecodeFrameEvent;   // best frame so far, when applicable
  readonly cause?: unknown;
}
```

### 18.2 Rules

- Malformed codestream fails the session immediately; no partial returned.
- Truncated stream keeps best partial. `done()` rejects with `TruncatedStream` carrying `partial`.
- Worker crash invalidates the session, recycles the worker, fails the session with `WorkerCrashed`. Other sessions on the pool are unaffected.
- Codec instance never reused after a non-trivial error. Workers may be reused once cleaned.
- Cancellation is not an error in the colloquial sense, but it surfaces through `JxlError` with code `Cancelled` so callers have a single failure path.

---

## 19. Versioning and Evolution

- Public API follows semver.
- libjxl is pinned per release. `jxl-wasm/build-manifest.json` and `jxl-native/binding.gyp` reference the same commit.
- A libjxl upgrade is a minor version bump if the public API is unchanged, a major bump otherwise.
- The wrapper is expected to live and evolve for years. The session API is the stability surface. Internal worker protocol may change in any minor release.
- Two-version overlap policy: a deprecated method must remain functional for at least one minor version before removal in a major.

---

## 20. Telemetry and Observability

- Every session may emit `CodecMetric` events via the optional `onMetric` callback.
- The worker also calls `performance.mark`/`performance.measure` in the browser (and the Node performance hooks equivalent) using names prefixed `jxl:` so callers can wire their existing observability.
- No telemetry leaves the process. No fetch calls. The wrapper is observable, not phone-home.

---

## 21. Test Corpus and Plan

### 21.1 Corpus

A vendored manifest of small but realistic fixtures, drawn from Casabio's own image inventory where licensing allows. Fixtures cover:

- 8-bit sRGB, no alpha (typical jpeg-from-camera replacement).
- 8-bit sRGB with alpha (UI assets).
- 16-bit Adobe RGB and Display-P3 (scientific captures).
- 32-bit float (synthetic, for completeness).
- Large 100+ MP raw (one fixture; size-budgeted but real).
- Truncated codestreams (manually clipped at byte offsets).
- Malformed codestreams (intentionally corrupted).
- Lossless from JPEG-1 (reconstruction available).
- ICC-tagged fixtures: sRGB v2, sRGB v4, Display-P3, Rec.2020 PQ.

### 21.2 Unit

Session lifecycle, push ordering, cancel during decode/encode, error normalization, cache key derivation, budget expiry, ICC round-trip, EXIF/XMP round-trip, bit-depth round-trip.

### 21.3 Integration

Decode truncated → early frames appear; final rejects with `TruncatedStream` and exposes partial. Decode large raw progressively → DC arrives <100 ms after first byte at the worker. Encode large RGBA → first byte emitted before pixel input complete. Thumbnail queue stays responsive while a viewer image decodes. Preemption verified by injecting a `visible` decode mid-`background` decode and observing cancel propagation.

### 21.4 Performance

Run on a fixed reference machine (CI runner) and on the developer machine; report both. Tests fail on regression beyond a tolerance set in Section 22.

---

## 22. Performance Targets

Targets are p50 / p95 on the CI reference machine, browser path with `simd-mt` build, unless noted. "Useful preview" = DC stage emitted.

| Workload | Metric | Target |
|---|---|---|
| 12 MP JPEG-replacement, viewer | time to header | 5 / 15 ms |
| 12 MP JPEG-replacement, viewer | time to first pixel (DC) | 50 / 150 ms |
| 12 MP JPEG-replacement, viewer | time to final | 250 / 600 ms |
| 100 MP raw, viewer | time to first pixel (DC at downsample 4) | 200 / 500 ms |
| 100 MP raw, viewer | time to final (full res) | **2.0 / 5.0 s** (down from current ~10 s) |
| 200-thumbnail gallery cold | time to first thumbnail painted | 100 / 250 ms |
| 200-thumbnail gallery cold | time to all thumbnails painted | 2.5 / 5.0 s |
| Encode 12 MP, viewer quality, previewFirst | time to first byte | 80 / 200 ms |
| Encode 100 MP raw, archival, chunked | time to first byte | 300 / 800 ms |
| Encode 100 MP raw, archival, chunked | time to done | **3.5 / 8.0 s** (down from current ~12 s) |

**Build-tier throughput ratios** (tracked by T-BENCH; CI fails on regression):

| Comparison | Target ratio (decode throughput on 12 MP fixture) |
|---|---|
| `simd-mt` vs `scalar` | ≥ 1.8× |
| `relaxed-simd-mt` vs `simd-mt` | ≥ 1.2× |
| `simd` vs `scalar` | ≥ 1.5× |

Server-native targets are roughly half the browser-WASM viewer figures and are documented separately in the bench suite.

---

## 23. Suggested Omissions from v1

Drop or defer:

- **The hard "browser-only" stance.** Server callers are a real and growing surface; sharing the session API saves work and reduces drift.
- **The presumption that progressive frames are abundant.** Many codestreams will emit only header + final. The policy already allows for this; v1 leaned on multi-pass refinement more than reality supports. v2 makes DC the guaranteed payoff and treats `pass` as optional.
- **Animation pipeline.** Already a non-goal; v2 keeps it dropped.
- **The "cache only the last useful preview" line in v1 thumbnail policy.** Replaced with concrete cache rules in Section 14.
- **JPEG-1 transcoding in the default WASM build.** It's a separate workflow. Build with the trim list excluding it by default; provide an opt-in build for callers that need it.

What v2 explicitly does *not* add (callers have asked, deferred on purpose):

- WebGPU acceleration of color conversion. Promising, but not stable enough cross-browser to be a build target now. Revisit in 12 months.
- GPU-side decode. Same reason.
- A polyfill for browsers without WASM. Capability detection fails fast; callers handle the UX.

---

## 24. Rollout

1. Land Section 5 contracts and Section 16 protocol as types and JSON Schemas. No implementation yet.
2. WASM and native libjxl builds land independently, gated behind capability detection.
3. Worker hosts and session facade land next, with stub codecs that exercise the protocol.
4. Real decode and encode land behind a feature flag, with the existing one-shot path remaining the default.
5. Scheduler, budgets, and caching come online.
6. Test corpus and benchmarks run in CI. Performance targets enforced.
7. Integration in `web/main.js` and the server ingestion path. One-shot path removed.
8. libjxl pin bumped; release.

---

## 25. Task Assignment and Dependency Graph

### 25.1 Wave Plan

The dependencies are real: codec implementations need the WASM artifact, worker hosts need the protocol types, integration needs everything. To execute in **one parallel session**, agents build against the contracts in Sections 5 and 16 as if they were source of truth, using stubs where their dependency is not yet present. A short **integration pass** at the end stitches real artifacts in.

If time pressure forces two waves, Wave 1 is everything that does not need a compiled WASM artifact, Wave 2 is decode/encode session bodies plus integration and benchmarks. Mark in the briefs which tasks tolerate stubs.

### 25.2 Dependency Graph

```
T-CORE ─────────┬─► T-WORKER-BROWSER ─┐
                ├─► T-WORKER-NODE ────┤
                ├─► T-SCHEDULER ──────┤
                ├─► T-STREAM ─────────┼─► T-INT ─► T-TEST ─► T-BENCH
                ├─► T-CACHE ──────────┤
                └─► T-CAPS ───────────┘
T-WASM-BUILD ───┬─► T-DECODE-WASM ────┤
                └─► T-ENCODE-WASM ────┤
T-NATIVE-BIND ──┬─► T-DECODE-NATIVE ──┤
                └─► T-ENCODE-NATIVE ──┘
T-CORPUS  (independent) ──────────────► T-TEST, T-BENCH
```

`T-CORE` must land first in time even if other agents start in parallel — they generate code from its types. Everyone treats the Section 5 / Section 16 specification as authoritative until `T-CORE` lands the actual `.d.ts`.

### 25.3 Assignment Table

| Task ID | Title | Agent | Model | Depends on |
|---|---|---|---|---|
| T-CORE | TypeScript types, error taxonomy, protocol schemas, package skeleton | Claude | Claude Sonnet 4.6 | — |
| T-WASM-BUILD | Emscripten build of libjxl, three artifacts, manifest | Codex | GPT-5-Codex | — |
| T-NATIVE-BIND | N-API binding, prebuilds, gyp config, version pin shared with WASM | Codex | GPT-5-Codex | — |
| T-DECODE-WASM | Browser decode session inside `jxl-worker-browser` | Codex | GPT-5-Codex | T-CORE, T-WASM-BUILD |
| T-ENCODE-WASM | Browser encode session inside `jxl-worker-browser` | Codex | GPT-5-Codex | T-CORE, T-WASM-BUILD |
| T-DECODE-NATIVE | Server decode session inside `jxl-worker-node` | Codex | GPT-5-Codex | T-CORE, T-NATIVE-BIND |
| T-ENCODE-NATIVE | Server encode session inside `jxl-worker-node` | Codex | GPT-5-Codex | T-CORE, T-NATIVE-BIND |
| T-WORKER-BROWSER | Worker host shell, message router, lifecycle, recycle on poison | Claude | Claude Sonnet 4.6 | T-CORE |
| T-WORKER-NODE | Node worker host shell, native/WASM selection at startup | Claude | Claude Sonnet 4.6 | T-CORE |
| T-SCHEDULER | Pool, priority lanes, budgets, dedupe, preemption | Claude | Claude Opus 4.7 | T-CORE |
| T-STREAM | ReadableStream / Blob / fetch / Node Readable adapters with backpressure | Gemini | Gemini 2.5 Pro | T-CORE |
| T-CACHE | OPFS + in-memory LRU (browser); fs + LRU (node) | Gemini | Gemini 2.5 Pro | T-CORE |
| T-CAPS | Runtime capability probe and build selector | Gemini | Gemini 2.5 Flash | T-CORE |
| T-CORPUS | Test fixture loader, manifest, vendored samples | Gemini | Gemini 2.5 Pro | — |
| T-INT | Integrate into `web/jxl-worker.js` and `web/main.js`; remove one-shot path | Claude | Claude Sonnet 4.6 | all above |
| T-TEST | Unit + integration tests against contracts and corpus | Gemini | Gemini 2.5 Pro | T-CORE, T-CORPUS, T-INT |
| T-BENCH | Benchmark harness, perf gate, results JSON | Codex | GPT-5-Codex | T-INT, T-CORPUS |

### 25.4 Why these assignments

- **Codex (GPT-5-Codex)** for everything that touches C, C++, Emscripten flags, N-API, libjxl callbacks, and tight performance loops. This is where it has the most leverage and where mistakes are most expensive. The encode chunked path in particular is fiddly and benefits from a model that writes confident systems code.
- **Claude (Sonnet 4.6 default, Opus 4.7 for the scheduler)** for the session contracts, worker hosts, error taxonomy, and integration into existing Casabio code. These are design-heavy, prose-heavy tasks where careful interface judgement matters more than raw code throughput. The scheduler gets Opus 4.7 because preemption semantics with dedupe and backpressure is the easiest place in this design to introduce subtle bugs, and the cost is justified once.
- **Gemini (2.5 Pro default, Flash for capability probe)** for stream adapters, OPFS plumbing, test corpus aggregation, and tests. These are wide-context tasks where reading a lot of source from libjxl, MDN, and reference projects pays off, and where Gemini's pricing is generous on the $20 plan. Capability probe is cheap enough for Flash.

### 25.5 Token budget notes for $20/mo plans

- Claude Opus 4.7 is used for exactly one task (T-SCHEDULER) — pick your moment, do it well, do it once.
- Sonnet 4.6 handles the other Claude tasks; if you hit weekly limits, T-WORKER-BROWSER and T-WORKER-NODE are the safest to drop to a smaller variant.
- GPT-5-Codex carries the load for code-heavy tasks; if Codex tier limits bite, T-BENCH is the most deferrable.
- Gemini 2.5 Pro is the most token-generous of the three for $20; lean on it for anything that needs to ingest a lot of upstream source (libjxl headers, icodec source, jxl-art) and synthesize.

---

## 26. Per-Task Briefs

Each brief is what you paste into the agent's session. Briefs are self-contained; the agent should not have to read this whole document.

### T-CORE (Claude Sonnet 4.6)

> Build the `jxl-core` TypeScript package. It contains no runtime; only types, error classes, JSON Schemas for the worker protocol, and a package skeleton. Take Section 5 ("Public API Surface") and Section 16 ("Message Protocol") of the construction spec as authoritative. Produce: `src/types.ts`, `src/errors.ts`, `src/protocol.ts`, `src/schemas/*.json`, `package.json` (ESM, `exports` map, `sideEffects: false`), `tsconfig.json` (strict, `moduleResolution: bundler`, ES2022 target), `README.md` describing the contract. Build on shoulders of giants: pull naming conventions from `icodec` and `@jsquash/jxl` where they help, but do not depend on either. Do not invent fields not in the spec. When the spec is ambiguous, prefer the more restrictive option and note it in `README.md`. Land the package, run `tsc`, leave any publishing or registry steps for the final integration pass.

### T-WASM-BUILD (GPT-5-Codex)

> Build `jxl-wasm`. Compile libjxl to WebAssembly with Emscripten using the four-build matrix in Section 6: `relaxed-simd-mt`, `simd-mt`, `simd`, `scalar`. Use the canonical flag set in Section 6.2 verbatim. Generate an `exports.txt` allowlist covering only the decoder and encoder API symbols listed at libjxl.readthedocs.io plus the memory manager hooks. Strip JPEG-1 transcoding by default. Produce a build container (Dockerfile, pinned base image, pinned Emscripten SDK version, pinned libjxl commit). Output `dist/jxl-core.{relaxed-simd-mt,simd-mt,simd,scalar}.{wasm,js}` plus `build-manifest.json` containing libjxl commit, Emscripten version, build flags, file SHAs, sizes, and (for the relaxed-simd-mt tier) the PGO profile hash when applicable. Enforce the size budget in Section 6.4; if exceeded, emit a diagnostic listing the heaviest objects.
>
> **PGO (Section 6.6):** wire the two-stage profile-generate / profile-use pipeline but leave it off by default in CI. Provide a `pnpm build:pgo` script that runs the full pipeline against the PGO training corpus at `jxl-test-corpus/pgo-manifest.json`. Document the trigger conditions in the package README.
>
> **Module loader (Section 6.8):** ship a `src/loader.ts` that handles `compileStreaming` + IndexedDB compiled-module cache for browser callers, and a plain compile-once-and-reuse path for Node. Cache keys include `${buildId}:${wasmSha}` from the manifest so toolchain bumps invalidate cleanly.
>
> **Build on shoulders of giants:** read icodec's libjxl build scripts (github.com/Kaciras/icodec) and libjxl's own `tools/wasm/` for prior art. Do not modify libjxl source; if a patch is unavoidable, vendor it as a separate `.patch` file with a written justification. Do not block on credentials, registry pushes, or CI configuration; produce a local-build script and a README documenting the publish step for the integration pass.

### T-NATIVE-BIND (GPT-5-Codex)

> Build `jxl-native`. N-API binding to libjxl pinned to the same commit as `jxl-wasm`. Provide a `binding.gyp` for source builds and `prebuildify` configuration for Linux x64/arm64, macOS x64/arm64, Windows x64. Expose a TypeScript surface that matches the C subset the WASM glue uses, so `jxl-worker-node` can swap implementations behind a single import. Loader at `src/index.ts` selects prebuilt binary if present, falls back to source build, then falls back to throwing a clean `CapabilityMissing` error so the worker host can degrade to WASM. Build on shoulders of giants: look at `sharp`'s prebuild conventions and `node-addon-api` patterns. Do not commit prebuilt binaries; document the CI publish step. Do not block on the CI being set up; produce the configuration and a README. Defer registry credentials to the integration pass.

### T-DECODE-WASM (GPT-5-Codex)

> Implement the decode session inside `jxl-worker-browser`. Import `jxl-core` types and `jxl-wasm`. Stand up a `JxlDecoder` per session, subscribe to header, color encoding, frame, full image, and frame progression events. On `JXL_DEC_FRAME_PROGRESSION`, call `JxlDecoderFlushImage` and transfer an RGBA buffer in the requested format. Support `region`, `downsample`, `preserveIcc`, `preserveMetadata` as specified in Sections 8 and 9. Emit `decode_header` once basic info is available. Emit `decode_progress` per progressive flush, `decode_final` on completion, `decode_error` on malformed codestream, `decode_cancelled` on cancel, `decode_budget_exceeded` on per-stage budget breach. Tile/region decode uses libjxl's frame-box-aware path; fall back to full-frame-then-crop with a `region_fallback_full_frame` metric when needed. Memory: scratch buffer recycled per session; transfer on flush; never copy. Never reuse a decoder instance after a non-trivial error. Build on shoulders of giants: study icodec's JXL decoder source for the event loop shape. Do not depend on `@jsquash/jxl`. Land tests as part of the task only for the state machine itself; corpus-driven tests are T-TEST.

### T-ENCODE-WASM (GPT-5-Codex)

> Implement the encode session inside `jxl-worker-browser`. Configure `JxlEncoderFrameSettings` from `quality`/`distance`/`effort`/`progressive`/`previewFirst`. Use `JxlEncoderAddImageFrame` for `chunked: false`, `JxlEncoderAddChunkedFrame` for `chunked: true`. Pump output via `JxlEncoderSetOutputProcessor` and emit `encode_chunk` messages as soon as bytes are available. Attach ICC, EXIF, and XMP boxes when provided. Map `quality` (0–100) to distance via `JxlEncoderDistanceFromQuality`. Honour `previewFirst` by enabling progressive output and biasing toward early DC; emit `encode_first_byte_ready` on the first usable output. Cancellation tears down the encoder cleanly; never reuse instances after a non-trivial error. Honour backpressure in the chunk push path: hold a high-water mark and signal the host. Build on shoulders of giants: libjxl's `tools/djxl_ng` and `tools/cjxl_ng` are reference implementations of the chunked paths; mirror their event handling. Do not depend on `@jsquash/jxl`.

### T-DECODE-NATIVE (GPT-5-Codex)

> Same as T-DECODE-WASM but for `jxl-worker-node`, calling `jxl-native`. Same message protocol, same session lifecycle, same error taxonomy. Threading: do not spawn nested libjxl thread pools unless the caller opts in; the worker thread is the unit of concurrency. Streams: accept `Buffer` and `Uint8Array` interchangeably on the input side; emit `Buffer` on the output side. Reuse the contract tests from T-CORE.

### T-ENCODE-NATIVE (GPT-5-Codex)

> Same as T-ENCODE-WASM but for `jxl-worker-node`, calling `jxl-native`. Same contract, same metrics.

### T-WORKER-BROWSER (Claude Sonnet 4.6)

> Build `jxl-worker-browser`. The worker host shell that owns sessions, routes messages by `sessionId`, dispatches to decode or encode handlers, recycles itself on codec poison. Implement a clean shutdown: drain in-flight messages, signal cancellation to active sessions, release the WASM instance, post `worker_shutdown_ack`, then `self.close()`. Spawn one decode or encode handler per session. Handler isolation: a handler crash must not bring the worker down unless it is a memory or instance-level failure. Build on shoulders of giants: Comlink for message dispatching patterns, but do not depend on it; the message protocol is small enough to implement directly. The worker is the only module that imports `jxl-wasm`. Provide a deterministic worker file path resolution that callers can override with `wasmUrl`.

### T-WORKER-NODE (Claude Sonnet 4.6)

> Same as T-WORKER-BROWSER for `node:worker_threads`. At startup, attempt `require('jxl-native')`; on success, route to native handlers. On failure or when `JXL_FORCE_WASM` is set, fall back to WASM via `jxl-wasm`. Expose the choice to the host context as a startup message. Lifecycle parity with the browser host: drain, cancel, release, exit.

### T-SCHEDULER (Claude Opus 4.7)

> Build `jxl-scheduler`. Owns a worker pool (browser: dedicated workers; node: worker_threads). Three priority lanes: `visible`, `near`, `background`. Implements:
>
> 1. Pool sizing per Section 12.1, with `ContextOptions.poolSize` override.
> 2. Idle worker reaping with `idleTimeoutMs`.
> 3. Preemption: a `visible` job entering an empty pool with all workers bound to `background` jobs cancels one background job, waits for cancel ack, reassigns the worker. Preempted background work re-queues with a fresh session id; partial frames discarded.
> 4. Dedupe: in-flight sessions keyed by source identity (URL hash or content hash). Second request for the same key returns a fan-out subscription, not a second decode. Cancellation by one subscriber does not cancel the underlying session unless all subscribers cancel.
> 5. Budget enforcement per stage transition, not wall-clock. Best-frame return on breach.
> 6. Backpressure propagation from worker queues to caller `push` / `pushPixels`.
>
> This module is the most behaviorally subtle in the system. Write integration-grade tests for preemption, dedupe-with-partial-cancel, and budget-breach-with-partial-return as part of the task. Do not optimize for throughput at the expense of correctness; the priority rules in Section 12.2 are the spec.

### T-STREAM (Gemini 2.5 Pro)

> Build `jxl-stream`. Adapters that turn `ReadableStream`, `Blob`, `File`, a `fetch()` response, and a Node `Readable` into ordered `push(chunk)` calls on a session, with cancellation. And the inverse: turn an `AsyncIterable<ArrayBuffer>` (from `EncodeSession.chunks()`) into a `ReadableStream` and a Node `Readable`. Backpressure must compose: if the consumer is slow, the producer slows. Use the platform's native backpressure where available (`ReadableStreamDefaultReader`, `WritableStream`, Node stream `highWaterMark`). Build on shoulders of giants: WHATWG Streams spec for browser, Node's stream/web for the polyfilled paths, MDN reference for `Blob.stream()`. Wire `AbortSignal` through every adapter. Provide a small `bufferedReader` helper that accumulates byte ranges for callers that prefer to push by byte range rather than by chunk.

### T-CACHE (Gemini 2.5 Pro)

> Build `jxl-cache`. Two layers: in-memory LRU (browser and node) and persistent (OPFS in browser, filesystem path in node). Keys per Section 14.2. Eviction per Section 14.4. The persistent layer is opt-in via `ContextOptions.cache.persistent`. OPFS implementation must handle the "quota exceeded" path gracefully: evict, retry once, fail soft on second attempt. Build on shoulders of giants: the OPFS chapter of web.dev for current best practice, idb-keyval for the LRU shape (but do not depend on it for the actual storage; OPFS is required for byte-granular control). Provide a `clear()` method and a `stats()` method.

### T-CAPS (Gemini 2.5 Flash)

> Build `jxl-capabilities`. Runtime probe returning the `Capabilities` shape in Section 17. Use `wasm-feature-detect` for WASM SIMD and threads. Detect Relaxed SIMD via a small runtime instruction probe (flag advertisement and execution have historically diverged for relaxed features). Use `self.crossOriginIsolated`, `typeof SharedArrayBuffer`, `typeof OffscreenCanvas`, `typeof createImageBitmap`. For native JXL decoder detection in the browser, attempt to load a 1×1 JXL test image via `createImageBitmap` from a `Blob` and observe success. Select the WASM build per the matrix in Section 6.1 — prefer `relaxed-simd-mt` when supported, then `simd-mt`, then `simd`, then `scalar`. In Node, additionally probe `require.resolve('jxl-native')` and the presence of a usable prebuilt binary. Return a stable object; do not throw. Document each capability's user-visible implication in the README. Small task: keep it small.

### T-CORPUS (Gemini 2.5 Pro)

> Build `jxl-test-corpus`. A vendored manifest of small but realistic fixtures matching Section 21.1. Pull from libjxl's own test fixtures, the JPEG XL community sample sets, and any Casabio-licensed samples flagged for test use (defer the Casabio sourcing to the integration pass; for now, scaffold the loader and use upstream samples). Each fixture has: filename, source URL, license, dimensions, bit depth, color space, ICC presence, EXIF presence, expected-pass behaviors. Build a `loader.ts` that returns `{ bytes: Uint8Array, manifest: FixtureManifest }`. Total vendored corpus size budget: 50 MiB. Larger fixtures (the 100 MP raw) are loaded on demand via a `fetchLargeFixture(id)` function that downloads from a documented URL with SHA verification.
>
> **PGO manifest:** also produce `pgo-manifest.json` — a curated subset of fixture IDs covering the Section 22 workloads, weighted toward viewer and gallery paths (the surfaces that benefit most from PGO). T-WASM-BUILD's PGO pipeline reads this. Keep it small (~10 fixtures); PGO training overhead grows with corpus size.

### T-INT (Claude Sonnet 4.6)

> Integration into Casabio's `web/`. Replace the one-shot logic in `web/jxl-worker.js` with `jxl-worker-browser` from this build. Replace the call sites in `web/main.js` with `jxl-session` calls, routing viewer requests at `visible` priority, near-viewport thumbnails at `near`, prefetch at `background`. Keep `web/icodec-jxl-options.js` only if its policy mappings are still useful; otherwise port what remains into `jxl-policy`. Wire the cache. Confirm COOP/COEP headers in the deployment configuration; if missing, add and document. Add a feature flag that routes 10% of traffic through the new path first; remove the flag after a clean week. Defer the server-side ingestion integration to a separate task once the browser path is stable; the server modules are built and tested independently in this wave but their call sites in the ingestion pipeline are out of scope here.

### T-TEST (Gemini 2.5 Pro)

> Build the test suite. Unit tests against the contracts in T-CORE: session lifecycle, push ordering, cancel paths, error normalization, cache keys, budget expiry. Integration tests using T-CORPUS fixtures: truncated decode emits early frames and rejects `done()` with `TruncatedStream` carrying `partial`; large raw decode produces DC under the latency target in Section 22; encode emits first byte before pixel input completes; ICC and EXIF round-trip byte-exact; 16-bit fixtures decode to `rgba16` without precision loss; bit-depth downcast emits the `format_downcast` metric. Run in CI on the reference machine. Fail on regression beyond a documented tolerance. Coverage target: 85% statement, 75% branch for `jxl-core`, `jxl-scheduler`, `jxl-session`.

### T-BENCH (GPT-5-Codex)

> Build `jxl-bench`. Harness that runs the workloads in Section 22 against the browser build (in a headless Chromium with COOP/COEP headers set) and the node build (native and WASM, both). Output `bench-results.json` with p50, p95, and a regression baseline. Fail CI when any result regresses beyond 15% from the recorded baseline; allow improvement to roll the baseline forward automatically.
>
> **Build-tier ratios:** run the 12 MP decode workload against all four WASM tiers and record the ratios in Section 22. Fail CI when ratios drop below target — catches regressions where SIMD work was inadvertently scalarized by a libjxl bump or compiler change.
>
> **Profile artifact:** for the top three workloads (100 MP raw decode, 100 MP raw encode, 200-thumbnail gallery cold), produce a sampling profile (Chrome DevTools JSON for browser, `--prof` for Node native) under `dist/profiles/`. These feed Section 6.7's hot-loop audit and future PGO training corpus tuning.
>
> Build on shoulders of giants: tachometer for browser microbenches, mitata or tinybench for node. Provide a `bench --compare baseline.json` mode for local use.

---

## 27. Agent Operating Instructions

These rules apply to every brief in Section 26.

1. **Do not ask the user questions.** Every contract you need is in this document. Ambiguities are resolved in favour of the more restrictive option; note your choice in the task README so a later pass can revisit.
2. **Build on the shoulders of giants.** Read source from `icodec`, libjxl's own `tools/`, `sharp` (for prebuild patterns), `node-addon-api`, the WHATWG Streams spec, and `wasm-feature-detect`. Cite the source in code comments where you borrowed a pattern. Do not vendor large third-party code without recording its license and origin.
3. **Do not block on permissions.** Anything that needs a credential, a registry push, a CI secret, a deployment header change, a domain whitelist, a code-signing certificate, or a human review goes into a `BLOCKED.md` file at the root of your package with a precise description. Keep working on the rest. The integration pass will resolve `BLOCKED.md` items.
4. **Keep going.** Do not stop at the first hard part. Do not ask for confirmation between subtasks. The completion bar is: package builds, contract tests pass, README documents what is done and what is in `BLOCKED.md`.
5. **Never modify another agent's package directory** unless your task brief explicitly says so. T-INT is the only task that touches `web/`.
6. **Use the types from `jxl-core` as the single source of truth.** If `jxl-core` has not landed yet, treat Sections 5 and 16 of this document as the type definitions and implement against them. The eventual `.d.ts` from T-CORE will match.
7. **Do not depend on `@jsquash/jxl`.** Not as a runtime dependency, not as a dev dependency.
8. **Pin everything.** Emscripten version, libjxl commit, prebuild platforms, Node version, TypeScript version. No `^` or `~` ranges on toolchain dependencies.
9. **Transfer, do not copy.** Every cross-worker pixel buffer is transferable. Tests must verify the buffer is detached on the sender side.
10. **Leave a trail.** Each package has a `CHANGELOG.md` started from v0.1.0 and a `DECISIONS.md` recording every non-obvious choice you made. The next pass — whether it is you or another agent in twelve months — will read these.

11. **Maintain `STATE.md` in your package root.** After every subtask, update it with: tasks complete, current subtask, next subtask, decisions made, blockers encountered, files touched. This is your resume point after any context loss. Treat it as the single most important file you write.

12. **Compact early, compact often.** After completing each subtask (a coherent commit's worth of work), save `STATE.md`, commit, and compact your CLI's context. Re-read your assigned spec sections plus `STATE.md`, then continue. Do not let context bloat past the point where you start losing detail. Compaction is also token discipline — $20/mo plans reward it.

13. **Commit after every subtask.** Clear messages: `T-WASM-BUILD: emsdk pinned, container builds`. Never bundle unrelated changes. Frequent commits are recovery points; they let the human cherry-pick what landed when something else broke later.

14. **No human is awake.** If you hit a question you would normally ask the user, do not ask. Resolve it using rule 1 (more restrictive option, note in `DECISIONS.md`) or rule 3 (`BLOCKED.md` and move on). Loop until your assigned tasks are exhausted or all remaining work is blocked.

15. **Self-recovery on failure.** Build, test, or install fails: read the error, try one fix, try a second if the first did not work, document the third attempt as a blocker if needed, move to the next subtask. Do not infinite-loop on a single failure. Do not delete and retry from scratch unless the failure mode demands it.

16. **Finishing.** When all your assigned tasks are complete or fully blocked, write `STATUS.md` at the repo root listing: tasks done, tasks blocked (with reasons), files created, files modified, suggested next steps for the human, and a one-line summary of where the human should look first in the morning. Then stop. Do not start work outside your assigned tasks.

### 27.1 Overnight Unattended Operation Loop

```
loop:
  read your assigned spec sections (Sections 5, 16, 27, 28 always; plus your task's section in 26)
  read STATE.md (if it exists)
  pick the next subtask from STATE.md or your current task brief
  do the subtask
  update STATE.md
  commit on your branch
  compact context
  if all assigned subtasks done OR all remaining are blocked:
    write STATUS.md
    exit
```

This loop runs unattended until the work is done or fully blocked. Each iteration ends in a near-fresh-context state, ready for the next.

---

## 28. Per-Agent Kickoff Prompts

Copy-paste each block into the first message of the relevant agent's CLI session. Fill in `[REPO_PATH]` with the local path to the repository on the branch the agent is working on. Each agent operates on its own branch; merges happen the morning after.

### 28.1 Claude Code agent

```
You are the Claude agent for the Casabio JXL wrapper build.

REPO_PATH: [REPO_PATH]
SPEC: [REPO_PATH]/casabio-jxl-wrapper-construction-spec-v2.md
BRANCH: claude/jxl-wrapper

Read the spec now. Focus on Sections 5 (Public API), 16 (Message Protocol),
27 (Operating Rules), 28.1 (this kickoff), and the briefs in Section 26 for
each of your tasks. Skim everything else for context.

Your assigned tasks, in order:
  1. T-CORE             (no dependencies)
  2. T-WORKER-BROWSER   (depends on T-CORE artifacts on this branch)
  3. T-WORKER-NODE      (depends on T-CORE)
  4. T-SCHEDULER        (depends on T-CORE)
  5. T-INT              (DEFERRED — depends on other agents' branches being
                         merged into this one; do not attempt unless other
                         branches are present in this working tree)

Model usage: default to Claude Sonnet 4.6. Use Claude Opus 4.7 ONLY for
T-SCHEDULER — preemption with dedupe and partial-cancel is the highest-risk
surface in this build and worth the premium tokens once.

Section 27 operating rules are mandatory. Compact your context after every
subtask. Maintain STATE.md and DECISIONS.md per package. Do not ask questions.
Document blockers in BLOCKED.md and continue.

When T-CORE through T-SCHEDULER are done (T-INT deferred), write STATUS.md
and stop.

Begin with T-CORE.
```

### 28.2 Codex CLI agent

```
You are the Codex agent for the Casabio JXL wrapper build.

REPO_PATH: [REPO_PATH]
SPEC: [REPO_PATH]/casabio-jxl-wrapper-construction-spec-v2.md
BRANCH: codex/jxl-wrapper

Read the spec now. Focus on Sections 6 (WASM Build Pipeline), 15 (Server-Side
Path), 22 (Performance Targets), 27 (Operating Rules), 28.2 (this kickoff),
and the briefs in Section 26 for each of your tasks. Skim everything else for
context.

Your assigned tasks, in order:
  1. T-WASM-BUILD       (no dependencies)
  2. T-NATIVE-BIND      (no dependencies; runs after T-WASM-BUILD on this
                         branch for build-tool sanity)
  3. T-DECODE-WASM      (depends on T-WASM-BUILD and Section 5 contracts)
  4. T-ENCODE-WASM      (depends on T-WASM-BUILD and Section 5 contracts)
  5. T-DECODE-NATIVE    (depends on T-NATIVE-BIND and Section 5 contracts)
  6. T-ENCODE-NATIVE    (depends on T-NATIVE-BIND and Section 5 contracts)
  7. T-BENCH            (DEFERRED — depends on T-INT having merged from the
                         Claude branch; do not attempt unless integration
                         exists in this working tree)

Section 5 type contracts and Section 16 protocol are authoritative. Treat
them as if jxl-core has already shipped them. The Claude agent is producing
the actual jxl-core .d.ts on its own branch; your code must match the spec
verbatim so it links cleanly on merge.

Section 27 operating rules are mandatory. Compact after every subtask.
Maintain STATE.md and DECISIONS.md per package. Do not ask questions.
Document blockers in BLOCKED.md and continue.

When T-WASM-BUILD through T-ENCODE-NATIVE are done (T-BENCH deferred), write
STATUS.md and stop.

Begin with T-WASM-BUILD.
```

### 28.3 Gemini CLI agent

```
You are the Gemini agent for the Casabio JXL wrapper build.

REPO_PATH: [REPO_PATH]
SPEC: [REPO_PATH]/casabio-jxl-wrapper-construction-spec-v2.md
BRANCH: gemini/jxl-wrapper

Read the spec now. Focus on Sections 5 (Public API), 14 (Caching),
17 (Capabilities), 21 (Test Corpus), 27 (Operating Rules), 28.3 (this
kickoff), and the briefs in Section 26 for each of your tasks. Skim
everything else for context.

Your assigned tasks, in order:
  1. T-CAPS    (small, no dependencies)         — use Gemini 2.5 Flash
  2. T-CORPUS  (no dependencies)                — use Gemini 2.5 Pro
  3. T-STREAM  (depends on Section 5 contracts) — use Gemini 2.5 Pro
  4. T-CACHE   (depends on Section 5 contracts) — use Gemini 2.5 Pro
  5. T-TEST    (DEFERRED — depends on T-INT having merged from the Claude
                branch; do not attempt unless integration and other packages
                exist in this working tree)

Section 5 type contracts are authoritative. Treat them as if jxl-core has
already shipped them. The Claude agent is producing the actual jxl-core
.d.ts on its own branch.

Section 27 operating rules are mandatory. Compact after every subtask.
Maintain STATE.md and DECISIONS.md per package. Do not ask questions.
Document blockers in BLOCKED.md and continue.

When T-CAPS through T-CACHE are done (T-TEST deferred), write STATUS.md
and stop.

Begin with T-CAPS (smallest), then T-CORPUS, T-STREAM, T-CACHE.
```

### 28.4 Morning-After Tasks

Three tasks are deliberately deferred because they cannot run until the other branches have merged:

| Task | Owner | Waits for |
|---|---|---|
| T-INT | Claude | All of Codex's and Gemini's packages merged into claude branch |
| T-BENCH | Codex | T-INT merged into codex branch |
| T-TEST | Gemini | T-INT merged into gemini branch |

Suggested morning sequence:

1. Review each agent's `STATUS.md` for blockers and decisions.
2. Resolve `BLOCKED.md` items (mostly registry credentials, CI secrets, COOP/COEP header deployment).
3. Merge codex and gemini branches into the claude branch.
4. Re-prompt the Claude agent to do T-INT.
5. Once T-INT lands, re-prompt Codex for T-BENCH and Gemini for T-TEST (these can run in parallel again).
