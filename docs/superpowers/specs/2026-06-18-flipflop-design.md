# flipflop — Standardized Flip-Flop Timing Vehicle (Design)

- **Status:** Draft for review (rev 2 — async / quality-scalar / pluggable inputs / role / marks integrated)
- **Date:** 2026-06-18
- **Author:** David + Claude
- **Skill name:** `flipflop` (sibling, deferred: `flipflopsize`)

## 1. Goal

A reusable, standardized benchmark harness an agent can wrap around **any algorithm** to compare N implementations ("variants") of the same operation. The agent inserts control points on one side (wraps each implementation as a callback or command; optionally drops `ctx.mark()` timing points inside it); the vehicle feeds an input corpus, runs the implementations **interleaved** (flip-flop / round-robin, `ABCDABCD…`) to cancel thermal and system drift, and emits per-flip timings, per-input aggregates, `%saved` vs a baseline, memory, an optional quality scalar, optional intra-run marks, and system state into a single append-only TOON journal — a running log of every test and every improvement found.

The vehicle exists to produce **trustworthy** numbers. This codebase has repeatedly been bitten by thermal hot-run false regressions (a ~1.5× "all metrics" regression once traced entirely to CPU temperature, not code). The harness records the thermal/throttle trace per flip and flags drift-polluted runs rather than reporting a clean-looking lie.

It serves two roles for the codec workflow: a **speed+memory oracle** for sync Rust kernels (e.g. tone-curve scalar vs SIMD) and an **async codec oracle** for the JS encode/decode paths (PhotonProgEnc / ModularProgEnc / shot_dec), with a perceptual-quality scalar riding alongside time so a speed win cannot silently hide a quality regression.

## 2. Non-goals (v1)

- **Output size / compression-ratio measurement and quality-vs-bytes curves.** Deferred to a future sibling skill `flipflopsize`. v1 measures **time** (headline) + memory, and records an **optional quality scalar** ride-along — it does not measure encoded byte size or sweep quality against bytes. The principled line: *flipflop = time + memory + quality scalar; flipflopsize = size/ratio + quality curves.*
- **Native Rust criterion bridge.** Native/Rust kernels are reached via external-command mode, not an in-process Rust timer. (Approach C, deferred.)
- **Cross-machine result comparison.** Fractal inputs are deterministic (inputs match across machines), but timings are compared **within a journal / machine** only. File inputs are not deterministic across machines.
- **Single-variant regression-vs-history mode.** v1 requires ≥2 variants (the flip-flop needs something to flop against). History comparison is a possible v1.1.

## 3. Constraints

- **Zero npm dependencies, zero build step.** Pure Node `.mjs` + PowerShell. Matches the repo's existing `.mjs` benchmark culture (`StandardMultifileTest.mjs`, `run-10-benchmarks.mjs`, `benchmark/fractal-scale-curves.mjs`).
- **Windows host.** Metrics via WMI / `Get-Counter` / `Get-CimInstance`. CPU temperature is unreliable without helper software → best-effort with graceful `n/a`.
- **Portable across projects.** The engine is invokable from any repo. Canonical engine source lives in the skill dir; a tracked working copy lives in the target repo root.
- **Timing path must stay clean.** No WMI / spawn / quality computation inside a timed region. Expensive metrics come from a background sampler joined post-hoc by timestamp; quality is computed outside timed regions.

## 4. Users & usage

The user is an agent. When the agent invokes the `flipflop` skill, `SKILL.md` explains usage and every argument, then the agent:

