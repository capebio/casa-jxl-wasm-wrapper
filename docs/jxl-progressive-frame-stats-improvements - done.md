# jxl-progressive-frame-stats.js — Improvements DONE

Date: 2026-06-17
File: `web/jxl-progressive-frame-stats.js` (mirrored byte-identical to `C:\Foo\Backup\raw-converter-wasm\web\...`)
Source: two-part engineer handoff (architecture review + explicit code handoff).

---

## TL;DR

Applied the handoff's one high-confidence win (split full vs truncated loop paths) plus
the safe additive fields. Rejected the rest with reasons grounded in how the function is
actually consumed. **Behaviour is byte-identical on every pre-existing return field**
(verified by A/B parity harness on full + truncated frames) and **5/5 unit tests pass**.

A WASM/Rust port of this kernel was evaluated and **rejected** — see below.

---

## What I changed

1. **Split the hot loop into two top-level functions** (`accumulateFull`, `accumulateTruncated`)
   instead of the single fused loop with four `full || i < limit ? …` bounds checks per pixel.
   - Full path: no per-pixel bounds checks (the case for every fully-decoded pass).
   - Truncated path: zero-fills bytes past `limit`, identical semantics to the original.
   - **Why two functions, not two branches in one body:** when both paths share one function,
     TurboFan specializes it for the hot full-buffer shape and then *penalizes* the cold
     truncated branch. Measured: a single-function split made the truncated path ~3× slower.
     Separate functions let each optimize in isolation.

2. **Kernel / derived-metric separation** — the accumulators return only raw sums, counts and
   the integer hash; mean, variance, percentages and the hex hash are derived afterwards in
   `analyzeProgressiveFrame`. This is the WASM-ready shape the handoff asked for (kernel is now
   a drop-in boundary) and keeps the per-pixel loop branch-light.

3. **Additive return fields (non-breaking):**
   - `meanLuma` — per-channel-weighted mean rescaled to ~0..255 (free; already accumulated).
     Useful for blank-frame / progressive-convergence telemetry.
   - `truncated` (`limit !== expected`) and `validPixels` (`limit >>> 2`) — truncation diagnostics.
   - `frameHashInt` — the raw numeric FNV hash alongside the existing hex string.
   - `formatFrameHash(hash)` exported helper.

4. **Formatters** switched from `[...].join()` to string concatenation (identical output, one
   fewer array allocation). Existing format strings unchanged — exports/UI untouched.

---

## What I rejected, and why (audit of real consumers)

I traced every consumer in `jxl-single-progressive.js` and `jxl-progressive-paint.js` before
touching the API shape.

| Handoff proposal | Verdict | Reason |
|---|---|---|
| Store **numeric-only** hash, format on log (P3) | **Rejected** (kept string + added int) | `frameHash` is a hard **string** contract: pass-dedup (`stats.frameHash === prev.stats.frameHash`), the `'--'` missing-stats sentinel, `new Set(...).size` unique-frame counts, and CSV/JSON/MD/TOON exports + the `['Hash', s.frameHash]` UI row all read it as a hex string. Numeric-only would silently break dedup sentinels and exports. |
| Make hashing **optional** (`computeHash`) (P2) | **Rejected** | The hash is *always* consumed (dedup + unique-frame count + exports). A runtime toggle either re-introduces a per-pixel branch into the hot loop or doubles the loop count to four. No call site wants hashing off. |
| **Sampled / strided** hash (P8) | **Rejected** | Hash identity *is* required — pass-dedup and the `hash differs on content` test depend on exact identity. |
| Hoist width/height coercion out of the function (P4) | **Rejected** | Runs once per call (not per pixel) — unmeasurable — and the `Math.floor(Number()||0)` guards the zero-dim / empty-buffer tests. |
| Incremental dirty-region accumulator (strategic) | **Out of scope** | Real idea, but the function is called ~once per progressive pass and its result is **cached** by `computeAndCachePassStats`. There is no per-frame-update rescan to eliminate here. This is a pipeline-architecture change, not a file edit. |
| Decode-integrated telemetry (strategic) | **Out of scope** | Same — belongs in the decode worker, not this module. |

---

## WASM / Rust assessment — rejected for this kernel

Evaluated per the explicit ask. **Rejected**, for the same class of reason the handoff used to
reject GPU offload:

- It is a **single-pass, memory-bound reduction**. The repo already learned (memory:
  *Perceptual SIMD kernel*) that these kernels are memory-bound and the WASM SIMD headroom is
  "a wash" (~2× at best, often less).
- It is called **a handful of times per image and the result is cached**, so there is no hot
  steady-state to amortize a port against.
