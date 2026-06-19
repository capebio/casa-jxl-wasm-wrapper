# Single progressive JXL encode vs three independent encodes — flipflop findings

**Date:** 2026-06-19 · **Branch:** `ProgressiveJXLEncodeBunch` · **Vehicle:** flipflop (Node, WASM jxl-core `simd` tier — the encoder the delivery layer actually uses)
**Harnesses:** `.flipflop/tests/prog-vs-3pass.mjs` (time+memory), `.flipflop/tests/prog-vs-3pass.delta.mjs` (bytes + final-quality Butteraugli), `.flipflop/tests/prog-tier-quality.mjs` (per-progression-step quality via the **production async decoder**).

## Question

The ADR draft proposed deriving all three delivery tiers (thumb/preview/full) from **one** progressive JXL encode (`ProgressiveDc` + `GroupOrder`), claiming "~2/3 encode-CPU + storage reduction" and retirement of the `profileJxl` re-decode. This investigation measured whether that holds, across **timings, memory, and delta (per-tier quality + bytes)**.

## Candidate algorithms flipflopped

| id | what | notes |
|---|---|---|
| `three-pass` | status quo: downscale cascade + 3 independent non-progressive encodes (thumb ≤300px E1, preview ≤1080px E3, full native E3) | baseline |
| `single-nonprog` | encode the full image **once**, non-progressive | decomposition control = floor for "one encode" |
| `single-prog` | encode full **once**, full progressive (DC + AC + qAC + groupOrder) | the smooth-refinement option |
| `single-prog-dc` | encode full **once**, DC-only progressive (`progressiveDc=2` + groupOrder, no spectral AC) | the cheap progressive option |

## Results

### 1. Timings (3 runs, fbm corpus; box is thermally noisy → `trust:low`, but the sign & magnitude are consistent across all runs + corroborated by `min_ms` and the decomposition control)

| size | three-pass | single-nonprog | single-prog (full AC) | single-prog-dc |
|---|---|---|---|---|
| 2048² (median / min) | 886 / 780 ms | **588 / 454 (−34%)** | 964 / 750 (**+8.7% SLOWER**) | 645 / 535 (−27%) |
| 4096² (min_ms) | 2330 ms | 1507 (−35%) | 2196 (−6%) | 1607 (−31%) |

**The "~2/3 CPU saving" claim is false.** The full-res encode dominates (full ≈16MP vs preview ≈1.2MP vs thumb ≈0.09MP), so the three passes are **not** 3× the work — the two small encodes are only ~8–30% of it. Decomposition:
- **DC progression is ~free** (`single-prog-dc` ≈ `single-nonprog`).
- **Spectral AC progression is expensive** — `single-prog` (full AC) costs *more* than the two small encodes it would replace, so it is **slower than the 3-pass baseline**.
- The only real CPU lever among these is *dropping the two small encodes* (≈ `single-nonprog`, −34%); `single-prog-dc` captures most of that (−27%) while staying progressive.

### 2. Memory — a wash

All variants ≈ **380–387 MB** RSS (the WASM heap dominates). `three-pass` is marginally higher (~+5 MB) for the downscale buffers. Memory does not differentiate the architectures.

### 3. Delta

**Final (full-tier) quality — preserved.** Butteraugli vs original is identical across all three (e.g. @2048: three-pass 0.356 / single-prog 0.357 / single-prog-dc 0.355). Progressive costs ~nothing in final quality.

**Storage — win evaporates at realistic sizes.** Total bytes for all tiers vs 3-pass: −47% @1024 → −20% @2048 → **−3% @4096**. Cause: a progressive encode **inflates the full file ~8–11%** (943K→1021K @2048), which nearly cancels the dropped thumb+preview blobs once the full file dominates (i.e. at real RAW resolutions).

