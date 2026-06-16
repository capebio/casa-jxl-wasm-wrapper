  Group 1: Saliency-Aware Progressive Stream Scheduling (packages/jxl-progressive)
  These files represent the core logic of the progressive chunk delivery network. They determine how raw incoming bytes are segmented, prioritized, and cached, and
  apply visual saliency (human visual region-of-interest) algorithms to render structural detail first.
   1. packages/jxl-progressive/src/progressive-stream.ts
   2. packages/jxl-progressive/src/progressive-scheduler.ts
   3. packages/jxl-progressive/src/saliency-policy.ts
   4. packages/jxl-progressive/src/progressive-manifest.ts
   5. packages/jxl-progressive/src/progressive-cache.ts

---

  Group 2: Multi-Runtime Fallback Session Contexts (packages/jxl-session)
  These files form the context layer that clients instantiate. They bind the underlying schedulers, handle runtime capabilities (e.g., SIMD, multithreading), and
  manage fallback routing between Multi-Threaded (MT) and Single-Threaded (ST) workers during high contention.
   1. packages/jxl-session/src/browser.ts
   2. packages/jxl-session/src/context.ts
   3. packages/jxl-session/src/context-base.ts
   4. packages/jxl-session/src/tier-routing.ts
   5. packages/jxl-session/src/event-stream.ts

---

  Group 3: Native RAW Decode Engine (crates/raw-pipeline)
  The low-level rust files that form the ingestion engine. They decompress, parse EXIF metadata, and demosaic proprietary camera raw formats (DNG, CR2, etc.) into
  linear RGB16/RGBA frames prior to feeding them into the JPEG XL encoder.
   1. crates/raw-pipeline/src/decompress.rs
   2. crates/raw-pipeline/src/demosaic.rs
   3. crates/raw-pipeline/src/dng.rs
   4. crates/raw-pipeline/src/exif.rs
   5. crates/raw-pipeline/src/ljpeg.rs

---

  Group 4: High-Performance Pyramid Tiled Ingestion (packages/pyramid-ingest)
  This cluster manages the multi-threaded offline ingestion pipeline that compiles massive gigapixel files into multi-level, megatexture-tiled pyramids.
   1. packages/pyramid-ingest/src/ingest.ts
   2. packages/pyramid-ingest/src/ingest-worker.ts
   3. packages/pyramid-ingest/src/raw-backend.ts
   4. packages/pyramid-ingest/src/manifest.ts
   5. packages/pyramid-ingest/src/schema.ts

---

  Group 5: Frontend Progressive Gallery & Lightbox Orchestrators (web/)
  The frontend controller layer that implements user-facing interactions. They synchronize multiple concurrent decoding streams, throttle network bandwidth
  simulations, and manage priority shifts when zooming/panning.
   1. web/jxl-progressive-session.js
   2. web/jxl-progressive-gallery-coordinator.js
   3. web/jxl-progressive-gallery-frame.js
   4. web/jxl-progressive-gallery-lightbox.js
   5. web/jxl-progressive-policy.js
▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
 > Next ten batches
 > ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
 > ✦ Here are the next 10 logical architectural clusters of unassessed and unoptimized files, each grouped into sets of up to 5 files based on their precise roles and
 > structural dependencies in the pipeline:

---

  Group 6: LRU Caching & Memory Lifecycles (packages/jxl-cache)
  This cluster manages the client-side pixel-buffer caching logic. It handles the Least Recently Used (LRU) evictions and provides platform-specific adapters to
  prevent garbage collection (GC) thrashing in both the browser and Node environments.
   1. packages/jxl-cache/src/lru.ts
   2. packages/jxl-cache/src/browser.ts
   3. packages/jxl-cache/src/node.ts
   4. packages/jxl-cache/src/index.ts
   5. packages/jxl-session/src/util.ts

---

  Group 7: Megatexture Viewport Selection (packages/jxl-pyramid)
  This group resolves the specific tile/resolution requirements for the megatexture rendering pipeline. It translates user pan/zoom coordinates and device pixel
  ratios into optimal pyramid levels and layout grids.
   1. packages/jxl-pyramid/src/choose-level.ts
   2. packages/jxl-pyramid/src/grid-layout.ts
   3. packages/jxl-pyramid/src/plan.ts
   4. packages/jxl-pyramid/src/worker-protocol.ts
   5. packages/jxl-pyramid/src/index.ts

