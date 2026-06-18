# flipflop — Standardized Flip-Flop Timing Vehicle (Design)

- **Status:** Draft for review
- **Date:** 2026-06-18
- **Author:** David + Claude
- **Skill name:** `flipflop` (sibling, deferred: `flipflopsize`)

## 1. Goal

A reusable, standardized benchmark harness an agent can wrap around **any algorithm** to compare N implementations ("variants") of the same operation. The agent inserts control points on one side (wraps each implementation as a callback or a command); the vehicle feeds a fixed fractal image corpus, runs the implementations **interleaved** (flip-flop / round-robin, `ABCDABCD…`) to cancel thermal and system drift, and emits per-flip timings, per-size aggregates, `%saved` vs a baseline, and system state into a single append-only TOON journal — a running log of every test and every improvement found.

The vehicle exists to produce **trustworthy** numbers. This codebase has repeatedly been bitten by thermal hot-run false regressions (a ~1.5× "all metrics" regression once traced entirely to CPU temperature, not code). Therefore the harness records the thermal/throttle trace per flip and flags any run whose numbers are drift-polluted, rather than reporting a clean-looking lie.

## 2. Non-goals (v1)

- **Output size / compression-ratio measurement.** Deferred to a future sibling skill `flipflopsize`. v1 measures **time** (and memory). Size requires a different aim and corpus discipline.
- **Native Rust criterion bridge.** Native/Rust kernels are reached via external-command mode, not an in-process Rust timer. (Approach C, deferred.)
- **Cross-machine result comparison.** The corpus is deterministic (so inputs match across machines), but timings are only compared **within a journal / machine**. No normalization across hardware.
- **Single-variant regression-vs-history mode.** v1 requires ≥2 variants (the flip-flop needs something to flop against). History comparison is a possible v1.1.

## 3. Constraints

- **Zero npm dependencies, zero build step.** Pure Node `.mjs` + PowerShell. Matches the repo's existing `.mjs` benchmark culture (`StandardMultifileTest.mjs`, `run-10-benchmarks.mjs`, `benchmark/fractal-scale-curves.mjs`).
- **Windows host.** Metrics via WMI / `Get-Counter` / `Get-CimInstance`. CPU temperature is unreliable without helper software → best-effort with graceful `n/a`.
- **Portable across projects.** The engine is invokable from any repo. Canonical engine source lives in the skill dir; a working copy lives in the target repo root.
- **Timing path must stay clean.** No WMI / spawn / heavy work inside a timed region. Expensive metrics come from a background sampler joined post-hoc by timestamp.

## 4. Users & usage

The user is an agent. When the agent invokes the `flipflop` skill, `SKILL.md` explains usage and every argument, then the agent:

