# CasaWASM JXL Wrapper Feature Summary

This document provides a high-level summary of the features available in the CasaWASM JXL wrapper, categorized by functional area.

## 1. High-Performance Build Architecture
*   **[x] Multi-Tiered WASM Matrix:** Automatically selects the fastest available WASM build (Relaxed SIMD, SIMD+MT, or Scalar) based on the browser's capabilities.
*   **[x] Worker WASM Build Tier Reporting:** The `worker_ready` message includes a `wasmBuild` field (`"relaxed-simd-mt" | "simd-mt" | "simd" | "scalar"`), allowing the scheduler and telemetry to observe which WASM build tier was selected at runtime. (`packages/jxl-worker-browser/src/worker.ts`, `packages/jxl-core/src/protocol.ts`)
*   **PGO (Profile-Guided Optimization):** WASM artifacts are optimized using real-world image data to maximize performance for common scientific and consumer use cases. `FAILED` until the corpus-side PGO manifest lands.
*   **[x] Zero-Copy WASM Writes:** Eliminates intermediate memory copies by writing chunk data directly into the WASM heap.
*   **[x] Grow-only WASM Allocator:** Minimizes reallocations and memory fragmentation by reusing and growing pre-allocated pixel buffers.
*   **[x] Immediate Chunk Slot Release:** Reduces memory pressure by making input chunks GC-eligible immediately after they are copied to WASM.
*   **[x] Streaming Input Encoder:** Lowers peak memory usage by processing pixel data in chunks rather than requiring the full image to be buffered.
*   **[x] Safe Pixel Allocation:** Validates image dimensions and memory requirements before allocation to prevent crashes and overflows.
*   **[x] FFI Overhead Reduction:** Caches bridge function references to minimize the cost of repeated calls between JavaScript and WASM.
*   **[x] Module Caching:** Stores compiled WASM modules in IndexedDB to skip expensive compilation on subsequent visits.
*   **[x] WASM-Side RGBA Resize:** Accelerates image resizing by performing the operation directly in WASM, avoiding slow GPU-to-CPU readbacks.
*   **[x] Orientation 1 Fast-Path:** Skips unnecessary orientation processing for the common case where no rotation is required.
*   **[x] Thumbnail from Lightbox Buffer:** Speeds up thumbnail generation by downscaling from a smaller lightbox buffer instead of the original full-resolution image.
*   **[x] Unified Look-Parameter Helper:** Consolidates image adjustment logic into a single helper to prevent bugs and ensure consistency.
*   **[x] Pre-Allocated `rgb_to_rgba` Buffer:** Uses a fixed-size buffer for color conversion to improve loop vectorization and performance.
*   **[x] Metadata-Only Parse:** Allows extraction of image metadata without the overhead of decoding pixel data.
*   **[x] Decode Benchmark:** Provides detailed per-stage timing for raw decoding to help isolate and tune performance bottlenecks.
*   **[x] Native `&[u16]` Support for `apply_look`:** Improves performance by allowing direct use of typed arrays for image adjustments, reducing unpacking overhead.
*   **[x] `LookRenderer` (WASM-Resident State):** Keeps image data and adjustment state inside WASM to enable near-instant slider updates without data transfers.
*   **[x] Selective Output Bitmask:** Allows specifying exactly which image outputs (full, lightbox, thumbnail) to generate, skipping unnecessary work.
*   **[x] Shared ORF Pipeline:** Refactors the ORF decoding process into modular, shared functions to eliminate code duplication.

