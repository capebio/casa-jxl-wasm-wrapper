# Pyramid vs Downsample-on-demand — Gobabeb gallery measurement (2026-06-20)

**Question** (from the traversal-report #2 discussion): a 4× downsample is only ~10 ms, so does it make sense to skip the pyramid — store only the full JXL, and downsample on demand for thumbnails?

**Answer: no, decisively, on every axis** — for a gallery. The ~10 ms was a *post-decode* pixel shuffle; the real cost of "downsample on demand" is the **full-resolution decode** it requires, which the pyramid avoids entirely. Generating the pyramid at ingest is nearly free; serving from it is 20–300× cheaper in CPU and ships 20–220× fewer bytes.

## Setup

- **Corpus**: Gobabeb ORF set (`C:\995\2026-02-20 Gobabeb To Windhoek`, 218 files available). Measured on **16 files**, Olympus ~3912×5240 (20 MP), ~17–21 MB each.
- **Phase A — ingest (server side, once)**: `tools/gob-pyramid-ingest.mjs`. Decode ORF→RGBA, encode full-size JXL (stored master), then generate 256 + 1024 long-edge thumbnail JXLs (timed start→stop). Artifacts written to a temp store = simulated server.
- **Phase B — gallery retrieval (A/B, interleaved)**: `.flipflop/tests/pyramid-vs-downsample-gallery.mjs`. Per file: `downsample` = read full JXL → decode full-res → resize to target; `pyramid` = read pre-stored target-size JXL → decode. flipflop interleaves the two to cancel machine/IO drift. Measures **decode+resize CPU**; transfer bytes modeled separately (local disk can't simulate network).
- **Caveat**: JXL decode/encode here is **scalar WASM** (no SIMD, no threads). Native+threaded decode is ~10× faster — so treat absolute ms as scalar-WASM; the **ratios and the byte/scaling arguments are toolchain-independent** and the verdict holds under native (see extrapolation below).

## Phase A — ingest cost (16 files)

| stage | per file | share |
|-------|---------:|------:|
| raw ORF decode | 1348 ms | — |
| full JXL encode | 5677 ms | — |
| **thumbnail gen (256+1024)** | **249 ms** | **3.4% of ingest** |

- Stored bytes: 278 MB source ORF → 44.8 MB full JXL + **0.2 MB (256) + 1.6 MB (1024)** sidecars.
- **Pyramid storage overhead: +4.0%** of the full-JXL bytes.
- You already pay the decode+full-encode to store the master; adding both thumbnail levels costs **+3.4% time, +4% bytes**. Effectively free.

## Phase B — gallery retrieval CPU (16 files, interleaved, scalar WASM)

| target | downsample (full decode + resize) | pyramid (read level + decode) | pyramid faster | trust |
|--------|----------------------------------:|------------------------------:|---------------:|-------|
| **256** | ~4.2–8.7 s/file | ~12–25 ms/file | **99.7%** (~300×) | downsample high* |
| **1024** | ~3.3–6.1 s/file | ~150–290 ms/file | **95.3%** (~21×) | high |

**Gallery-of-16 CPU total**: at 256 — pyramid **~0.26 s** vs downsample **~85 s**. At 1024 — pyramid **~2.9 s** vs downsample **~62 s**.

\* Some downsample rows are `trust:low` from background machine load during the long run — but the effect size (20–300×) dwarfs any variance, and flipflop's interleave protects the *ratio* even when the absolute wobbles. The cost is the full 20 MP decode (~3.5 s scalar); resize is only ~5–15 ms of it.

## The network dimension (modeled from ingest bytes)

"Downsample on demand" must get full-res pixels first. Two placements, both lose:

**Client-side downsample** — ship the full master to every client:
| gallery of 16 | bytes shipped | @ 4G (1.5 Mbps) | @ 50 Mbps |
|---|---:|---:|---:|
| pyramid 256 | 0.2 MB | ~1.1 s | ~0.03 s |
| pyramid 1024 | 1.6 MB | ~8.5 s | ~0.26 s |
| downsample (full) | **44.8 MB** | **~239 s** | **~7.2 s** |

Plus the client then decodes 16 × 20 MP. Infeasible for a grid.

**Server-side downsample** — trades transfer for **server CPU**: ~60–85 s of full-res decode per gallery load (16 files), **uncached and unscalable**. Caching the result = storing derivatives = a pyramid, just built lazily.

## Verdict

| axis | pyramid | downsample-on-demand |
|------|---------|----------------------|
| ingest add'l cost | +3.4% time, +4% bytes | none |
| retrieval CPU (256 / 1024) | 16 ms / 183 ms per file | **5.3 s / 3.9 s** per file |
| web transfer (16-img grid) | 0.2 / 1.6 MB | **44.8 MB** (or move cost to server CPU) |
| scales to many images / clients | yes | no (per-request full decode) |

The 9.8 ms downsample is the right tool **only** for "I already decoded the full-res image in-client and want a different exact size" (single-image zoom). For a **gallery of many**, the pyramid wins on ingest-cheapness, retrieval CPU, transfer bytes, and scalability simultaneously. Keep the pyramid.

### Native extrapolation (scalar→native ~10× decode)
Even with native threaded decode: downsample 256 ≈ ~350–450 ms/file, pyramid ≈ ~2–3 ms/file → still **~100–150×**. The transfer (44.8 MB) and server-scaling arguments don't change at all. Verdict unaffected.

## Reproduce
```
node tools/gob-pyramid-ingest.mjs                  # GOB_LIMIT=16 default; writes temp store + manifest
GOB_TARGET=256  GOB_ROUNDS=3 node --expose-gc flipflop.mjs .flipflop/tests/pyramid-vs-downsample-gallery.mjs --print --no-metrics
GOB_TARGET=1024 GOB_ROUNDS=3 node --expose-gc flipflop.mjs .flipflop/tests/pyramid-vs-downsample-gallery.mjs --print --no-metrics
```
Quality not measured (time was the axis); the two paths produce same-dim but not bit-identical pixels (pyramid level = separately-encoded resize at grid quality; downsample = resize of full-quality decode).