- The RGBA frame lives in a JS `Uint8Array` from the decoder event. Crossing into WASM needs a
  **full heap copy of the frame** — that copy alone is on the order of the entire scan cost,
  erasing any arithmetic gain.

The kernel/derived split above is the right *preparation* if telemetry ever moves into the
decode worker (where pixels already sit in the WASM heap) — that is the only context where a
WASM telemetry kernel would pay off, and it is an architecture change outside this file.

---

## Verification

- **Unit tests:** `bun test web/jxl-progressive-frame-stats.test.js` → **5 pass / 0 fail**.
- **Parity:** A/B harness (`bench-frame-stats.mjs`) compares all 8 pre-existing return fields
  against a verbatim copy of the old implementation on a 1920×1280 frame and a mid-pixel
  truncated frame → **OK / OK** (byte-identical).
- **Backup mirror:** live `web/` copy and `C:\Foo\Backup\...` copy verified byte-identical.

---

## Performance metrics

### Focused kernel micro-benchmark (`bench-frame-stats.mjs`)

Each implementation measured in its **own fresh Node process** (no shared JIT/IC/GC state),
reporting **min ms/call** across trials — the noise-resistant estimator for CPU micro-bench.
Frame: 1920×1280 RGBA (2.46 MP). Three isolated runs:

| Path | OLD (ms/call) | NEW (ms/call) | Speedup |
|---|---|---|---|
| Full buffer | ~62 | ~61 | **~1.02×** (neutral, slight win) |
| Truncated buffer | ~33 | ~28 | **~1.18×** (consistent across 3 runs: 1.18/1.14/1.22×) |

Interpretation: the workload is **memory-bandwidth-bound**, so removing four conditionals per
pixel from the full path is a real instruction-count reduction but is largely hidden in
wall-clock — exactly the handoff's own thesis that this file is near locally optimal. The
truncated path improves consistently because a separate monomorphic function optimizes better
than the old branchy `full || i < limit` ternary. **No path regresses.**

> Note on methodology: an early single-process A/B harness showed wild swings (0.4×–1.5×) due
> to shared optimizer state and CPU-frequency noise on this machine. The isolated-process
> min-of-trials harness above is the trustworthy measurement.

### Named pipeline benchmark (`test-metrics-performance.mjs`)

Run as a **smoke test only** — this harness measures PSNR/SSIM/Butteraugli on a full RAW→JXL
encode/decode round-trip and **does not import `analyzeProgressiveFrame`**, so it does not
measure this change. It confirms the broader pipeline is unaffected by the edit.

Ran clean (P2200476 ORF, 5240×3912 → 1920×1433, encode 901 B, 2 progressive passes):

```
PSNR    final 81.79 dB (>= 25 dB gate OK)   total 69.45 ms
SSIM    final 1.000                          total 92.79 ms
Butteraugli final 0.029 (precompute 32.52)  total 392.70 ms
Total metric compute time: 554.94 ms (Node, full-res, synchronous)
```

No errors; the RAW→JXL pipeline is unaffected by the frame-stats edit (as expected — it
never calls into this module).

---

## Follow-up: WASM/SIMD flip-flop investigation (2026-06-17)

### Correction: the kernel is COMPUTE-bound, not memory-bandwidth-bound

The original review (and an earlier answer) called this scan "memory-bound." A diagnostic
(`bench-frame-stats-diag.mjs`) **refutes** that — the label was wrongly borrowed from the
perceptual kernels (PSNR/SSIM/Butteraugli), which *are* memory-bound. For frame-stats:

| diagnostic variant (2.46 MP) | min ms | note |
|---|---|---|
| baseline (byte FNV) | 45.5 | — |
| nohash (stats only) | 30.8 | hash ≈ **32%** of total |
| u32 word-read, same FNV | 45.5 | **zero gain → not load/bandwidth bound** |
| u32 + word-hash, 2 lanes | 30.8 | de-serializing the hash recovers the whole 32% |

~25 ns/pixel is ~100× above the memory-bandwidth floor. The cost is the **serial FNV hash
dependency chain** (~⅓) plus the **per-pixel stats arithmetic** (luma multiply + variance
`L*L`, ~⅔). Both are compute, not bandwidth.

### Flip-flop: JS vs WASM {scalar, autovec, hand-SIMD, copy}

Wired in `tools/frame-stats-flipflop.mjs` (true alternation + min/median, correctness pinned
before timing — every variant's stats match the JS baseline; exact-hash variants match the
FNV value). WASM kernels added to `src/lib.rs` (`fstats_prepare/scalar/fast/simd/copy`),
built `pkg-bench` with `RUSTFLAGS=-C target-feature=+simd128`, `--target nodejs`.

