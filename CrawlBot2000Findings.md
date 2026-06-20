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

---

# `crates/raw-pipeline/src/cr2.rs`

**Branch:** `crawlbot/cr2-rs-20260620T2135` · **Status:** ✅ E1 SHIPPED; E2 deferred

## E1 — move reassembled raster into raw_buf ✅ SHIPPED

Multi-slice CR2 reassembly finalized with `raw_buf.clear(); raw_buf.extend_from_slice(&raster)` —
a full-frame copy-back. Replaced with `*raw_buf = raster` (O(1) move). The reassemble permute itself
is unavoidable (scatters slice columns into a fresh raster), but the copy-back is pure waste.

**Measured** (`cr2_finalize_membench`, 24 MP / 45 MB): eliminated copy = **5.1 ms** per multi-slice
decode; **−45 MB peak** during finalize (raster + raw_buf no longer coexist). Byte-identical; 13/13
cr2 tests pass. Single-slice files (`have_slices=false`) skip this block entirely — unaffected.

## E2 — zero-fill before LJPEG overwrite (DEFERRED)

`raw_buf.resize(total_pixels, 0)` zero-fills the decode buffer before `ljpeg::decode_tile` writes
every cell. The zero is dead work (~45 MB memset). **Deferred:** this is the uninit-skip class that
was already rejected crate-wide (D6, unsafe-surface / WASM-audit grounds). A safe version needs the
"decode_tile writes all `total_pixels` on Ok" invariant formally audited plus a guard that any short
write returns Err (buffer discarded). Not worth the unsafe surface for one memset under this crawl's
risk budget; recorded for a dedicated uninit-audit pass.

## Conclusion

E1 is a free, byte-exact win (**−5.1 ms + −45 MB peak** per multi-slice CR2). The only other cr2
memory lever (E2) is an unsafe uninit-skip in the previously-rejected class — deferred deliberately.
Memory bases covered.

---

# `crates/raw-pipeline/src/casabio_encode.rs`

**Branch:** `crawlbot/casabio-encode-rs-20260620T2150` · **Status:** ✅ F1 SHIPPED; F2/F4/F7/F8 analyzed

## F1 — drop discarded full-res RGB strip in alpha detection ✅ SHIPPED

`encode_variants` and the sidecar path called `alpha_strip(rgba)` to learn `has_alpha`, but
**discarded** the full-frame n*3 RGB strip it built in the same pass (the variants re-strip at their
own 3 sizes). Both sites now use `has_meaningful_alpha` — the same early-out alpha scan with **zero
allocation**.

**Measured** (`alpha_scan_membench`, 24 MP opaque RGBA, the RAW case):

| fn | median_ms | alloc/call |
|----|-----------|-----------|
| `alpha_strip` (old) | 55.19 | 68.7 MB (1) |
| `has_meaningful_alpha` (new) | **13.53** | **0 MB (0)** |

**4.1× faster + −68.7 MB allocation per call**, at **both** call sites — every RAW encode_variants
invocation. 146/146 lib tests pass. (RAW is always opaque, so the full strip was always built then
thrown away — pure waste.)

## Other casabio bases (analyzed)

- **F2 (strip_rgba_to_rgb per-level alloc) — DEFERRED.** Each no-alpha encode level allocates a
  fresh RGB strip though the `Encoder` handle is reused. A caller-held `&mut Vec<u8>` scratch would
  cut 2 allocs/variant-set; needs threading scratch through `encode_into`/`encode_distance_into`/the
  rayon `map_init`. Real but smaller than F1.
- **F4 (RGB16 unsharp `to_vec()` clone) — conditional.** Only when texture/clarity ≠ 0; the borrow
  contract makes the clone intrinsic unless the signature takes `Vec<u16>` by value. List-only.
- **F7 (encode() output Vec per call) — minor.** Output is the smallest buffer.
- **F8 (strided 4→3 strip not SIMD) — speculative speed**, not a reduction.

## Conclusion

F1 is a large, byte-exact win (**4.1× + −68.7 MB** per encode on the RAW path) shipped at two sites.
Remaining casabio levers (F2/F7) are incremental and need scratch threading; deferred. Bases covered.

---

# `crates/raw-pipeline/src/pipeline.rs` (tone cost-center)

**Branch:** `crawlbot/pipeline-rs-mt-20260620T2210` · **Status:** ❌ A-4 measured NON-WIN (reverted); A-3 deferred

## A-4 — parallel tone scratch hoist (for_each_init) — MEASURED NON-WIN, NOT SHIPPED

