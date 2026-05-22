# Overview and features of the CasaWASM JXL wrapper

## Overview
The CasaWASM JXL wrapper is a production-grade, high-performance JPEG XL (JXL) codec suite designed for scientific and consumer imaging. It provides a unified TypeScript API that bridges the gap between high-performance native execution and WebAssembly. Developed for the Casabio biodiversity platform, it prioritizes **scientific fidelity** (preserving 16-bit depth, ICC profiles, and EXIF/XMP metadata) and **progressive performance** (showing pixels immediately while a large raw image continues to decode).

It uniquely employs an advanced **preemptive scheduler** that manages a worker pool to ensure that high-priority "visible" images always take precedence over background prefetching, significantly reducing perceived latency on image-heavy gallery surfaces.

---

## Feature Set

### 1. High-Performance Build Architecture
*   **Multi-Tiered WASM Matrix:** Automatically selects the fastest build for the user's environment:
    *   **Relaxed SIMD + MT:** Leverages modern Chrome/Firefox features for maximum throughput.
    *   **SIMD + MT:** Primary path for Safari and stable threaded environments.
    *   **SIMD & Scalar:** Fallbacks for restricted or non-cross-origin-isolated contexts.
*   **PGO (Profile-Guided Optimization):** Optimized WASM artifacts based on real-world training data from the Casabio image corpus.
*   **Zero-Copy WASM Writes:** Both the encoder and the fallback one-shot decoder write chunk data directly into the WASM heap (`HEAPU8.set` into a pre-allocated region) rather than creating an intermediate JS `Uint8Array` via `concatBytes`, eliminating one full-image allocation and copy per operation.
*   **FFI Overhead Reduction:** Bridge function references are cached once per decode session, avoiding repeated property lookups on the WASM module object at the per-chunk hot path.
*   **Module Caching:** Compiled WASM modules are cached in IndexedDB, eliminating re-compilation time on repeat visits.

### 2. Advanced Scheduling & Flow Control
*   **Prioritized Task Lanes:** Three priority tiers—`visible`, `near`, and `background`—ensure the user's current view is always processed first.
*   **Preemption & Re-queuing:** A "visible" task can interrupt and preempt a "background" task, which is then gracefully re-queued.
*   **Deduplication (Fan-out):** Multiple requests for the same source URL are consolidated into a single decode session to save CPU and memory.
*   **Integrated Backpressure:** Uses WHATWG/Node stream adapters to prevent memory bloat during massive transfers.
*   **Pipelined I/O Prefetch:** `fromReadableStream` in `jxl-stream` prefetches the next network chunk immediately after each chunk arrives (before awaiting `session.push`), so network delivery of chunk N+1 overlaps with scheduler backpressure resolution on chunk N. Eliminates idle I/O time during push-wait on bandwidth-constrained connections.
*   **Execution Budgets:** Stage-based time budgets prevent long-running decodes from hanging the worker or UI.

### 3. Scientific Correctness & Fidelity
*   **Metadata Round-trip:** Byte-exact preservation of **ICC profiles**, **EXIF**, and **XMP** metadata.
*   **High Dynamic Range (HDR):** End-to-end support for 16-bit and 32-bit float pixel formats, essential for scientific raw data.
*   **Color Management:** First-class support for sRGB, Display-P3, Adobe RGB, and Rec.2020.
*   **Alpha Channel Integrity:** Support for transparency without forced premultiplication, maintaining raw pixel values.

### 4. Progressive UX Features
*   **Progressive Decoding:** Emits low-resolution **DC previews** and intermediate refinement passes before the final image is complete.
*   **Region-of-Interest (ROI) Decoding:** Decodes only the requested viewport of a large raw (e.g., 100MP+), dramatically speeding up gallery views.
*   **Preview-First Encoding:** Biases the encoder to produce a usable "first pass" quickly, enabling "instant" upload previews on slow connections.
*   **Sidecar Thumbnails:** Integrated support for extracting or generating small sidecar previews during the main decode loop.
*   **Compression Ratio Feedback:** After encode completes, `encoder.getStats()` returns `{ originalBytes, compressedBytes, ratio }` (ratio = compressed / raw pixels), letting callers decide whether to keep the JXL, fall back to the original, or adjust quality before storing.
*   **Tier-Aware Effort Default:** `recommendedEffort()` maps the detected WASM tier (scalar / simd / simd-mt / relaxed-simd-mt) to a sensible encoder effort level (4 → 7), preventing scalar workers from stalling while allowing multi-threaded builds to use full quality.