## 2. Advanced Scheduling & Flow Control
*   **[x] Prioritized Task Lanes:** Manages priority tiers (visible, near, background) to ensure the user's current view is always processed first.
*   **[x] Preemption with Pause/Resume:** Allows high-priority tasks to suspend background work mid-decode, resuming it later without losing progress.
*   **[x] Pool Pre-warming:** Spawns worker threads eagerly at startup to eliminate first-image cold-start latency.
*   **[x] Pool Lifecycle Hardening:** Implements robust tracking, O(1) lookups, and generation-based cleanup to ensure worker pool stability.
*   **[x] Deduplication (Fan-out):** Consolidates multiple requests for the same URL into a single decode session to save resources.
*   **[x] Integrated Backpressure:** Uses stream adapters to prevent memory bloat during high-volume data transfers.
*   **[x] Adaptive Drain HWM:** Dynamically tunes worker buffer sizes based on real-time latency to balance throughput and memory usage.
*   **[x] Input Queue Safety Cap:** Enforces strict memory limits on unprocessed input data to prevent unbounded growth.
*   **[x] `QueueOverflow` as First-Class Error Code:** `JxlErrorCode` union now includes `"QueueOverflow"`, distinguishing the 128 MiB input queue cap from generic `"Internal"` errors so callers can detect and handle this case explicitly.
*   **[x] `onPause` Idempotency:** Prevents redundant pause/resume acknowledgments to maintain scheduler synchronization.
*   **[x] Event Iterator Unblocking:** Ensures the decoder event loop correctly terminates upon cancellation to prevent memory leaks.
*   **[x] Coalesced Drain Messages:** Reduces message overhead by batching drain signals while remaining responsive to slow connections.
*   **[x] Post-Push Budget Check:** Ensures decoding time limits are respected even during long-running data ingestion steps.
*   **[x] Terminal-State Wakeup:** Explicitly resolves pending promises when a session ends to prevent stuck workers.
*   **[x] Pre-Transfer Budget Check:** Prevents wasting resources on transferring pixel data if the execution budget has already been exceeded.
*   **[x] `MsgDecodeBudgetExceeded` Region Field:** Budget-exceeded messages for tiled/region decodes now include the `region?: Region` field, making the partial pixel buffer positionable by the consumer. Previously the field was silently dropped.
*   **[x] Telemetry for Final-Only Decodes:** Extends performance tracking to cover decodes that skip progressive passes.
*   **[x] Disposal Promise Sharing:** Ensures all callers wait for full decoder teardown before proceeding, preventing race conditions.
*   **[x] Terminal-Aware Pause Guard:** Improves robustness by correctly ignoring pause requests for sessions that are already finishing.
*   **[x] Single-Emit Metric Guard:** Ensures first-pixel performance metrics are reported exactly once per session.
*   **[x] Pipelined I/O Prefetch:** Overlaps network data delivery with scheduler processing to eliminate idle I/O time.
*   **[x] Stream Abort Hardening:** Provides robust cancellation and cleanup for stream-based operations to prevent resource leaks.
*   **[x] `fromResponse()` Helper:** Simplifies piping fetch responses directly into decode sessions with full backpressure support.
*   **[x] Execution Budgets:** Prevents UI hangs by enforcing strict time limits on each stage of the decoding process.
*   **[x] Cold-Start Message Buffering:** Queues messages arriving during WASM initialization to ensure no commands are lost during worker startup.
*   **[x] WASM Load Retry:** Allows workers to recover from transient WASM loading failures rather than failing all future tasks.
*   **[x] Idempotent Worker Shutdown:** Ensures clean and coordinated worker termination even if shutdown is requested multiple times.
*   **[x] `release_state` Handler Cancellation:** Properly cleans up active session handlers and WASM resources when a session state is released.
*   **[x] Cross-Type Session Guard:** Prevents ID collisions and ensures session uniqueness across different operation types.
*   **[x] Uncaught Error Reporting:** Captures and reports silent worker crashes to the main thread for better observability.
*   **[x] Deterministic Backend Init:** Synchronizes concurrent backend initialization attempts in Node.js to avoid redundant probing.
*   **[x] Zombie-Start Prevention:** Prevents cancelled sessions from starting up late and creating resource-leaking "zombie" handlers.
*   **[x] Race-Safe Push Guards:** Adds safety checks to ensure data isn't pushed to sessions that were closed during asynchronous waits.
*   **[x] Pre-Aborted Signal Handling:** Ensures sessions settle immediately if an abort signal was already triggered before construction.
*   **[x] Three-Way Terminal Helpers:** Centralizes session termination logic to ensure consistent cleanup across all success and error paths.
*   **[x] Encoder Module-Level Error Sets:** Reduces memory allocations by sharing a common set of error codes across all encoder instances.

## 3. Scientific Correctness & Fidelity
*   **[x] Metadata Round-trip:** Ensures byte-exact preservation of ICC profiles, EXIF, and XMP metadata during processing.
*   **[x] High Dynamic Range (HDR):** Provides end-to-end support for 16-bit and 32-bit float pixel formats required for scientific raw data.
*   **[x] Color Management:** First-class support for sRGB, Display-P3, Adobe RGB, and Rec.2020. DNG uses `ForwardMatrix1/2` (preferred) or inverted `ColorMatrix1/2` from TIFF tags via `choose_camera_to_srgb_matrix`; falls back to the generic `CAM_TO_SRGB` constant only when both tags are absent. (`raw-pipeline/src/dng.rs`, `src/lib.rs`)
*   **[x] Alpha Channel Integrity:** Maintains raw pixel values by supporting transparency without forced premultiplication.

## 4. Progressive UX Features
*   **[x] Progressive Decoding:** Enhances user experience by emitting low-resolution previews and refinement passes before the final image is complete.
*   **[x] `MsgDecodeError` Partial Frame Fields:** `MsgDecodeError` now carries `partialPixelStride?: number` and `partialStage?: DecodeStage` for `TruncatedStream` errors, enabling decode-session to construct accurate partial `DecodeFrameEvent`s with correct row stride and stage label.
*   **Region-of-Interest (ROI) Decoding:** Dramatically speeds up viewing large images by decoding only the requested viewport. `PARTIAL` — JS-crop fallback implemented with honest flags (`regionFallback: "full-frame-then-crop"`, `getDecodeGridInfo()` returns `{}`). True bitstream ROI requires tile-grid metadata not yet exposed by libjxl.
*   **[x] Preview-First Encoding:** Biases the encoder to quickly produce a usable first pass for "instant" upload previews.
*   **[x] Sidecar Thumbnails:** Allows for the extraction or generation of small preview images during the main decoding process.
*   **[x] Compression Ratio Feedback:** Provides post-encode statistics to help applications decide whether to keep or discard the result.
*   **[x] Tier-Aware Effort Default:** Automatically tunes encoder effort based on detected hardware capabilities to balance quality and speed.

## 5. Platform & Persistence
*   **[x] Unified Cross-Platform API:** Provides an identical programming interface for both Browser and Node.js environments.
*   **[x] Native Node.js Fallback:** Uses high-speed N-API bindings for server-side processing with a WASM fallback for restricted environments.
*   **[x] Two-Layer Caching:** Combines a fast in-memory LRU cache with persistent storage (OPFS or local filesystem) for durable performance.

## 6. Developer & Debugging Tools
*   **[x] Comprehensive Benchmark UI:** Includes a built-in dashboard for detailed performance testing and comparison across environments.
*   **[x] Hardware Capability Probing:** Detects SIMD, multi-threading, and other advanced features at runtime to optimize execution.
*   **[x] Module Capability Detection:** Caches available bridge functions per module to ensure fallback paths are only used when features are genuinely absent.
*   **[x] Telemetry Hooks:** Provides detailed timing and memory metrics via callbacks for deep performance analysis.
*   **[x] Blur Optimization Benchmark:** A specialized tool for testing and optimizing the performance of separable Gaussian blur implementations.
