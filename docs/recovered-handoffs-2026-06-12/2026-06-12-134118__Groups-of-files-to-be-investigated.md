  Group 1: Saliency-Aware Progressive Stream Scheduling (packages/jxl-progressive)
  These files represent the core logic of the progressive chunk delivery network. They determine how raw incoming bytes are segmented, prioritized, and cached, and
  apply visual saliency (human visual region-of-interest) algorithms to render structural detail first.
   1. packages/jxl-progressive/src/progressive-stream.ts — Manages progressive byte chunk parsing and assembly.
   2. packages/jxl-progressive/src/progressive-scheduler.ts — Orchestrates stream-to-worker dispatching based on priority.
   3. packages/jxl-progressive/src/saliency-policy.ts — Implements early saliency bounding-box calculations for progressive visual weight.
   4. packages/jxl-progressive/src/progressive-manifest.ts — Parses and serves progressive metadata headers.
   5. packages/jxl-progressive/src/progressive-cache.ts — Caches intermediate progressive frame data to avoid decoding from byte-0 on subsequent sweeps.

---

  Group 2: Multi-Runtime Fallback Session Contexts (packages/jxl-session)
  These files form the context layer that clients instantiate. They bind the underlying schedulers, handle runtime capabilities (e.g., SIMD, multithreading), and
  manage fallback routing between Multi-Threaded (MT) and Single-Threaded (ST) workers during high contention.
   1. packages/jxl-session/src/browser.ts — Browser-specific context entry point (isolates browser-only bindings).
   2. packages/jxl-session/src/context.ts — Node-specific context entry point (isolates node-only bindings).
   3. packages/jxl-session/src/context-base.ts — The shared context class encapsulating capabilities, initialization, and validation.
   4. packages/jxl-session/src/tier-routing.ts — Fallback logic that manages grace windows and switches users to ST under high MT thread pressure.
   5. packages/jxl-session/src/event-stream.ts — The reactive event channel transmitting decode markers and performance metrics back to the UI.

---

  Group 3: Native RAW Decode Engine (crates/raw-pipeline)
  The low-level rust files that form the ingestion engine. They decompress, parse EXIF metadata, and demosaic proprietary camera raw formats (DNG, CR2, etc.) into
  linear RGB16/RGBA frames prior to feeding them into the JPEG XL encoder.
   1. crates/raw-pipeline/src/decompress.rs — Coordinates raw sensor decompression routines.
   2. crates/raw-pipeline/src/demosaic.rs — Executes Bayer pattern demosaicing algorithms (AHD, bilinear, etc.).
   3. crates/raw-pipeline/src/dng.rs — Parses Adobe DNG metadata structure and tags.
   4. crates/raw-pipeline/src/exif.rs — Extracts detailed shooting/maker-note metadata.
   5. crates/raw-pipeline/src/ljpeg.rs — Decodes lossless JPEG streams embedded inside older camera RAW files.

---

  Group 4: High-Performance Pyramid Tiled Ingestion (packages/pyramid-ingest)
  This cluster manages the multi-threaded offline ingestion pipeline that compiles massive gigapixel files into multi-level, megatexture-tiled pyramids.
   1. packages/pyramid-ingest/src/ingest.ts — The orchestration pipeline compiling full-res sensor data into multi-level ladders.
   2. packages/pyramid-ingest/src/ingest-worker.ts — Coordinates concurrent CPU threads performing tiling and downsampling work.
   3. packages/pyramid-ingest/src/raw-backend.ts — Bridges native rust raw pipeline decoders into the ingestion harness.
   4. packages/pyramid-ingest/src/manifest.ts — Formulates the hierarchical JSON mapping files (e.g., linking level indices, sizes, and convergedByteEnd).
   5. packages/pyramid-ingest/src/schema.ts — Declares the validation schemas (Zod) ensuring manifest integrity.

---

  Group 5: Frontend Progressive Gallery & Lightbox Orchestrators (web/)
  The frontend controller layer that implements user-facing interactions. They synchronize multiple concurrent decoding streams, throttle network bandwidth
  simulations, and manage priority shifts when zooming/panning.
   1. web/jxl-progressive-session.js — Client-side wrapper coordinating progressive scheduler sessions.
   2. web/jxl-progressive-gallery-coordinator.js — Controls resource limits across a grid of rendering frames to avoid main-thread lockups.
   3. web/jxl-progressive-gallery-frame.js — Handles rAF-coalesced draw cycles and telemetry indicators for a single gallery cell.
   4. web/jxl-progressive-gallery-lightbox.js — Coordinates high-resolution visual progressive overlays for the viewer/lightbox window.
   5. web/jxl-progressive-policy.js — Configures the client-side speed-vs-quality trade-offs based on user zoom state and network throughput.
▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
 > Next ten batches
 > ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
 > ✦ Here are the next 10 logical architectural clusters of unassessed and unoptimized files, each grouped into sets of up to 5 files based on their precise roles and
 > structural dependencies in the pipeline:

---

  Group 6: LRU Caching & Memory Lifecycles (packages/jxl-cache)
  This cluster manages the client-side pixel-buffer caching logic. It handles the Least Recently Used (LRU) evictions and provides platform-specific adapters to
  prevent garbage collection (GC) thrashing in both the browser and Node environments.
   1. packages/jxl-cache/src/lru.ts — The core LRU cache state machine.
   2. packages/jxl-cache/src/browser.ts — Browser-specific memory allocations and Canvas cache bindings.
   3. packages/jxl-cache/src/node.ts — Node-specific Buffer recycling and native memory management.
   4. packages/jxl-cache/src/index.ts — Unified cache package entry point.
   5. packages/jxl-session/src/util.ts — Low-level buffer conversion and hardware-concurrency helpers.

---

  Group 7: Megatexture Viewport Selection (packages/jxl-pyramid)
  This group resolves the specific tile/resolution requirements for the megatexture rendering pipeline. It translates user pan/zoom coordinates and device pixel
  ratios into optimal pyramid levels and layout grids.
   1. packages/jxl-pyramid/src/choose-level.ts — Heuristics sorting and matching levels to target viewport dimensions.
   2. packages/jxl-pyramid/src/grid-layout.ts — Computes 2D grid alignments and stitching boundaries for visible tiles.
   3. packages/jxl-pyramid/src/plan.ts — Formulates sequential decode steps to retrieve tiles with minimum overlap overhead.
   4. packages/jxl-pyramid/src/worker-protocol.ts — Explicit types and message channels communicating tile tasks to background threads.
   5. packages/jxl-pyramid/src/index.ts — Unified pyramid package entry point.

---

  Group 8: Partial Stream Fetching & Core WASM Loaders (packages/jxl-stream & jxl-wasm)
  This cluster links the networking layers to the raw WebAssembly loading routines, managing partial binary range fetches and feeding the streamed segments
  directly into the low-level FFI decoders.
   1. packages/jxl-stream/src/browser.ts — Stream provider utilizing standard browser Fetch and ReadableStreams.
   2. packages/jxl-stream/src/node.ts — Stream provider utilizing Node FS ReadStreams and HTTP agents.
   3. packages/jxl-stream/src/index.ts — Unified stream package entry point.
   4. packages/jxl-wasm/src/loader.ts — Dynamically compiles and instantiates multithreaded vs. single-threaded .wasm targets.
   5. packages/jxl-wasm/src/index.ts — Unified WebAssembly FFI package entry point.

---

  Group 9: Ingest Checkpointing, Locking, and State Sharding (packages/pyramid-ingest)
  Highly critical files for cluster execution. They prevent duplicate ingestion work across parallel workers, manage process recovery checkpoints, and split
  high-resolution sensor outputs into shards.
   1. packages/pyramid-ingest/src/checkpoint.ts — Persists pipeline milestones to disk to support seamless resumes on failure.
   2. packages/pyramid-ingest/src/lock.ts — Standard file-locking APIs to prevent cross-process read/write collisions.
   3. packages/pyramid-ingest/src/shard.ts — Breaks massive pixel planes into distinct spatial grids to enable parallel worker threads.
   4. packages/pyramid-ingest/src/hash.ts — Computes block-level hashes to detect and skip redundant tiles.
   5. packages/pyramid-ingest/src/backends.ts — Plumbs concrete storage targets (Local FS, Cloud, or memory caches) for the output files.

