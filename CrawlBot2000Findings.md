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

---

# `src/lib.rs` (root WASM crate)

**Branch:** `crawlbot/src-lib-rs-20260620T2110` · **Commit:** `<A-1>` · **Status:** ✅ A-1 SHIPPED; A-2/A-5/A-6/A-9 analyzed

> Toolchain note: the root crate does **not** native-check on the GNU toolchain (`dlltool.exe not
> found` from a libjxl/jpegxl transitive dep). Use **MSVC**: `cargo +stable-x86_64-pc-windows-msvc
> check/test --no-default-features --lib` (≈3.5 min). End-to-end `process_orf` benching needs a
> wasm-pack build + flipflopMem; native proxies used here measure the eliminated work directly.

## A-1 — skip preview demosaic + downscales when no preview requested ✅ SHIPPED

`decode_orf_raw` unconditionally ran the full-res planar bilinear demosaic (`demosaic_rggb_planar`)
+ two `downscale_rgb16_planar` calls to build the lightbox/thumb previews — *before* it knew the
output flags. A pure `OUT_FULL_RGB8` batch-encode (no `OUT_LIGHTBOX`/`OUT_THUMB`) then **discarded**
those buffers in `process_orf_impl`. Threaded `output_flags` into `decode_orf_raw` and gated the
whole preview build on `need_previews = flags & (OUT_LIGHTBOX|OUT_THUMB) != 0`. The MHC demosaic
(the `OUT_FULL_RGB8` source) is independent and always runs.

**Measured skipped cost** (`planar_demosaic_membench`, 5184×3888 = 20.2 MP, the dominant skipped
piece — the 2 downscales live in the root crate and add more):

| metric | value |
|--------|-------|
| transient alloc | **115.3 MB** |
| alloc count | 3 (already direct-to-planes; the old interleaved-alloc is gone in this tree) |
| median time | **86.1 ms** |

So **~86 ms + 115 MB saved per `OUT_FULL_RGB8`-only image** (plus the 2 downscales). A 100-image
batch encode → **~8.6 s** + ~11.5 GB of alloc traffic avoided. Like C-1, the *global* decode peak is
not reduced (the planar planes are dropped before the MHC `rgb16` alloc, so they don't coexist) — the
win is wall-clock + allocator pressure. `OUT_FULL_RGB8` output is **byte-identical** (those previews
were already discarded in that case). MSVC check + 5/5 root lib tests pass.

## Other lib.rs memory bases (analyzed)

- **A-2 (LookRenderer retained output buffer) — NOT A CLEAN WIN, skipped.** `render()` returns
  `Vec<u8>`; wasm-bindgen copies it to JS and frees it regardless. A retained `RefCell<Vec<u8>>`
  would still need a `clone()` to produce the return Vec → trades the output zero-init for a copy
  pass (a wash), unless the return ABI changes to write into a JS-provided buffer (API change,
  touches JS callers — out of scope, and the concurrent agent owns parts of the JS layer).
- **A-5 (pack_rgb16_full doubles the full-res buffer) — REAL ~120 MB PEAK WIN, DEFERRED.** The
  discovery's "transmute `Vec<u16>`→`Vec<u8>` in place" is unsound *as proposed*: `rgb16` is still
  read by the `OUT_FULL_RGB8` tone path **after** packing (the common flag `15` sets both
  `OUT_FULL_RGB8|OUT_FULL_16`). A safe version must reorder the output assembly to pack **after**
  the tone path's last read of `rgb16`, then move-transmute it. This is the rare win that *does*
  lower peak RSS (the two ~121 MB buffers currently coexist), but the reorder is medium-risk under
  3.5-min build iteration. Deferred to a focused WASM-batch session; documented for safe pickup.
- **A-6 (rgb_to_rgba 255-prefill) — micro, skipped.** SIMD path force-sets alpha anyway; only the
  scalar tail relies on the prefill. Sub-noise; not worth the unsafe set_len.
- **A-9 (string getters clone) — non-win.** wasm-bindgen getter ABI requires an owned `String`; a
  borrow can't cross the boundary. Recorded to pre-empt re-flagging.

## Conclusion

A-1 is a solid, byte-exact batch-encode speedup (**~86 ms + 115 MB/image**) — shipped. The remaining
peak-RSS lever in this file is A-5 (~120 MB on the 16-bit export path), deferred only because a safe
implementation needs an output-assembly reorder best done in a dedicated WASM-bench session, not
under slow MSVC iteration. A-2/A-6/A-9 are washes or ABI-bound non-wins. Memory bases covered.