| variant (2.46 MP) | min ms | vs JS baseline |
|---|---|---|
| js-baseline (byte FNV) | 46.7 | 1.00× |
| wasm-scalar (**exact** byte FNV) | 13.7 | **3.42×** |
| wasm-fast (autovec ILP, word-hash) | 13.3 | 3.50× |
| wasm-simd (**hand v128**, word-hash) | 10.2 | **4.58×** |
| wasm-copy (+wasm-bindgen copy) | 14.4 | 3.24× |

(1.05 MP browser-cap size mirrors this: wasm-simd 4.80×.)

**Findings:**
1. **Porting to WASM alone = 3.4×, with exact FNV identity** (no hash migration, parity-clean).
   V8's codegen for the serial-hash + branchy byte loop is far worse than Rust's. Biggest lever.
2. **Hand-written v128 adds ~1.3× more → 4.6×.** Real, but a smaller step than JS→WASM.
3. **Autovectorization ≈ scalar in WASM** — the compiler did not vectorize the strided-RGBA
   reduction; only hand-coded `core::arch::wasm32` intrinsics unlock SIMD here.
4. **Copy overhead is ~0.8 ms (<6%).** wasm-copy ≈ wasm-scalar, so decoder-fused/"resident"
   telemetry buys almost nothing — the byte copy is cheap, arithmetic dominates. Final proof
   it is compute-bound, and that the earlier "fuse to eliminate the read" idea targets a
   non-bottleneck for this kernel.
5. **JS-side word-hash migration is not worth it** (clean 2-lane = 1.48×; fragile to alloc).
   The win is WASM, not a better JS hash.

### Recommendation

The shipped JS `analyzeProgressiveFrame` stays as-is — it is cached (`computeAndCachePassStats`)
and called a handful of times per image, so 46 ms → 10 ms is not user-visible today. The 3.4×
(exact) / 4.6× (hand-SIMD) win is only worth wiring if telemetry moves onto a hot per-pass or
per-update path; doing so means calling the `fstats` WASM kernel from the worker that already
holds `raw_converter_wasm`. The hand-SIMD kernel and benches are kept in-tree as proven
artifacts.

## WIRED FOR REAL (2026-06-17): exact-FNV WASM kernel in the frame-stats worker

After the flip-flop, the production wiring decision came down to one measured fact:

| variant (2.46 MP) | min ms | vs JS | hash |
|---|---|---|---|
| js-baseline | ~50 | 1.00× | exact FNV |
| **wasm-scalar (exact FNV)** | ~14 | **~3.7×** | exact FNV |
| **wasm-simd-exact (SIMD stats + exact FNV)** | ~14.6 | ~3.6× | exact FNV |
| wasm-simd (hand v128, word-hash) | ~11 | ~4.7× | **word-hash** |

**SIMD-vectorizing the stats buys nothing while the exact FNV hash is kept** (`wasm-simd-exact
≈ wasm-scalar`): the serial byte-wise FNV dependency chain is the critical path, and the stats
math runs in its shadow. The only way to go faster (hand-v128, 4.7×) is to *also* de-serialize
the hash via word-hashing — which breaks `frameHash` identity (dedup, exports, persisted hashes,
the unit test).

**Decision: ship the plain scalar exact-FNV kernel (~3.7×), not SIMD.** The extra ~1.25× from
word-hash is not worth breaking the hash contract on a cached, rare-call telemetry function. The
~3.7× comes purely from leaving the JS interpreter, not from SIMD.

**Integration (parity-clean, non-breaking):**
- `src/lib.rs` — production `frame_stats(pixels, width, height)` export (scalar exact-FNV full
  path + truncation-safe scalar path). Returns the numeric stat fields; `frameHashInt` is
  bit-identical to the JS FNV.
- `web/jxl-progressive-frame-stats.js` — `setFrameStatsWasm(fn)` DI seam. `analyzeProgressiveFrame`
  uses the injected kernel when present (assembling the same return shape incl. hex `frameHash`,
  `byteLength`, `truncated`, `validPixels`), and **falls back to the JS kernel on any error or
  when not injected**. Signature stays synchronous — no caller changes.
- `web/jxl-frame-stats-worker.js` — registers `frame_stats` into the seam after
  `raw_converter_wasm` initializes (independent of `PerceptualComparer`); `handleFrameStats` is
  now `async` and awaits init so the first stats call already uses WASM.

**Verified:** `frame_stats` is bit-exact vs the JS kernel (incl. `frameHash`) on full / truncated
/ zero-dim inputs; the DI path returns an identical shape+values object; JS unit tests still
5/5; shipped `pkg` + `web/pkg` rebuilt with `build-parallel-wasm.ps1 -Features parallel-wasm`
(keeps `process_orf` threading; `c-perceptual` omitted — it link-fails wasm).