### 5. Platform & Persistence
*   **Unified Cross-Platform API:** Identical interface for Browser and Node.js environments.
*   **Native Node.js Fallback:** High-speed N-API bindings for server-side processing, with a WASM fallback for restricted cloud environments.
*   **Two-Layer Caching:**
    *   **Hot In-Memory LRU:** Instant retrieval of recently viewed frames.
    *   **Persistent Cache:** Uses **OPFS (Origin Private File System)** in browsers and the local filesystem in Node for durable storage.

### 6. Developer & Debugging Tools
*   **Comprehensive Benchmark UI:** A built-in dashboard for testing throughput across different WASM tiers and file types.
*   **Capability Probing:** A specialized runtime probe (`jxl-capabilities`) that detects SIMD, Threads, and Relaxed SIMD support.
*   **Telemetry Hooks:** `onMetric` callbacks provide detailed timing for "time to header," "time to first pixel," and peak memory usage.

---

## Comparison with Other JXL Wrappers

| Feature | **CasaWASM JXL** | **@jsquash/jxl** | **sharp** (Node) | **jxl-rs-polyfill** |
| :--- | :--- | :--- | :--- | :--- |
| **Environments** | Browser & Node.js | Browser & Edge | Node.js Only | Browser Only |
| **Progressive Support** | **Full (DC/Passes)** | Limited (One-shot) | None (Full-frame) | Limited |
| **ROI / Region Decode** | **Yes (Tile-aware)** | No | No | No |
| **WASM Optimization** | **Multi-tier + Relaxed SIMD** | Single-tier SIMD | N/A (Native) | Single-tier |
| **Scheduler** | **Preemptive / Priority** | Basic Queue | Internal (libvips) | None |
| **Metadata Fidelity** | **Scientific (EXIF/XMP/ICC)** | Partial | Good | Minimal |
| **Streaming** | Full (Backpressure) | Minimal | Native Streams | No |
| **Caching Layer** | **Integrated (OPFS/fs)** | External Only | External Only | No |

### Key Differentiators
1. **The Scheduler:** Unlike other wrappers that treat every decode as an isolated task, CasaWASM understands UI context. It can kill a background prefetch to immediately start decoding an image the user just clicked on.
2. **Region-of-Interest (ROI):** CasaWASM is optimized for multi-hundred-megapixel raws. It can decode just a "viewport" region, whereas most other WASM wrappers must decode the entire massive frame into memory first.
3. **WASM Tiers:** By shipping four distinct WASM builds (including a "Relaxed SIMD" tier), it extracts ~20-30% more performance on modern browsers than standard SIMD builds.
4. **Unified API:** Developers can write their imaging logic once and have it run with native speed on the server (N-API) and optimized WASM speed in the browser.

---

## Suggested and Deferred Implementations

### Bun vs. Node.js for Production
While the current architecture is built for Node.js (via N-API) and Browser (WASM), Bun represents a significant opportunity for performance optimization, particularly in the server-side ingestion pipeline.

| Metric | Bun (JSC Engine) | Node.js (V8 Engine) |
| :--- | :--- | :--- |
| **WASM Startup (Cold Start)** | **8–15 ms** | 60–120 ms |
| **Native Overhead** | **Low (via `bun:ffi`)** | Moderate (via N-API) |
| **Peak Throughput** | High | **Very High (TurboFan)** |
| **Memory Management** | **Aggressive/Efficient** | Moderate |
| **Startup Overhead** | **Minimal** | Higher |

#### Virtues of Bun Implementation
1. **Cold Start Performance:** Bun's JavaScriptCore engine initializes WASM modules up to 10x faster than Node's V8. This is ideal for CLI tools and ephemeral serverless environments.
2. **Low-Level FFI:** Migrating from N-API to `bun:ffi` could reduce the overhead of calling into `libjxl` by 2-6x, as Bun's FFI is designed for near-zero-latency C-interop.
3. **Integrated Tooling:** Bun's built-in test runner and dev server (already used in this project) drastically reduce the developer feedback loop compared to Node-based alternatives.

#### Reasons for Deferral (Current Status)
*   **Peak Throughput Stability:** For long-running, CPU-intensive JXL decodes, Node's V8 "TurboFan" compiler is currently more mature and can reach slightly higher peak throughput than Bun.
*   **Worker Thread Maturity:** Node's implementation of `node:worker_threads` remains the benchmark for stable, multi-threaded C-bridge applications at high concurrency.
*   **Ecosystem Readiness:** The project's existing `jxl-native` package is built on N-API to ensure maximum compatibility with existing Node infrastructure.

**Recommendation:** Continue using Bun for the development server, testing, and utility scripts (`bun serve.ts`, `bun test`). Transition the production server path to Bun if cold-start latency or N-API overhead becomes a primary bottleneck in high-frequency ingestion workloads.