1. Ensures the engine is present in repo root (copies from the skill's `engine/` dir if `flipflop.mjs` is missing).
2. Writes a small **test-definition file** (the only thing the agent authors — see §6).
3. Runs `node flipflop.mjs <test-file> [options]` (or `node --expose-gc flipflop.mjs …` for cleaner memory deltas).
4. Reads the appended TOON journal entry (and optional stdout summary).

`SKILL.md` content (so the agent is self-sufficient): one-paragraph purpose; the test-file contract with a copy-paste example; the full CLI argument table; the journal location; the "what trust:low means" note; and the rule that first-of-day runs are kept and labelled, not discarded.

## 5. Architecture

```
agent writes:  <repo>/.flipflop/tests/<name>.mjs   (test definition: variants + metadata)
                         │  imported by
engine (repo root, 4 modular .mjs):
  flipflop.mjs ─────────► CLI parse → load test → drive flip-flop engine → stats → verdict
     ├─ flipflop-corpus.mjs   deterministic fractals (mandel/fbm/branch) × sizes; in-mem; TIFF for cmd-mode
     ├─ flipflop-metrics.mjs  background PS sampler (cpu/freq/temp) + per-flip mem + throttle verdict
     └─ flipflop-journal.mjs  TOON encode + append + first_paint_of_day + verdict line
                         │  appends one record to
journal:  C:\Foo\raw-converter-wasm\docs\outputs\timing tests\flipflop\flipflopjournal.toon
corpus cache (cmd-mode TIFFs only):  %TEMP%\flipflop-corpus\
```

**Data flow per run:** parse args → load + validate test file → start background metrics sampler → for each fractal `type` → for each `size` → generate corpus image (in-mem, deterministic) → calibrate inner-reps (probe, discarded) → for each `round` (rotated variant order) → for each `variant` → run flip (timed), snapshot mem immediately after, record timestamp → join nearest sampler reading for temp/freq → accumulate. After all tiers: compute stats (median_warm / median_all / min / stdev / saved_pct / trust), build verdict, stop sampler, append TOON record, optional stdout summary.

## 6. Agent-facing test contract

The agent authors one ES module. Only `name`, `description`, and `variants` are required.

```js
// .flipflop/tests/tone-curve.mjs
export const name = 'tone-curve-simd';
export const description = 'Scalar vs SIMD tone-curve apply on RGBA';

// Optional: per-(type,size) prep. Receives the corpus image + metadata.
// Return value becomes `input` to run(). Default: returns ctx.rgba.
export function setup({ rgba, width, height, size, type }) {
  return rgba;
}

// 2..N variants. First with baseline:true is the baseline; else variants[0].
export const variants = [
  { name: 'baseline-scalar', baseline: true, run: (input, ctx) => applyToneScalar(input) },
  { name: 'simd-wasm128',                    run: (input, ctx) => applyToneSimd(input)  },
  // external-command variant (cmd-mode) instead of run():
  // { name: 'native', cmd: 'cargo run -q --release -- --in {input} --out {output}' },
];

// Optional: equality guard. Returns true if two variant outputs match within tolerance.
// If any pair mismatches → variant flagged equality:mismatch, verdict warns.
export function equal(a, b) { return rmse(a, b) < 1e-3; }
```

- `ctx = { size, type, round, width, height, variantName }`.
- `run(input, ctx)` returns the output (used by `equal`) or nothing. Synchronous or async (awaited outside? — **no**: `run` must be synchronous so the timed region is a tight `for` loop; async variants are out of scope for v1, documented).
- **cmd-mode:** `{input}` is replaced with a path to the materialized corpus TIFF; `{output}` with a temp output path. The harness times the full child-process wall-clock (`spawnSync`), reads `{output}` for `equal()` if present. cmd-mode timings include process startup — documented as coarser; the flip-flop interleave still cancels shared drift.

## 7. Flip-flop timing methodology

The core. Designed for trustworthy small-signal measurement.

- **Sizes:** `[256, 512, 1024, 2048, 4096]` (override `--sizes`).
- **Rounds per size:** `{256:10, 512:10, 1024:10, 2048:5, 4096:5}` (override `--rounds`). A *round* = one measured execution of **every** variant.
- **Interleave (the flip-flop):** within a round, variants run back-to-back `A,B,C,D`. Slow thermal/system drift affects all variants nearly equally inside one round → fair comparison. This is the central defense against the thermal false-regression failure mode.
- **Start rotation:** round *r* starts at variant `r mod N` (`ABCD / BCDA / CDAB …`) → removes systematic "first slot runs coldest" bias on top of interleaving.
- **Inner-rep calibration (discarded):** before scored rounds, a probe times one variant and picks `innerReps` so a single scored sample executes the op enough times to exceed `--min-sample-ms` (default 2 ms), beating `performance.now()` granularity. The probe also primes JIT/caches. The probe is the **only** discarded work.
- **first_paint (kept, not discarded):** round 0 of each (size×variant) is tagged `first_paint:true` and **retained** in the journal. Cold-start cost is data. Aggregates report **both** `median_warm` (rounds 1..R-1) and `median_all` (rounds 0..R-1). If `R ≤ 2`, `median_warm` falls back to `median_all` with a note. The whole run is tagged `first_paint_of_day:true` if the journal has no record dated today (local date).
- **Per-flip record:** each flip stores `ms` (= mean over `innerReps`), `rss_mb` (`process.memoryUsage().rss` snapshot immediately after the timed region — sub-µs, no pollution), `temp_c` and `freq_ratio` (nearest background-sampler reading by timestamp), `first_paint`. Per-flip metrics let an analyst explain why one side of a run drifted from the other.
- **Statistics:** per (size, variant): `median_warm`, `median_all`, `min` (cleanest single signal), `stdev` (over warm samples), `p95`. `saved_pct = (1 − variant.median_warm / baseline.median_warm) × 100` (positive = faster). An all-sizes figure uses the **geometric mean** of per-size ratios (robust across scale). 
- **Trust:** `high` iff `stdev/median_warm < 0.10` **and** not `throttled` **and** no `equality:mismatch`; else `low` with a reason string. `trust:low` is surfaced in the verdict, never hidden.
- **GC hygiene:** if launched with `--expose-gc`, `global.gc()` runs **between** flips (outside any timed region) for cleaner `rss` deltas. Whether gc was available is recorded (`env.gc_exposed`).

## 8. Fractal corpus

3 types × 5 sizes, fully **deterministic** (fixed math, no RNG) → byte-identical for a given (type,size) on any machine. Renderers adapted from `benchmark/fractal-scale-curves.mjs` (proven scale-invariant — "same view at any resolution"; only resolution changes), with **fixed** iteration parameters for one canonical image per (type,size):

| key | name | structure it stresses |
|---|---|---|
| `mandel` | Mandelbrot | sharp self-similar edges + smooth gradients |
| `fbm` | fBm noise | broadband stochastic texture / high entropy |
| `branch` | Branching | radial anisotropy / directional structure |

- **Canonical buffer:** RGBA `Uint8`, alpha always 255 (renderer-native). JS variants receive this via `ctx.rgba` / `setup`. The alpha=255 invariant makes RGB↔RGBA trivially equivalent.
- **TIFF (cmd-mode only):** baseline uncompressed **RGB** 8-bit (alpha stripped), matching the existing reference files at `c:\Foo\raw-converter\tests\fractal_*.tiff`. Materialized lazily into `%TEMP%\flipflop-corpus\<type>_<size>.tiff`, cached.
- **Memory discipline:** generate one (type,size) image at a time; free before the next tier. Peak ≈ one 4096² RGBA buffer (~64 MB). Never hold all 15 at once.
- **Determinism check:** a self-test hashes `corpus(type,size)` and compares to a committed reference hash.

## 9. System metrics & thermal honesty

- **Background sampler:** one long-lived PowerShell process started at run begin, emitting CSV `timestamp,cpu_pct,freq_ratio,temp_c` every `--sampler-ms` (default 500). One spawn total → **zero per-flip overhead**. Each flip's timestamp is joined to the nearest sample.
  - `cpu_pct`: `Get-Counter '\Processor(_Total)\% Processor Time'`.
  - `freq_ratio`: `Get-Counter '\Processor Information(_Total)\% of Maximum Frequency'` / 100 (preferred); fallback `Win32_Processor CurrentClockSpeed/MaxClockSpeed`.
  - `temp_c` best-effort chain: LibreHardwareMonitor WMI (`root\LibreHardwareMonitor`, `SensorType='Temperature'`) → OpenHardwareMonitor namespace → `root\WMI MSAcpi_ThermalZoneTemperature` (deci-Kelvin → °C) → `n/a`.
- **Per-flip memory:** `process.memoryUsage().rss` + `heapUsed`, captured in-process (cheap), reported per flip and as run peak.
- **Throttle verdict:** `throttled = (freq_ratio_min < 0.90) || (temp climbed into a vendor-throttle band)`. If temp `n/a`, throttle is decided on freq alone; if freq also `n/a`, `throttled:unknown`.
- **Degradation:** sampler spawn failure → warn once, continue as `--no-metrics` (timing + mem only; temp/freq = `n/a`).

## 10. TOON journal format

One append-only file: `docs\outputs\timing tests\flipflop\flipflopjournal.toon` (auto-mkdir; default overridable via `--journal`). The file is a sequence of TOON records separated by a line beginning `=== `. A consumer splits on that prefix and parses each record as standalone TOON. Newest appended at end (chronological journal).

Per-record shape (TOON: objects = indented `key: value`; arrays-of-objects = `key[N]{cols}:` + N indented comma rows):

```
=== flipflop 2026-06-18T14:22:05Z tone-curve-simd ===
schema: flipflop/v1
ts: 2026-06-18T14:22:05Z
name: tone-curve-simd
description: Scalar vs SIMD tone-curve apply on RGBA
first_paint_of_day: true
env:
  commit: f3bcc8fe
  host: DAVID-PC
  cpu: AMD Ryzen 9 7900X
  cores: 24
  node: v22.3.0
  gc_exposed: true
  os: Windows-11-26200
config:
  variants: baseline-scalar,simd-wasm128
  baseline: baseline-scalar
  sizes: 256,512,1024,2048,4096
  rounds: 256:10,512:10,1024:10,2048:5,4096:5
  min_sample_ms: 2
  sampler_ms: 500
summary[10]{size,variant,median_warm_ms,median_all_ms,min_ms,stdev_ms,saved_pct,trust}:
  256,baseline-scalar,0.812,0.840,0.790,0.021,0.0,high
  256,simd-wasm128,0.241,0.250,0.233,0.009,70.3,high
  512,baseline-scalar,3.201,3.260,3.150,0.044,0.0,high
  512,simd-wasm128,0.951,0.970,0.940,0.018,70.3,high
  ...
flips[N]{size,round,variant,ms,rss_mb,temp_c,freq_ratio,first_paint}:
  256,0,baseline-scalar,0.840,142.1,52,0.99,true
  256,0,simd-wasm128,0.250,142.6,52,0.99,true
  256,1,baseline-scalar,0.810,142.2,53,0.99,false
  ...
thermal:
  temp_c_start: 51
  temp_c_end: 63
  temp_c_max: 64
  freq_ratio_min: 0.96
  throttled: false
  variance_flag: false
verdict: simd-wasm128 -70.3% vs baseline-scalar (geomean median_warm, all sizes); thermal stable; trust:high
```

A hand-rolled encoder in `flipflop-journal.mjs` produces this (no npm TOON dep). The `flips` table is included **by default** (per the per-flip-metrics requirement); it is the raw evidence behind the summary.

## 11. CLI arguments

```
node [--expose-gc] flipflop.mjs <test-file> [options]

  --rounds <spec>     "256:10,2048:5" map, or a single int for all sizes   (default per §7)
  --sizes <list>      comma list                                          (default 256,512,1024,2048,4096)
  --types <list>      fractal types                                       (default mandel,fbm,branch)
  --min-sample-ms <n> inner-rep calibration floor                         (default 2)
  --sampler-ms <n>    background metrics interval                         (default 500)
  --journal <path>    journal file                                        (default docs/outputs/timing tests/flipflop/flipflopjournal.toon)
  --no-metrics        skip temp/freq sampler (keep timing + memory)
  --print             also print a human summary table to stdout
  --dry               1 round/size, do NOT append journal (smoke test)
  --help              print this and the test-file contract
```

## 12. File layout

```
~/.claude/skills/flipflop/
  SKILL.md                      # invoked → explains usage + args + contract + examples
  engine/                       # canonical source of truth (portable)
    flipflop.mjs
    flipflop-corpus.mjs
    flipflop-metrics.mjs
    flipflop-journal.mjs
  templates/example-test.mjs    # copy-paste starter

<repo root>/                    # working copy of engine (this project)
  flipflop.mjs
  flipflop-corpus.mjs
  flipflop-metrics.mjs
  flipflop-journal.mjs
  .flipflop/tests/<name>.mjs    # agent-authored test definitions
  docs/outputs/timing tests/flipflop/flipflopjournal.toon   # the journal

%TEMP%/flipflop-corpus/         # cmd-mode TIFF cache (per machine)
```

`.flipflop/` and the repo-root engine copies are git-ignored by default (the canonical copy is the skill); the journal under `docs/outputs/` is intentionally **not** ignored (it is the kept record).

## 13. Edge cases & error handling

- Test file missing `name`/`description`/`variants`, or `<2` variants → clear error, exit 1.
- A variant `run`/`cmd` throws or exits nonzero → that flip recorded as `failed`; variant excluded from verdict; noted in journal; other variants continue.
- `equal()` returns false for any compared pair → variant flagged `equality:mismatch`; verdict warns "outputs differ — speed comparison may be invalid"; `trust:low`.
- Temp unavailable → `temp_c:n/a`; throttle from freq only; both unavailable → `throttled:unknown`.
- Background sampler fails to spawn → auto `--no-metrics`, warn once.
- 4096² memory: one image at a time; peak ~64 MB; explicit free between tiers.
- Journal dir missing → created. Path contains a space ("timing tests") → safe (Node `fs`, no shell); any shelling quotes it.
- Concurrent runs to one journal: append is a single `appendFileSync` of the full record (atomic for a single user). Documented limitation; no lock in v1.
- `R ≤ 2` → `median_warm` falls back to `median_all` (note emitted).

## 14. Success criteria

1. Agent writes a ≤30-line test file + one command → a complete TOON journal record: per-size `median_warm`/`median_all`/`min`/`stdev`/`saved_pct`, per-flip `rss`/`temp`/`freq`, thermal block, verdict.
2. **No fabricated savings:** two identical variants → `saved_pct ≈ 0 ± noise`.
3. **Correct sign/magnitude:** a variant doing the op twice (≈2× slower) → `saved_pct ≈ −100%`; a half-work variant → `≈ +50%`.
4. **Determinism:** `corpus(type,size)` hash is stable across runs and matches a committed reference.
5. **Thermal honesty:** an induced throttle (freq_ratio < 0.90) during a run → `throttled:true` + `trust:low` in the record.
6. **Graceful degradation:** runs to completion with timing + memory even when temp sensors and the sampler are unavailable.
7. Zero npm deps; runs under the installed Node; no build step.

## 15. Testing strategy

- **Engine self-tests** (`node flipflop.mjs --selftest`, or a `flipflop.test.mjs`):
  - Sleep/busy-loop variants with a known work ratio → assert `saved_pct` within tolerance (criteria 2 & 3).
  - Corpus determinism: hash twice + vs reference (criterion 4).
  - TOON encode round-trips a sample object; record splits cleanly on `=== `.
  - first_paint: round 0 tagged, excluded from `median_warm`.
  - `--no-metrics` path completes; temp/freq report `n/a` (criterion 6).
- **Smoke:** `--dry` on the example test → no journal mutation, prints summary.

## 16. Future sibling: flipflopsize

Same vehicle, different aim: measure **encoded output size / compression ratio** (and quality, e.g. Butteraugli/SSIM/PSNR via the existing perceptual modules) rather than time. Shares corpus + journal conventions; separate skill once the time-vehicle formula is proven. Out of scope here, noted so the contract (variant `run` returning output, the `equal` hook) is forward-compatible.

## 17. Deferred / open

- Single-variant regression-vs-journal-history mode (v1.1).
- Async `run` variants (v1 is synchronous-only for a tight timed loop).
- Journal `--summary` leaderboard (scan records → best `%saved` per test name).
- Cross-machine normalization.