---

  Group 10: Ingestion Pipeline Command-Line & Migration Interfaces (packages/pyramid-ingest)
  This cluster forms the administrative interface of the ingestion compiler, handling command-line parsing, database migrations, asset validation, and process
  status reports.
   1. packages/pyramid-ingest/src/cli.ts — Entry point parsing ingest commands, configurations, and profiling parameters.
   2. packages/pyramid-ingest/src/migrate.ts — Manages database schema migrations for multi-generational manifests.
   3. packages/pyramid-ingest/src/validate.ts — Exhaustively verifies output files and JXTC structure prior to shipping.
   4. packages/pyramid-ingest/src/telemetry-tty.ts — Directs real-time terminal progress indicators and CPU utilization statistics.
   5. packages/pyramid-ingest/src/rm.ts — Safely purges intermediate tiles, failed shards, and stale cache directories.

---

  Group 11: Proprietary Sensor Raw & Performance Benchmarks (crates/raw-pipeline & src/bin)
  Low-level Rust handlers focused on reading older raw sensor patterns (Canon CR2) and native CLI benchmarks evaluating memory speeds and core demosaicing
  performance.
   1. crates/raw-pipeline/src/cr2.rs — Custom sensor parsing for Canon CR2 RAW format files.
   2. packages/pyramid-ingest/src/rgb16.ts — TypeScript structures marshalling 16-bit linear RGB arrays to/from the native Rust layer.
   3. src/bin/raw_decode_bench.rs — Benchmarks decoding speeds of multi-format camera raw assets.
   4. src/bin/blur_bench.rs — Evaluates spatial-domain processing operations (e.g., box-blur, downsampling) directly on linear buffers.

---

  Group 12: Visual Saturation & Perceptual Metric Computation (web/)
  The JS profiling files calculating visual accuracy metrics directly on incremental byte slices to determine early-termination points.
   1. web/jxl-progressive-quality.js — Core calculator running PSNR, SSIM, and Delta-E calculations.
   2. web/jxl-progressive-quality.test.js — Unit assertions for quality scaling and visual convergence.
   3. web/jxl-progressive-byte-metrics.js — Formulates progressive quality-vs-byte curves for output files.
   4. web/jxl-progressive-byte-metrics.test.js — Validates the integrity of metric summaries and serialization.
   5. web/jxl-butteraugli.js — Exposes the Emscripten-compiled Butteraugli metric comparisons to the browser frontend.

---

  Group 13: Client-Side Bandwidth & Cutoff Profiling (web/)
  This group runs physical simulations of congested network paths, measuring how partial download blocks affect the visual response curves.
   1. web/jxl-progressive-byte-benchmark.js — Controls the benchmark flow simulating 3G/LTE stream delivery rates.
   2. web/jxl-progressive-byte-benchmark.test.js — Asserts performance timelines and paint intervals across varying bandwidth limits.
   3. web/jxl-byte-cutoff-probe.js — Evaluates how truncating the codestream at specific byte counts affects decoding.
   4. web/jxl-byte-cutoff-probe.test.js — Automated verification of progressive file rendering on early segment truncations.
   5. web/jxl-preset-benchmark.js — Compares Sneyers flag variations against default settings under throttled parameters.

---

  Group 14: Gallery Push Schedulers & Multi-Asset Delivery (web/)
  The browser orchestrators managing lazy loading queues and task dispatch routines across a grid of progressive image frames.
   1. web/jxl-progressive-gallery.js — Tracks scroll triggers and coordinates visible viewport priorities.
   2. web/jxl-progressive-gallery.test.js — Asserts layout triggers and priority shift events on virtual scroll.
   3. web/jxl-progressive-gallery-push.js — Controls resource limits and manages a pool of active fetch ranges to avoid browser connection starvation.
   4. web/jxl-progressive-gallery-push.test.js — Asserts queue limits and fetch cancellation policies under rapid navigation.
   5. web/jxl-progressive-best-preset.js — Dictates preset configurations for optimized progressive sidecar assets.

---

  Group 15: Client-Side Diagnostics, UI Controls, & Orientation Handling (web/)
  This cluster forms the diagnostics harness, handling layout orientation corrections, dashboard reporting overlays, and telemetry workers.
   1. web/jxl-dashboard-ui.js — Renders real-time diagnostic overlays (e.g., fps, paint count, current active workers).
   2. web/jxl-dashboard-controls.test.js — Verification of dashboard user-interaction controls and state routing.
   3. web/jxl-frame-stats-worker.js — Offloads spatial difference calculations from the main thread.
   4. web/jxl-progressive-frame-stats.js — Coordinates statistical tracking across progressive passes.
   5. web/jxl-progressive-frame-stats.test.js — Formally asserts paint durations, pass indices, and frame rates.
