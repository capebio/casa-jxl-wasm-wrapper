# Progressive Byte Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a focused progressive JXL benchmark/lightbox that applies the best reference-library patterns: cjxl-style progressive presets, byte-tier measurement, target-size output, Gobabeb corpus testing, and honest unsupported state for SSIMULACRA2 until a real metric exists.

**Architecture:** Keep reusable policy/metrics in small `web/` modules, then create a new benchmark page instead of expanding the already-large `jxl-progressive.html`. The page uses `/api/random-gobabeb`, the existing RAW WASM pipeline, `@casabio/jxl-wasm` encode/decode, and byte-prefix decode probes to render progressive thumbnails and a larger lightbox.

**Tech Stack:** Bun tests, browser ES modules, RAW WASM (`process_orf`, `downscale_rgb`, `rgb_to_rgba`), `@casabio/jxl-wasm`, existing benchmark CSS conventions.

---

### Task 1: Progressive Preset And Metrics Modules

**Files:**
- Create: `web/jxl-progressive-best-preset.js`
- Create: `web/jxl-progressive-byte-metrics.js`
- Test: `web/jxl-progressive-best-preset.test.js`
- Test: `web/jxl-progressive-byte-metrics.test.js`

- [ ] Write failing tests for cjxl-style preset, target-size dimensions, unsupported SSIMULACRA2 policy, and byte summary fields.
- [ ] Run tests and verify they fail because modules do not exist.
- [ ] Implement modules with minimal exported functions.
- [ ] Run tests and verify pass.

### Task 2: User-Facing Benchmark Page

**Files:**
- Create: `web/jxl-progressive-byte-benchmark.html`
- Create: `web/jxl-progressive-byte-benchmark.js`
- Create: `web/jxl-progressive-byte-benchmark.test.js`
- Modify: `web/test-nav.css` only if link styling requires it; otherwise use existing home-bar links.

- [ ] Write static page tests for import map, controls, Gobabeb endpoint usage, target-size control, SSIMULACRA2 state text, and lightbox wiring.
- [ ] Run tests and verify fail.
- [ ] Implement page and script.
- [ ] Run static tests and module syntax checks.

### Task 3: Integration Verification And Iteration

**Files:**
- Same as Tasks 1-2.

- [ ] Run targeted Bun tests.
- [ ] Run node syntax checks for new modules.
- [ ] Fetch the new page from `localhost:9000` if server is running; otherwise verify static files.
- [ ] If tests or syntax checks fail, improve implementation and repeat.

