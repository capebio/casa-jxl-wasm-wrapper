# CrawlBot2000 — Memory & MT Crawl Findings

**Operator:** Claude Opus 4.8 (ultracode)
**Started:** 2026-06-20
**Worktree:** `C:/foo/rcw-crawlbot` (isolated from concurrent agent on `fix/packages-jxl-cache-*`)
**Base branch:** `crawlbot/base-20260620T2030`
**Bench gate:** every change measured with `flipflopMem.mjs` (memory) and/or native `flipflop` examples (speed). Parity verified before commit.

## Method

1. **Code-level sweep** — 7-cluster parallel deep-read of the whole pipeline (memory copies/allocs/transfers, MT-for-memory, math/speed).
2. **Perspective pass** — rank by gain × feasibility × benchability; cross-reference `docs/EncDecMemoryBottleneck.md` (M1–M13) and landed MT work.
3. **Implement + bench** — one file per branch (`crawlbot/<file>-<datetime>`), bench-gated, parity-checked, committed only on a measured win.

## Git protocol

- One branch per file, named after the file + datetime, off `crawlbot/base-20260620T2030`.
- Rejected/no-win experiments are recorded here but reverted (not committed).
- Concurrent agent owns `packages/jxl-cache/**` and `packages/jxl-wasm/src/loader.ts` — **untouched**.

---

<!-- File chapters appended below as work completes. Each ends with a Conclusion. -->

---

# `crates/raw-pipeline/src/perceptual/mod.rs`

**Branch:** `crawlbot/perceptual-mod-rs-20260620T2045` · **Commit:** `7b3c6725` · **Status:** ✅ SHIPPED

## PERC-12 — eliminate level-0 plane clone in `Comparer::new`

**Finding (C-1, my P1).** The pyramid-construction loop cloned the full-res XYB planes
(`cx.clone()`, `cy.clone()`, `cb.clone()`) into each non-last `Level` *before* downsampling —
3× full-res f32 clones at level 0, 3× half-res at level 1. The clone existed only so the
originals stayed alive to feed `dn2_into` for the next level.

**Fix.** `dn2_into` only *reads* its source and writes into separate `nx/ny/nb` buffers, so the
planes can be **moved** into the `Level` and **borrowed back** for the downsample:

```rust
levels.push(Level { x: cx, y: cy, b: cb, mask, w, h });
let lvl = levels.last().expect("level just pushed");
butteraugli::dn2_into(&lvl.x, &mut nx, w, h, dw, dh);   // read-only, separate target
// … cx = nx; cy = ny; cb = nb;
```

NLL releases the `lvl` borrow before the next `levels.push`. Move-vs-clone is **byte-identical**.

## Measurement

Counting global allocator (`examples/perc_construct_membench.rs`) — peak/resident/alloc-count/time
per `Comparer::new`. A/B = base (clone) vs branch (move). Peak & alloc-count are deterministic;
time is median-of-7.

| size | metric | base (clone) | branch (move) | Δ |
|------|--------|-------------|---------------|---|
| 1024² | alloc_count | 29 | **23** | −6 allocs |
| 1024² | median_ms | 31.98 | **26.95** | **−15.7%** |
| 2048² | alloc_count | 29 | **23** | −6 allocs |
| 2048² | median_ms | 140.17 | **122.42** | **−12.7%** |
| 4096² | alloc_count | 29 | **23** | −6 allocs |
| 4096² | median_ms | 598.73 | **491.06** | **−18.0%** |
| 4096² | peak_transient_MB | 784.0 | 784.0 | **0 (unchanged)** |

**Honest correction to the hypothesis.** I (and the discovery agent) predicted a "−288 MB peak"
win. **Wrong.** The *global* peak RSS is unchanged: it is set by the **required resident** scratch
(`tx/ty/tb/dx/dy/db` = 6×n f32 ≈ 402 MB @4096²) allocated *after* the construction loop, which
exceeds the transient clone peak reached *during* the loop. The clone elimination removes 6 large
allocations and ~288 MB of memcpy **traffic** (the copies themselves), which is what produces the
13–18 % faster construction — but it does **not** lower the high-water mark. Verified by direct
measurement, not asserted.

- **Parity:** 27/27 perceptual lib tests pass; move and clone produce bit-identical pyramids.

## Conclusion

`Comparer::new` is **13–18 % faster** and does **6 fewer heap allocations** per construction,
eliminating ~288 MB of clone memcpy traffic at 24 MP — a real setup-cost and memory-bandwidth win
on the perceptual quality-gate / Butteraugli-chart path. **Peak RSS is unchanged** (floored by the
required reusable test scratch), so this is a speed + allocator-pressure win, not a peak-memory win.
Shipped; low risk; byte-exact. The measurement tool (`perc_construct_membench.rs`) is reusable for
the rest of the crawl.
