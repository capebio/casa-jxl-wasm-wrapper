# File Optimization Assessment

This document assesses the optimization level of key files in the CasaWASM JXL & RAW conversion pipeline. Assessment is based on zero-copy patterns, concurrency efficiency, memory management, and use of advanced WASM features.

| File Path | Optimization (1-5) | Key Features / Notes |
| :--- | :---: | :--- |
| `packages/jxl-scheduler/src/scheduler.ts` | 5 | **State of the Art.** Implements background preemption, request deduplication (fan-out), adaptive backpressure HWM based on EMA of latency, and O(1) victim scanning. |
| `packages/jxl-worker-browser/src/decode-handler.ts` | 5 | **Highly Efficient.** Uses EMA-scaled drain thresholds, adaptive high-water marks, and coalesced drain signals to minimize worker-to-main roundtrips. |
| `packages/jxl-wasm/src/facade.ts` | 5 | **Optimized FFI.** Batches queued data into single WASM writes, uses direct HEAPU32 struct reading to avoid multiple FFI calls, and supports WASM-side region cropping. |
| `packages/jxl-cache/src/browser.ts` | 5 | **Modern Persistence.** Leverages OPFS (Origin Private File System) for high-performance binary storage, handles inflight request coalescing, and manages dual-layer LRU (Memory + OPFS). |
| `packages/jxl-stream/src/browser.ts` | 5 | **Pipelined I/O.** Uses `ReadableStream` with a "read-ahead" pattern that pipelines the next chunk's I/O while the current one is being processed by the decoder. |
| `src/lib.rs` | 5 | **Resident State.** The `LookRenderer` pattern keeps pre-tonemapped RGB16 buffers in WASM memory, allowing slider-based edits with zero JS<->WASM pixel transfer overhead. |
| `packages/jxl-core/src/protocol.ts` | 5 | **Zero-Copy Protocol.** Rigorously uses transferable types (`ArrayBuffer`) for all heavy payloads (pixels, chunks, ICC profiles) to ensure ownership transfer without copying. |
| `packages/jxl-session/src/decode-session.ts` | 4 | **Robust Wrapper.** Cleanly integrates the scheduler with `AsyncEventStream`. Solid use of transferables. |
| `web/jxl-progressive-decode.js` | 3 | **Legacy/Compat.** Functional but less "tight" than the package implementations. Uses standard EventListeners and has some logic duplication with the core protocol. |
| `web/jxl-progressive-session.js` | 3 | **Basic Orchestration.** Handles backend selection and source loading but lacks the advanced resource management found in the scheduler. |

### Scoring Rubric:
- **5 (Excellent)**: Uses zero-copy/transferables, handles backpressure, employs adaptive or heuristic-based tuning, and minimizes FFI overhead.
- **4 (Great)**: Proper use of async patterns and transferables, but lacks advanced adaptive logic.
- **3 (Good)**: Functional and correct, but uses standard patterns that may involve redundant copies or higher overhead.
- **2 (Sub-optimal)**: Heavy reliance on copying, blocking I/O, or inefficient data structures.
- **1 (Poor)**: Significant bottlenecks, memory leaks, or lack of concurrency.