---

  Group 8: Partial Stream Fetching & Core WASM Loaders (packages/jxl-stream & jxl-wasm)
  This cluster links the networking layers to the raw WebAssembly loading routines, managing partial binary range fetches and feeding the streamed segments
  directly into the low-level FFI decoders.
   1. packages/jxl-stream/src/browser.ts
   2. packages/jxl-stream/src/node.ts
   3. packages/jxl-stream/src/index.ts
   4. packages/jxl-wasm/src/loader.ts
   5. packages/jxl-wasm/src/index.ts

---

  Group 9: Ingest Checkpointing, Locking, and State Sharding (packages/pyramid-ingest)
  Highly critical files for cluster execution. They prevent duplicate ingestion work across parallel workers, manage process recovery checkpoints, and split
  high-resolution sensor outputs into shards.
   1. packages/pyramid-ingest/src/checkpoint.ts
   2. packages/pyramid-ingest/src/lock.ts
   3. packages/pyramid-ingest/src/shard.ts
   4. packages/pyramid-ingest/src/hash.ts
   5. packages/pyramid-ingest/src/backends.ts

---

  Group 10: Ingestion Pipeline Command-Line & Migration Interfaces (packages/pyramid-ingest)
  This cluster forms the administrative interface of the ingestion compiler, handling command-line parsing, database migrations, asset validation, and process
  status reports.
   1. packages/pyramid-ingest/src/cli.ts
   2. packages/pyramid-ingest/src/migrate.ts
   3. packages/pyramid-ingest/src/validate.ts
   4. packages/pyramid-ingest/src/telemetry-tty.ts
   5. packages/pyramid-ingest/src/rm.ts

---

  Group 11: Proprietary Sensor Raw & Performance Benchmarks (crates/raw-pipeline & src/bin)
  Low-level Rust handlers focused on reading older raw sensor patterns (Canon CR2) and native CLI benchmarks evaluating memory speeds and core demosaicing
  performance.
   1. crates/raw-pipeline/src/cr2.rs
   2. packages/pyramid-ingest/src/rgb16.ts
   3. src/bin/raw_decode_bench.rs
   4. src/bin/blur_bench.rs

---

  Group 12: Visual Saturation & Perceptual Metric Computation (web/)
  The JS profiling files calculating visual accuracy metrics directly on incremental byte slices to determine early-termination points.
   1. web/jxl-progressive-quality.js
   2. web/jxl-progressive-quality.test.js
   3. web/jxl-progressive-byte-metrics.js
   4. web/jxl-progressive-byte-metrics.test.js
   5. web/jxl-butteraugli.js

---

  Group 13: Client-Side Bandwidth & Cutoff Profiling (web/)
  This group runs physical simulations of congested network paths, measuring how partial download blocks affect the visual response curves.

   1. web/jxl-progressive-byte-benchmark.js
   2. web/jxl-progressive-byte-benchmark.test.js
   3. web/jxl-byte-cutoff-probe.js
   4. web/jxl-byte-cutoff-probe.test.js
   5. web/jxl-preset-benchmark.js

---

  Group 14: Gallery Push Schedulers & Multi-Asset Delivery (web/)
  The browser orchestrators managing lazy loading queues and task dispatch routines across a grid of progressive image frames.
   1. web/jxl-progressive-gallery.js
   2. web/jxl-progressive-gallery.test.js
   3. web/jxl-progressive-gallery-push.js
   4. web/jxl-progressive-gallery-push.test.js
   5. web/jxl-progressive-best-preset.js

---

  Group 15: Client-Side Diagnostics, UI Controls, & Orientation Handling (web/)
  This cluster forms the diagnostics harness, handling layout orientation corrections, dashboard reporting overlays, and telemetry workers.
   1. web/jxl-dashboard-ui.js
   2. web/jxl-dashboard-controls.test.js
   3. web/jxl-frame-stats-worker.js
   4. web/jxl-progressive-frame-stats.js
   5. web/jxl-progressive-frame-stats.test.js
