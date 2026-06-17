Core implementations

Rust (the WASM/native accelerated path — PerceptualComparer → PerceptualCore):
- crates/raw-pipeline/src/perceptual/mod.rs — engine; computes all three in one shared pass
- crates/raw-pipeline/src/perceptual/psnr.rs
- crates/raw-pipeline/src/perceptual/ssim.rs
- crates/raw-pipeline/src/perceptual/butteraugli.rs
- crates/raw-pipeline/src/perceptual/xyb.rs — RGB→XYB colour transform
- crates/raw-pipeline/src/perceptual/blur.rs — Butteraugli blur stage
- crates/raw-pipeline/src/perceptual/simd/mod.rs — SIMD dispatch
- crates/raw-pipeline/src/perceptual/simd/avx2.rs — server AVX2 (256-bit)
- crates/raw-pipeline/src/perceptual/simd/avx512.rs — AVX-512 route
- crates/raw-pipeline/src/perceptual/simd/wasm.rs — wasm128 SIMD (browser)
- src/lib.rs — PerceptualComparer wasm-bindgen wrapper (new/all/input_ptr/all_at)

JS (fallback / legacy path):
- web/jxl-progressive-quality.js — computePsnrVsFinal, computeSsimVsFinal, computeChannelMoments
- web/jxl-butteraugli.js — pixelsToXyb, computeButteraugliVsFinal, createButteraugliComparer, computeButteraugliApproxVsFinal

Orchestrator

- web/jxl-frame-stats-worker.js — handleChartRequest: picks wasm PerceptualComparer vs JS, runs per-pass metrics

Consumers (call the metrics)

- web/jxl-single-progressive.js
- web/jxl-progressive-paint.js
- web/jxl-progressive-byte-metrics.js

Tests / benchmarks

- web/jxl-progressive-quality.test.js
- test-metrics-performance.mjs, benchmark/test-metrics-performance.mjs
- benchmark/metrics-flipflop.mjs, benchmark/metrics-micro-bench.mjs, benchmark/perceptual-wasm-parity.mjs, benchmark/streaming-ssim-benchmark.mjs, benchmark/butteraugli-smoke-test.mjs, benchmark/quality-search-heuristic-ab.mjs

Generated (don't edit)

- pkg/, web/pkg/, pkg-bench/raw_converter_wasm.js; packages/jxl-wasm/dist/facade.js

Key: Rust path already has AVX2/AVX-512/wasm SIMD. The ~554 ms cost I flagged earlier is when the worker falls back to the JS jxl-progressive-quality.js / jxl-butteraugli.js instead of the wasm PerceptualComparer — that fallback (or any consumer calling JS directly) is the real lever, much bigger than frame-stats.