1. Ensures the engine is present in repo root (copies from the skill's `engine/` dir if `flipflop.mjs` is missing).
2. Writes a small **test-definition file** (the only thing the agent authors — see §6).
3. Runs `node flipflop.mjs <test-file> [options]` (or `node --expose-gc flipflop.mjs …` for cleaner memory deltas).
4. Reads the appended TOON journal entry (and optional stdout summary).

`SKILL.md` content (so the agent is self-sufficient): one-paragraph purpose; the test-file contract with copy-paste examples (sync kernel; async codec; custom inputs; marks; quality hook); the full CLI argument table; the journal location; the "what trust:low means" note; the first-of-day-kept-not-discarded rule; and the sync-vs-async mode rule.

## 5. Architecture

```
agent writes:  <repo>/.flipflop/tests/<name>.mjs   (variants + metadata + optional hooks)
                         │  imported by
engine (repo root, 4 modular .mjs):
  flipflop.mjs ─────────► CLI parse → load test → resolve input items → drive flip-flop → stats → verdict
     ├─ flipflop-corpus.mjs   default fractal provider (mandel/fbm/branch) + --inputs/corpus() resolution + TIFF
     ├─ flipflop-metrics.mjs  background PS sampler (cpu/freq/temp) + per-flip mem + throttle verdict
     └─ flipflop-journal.mjs  TOON encode + append + first_paint_of_day + verdict
                         │  appends one record to
journal:  C:\Foo\raw-converter-wasm\docs\outputs\timing tests\flipflop\flipflopjournal.toon
corpus cache (cmd-mode TIFFs only):  %TEMP%\flipflop-corpus\
```

**Data flow per run:** parse args → load + validate test → **resolve input items** (default fractals, or `corpus()`/`--inputs`) → determine `timing_mode` (sync/async) → start background metrics sampler → for each **input item** → materialize/generate input → capture baseline output once (for quality/equal) → calibrate inner-reps (probe, discarded) → for each `round` (rotated variant order) → for each `variant` → run flip (timed; collect marks; snapshot mem after) → join nearest sampler reading → accumulate. After all items: compute stats, quality, marks aggregates, verdict; stop sampler; append TOON record; optional stdout summary.

## 6. Agent-facing test contract

The agent authors one ES module. Only `name`, `description`, and `variants` are required; everything else is optional.

```js
// .flipflop/tests/tone-curve.mjs  (sync kernel — speed+memory oracle)
export const name = 'tone-curve-simd';
export const description = 'Scalar vs SIMD tone-curve apply on RGBA';
export const variants = [
  { name: 'baseline-scalar', baseline: true, run: (input, ctx) => applyToneScalar(input) },
  { name: 'simd-wasm128',                    run: (input, ctx) => applyToneSimd(input)  },
];
export function equal(a, b) { return rmse(a, b) < 1e-3; }   // optional lossless guard
```

```js
// .flipflop/tests/photon-prog-enc.mjs  (async codec — quality + marks + custom input)
export const name = 'photon-prog-enc';
export const description = 'PhotonProgEnc vs ModularProgEnc, real RAW corpus';
export const isAsync = true;                                 // (or auto-detected from AsyncFunction)

// custom input provider — replaces fractal default for this test
export async function corpus() {
  return loadStandardMultifileAssets();                      // [{ name, kind:'file', bytes, width, height }]
}

export const variants = [
  { name: 'modular-prog', baseline: true, role: 'primary',
    run: async (input, ctx) => { const e = newModularEnc(); ctx.mark('open');
      await e.pushPixels(input); ctx.mark('pushed'); return await e.finish(); } },
  { name: 'photon-prog', role: 'primary',
    run: async (input, ctx) => { const e = newPhotonEnc();  ctx.mark('open');
      await e.pushPixels(input); ctx.mark('pushed'); return await e.finish(); } },
  { name: 'legacy-fallback', role: 'fallback', note: 'kept for pre-v2 decoders',
    run: async (input, ctx) => await legacyEnc(input) },
];

// quality scalar ride-along (time stays the headline). Lower = better here (Butteraugli).
export const qualityDirection = 'lower';
export const qualityThreshold = 1.5;
export function quality(out, baselineOut, ctx) { return butteraugli(decode(out), decode(baselineOut)); }
```

Contract surface:

| export | required | meaning |
|---|---|---|
| `name`, `description` | yes | journal identity |
| `variants[]` | yes (≥2) | `{ name, run \| cmd, baseline?, role?, note? }`. First `baseline:true` (else `variants[0]`) is the baseline. `role:'primary'\|'fallback'` (default primary). |
| `setup({rgba\|bytes,width,height,size,type,name})` | no | per-input prep; returns the `input` passed to `run`. Default: returns the input item's `rgba`/`bytes`. |
| `corpus(ctx)` | no | returns `InputItem[]`, replacing the fractal default for this test. Sync or async. |
| `equal(a, b)` | no | lossless guard; false → `equality:mismatch`, `trust:low`. |
| `quality(out, baseOut, ctx)` | no | perceptual scalar; recorded per variant. flipflop bundles no metric — the hook calls the repo's. |
| `qualityDirection`, `qualityThreshold` | no | `'lower'`(default)/`'higher'`; threshold for `quality_ok` + verdict flag. |
| `isAsync` | no | force async timing mode (else auto-detected). |

- `ctx = { name, type, size, round, width, height, variantName, mark(label) }`.
- `run(input, ctx)` returns the output (used by `equal`/`quality`) or nothing. **Sync** (tight timed loop) or **async** (awaited loop) — see §7.
- **cmd-mode:** `{input}` → path to the materialized input (fractal TIFF, or the real file path for `--inputs`); `{output}` → temp output path. Timed via `spawnSync` (full child wall-clock; coarser, documented). `{output}` read for `equal`/`quality` if present.

## 7. Flip-flop timing methodology

- **Iteration unit = input item** (a fractal `(type,size)` or a custom file). Default fractal items: types × `[256,512,1024,2048,4096]`.
- **Rounds:** default by fractal pixel-size `{256:10, 512:10, 1024:10, 2048:5, 4096:5}`; for custom inputs, `--rounds <int>` (default 8) or a per-name map; a custom item may carry its own `rounds`. A *round* = one measured execution of **every** variant.
- **Interleave (the flip-flop):** within a round, variants run back-to-back `A,B,C,D`. Slow drift hits all variants nearly equally inside one round → fair comparison. Central defense against thermal false-regression.
- **Start rotation:** round *r* starts at variant `r mod N` (`ABCD/BCDA/CDAB…`) → removes "first slot runs coldest" bias.
- **Sync vs async mode (per test):** `timing_mode = 'async'` if any variant is an `AsyncFunction` or `isAsync` is set, else `'sync'`. Uniform within a test for fairness.
  - sync: `t0; for(i<inner) run(); t1`.
  - async: `t0; for(i<inner) await run(); t1`. The `await` adds a small **additive** per-flip overhead applied to **both** arms; this biases `saved_pct` toward 0 (conservative), and is negligible for ms-scale codec ops. Same coarseness class as cmd-mode. Recorded as `config.timing_mode`.
- **Inner-rep calibration (discarded):** a probe picks `innerReps` so one scored sample exceeds `--min-sample-ms` (default 2 ms), beating timer granularity, and primes JIT/caches. The probe is the **only** discarded work. ms-scale codec ops calibrate to `innerReps=1` naturally.
- **Marks / control points:** `ctx.mark(label)` records `performance.now()` inside a `run`. Per flip, intervals `start→mark₁→…→end` are derived; aggregated per label (median) per (input,variant) into an optional `marks` table → measures time-to-first-frame / inter-event delay. **If a test uses marks, `innerReps` is forced to 1** (codec ops are ms-scale, so calibration already lands there). Total time stays the headline.
- **first_paint (kept, not discarded):** round 0 of each (input×variant) is tagged `first_paint:true` and **retained**. Aggregates report **both** `median_warm` (rounds 1..R-1) and `median_all`. `R ≤ 2` → `median_warm` falls back to `median_all` (noted). The run is tagged `first_paint_of_day:true` if the journal has no record dated today.
- **Per-flip record:** `ms` (mean over `innerReps`), `rss_mb` (snapshot immediately after timed region — sub-µs), `temp_c` + `freq_ratio` (nearest sampler reading), `first_paint`, plus mark offsets if any.
- **Quality (ride-along):** if `quality()` is exported, it is computed **once per (input, variant)** on that variant's real (timed) output vs the baseline's captured output — so speed and quality are co-reported for the *same* code path. Recorded as `quality` + `quality_ok` (vs `qualityThreshold`/`qualityDirection`). Computed outside any timed region. n/a if absent. (Per-flip recompute is unnecessary for deterministic encoders and would waste work; nondeterministic-encoder per-round quality is deferred.)
- **Statistics:** per (input, variant): `median_warm`, `median_all`, `min`, `stdev`, `p95`. `saved_pct = (1 − variant.median_warm / baseline.median_warm) × 100` (positive = faster). All-inputs figure = **geometric mean** of per-input ratios.
- **Trust:** `high` iff `stdev/median_warm < 0.10` **and** not `throttled` **and** no `equality:mismatch`; else `low` + reason. `quality_ok=false` does not lower timing `trust` but raises a distinct verdict flag. `trust:low` is always surfaced.
- **GC hygiene:** with `--expose-gc`, `global.gc()` runs **between** flips (outside timed regions). `env.gc_exposed` recorded.

## 8. Inputs & fractal corpus

**Input resolution order:** `corpus()` test hook → `--inputs <glob>` → default fractal provider.

**Default fractal provider** — 3 types × 5 sizes, fully **deterministic** (fixed math, no RNG) → byte-identical for a given (type,size) on any machine. Renderers adapted from `benchmark/fractal-scale-curves.mjs` (proven scale-invariant), fixed iteration params for one canonical image per (type,size):

| key | name | structure it stresses |
|---|---|---|
| `mandel` | Mandelbrot | sharp self-similar edges + smooth gradients |
| `fbm` | fBm noise | broadband stochastic texture / high entropy |
| `branch` | Branching | radial anisotropy / directional structure |

- Canonical buffer: RGBA `Uint8`, alpha 255. JS variants get `ctx`-provided `rgba`. TIFF for cmd-mode: baseline uncompressed **RGB** 8-bit, lazily cached at `%TEMP%\flipflop-corpus\<type>_<size>.tiff`, matching the existing reference files at `c:\Foo\raw-converter\tests\fractal_*.tiff`.
- Memory discipline: one image at a time; free before the next item; peak ≈ one 4096² RGBA buffer (~64 MB).
- Determinism self-test hashes `corpus(type,size)` vs a committed reference hash.

**Custom inputs** (override): real-photo entropy and Bayer/RAW sensor files cannot be synthesized by fractals, so the codec/RAW paths need real bytes.
- `export function corpus(ctx)` → `InputItem[]`, each `{ name, kind, size?, width?, height?, bytes?|rgba? }`.
- `--inputs <glob>` → each matched file → `{ name:basename, kind:'file', bytes:<Uint8Array>, size:<byteLength> }`. JS variants receive `bytes`; cmd-mode `{input}` = the **real file path** (no temp materialization). Covers ORF/CR2/DNG and the 8 StandardMultifileTest assets feeding `process_orf_with_flags` / progressive encoders.
- File inputs are flagged `kind:file` and marked **non-deterministic** in the journal (the determinism guarantee covers fractal inputs only).

## 9. System metrics & thermal honesty

- **Background sampler:** one long-lived PowerShell process from run begin, emitting CSV `timestamp,cpu_pct,freq_ratio,temp_c` every `--sampler-ms` (default 500). One spawn → **zero per-flip overhead**; each flip's timestamp joins the nearest sample.
  - `cpu_pct`: `Get-Counter '\Processor(_Total)\% Processor Time'`.
  - `freq_ratio`: `Get-Counter '\Processor Information(_Total)\% of Maximum Frequency'` / 100 (preferred); fallback `Win32_Processor CurrentClockSpeed/MaxClockSpeed`.
  - `temp_c` best-effort chain: LibreHardwareMonitor WMI (`root\LibreHardwareMonitor`, `SensorType='Temperature'`) → OpenHardwareMonitor namespace → `root\WMI MSAcpi_ThermalZoneTemperature` (deci-Kelvin → °C) → `n/a`.
- **Per-flip memory:** `process.memoryUsage().rss` + `heapUsed`, in-process (cheap), per flip + run peak. Directly serves the "equal speed acceptable if memory down" axis.
- **Throttle verdict:** `throttled = (freq_ratio_min < 0.90) || (temp in vendor-throttle band)`. Temp `n/a` → freq only; both `n/a` → `throttled:unknown`.
- **Degradation:** sampler spawn failure → warn once, continue as `--no-metrics` (timing + mem only; temp/freq = `n/a`).

## 10. TOON journal format

One append-only file: `docs\outputs\timing tests\flipflop\flipflopjournal.toon` (auto-mkdir; `--journal` override). A sequence of TOON records separated by a line beginning `=== `; consumers split on that prefix and parse each record as standalone TOON. Newest appended at end.

```
=== flipflop 2026-06-18T14:22:05Z photon-prog-enc ===
schema: flipflop/v1
ts: 2026-06-18T14:22:05Z
name: photon-prog-enc
description: PhotonProgEnc vs ModularProgEnc, real RAW corpus
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
  variants: modular-prog,photon-prog,legacy-fallback
  baseline: modular-prog
  timing_mode: async
  input_source: corpus()  (kind:file, non-deterministic)
  rounds: 8
  min_sample_ms: 2
  sampler_ms: 500
summary[3]{input,variant,role,median_warm_ms,median_all_ms,min_ms,stdev_ms,saved_pct,quality,quality_ok,trust}:
  P1040206.ORF,modular-prog,primary,182.4,190.1,180.0,2.1,0.0,0.00,true,high
  P1040206.ORF,photon-prog,primary,151.2,158.7,149.8,3.0,17.1,1.32,true,high
  P1040206.ORF,legacy-fallback,fallback,240.9,251.0,238.1,4.2,-32.0,0.00,true,high
marks[4]{input,variant,label,median_ms}:
  P1040206.ORF,modular-prog,open,0.39
  P1040206.ORF,modular-prog,pushed,118.2
  P1040206.ORF,photon-prog,open,0.41
  P1040206.ORF,photon-prog,pushed,96.7
flips[N]{input,round,variant,ms,rss_mb,temp_c,freq_ratio,first_paint}:
  P1040206.ORF,0,modular-prog,190.1,512.4,52,0.99,true
  P1040206.ORF,0,photon-prog,158.7,540.2,52,0.99,true
  ...
thermal:
  temp_c_start: 51
  temp_c_end: 63
  temp_c_max: 64
  freq_ratio_min: 0.96
  throttled: false
  variance_flag: false
verdict: photon-prog -17.1% vs modular-prog (geomean median_warm); quality 1.32 within threshold 1.5; legacy-fallback role:fallback (alternative, intentional, +32% slower); thermal stable; trust:high
```

(Objects = indented `key: value`; arrays-of-objects = `key[N]{cols}:` + N indented comma rows.) `flips` is on by default (raw evidence). `marks` and `quality`/`quality_ok` appear only when those hooks are used. Hand-rolled encoder in `flipflop-journal.mjs` (no npm TOON dep).

## 11. CLI arguments

```
node [--expose-gc] flipflop.mjs <test-file> [options]

  --inputs <glob>     real-file corpus, overrides fractals (kind:file)
  --rounds <spec>     "256:10,2048:5" map, or a single int                (default §7)
  --sizes <list>      fractal sizes                                       (default 256,512,1024,2048,4096)
  --types <list>      fractal types                                       (default mandel,fbm,branch)
  --min-sample-ms <n> inner-rep calibration floor                         (default 2)
  --sampler-ms <n>    background metrics interval                         (default 500)
  --journal <path>    journal file        (default docs/outputs/timing tests/flipflop/flipflopjournal.toon)
  --no-metrics        skip temp/freq sampler (keep timing + memory)
  --print             also print a human summary table to stdout
  --dry               1 round/input, do NOT append journal (smoke test)
  --help              print usage + the test-file contract
```

## 12. File layout

```
~/.claude/skills/flipflop/
  SKILL.md                      # invoked → explains usage + args + contract + examples
  engine/                       # canonical source of truth (portable)
    flipflop.mjs  flipflop-corpus.mjs  flipflop-metrics.mjs  flipflop-journal.mjs
  templates/                    # copy-paste starters
    example-test-sync.mjs  example-test-async.mjs

<repo root>/                    # tracked working copy of engine (this project)
  flipflop.mjs  flipflop-corpus.mjs  flipflop-metrics.mjs  flipflop-journal.mjs
  .flipflop/tests/<name>.mjs    # agent-authored test definitions (git-ignored)
  docs/outputs/timing tests/flipflop/flipflopjournal.toon   # the journal (tracked)

%TEMP%/flipflop-corpus/         # cmd-mode TIFF cache (per machine)
```

**Tracked vs ignored (this repo):** repo-root engine `.mjs` are **tracked** (matches existing tracked root benchmarks). `.flipflop/tests/` (force-add individual fixtures worth keeping) and `%TEMP%/flipflop-corpus/` are **git-ignored**. The journal lives under `docs/outputs/`, which is **already git-ignored repo-wide** (the repo's scratch outputs dir, alongside other local timing `.toon` files) — so the journal is an intentionally **local, untracked** running record, not committed on every run. The skill's `engine/` is the portable canonical copy used to seed other repos.

## 13. Edge cases & error handling

- Test file missing `name`/`description`/`variants`, or `<2` variants → clear error, exit 1.
- A variant `run`/`cmd` throws or exits nonzero → that flip recorded `failed`; variant excluded from verdict; noted; others continue.
- `equal()` false → `equality:mismatch`, `trust:low`, verdict warns "outputs differ — speed comparison may be invalid."
- `quality()` throws or returns non-finite → `quality:n/a` for that variant; warn once; timing unaffected.
- Mixed sync/async variants in one test → whole test runs in **async** mode (uniform `await`) for fairness; noted.
- Marks used with `innerReps>1` → forced to `innerReps=1`; noted.
- Custom input items missing `bytes`/`rgba` (JS mode) or unreadable file (`--inputs`) → that item skipped with a warning; run continues on remaining items.
- File inputs → journal flags `non-deterministic`; determinism self-test only asserts on fractal inputs.
- Temp unavailable → `temp_c:n/a`; throttle from freq; both → `throttled:unknown`.
- Background sampler spawn failure → auto `--no-metrics`, warn once.
- 4096² memory: one image at a time; explicit free between items.
- Journal dir missing → created. Space in path ("timing tests") → safe (Node `fs`, no shell; shelling quotes).
- Concurrent runs to one journal: append is a single `appendFileSync` of the full record (atomic for a single user). Documented; no lock in v1.
- `R ≤ 2` → `median_warm` falls back to `median_all` (noted).

## 14. Success criteria

1. Agent writes a ≤40-line test file + one command → a complete TOON record: per-input `median_warm`/`median_all`/`min`/`stdev`/`saved_pct`, per-flip `rss`/`temp`/`freq`, thermal block, verdict; plus `quality`/`marks` when those hooks are used.
2. **No fabricated savings:** two identical variants → `saved_pct ≈ 0 ± noise`.
3. **Correct sign/magnitude:** ≈2×-work variant → `saved_pct ≈ −100%`; half-work variant → `≈ +50%` (sync and async modes).
4. **Determinism:** fractal `corpus(type,size)` hash stable + matches committed reference.
5. **Thermal honesty:** induced throttle (freq_ratio < 0.90) → `throttled:true` + `trust:low`.
6. **Async path:** an async variant pair (e.g. awaited encode) measures and compares without crashing; `timing_mode:async` recorded.
7. **Quality guard:** a faster variant breaching `qualityThreshold` → `quality_ok:false` + verdict flag, while `saved_pct` still reflects the speed win (speed cannot hide quality regression).
8. **Custom input:** `--inputs <glob>` (or `corpus()`) drives variants on real bytes; journal flags `non-deterministic`.
9. **Role framing:** a `role:'fallback'` variant is journaled as alternative/intentional, not "regression."
10. Zero npm deps; runs under installed Node; graceful degradation w/o temp sensors; no build step.

## 15. Testing strategy

- **Engine self-tests** (`node flipflop.mjs --selftest` or `flipflop.test.mjs`):
  - Sleep/busy-loop variants, known work ratio → `saved_pct` within tolerance, **sync and async** (criteria 2/3/6).
  - Fractal corpus determinism: hash twice + vs reference (criterion 4).
  - TOON encode round-trips a sample object; record splits cleanly on `=== `.
  - first_paint: round 0 tagged, excluded from `median_warm`.
  - Quality guard: stub `quality()` over threshold → `quality_ok:false` + verdict flag (criterion 7).
  - `--no-metrics` path completes; temp/freq `n/a` (criterion 10).
- **Smoke:** `--dry` on each example → no journal mutation; prints summary.

## 16. Sibling: flipflopsize (deferred)

Same vehicle, different aim: measure **encoded output size / compression ratio** and sweep **quality-vs-bytes curves** (Butteraugli/SSIM/PSNR via the perceptual modules), not time. Shares corpus + journal conventions. The v1 quality **scalar** ride-along here is forward-compatible (same `quality()` hook, same variant-returns-output contract); flipflopsize generalizes it to curves + size. Out of scope here.

## 17. Deferred / open

- Single-variant regression-vs-journal-history mode (v1.1).
- Per-round quality recompute for nondeterministic encoders (opt-in flag).
- Journal `--summary` leaderboard (best `%saved` per test name across records).
- Cross-machine normalization.
- Sub-µs async ops (await overhead would dominate — out of intended use; documented).