The parallel SIMD tone path (`process_into_simd` / `process_16bit_simd`) re-declares `[0f32; BLK]×3`
(BLK=2048, 24 KB) SoA scratch *inside* each per-block Rayon closure. The serial path hoists it
(PIPE-005); the parallel path could not. I replaced the `for_each` with `for_each_init`, which
allocates+zeros the scratch **once per Rayon job** and reuses it across blocks (safe; no unsafe
MaybeUninit). Compiles; parity preserved (max diff 1 u8 / 6 u16 — the documented SIMD tolerance).

**Measured (cross-build A/B, `process_simd_flip`, 24 MP, `--features parallel`, back-to-back):**

| build | process_simd (8-bit) | process_16bit_simd |
|-------|---------------------|--------------------|
| base (per-block scratch) | 73.4 ms | 77.4 ms |
| A-4 (for_each_init) | 76.1 ms | 79.6 ms |

A-4 is **within thermal noise and slightly *worse*** — **not shipped.** The discovery's "−288 MB
memset traffic @24MP" is a *static traffic* estimate that does not translate to wall-clock: the
24 KB stack scratch is L1-resident and zeroed-then-immediately-overwritten, so the store buffer + L1
absorb it entirely, overlapped with the per-block LUT-gather + SIMD-tone compute. for_each_init's
per-job closure capture adds marginal overhead with no compute benefit. **Lesson: byte-traffic
estimates are not latency; measure before believing a memset "win" on small, hot, overwritten
scratch.** Reverted clean.

## Other pipeline.rs bases (analyzed)

- **A-3 (process_rgba / process_16bit_scalar still scalar per-pixel tone) — DEFERRED (secondary
  path).** The plain RGB8 path was migrated to SoA `apply_tone_bulk` (3.71× measured), but the
  **RGBA8** and 16-bit-scalar entries still call per-pixel `apply_tone_fused`. Routing them through
  a 4-stride / u16 scatter variant of `simd_block_kernel` would give ~3.6× on those paths — real,
  but the consumers are secondary (Tauri direct-RGBA, 16-bit TIFF), not the RAW→JXL primary path,
  and it needs new kernel scatter variants + parity tests. Higher-effort, lower-priority; deferred.
- **A-8 (interleave pre_r/g/b into one pre_rgb LUT) — likely a loss.** The three channels gather by
  *different* per-channel codes, so a single `code*3` gather doesn't serve all three; the in-code
  PIPE-002 note already gates it behind a flip. Triples the table footprint. Skip.
- **A-7 (auto_wb_rggb serial) — rare fallback, already 64× strided.** Not on the hot path.

## Conclusion

pipeline.rs (the tone cost-center) is at its memory/compute floor for the **primary** RGB8 path. The
one MT-memory idea here (A-4) is a **measured non-win** — the per-block stack zeroing is free in
practice. The only remaining real lever (A-3, SoA SIMD for RGBA/16-bit) is a secondary-path speed win
deferred on effort/priority. No code shipped from this file; the negative result is the finding.

---

# `crates/raw-pipeline/src/jxl_casadecoder.rs` (BSD JXL decoder, `jxl-codec` feature)

**Status:** ⏸ F3/F5/F6 analyzed — DEFERRED to a jxl-codec build session

This whole module is gated behind `feature = "jxl-codec"` (jxl-ffi FFI over `external/libjxl`).
Benching/testing requires a full libjxl cmake build — out of this session's toolchain/time budget
(the GNU toolchain `dlltool` issue + a 10+ min libjxl build). Findings recorded for a codec pass:

- **F3 (extra-channel plane zero-fill) — correct-by-inspection, deferred.** Line 605 unconditionally
  `write_bytes(plane, 0, n)` for each extra channel, while the **main color buffer 26 lines above
  (579)** already gates the identical zero-sweep on `self.opts.allow_partial` with a comment proving
  libjxl writes every byte before `S_FULL`. The fix is a **1:1 mirror** of that proven gate (same
  invariant, same flag). Zero-risk; the existing `reads_back_one_planar_extra_channel` test covers
  it. Saves one full per-plane memory sweep on multi-band hyperspectral/depth decodes (0 for the
  common 0-extra photo). Not shipped only because I won't commit code I couldn't build+bench this
  session.
- **F5 (time_full_decode realloc + 4ch grayscale inflation) — measurement-path only**, low priority.
- **F6 (JXTC region materializes full tile-index Vec) — niche** (large grid + small viewport / AR
  tile-seam); read entries on demand inside the map_init closure. Deferred.

## Conclusion

Real but codec-build-gated. F3 is a trivial, zero-risk mirror of a proven gate and should be picked
up first in a dedicated jxl-codec session. Nothing shipped to keep the bench-gate honest.