The word-hash / hand-v128 kernels (`fs_core_fast`, `fs_core_simd`, `fstats_*` probes) remain in
`src/lib.rs` as bench-only artifacts documenting the 4.7× ceiling, not shipped.

## REVISED — shipped word-hash + native AVX2 (2026-06-17, after audit + "servers" requirement)

The user asked: why not fix+ship hand-v128, and does running on **servers** change the choice.

**Audit of `frameHash` consumers (decisive).** Every use is *within a single run* — consecutive-
pass dedup, per-session change-cache keys, unique-frame counts, and current-run human-readable
exports (`jxl-single-progressive.js`, `jxl-progressive-paint.js`). **Nothing** persists or compares
it across runs: no `localStorage`/OPFS/manifest/`writeFile`, nothing in `packages/` or the cache
(`pyramid-gallery` was a false hit — `.hash` = URL fragment). It is always a hex *string*, and the
unit test hardcodes no hash value. **Conclusion: the hash algorithm is free to change.** Word-hash
just needs to be stable + content-sensitive (tail included), which it is.

**So we shipped the word-hash hand-v128 wasm kernel (4.8×), not the scalar (3.7×).** Within a run
the worker's wasm load is sticky → hashing is homogeneous → dedup stays self-consistent. The JS
fallback stays byte-FNV (only used if wasm fails, and then uniformly for that whole run).

**Servers change it — yes.** Native AVX2 kernel added at
`crates/raw-pipeline/src/frame_stats.rs` (`analyze` / `analyze_scalar` / `analyze_avx2`): 8-lane
word-hash fully vectorized (`_mm256_xor_si256` + `_mm256_mullo_epi32`, 1 xor+1 mul per 8 px),
masked `min/max_epu8` alpha, `movemask` zero/rgb counts, `madd_epi16` luma. Runtime
`is_x86_feature_detected!("avx2")` dispatch; scalar fallback bit-identical (parity test passes).

**Cross-platform (2.46 MP, min ms/call):**

| platform | kernel | ms | vs JS |
|---|---|---|---|
| JS (browser) | byte-FNV | ~50–65 | 1× |
| **wasm (shipped)** | hand-v128 word-hash | ~13.5 | **~4.8×** |
| native scalar | word-hash | ~13.4 | ~4× |
| **native AVX2 (server)** | word-hash + 256-bit SIMD | **~4.7** | **~11–14×** |

(1.05 MP cell was background-noisy; the 2.46 MP row is the trustworthy comparison.)

**Why exact-hash SIMD was a dead end (and word-hash isn't):** FNV-1a is a serial recurrence —
unvectorizable for a single frame (proved: `fstats_simd_exact` ≈ scalar). The word-hash uses
independent lanes, which is exactly what lets *both* wasm v128 and native AVX2 vectorize it. On
native, AVX2 also vectorizes the hash itself (8 lanes in one `mullo_epi32`), which is why native
pulls ~2.9× ahead of wasm.

**Server wiring:** native call site is `raw_pipeline::frame_stats::analyze(pixels, w, h)`, ready
for the native pipeline. No N-API/binding wired (server runtime/binary not specified) — flag the
actual server entry point and I'll bind it. Run the native bench:
`cd crates/raw-pipeline; $env:RUSTFLAGS=''; cargo test --no-default-features --lib --release frame_stats::tests::native_bench -- --ignored --nocapture`.

**Verified:** native scalar==AVX2 parity test passes; shipped `pkg`+`web/pkg` rebuilt with the
word-hash `frame_stats` (stats-parity vs JS, hash stable + tail-sensitive); JS unit tests still 5/5.

New file: `crates/raw-pipeline/src/frame_stats.rs` (+ `pub mod frame_stats;` in its `lib.rs`).

## Files touched

- `web/jxl-progressive-frame-stats.js` — split-path improvements + `setFrameStatsWasm` DI seam (+ backup mirror).
- `web/jxl-frame-stats-worker.js` — registers + awaits the WASM `frame_stats` backend (+ backup mirror).
- `src/lib.rs` — production `frame_stats` export + truncation-safe kernel; bench-only `fstats_*` probes.
- `bench-frame-stats.mjs` — isolated-process A/B micro-benchmark.
- `bench-frame-stats-diag.mjs` — bottleneck diagnostic (hash vs stats vs load; proves compute-bound).
- `tools/frame-stats-flipflop.mjs` — JS vs WASM scalar/simd-exact/autovec/hand-SIMD/copy flip-flop.
- `pkg/` + `web/pkg/` — rebuilt with the `frame_stats` export (shipped). `pkg-bench/` = fast bench build.