**Early-preview quality-per-byte — REGRESSES badly (the decisive finding).** Measured with the production async progressive decoder (per-step, byte-stamped like `profileJxl`):
- At the **thumb byte budget (~40K)**, a 2048² progressive stream has emitted **no frame at all** — its first decodable DC lands at ~90–164K (8–16% of the file). A dedicated 300px thumb is a complete, good image at 40K (Butteraugli 0.388).
- At the **preview byte budget (~330K)**, the progressive stream is **~2.5× worse** than the dedicated 1080px preview (0.95–1.05 vs 0.38 @2048).
- No intermediate progressive pass reaches the dedicated full quality — only the **final** (100%) frame does.
- `single-prog-dc` is **strictly inferior** to `single-prog` at every budget (later first frame, worse per byte), tying only at the final frame — so `progressiveDc=2` buys nothing over full AC on quality.

**Root cause:** a progressive stream of a full-resolution (16–24 MP) image is intrinsically byte-inefficient at *small* display sizes — its prefix carries full-res low-frequency data, whereas a dedicated small encode is a complete image in a fraction of the bytes. Dedicated downscaled tiers win quality-per-byte at their display size; that is fundamental, not tunable.

## Verdict — the ADR's "one progressive encode for all tiers" is NOT the optimal route

| factor | one progressive stream | conclusion |
|---|---|---|
| encode CPU | no win (full-AC slower; DC-only faster only by dropping small tiers, and it's quality-inferior) | ✗ |
| memory | wash | – |
| final quality | preserved | ✓ |
| storage @ real RAW sizes | ~−3% (progressive inflates the full file) | ~neutral |
| early-preview quality/byte | ~2.5× worse; no thumb-budget frame | ✗ (bad for a bandwidth-sensitive gallery) |

The single-stream approach is a **delivery-simplicity / graceful-refinement** play (one Range-fetchable file + true delta-append refinement via `fetchTierWithPrefix`, which 3 separate blobs can never do), **not** a performance play. For a biodiversity gallery where fast thumbnails and field/offline bandwidth matter, the byte-efficiency regression is a real cost.

## Recommended optimal route

**Keep dedicated, byte-efficient `thumb` + `preview`; make only the `full` tier progressive** using the cheap knobs (`progressive_dc` + `group_order`; skip `qProgressiveAc` — it adds ~8% time + storage for refinement smoothness that only benefits the full tier's tail).

- This is **CPU-neutral** vs the status quo (DC progression on the full tier is ~free) but adds graceful big-image loading + `fetchTierWithPrefix` delta-append for the one tier where it matters (the large download), and preserves the small tiers' quality-per-byte.
- It is a **small change** — `casabio_encode::encode_variants` already routes progressive opts to the full tier only (`casabio_encode.rs:180-185`); the work is to default the full tier to `progressive_dc`/`group_order` and emit its tier offsets.
- libjxl exposes **no API** to report per-pass byte offsets during encode (verified, `encode.h`), so retiring `profileJxl` entirely is blocked; a decode-side section scan of the *single full progressive tier* (not the whole 3-blob set) is the lighter replacement.

**If pure ingest-CPU reduction is the real goal:** the only meaningful lever here is *dropping the dedicated preview tier* and serving preview from the progressive full prefix — saves ~20–30% encode at realistic sizes but at a measured ~2.5× preview-quality-per-byte cost. That is an explicit product tradeoff (ingest speed vs gallery card quality), not a free win. The dominant cost is the full encode itself; to cut it, tune the full encode's effort/quality or parallelism, not the tier count.

## Reproduce

```
node --expose-gc flipflop.mjs .flipflop/tests/prog-vs-3pass.mjs --print            # time + memory
node --expose-gc .flipflop/tests/prog-vs-3pass.delta.mjs                            # bytes + final-quality delta
node --expose-gc .flipflop/tests/prog-tier-quality.mjs                              # per-step tier quality (async decoder)
```
Sizes via `PROG_SIZES=1024,2048,4096`; quality via `FULL_Q`/`TIER_Q`. Numbers above are fractal (`fbm`) corpus; the final quality gate should be re-confirmed on a real organism-image corpus before any default change (per the ADR gate).
