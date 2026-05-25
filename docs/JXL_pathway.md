# CasaWASM JXL & RAW Conversion Pipeline Pathway

This document maps the end-to-end data flow for decoding RAW/JXL images and encoding them into JXL. It is designed for AI agents to quickly identify the files involved in each stage of the pipeline to target optimizations.

## 1. RAW Image Ingestion & Processing

This pathway processes Olympus ORF or Adobe DNG files, debayers them, applies color correction, and produces an interleaved RGB/RGBA buffer.

*   **Entry Point (Main Thread):** The user or application initiates a RAW conversion.
*   **WASM Boundary / FFI:** `src/lib.rs` (Exported functions: `process_orf`, `process_dng`)
*   **Core Logic:** The `raw_pipeline` Rust crate (external, linked via `Cargo.toml`).
    *   *Decompression:* `raw_pipeline::decompress`
    *   *Demosaicing:* `raw_pipeline::demosaic`
    *   *Color / Tone / Orientation:* `raw_pipeline::pipeline`
*   **Outputs:** Interleaved RGB8/RGBA8 byte buffer (`ProcessResult`), ready to be displayed on a Canvas or passed to the JXL encoder.
*   **Optimization Targets:**
    *   `src/lib.rs`: Explore multi-threading (`wasm-bindgen-rayon`) for `process_dng`/`process_orf` as they are currently single-threaded.
    *   WASM FFI overhead reduction (e.g., zero-copy buffer sharing).

## 2. JXL Image Decoding (Progressive & Streaming)

This pathway handles incoming JXL bitstreams, progressively decoding them into pixel data. It is highly concurrent and preemptive.

*   **Ingestion & Backpressure:** `packages/jxl-stream/src/browser.ts` (`fromReadableStream`, `fromResponse`). Handles network stream reading.
*   **Scheduler & Worker Pool:** `packages/jxl-scheduler/src/scheduler.ts`, `packages/jxl-scheduler/src/pool.ts`. Distributes decode tasks, prioritizes visible images, and manages preemption.
*   **Worker Thread Coordinator:** `packages/jxl-worker-browser/src/worker.ts` (or `packages/jxl-worker-node/src/worker.ts` for Node). Routes messages and manages session lifecycles.
*   **Decode Session Handler:** `packages/jxl-worker-browser/src/decode-handler.ts`. Manages the state machine, enforces adaptive high-water marks (HWM), and pushes chunks to WASM.
*   **WASM Facade (JS):** `packages/jxl-wasm/src/facade.ts`. Handles safe allocation (`expectedPixelBytes`), zero-copy copies to WASM heap (`HEAPU8.set`), and memory lifecycle.
*   **WASM Bridge (C++):** `packages/jxl-wasm/src/bridge.cpp`. The C++ FFI layer. Manages grow-only `realloc` buffers and interfaces with `libjxl`.
*   **Outputs:** Detached `ArrayBuffer` containing RGBA pixels for rendering.
*   **Optimization Targets:**
    *   `packages/jxl-stream/src/browser.ts`: Implement BYOB (`mode: "byob"`) readers to avoid V8 `Uint8Array` allocations.
    *   `packages/jxl-wasm/src/bridge.cpp` & `facade.ts`: Expose WASM heap pointers directly to the stream reader (Zero-copy ingestion).
    *   `decode-handler.ts`: Utilize `SharedArrayBuffer` for zero-transfer pixel delivery if COOP/COEP is enabled.

## 3. JXL Image Encoding

This pathway takes raw pixel data (usually from the RAW conversion step) and encodes it into a JXL bitstream.

*   **Entry Point (Worker):** `packages/jxl-worker-browser/src/encode-handler.ts`. Receives pixel chunks.
*   **WASM Facade (JS):** `packages/jxl-wasm/src/facade.ts`. Streams pixel chunks into WASM via `_jxl_wasm_enc_push_chunk`.
*   **WASM Bridge (C++):** `packages/jxl-wasm/src/bridge.cpp`. Feeds pixels to `libjxl` encoder.
*   **Outputs:** JXL bitstream chunks, emitted back to the main thread.
*   **Optimization Targets:**
    *   `encode-handler.ts`: Streamline pixel chunk handoff.
    *   `packages/jxl-wasm/src/bridge.cpp`: Ensure encoder chunking matches the CPU cache sizes efficiently.
