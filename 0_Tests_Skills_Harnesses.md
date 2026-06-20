# Tests, Skills & Harnesses — Master Index

Catalogue of every timing test, benchmark, performance harness, and review/optimization
skill available to this project. Use it to pick the right tool, find prior measurements,
and avoid re-deriving things already measured.

## Index

1. [Timing harnesses](#1-timing-harnesses) — flipflop, flipflopdom, bottleneck harness
2. [Rust benches and flip examples](#2-rust-benches-and-flip-examples) — `crates/raw-pipeline/examples/`
3. [Node bench tools](#3-node-bench-tools) — MT speedup, real-image encode, colour-verify
4. [Build scripts](#4-build-scripts) — parallel/MT WASM, MSVC, Docker
5. [Dev and runtime tooling](#5-dev-and-runtime-tooling) — dev-server, launch-browser, workspaces, clean
6. [Review and optimization skills](#6-review-and-optimization-skills) — scannerbot, EpicCodeReview, …
7. [Project-local workflows](#7-project-local-workflows) — comptroller-loop, optimize-codec-times
8. [Methodology and reference docs](#8-methodology-and-reference-docs) — lenses, rejected optimizations
9. [Result artifacts](#9-result-artifacts) — TOON journals, coverage ledgers
10. [Quick reference: which tool?](#10-quick-reference-which-tool)

**Mental model — three layers, one decision flow:**

```
WHERE is it slow?  →  Bottleneck harness (ablation + flame)   → localize the rock
WHAT is the win?   →  flipflop / flipflopdom                  → measure A/B, thermal-safe
IS it broad?       →  scannerbot / EpicCodeReview / workflows → sweep many files, gated
```

Theory first (Amdahl bounds the win, roofline says compute- vs memory-bound — memory-bound
means SIMD/cores won't help), then ablation to confirm the stage is on the critical path,
then flame to pick SIMD-the-code vs faster-API, then flipflop to prove the fix. Fix only
confirmed stages; re-measure end-to-end.

---

## 1. Timing harnesses

### flipflop — interleaved N-way A/B timing (Node/native)
**Skill:** `flipflop` · **Engine:** `flipflop.mjs` (repo root) · **Tests:** `.flipflop/tests/*.mjs`

The workhorse. Compares 2..N implementations ("variants") of the same op. Variants run
**interleaved** (ABCD ABCD…, start-rotated each round) so thermal/system drift hits every
arm equally — this is what makes the `%saved` trustworthy. Feeds a deterministic fractal
corpus at 5 sizes (256/512/1024/2048/4096) or real files via `--inputs`.

- Reports per-input **median warm time**, `%saved` vs baseline, per-flip RSS + CPU temp +
  frequency, optional quality scalar, and a `trust:high/low` verdict (flags throttling /
  high variance).
- **Test contract:** export `name`, `description`, `variants[]` (each `{name, run|cmd,
  baseline?, role?}`). Optional: `setup()`, `corpus()`, `equal(a,b)` lossless guard,
  `quality(out,base)`, `ctx.mark()` for intra-run timing points.
- **Run:** `node --expose-gc flipflop.mjs .flipflop/tests/<name>.mjs --print`
- **Journal:** append-only TOON at `docs/outputs/timing tests/flipflop/flipflopjournal.toon`.
  `trust:low` = do NOT trust `%saved`; box was throttling — re-run cooler.
- **Thermal gotcha (Windows):** real CPU temps need **LibreHardwareMonitor running** (not
  just installed). On desktops where `CurrentClockSpeed == MaxClockSpeed` always, frequency
  is a useless throttle signal — a running LibreHardwareMonitor is the only honest one;
  else thermal is `unknown`, lean on interleave + stdev.

**Utility:** the default oracle for any "did this optimization actually help" question.
Determinism of the fractal corpus means results compare across machines.

### flipflopdom — flipflop inside a real headless Chrome
**Skill:** `flipflopdom` · **Engine:** `flipflopdom.mjs`, `.flipflop/dom-runner.mjs`,
`.flipflop/dom-worker.mjs`

Browser sister to flipflop. Same contract, stats, TOON journal — but runs variants inside a
real Chrome (Playwright/CDP), in the page **or** a Worker, cross-origin-isolated so OPFS /
SharedArrayBuffer / `createImageBitmap` / WASM-in-browser all work. Use when the op needs
the DOM/OPFS/SAB and Node can't reach it.

**Proven wins (in `.flipflop/dom-tests/`):** OPFS `createSyncAccessHandle` ~40–58% faster
than `createWritable`; SAB-share −97%; zero-copy view −99.5%; wasm-decay −82%. Counter-
example: binary manifest **loses** in-browser (−202%; V8 `JSON.stringify` is fast).

### Bottleneck harness — "find the rock in the river"
**Doc:** `.flipflop/BOTTLENECK-HARNESS.md` · **Tools:** `.flipflop/pipeline/ablate.mjs`,
`flameprofile.mjs`

Two complementary tools, both over the **real browser pipeline**. Use together — each
answers what the other can't:

1. **Ablation ("cut the pipe")** — `flipflopdom` + `ablate.mjs`. Describe the pipeline as
   ordered functional **stages**; `makeAblation` emits `full` + one `ablate:<stage>` variant
   each. An ablated stage replays from a memoised output (free) while downstream runs for
   real → `%saved` of `ablate:X` = X's **true critical-path contribution, accounting for
   overlap** (an overlapped slow stage shows ~0%, it's hidden). `full` emits per-stage marks
   = the latency timeline.
   `node flipflopdom.mjs .flipflop/dom-tests/ablate-<name>.mjs --print --sizes 512,1024`
2. **Flame (CDP CPU profiler)** — `flameprofile.mjs`. Runs `action(input,ctx)` N times under
   the CDP `Profiler`, reports **self-time per function** + `(idle)`/`(program)`/`(gc)`,
   writes a `.cpuprofile`. The crucial column: **CPU vs `(idle)`** — high self-time in a
   `run @ …` = CPU-bound (fix with SIMD/better code); time in `(idle)` = I/O-wait (fix the
   *API*, e.g. OPFS sync handles — faster code does nothing).
   `node flameprofile.mjs .flipflop/profiles/<name>.mjs --size 1024 --runs 300`

When the ablation %saved and the flame timeline **agree**, there's no hidden overlap and the
numbers are trustworthy.

**Pipeline fixtures:** `.flipflop/pipeline/cache-paint.mjs` (cold-cache get → SAB copy →
decode-sim → paint), `.flipflop/pipeline/ablate.mjs` (ablation framework). Swap `decode-sim`
for the real JXL worker decode and the same two commands localize the real pipeline.

---

## 2. Rust benches and flip examples

Location: `crates/raw-pipeline/examples/`.

Native-level A/B benches. Run with `cargo run --release --example <name>` (raw-pipeline is
**not** a workspace member — `cd crates/raw-pipeline` first; use
`--no-default-features` where heavy vendored libjxl isn't needed).

### Flipflop A/B examples (scalar vs SIMD / fused vs unfused)
| Example | Measures |
|---|---|
| `perceptual_flipflop.rs` | Perceptual kernel backends (scalar vs SIMD), thermal-corrected 10× |
| `tone_fuse_flipflop.rs` | Tone matrix×saturation fused vs unfused |
| `process_simd_flip.rs` | `process`/`process_16bit` scalar vs SIMD dispatcher |
| `traversal_fusion_flipflop.rs` | Fused frame-stats + RGB histogram single-pass |
| `ssim_moments_avx2_flip.rs` | SSIM moments AVX2 (channel-as-lane) |
| `lut_shoulder_flipflop.rs` / `post_lut_compact_flipflop.rs` / `postlut_cache_flip.rs` | LUT shoulder / compaction / cache paths |
| `preview3d_flip.rs` / `quantize_flip.rs` | 3D preview, quantization paths |
| `frame_stats_flipflop.rs` | JS baseline vs wasm scalar/autovec/hand-SIMD/copy |
| `casabio_encode_flip.rs` | Casa-bio encode path |
| `cr2_fulldecode_flip.rs` / `cr2_reassembly_flip.rs` / `cr2_demosaic_realfile_flip.rs` | CR2 decode/reassembly/demosaic |
| `dng_mhc_interior_flip.rs` / `dng_unpack_flip.rs` | DNG MHC demosaic / unpack |
| `demosaic_bilinear_flip.rs` | Bilinear demosaic |
| `rgb16_pack_flip.rs` / `rgb_to_rgba_flip.rs` | Pixel pack / channel expansion |
| `downscale_general_flip.rs` / `_reciprocal_flip.rs` / `_snap_flip.rs` | Downscale variants (results: `downscale_reciprocal_flip_RESULTS.md`) |

### Standard benches (isolated subsystem timing)
| Example | Measures |
|---|---|
| `cr2_bench.rs` | CR2 decode 10-run flip (parse/LJPEG/crop), real files |
| `tone_simd_bench.rs` / `tone-bench.rs` / `tone_fused_bench.rs` | `apply_tone_math` scalar vs SIMD, 20MP |
| `comparer-bench.rs` | PSNR+moments 2-pass vs fused 1-pass (memory-bound) |
| `demosaic-bench.rs` | Generic Bayer MHC vs RGGB-specific |
| `tile-decode-bench.rs` | Tile decoding |
| `jxl_encode_cpp_bench.rs` | JXL C++ bridge encode |

### Memory-bandwidth benches
`alpha_scan_membench.rs`, `cr2_finalize_membench.rs`, `perc_construct_membench.rs`,
`planar_demosaic_membench.rs`, `perc_butteraugli_bench.rs` — confirm a stage is
memory-bound (→ SIMD/cores won't help) before chasing it.

### Profiling / diagnostic examples
`pipeline_profile.rs` (full pipeline CPU profile), `wasm_memory_audit.rs` (heap alloc
audit), `tonemap_subspans.rs`, plus per-format probes (`cr2_render_probe`, `cr2_slice_scan`,
`orf_black_sweep`, `orf_wb_probe`, `synthetic_calib`).

**WASM bench crate:** `crates/raw-pipeline/bench-wasm/` (perceptual-bench-wasm, wasm target).

---

## 3. Node bench tools

`tools/*.mjs` — real images, real browser.

| Tool | Measures |
|---|---|
| `tools/tone-mt-bench.mjs` | Tone wasm **multithread speedup** — 24MP synthetic, page ST vs MT (`?threads=1` vs cores). Measured 3.84×@24MP / 4.03×@12MP |
| `tools/decode-mt-bench.mjs` | Real RAW decode MT — serial decompress + parallel demosaic + parallel tone, end-to-end ST vs MT with Amdahl cap |
| `tools/encode-mt-bench.mjs` | JXL encode MT — libjxl simd vs simd-mt tiers in COOP/COEP browser |
| `tools/encode-real-bench.mjs` | Real RAW → RGBA (shipped pkg) → JXL encode at forced tier/effort/distance |
| `tools/demosaic-flipflop.mjs` | Demosaic SIMD flip (wasm128 in Node), correctness pin + A/B, min+median |
| `tools/frame-stats-flipflop.mjs` | Frame telemetry JS vs wasm variants, true alternation |
| `tools/colour-verify.mjs` | **Quality, not timing** — real file → lightbox pipeline in headless Chromium → render + screenshot; catches garbage decodes / WB errors |
| `tools/jxtc-diagnostic-report.mjs` / `tools/jxtc-real-report.mjs` | JXTC vs full-decode boundary cost (joins flipflop journals + per-crop payback) |
| `tools/webgpu-probe.mjs` | WebGPU feasibility (real GPU vs SwiftShader, compute parity). NOTE: WebGPU dead on dev box |

---

## 4. Build scripts

| Script | Purpose |
|---|---|
| `build-parallel-wasm.ps1` | Perf build: nightly + SIMD features (`parallel-wasm`, `c-perceptual`), AVX2 bridges, wasm-opt. Default `c-perceptual` link-fails wasm → pass `-Features parallel-wasm` |
| `tools/build-mt-wasm.sh` | Threaded rayon/wasm-bindgen-rayon build → `pkg-mt/` (atomics+bulk-memory+mutable-globals, `--shared-memory --import-memory`, `-Z build-std`). wasm-pack can't do `-Z`; manual cargo+nightly+wasm-bindgen |
| `build-msvc.ps1` | Thin MSVC+LLVM toolchain wrapper, forwards args to cargo (`.\build-msvc.ps1 check`) |
| `build-with-docker.ps1` | Docker-based build wrapper |

WASM rebuild prerequisites and gotchas: see `CLAUDE.md` → Build Notes.

---

## 5. Dev and runtime tooling

Scripts to run the app, serve it with the right headers, drive a browser, and keep the repo
healthy. Not timing tests — but the plumbing the timing/quality tools depend on.

| Tool | Purpose |
|---|---|
| `tools/dev-server.mjs` | Minimal static dev server for `web/` with **COOP/COEP headers** (required for SharedArrayBuffer = WASM threads). Serves from repo root so importmap `../packages/...` resolves; redirects `/` → `/web/index.html`. `node tools/dev-server.mjs [port=8080] [root=.]` |
| `tools/launch-browser.mjs` | Resolves a local Chrome/Chromium (incl. Playwright headless-shell), launches with a temp profile. Shared browser-spawn helper for the visual/verify tools; Windows file-lock retry on cleanup |
| `tools/run-workspaces.mjs` | Runs `build` / `typecheck` / `test` across all `@casabio/*` workspaces in dependency order. `node tools/run-workspaces.mjs <build\|typecheck\|test>` |
| `tools/pack-test.mjs` | `npm pack` every publishable package into a temp dir, smoke-imports the tarballs (incl. Node worker entry) — catches broken `files`/exports before publish |
| `tools/clean.mjs` | Removes build cruft (`node_modules`, `target`, `tmp`, `pkg`, …) repo-wide |
| `tools/colour-baseline.mjs` | Establishes a colour-parity baseline (mean RGB + luma variance) for demosaic-refactor validation; serves `pkg/` to Chromium. `node tools/colour-baseline.mjs --raw <path>`. Pairs with `tools/colour-verify.mjs` (§3) |
| `tools/predator-paint-visual-smoke.mjs` | Playwright visual smoke for progressive paint (`jxl-progressive-paint.html`) — screenshots paint evidence (baseline + Sneyers) for regression eyeballing |
| `tools/ecosystem-map-gen.mjs` | Regenerates the graph in `docs/ecosystem-map.html` from `docs/ecosystem-map.model.json` reconciled vs live Rust; `--check` exits 1 on STALE/UNMAPPED/ORPHAN drift (CI) |

---

## 6. Review and optimization skills

Invoke via the `Skill` tool. These orchestrate the harnesses above across many files.

| Skill | What it does | When |
|---|---|---|
| **scannerbot** | Self-contained sweeper — visits files, optimizes each through `docs/ScannerBotLenses.md` taxonomy, measures with flipflop (R0–R4 acceptance gate: prior-art immune system, REAL tests, parity, flipflop ≥5%, Amdahl attribution), writes dated `docs/ScannerBot-*.md` ledger. Modes: inline / agents / workflow | Unattended optimization sweep over a path |
| **EpicCodeReview** | Multi-agent review+fix loop on **current code** (not diff). 5 finders (correctness, hacker, structure, architecture, vision) × ~20 lenses + CodeQL → dedupe → verify → plan → fix (perf fixes flipflop-measured) → loop. Workalone or modelswitching | Overnight/unattended review+fix, "iterate through codebase" |
| **SpeedCodeReview** | EpicCodeReview lenses applied **inline** (no agents, same session model). Lighter, focused | Review+fix named files/functions inline |
| **EpicDesignReview** | 5-agent UX/UI/frontend review (WCAG 2.1 AA, design critique, design-system audit, UX copy, frontend craft) → verify → report | Frontend/accessibility audit |
| **EpicSystemsReview** | 7-layer platform review (business, architecture, reliability, perf, security, dev-ex, data) → ADR drafts | Platform/architecture/reliability audit |
| **optimize-codec-times** | Reusable perf tournament for JXL enc/dec + RAW decode; 6-lens sweep, flipflop oracle, pixel-exact/Butteraugli gate | Cut codec times, quality-safe |
| **comptroller-loop** | Supervised one-file loop — Haiku workers find ≤3 issues → Sonnet comptroller validates → fix in worktree | Observable bit-by-bit pass on a single small file |
| **deep-research** | Fan-out web search → fetch → adversarially verify → cited report | Multi-source research |

---

## 7. Project-local workflows

| Workflow | Purpose | Status |
|---|---|---|
| `comptroller-loop.js` | Supervised one-file optimization (Haiku find → Sonnet validate → fix in worktree + `fix/<file>` branch → report) | Verified working (`docs/HANDOFF-optimize-comptroller-2026-06-18.md`) |
| `optimize-codec-times.js` | Tournament lens-sweeper (6 lenses: aerial, seam, architecture, operational, mathematical, tactical). Folder/single-file modes; findonly read-only mode; coverage ledger; flipflop-gated C++ | Built, probe-verified, awaiting full end-to-end run |

**Workflow gotchas** (`HANDOFF-optimize-comptroller-2026-06-18.md`): `args` arrives as a JSON
string; launch by `scriptPath` not `{name}`; probe first; no concurrent perf runs (thermal);
worktree isolation.

---

## 8. Methodology and reference docs

| Doc | Contents |
|---|---|
| `.flipflop/BOTTLENECK-HARNESS.md` | Ablation + flame strategy; %saved interpretation; CPU-vs-idle localization |
| `docs/ScannerBotLenses.md` | Lens taxonomy — Categories A (strategic) B (structural) C (subsystem/algo) D (kernel/memory) E (code/math) F (safety) + overlays V (verify) X (anti-lenses); highest yield in C/D/E; cites empirical wins by SHA |
| `docs/optimize-codec-times-usage.md` | Workflow usage — targets, lens selection, layer filtering, Butteraugli thresholds |
| `docs/rejected optimizations.md` (+ `_backup`) | Formal rejection log with evidence. **Check before proposing** — many "obvious" wins already disproven. Mirror summary in `CLAUDE.md` → "Recurring False Claims" |
| `CLAUDE.md` | Architecture layer map, layer invariants, behavioral contracts, build notes |
| `benchmark/README.md` | Benchmark methodology overview; `benchmark/optimize/` helpers (gate, testgen, coverage), 24 tests green |
| `docs/BENCHMARK_AND_TESTING_HANDOFF - DONE.md` | Historical (May 2026) benchmark-surface taxonomy + production-scope assessment |
| `docs/superpowers/specs/` + `plans/` | 25+ dated specs/plans (progressive JXL, perceptual SIMD, BSD codec, flipflop, optimize-codec-times) |

---

## 9. Result artifacts

- `docs/outputs/timing tests/flipflop/flipflopjournal.toon` — **master** flipflop journal,
  merged across all runs. Append-only TOON; records split on `=== ` lines; `summary` =
  per-input medians + `%saved` + quality + trust; `flips` = raw per-flip evidence.
- `docs/outputs/timing tests/*.toon` — 100+ dated per-run journals (from 2026-06-06).
- `benchmark/optimize/.flipflop/*.toon` — codec parameter-sweep journals (qprog, modular,
  EPF/Gaborish, photon RGB8).
- `benchmark/optimize/.flipflop/tests/*.mjs` — 50+ libjxl encode parameter variants
  (effort, distance, modular flavors, progressive modes, brotli effort).
- `docs/outputs/optimize/` — coverage ledger + revert manifests for workflow runs.

---

## 10. Quick reference: which tool?

- **"Is this code change faster?"** → write a `.flipflop/tests/<name>.mjs`, run flipflop.
  Add `equal()` for a lossless guard. Check `trust:high`.
- **"…but it needs OPFS/SAB/createImageBitmap/WASM-in-browser?"** → flipflopdom.
- **"Where is the pipeline slow?"** → ablation (`ablate.mjs`). **"What kind of slow?"** →
  flame (`flameprofile.mjs`). Read together.
- **"Native Rust kernel A/B?"** → `crates/raw-pipeline/examples/*_flip.rs`.
- **"Does multithreading help on a real image?"** → `tools/{tone,decode,encode}-mt-bench.mjs`.
- **"Did the colour/decode actually render right?"** → `tools/colour-verify.mjs` (visual,
  mandatory — mean-RGB parity ≠ correct).
- **"Sweep a whole dir for wins, unattended?"** → scannerbot (perf) / EpicCodeReview
  (correctness) / optimize-codec-times (codec, quality-gated).
- **Before proposing any optimization** → grep `docs/rejected optimizations.md` and
  `CLAUDE.md` "Recurring False Claims". Memory-bound stages (see `*_membench.rs`) won't
  benefit from SIMD/cores — confirm with theory first.
