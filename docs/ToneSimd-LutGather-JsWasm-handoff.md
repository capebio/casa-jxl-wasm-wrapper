# Handoff — Tone path next steps: LUT gather + JS↔WASM boundary

**Context.** `tone_simd.rs` is optimised (rounds 1–3: AVX2/wasm/scalar, `M'` collapse,
luma decouple). The tone *math* is now ~19–24 ms for a 20 MP frame (single-thread). The
end-to-end tone stage is **gather-bound**: the random-access LUT lookups in the caller
dominate, not the arithmetic. The fused primitive `apply_tone_fused_u16_u8` is wired in
but **dormant** — on an isolated bench it runs ~0.80–0.89× the two-pass because it removes
an L1-cheap SoA round-trip while the gathers (unchanged) set the floor. It flips to a win
once the items below lower the gather / boundary cost.

**Measurement of record** (`cargo run --release --no-default-features --example
tone_fused_bench`, 8 MP, single-thread):
- vib_zero: two-pass ~60 ms · fused ~75 ms (0.80×)
- vibrance: two-pass ~65 ms · fused ~73 ms (0.89×)

**Quality gates (Blueprint Ch.7).** Value-preserving changes (faster, same output) need only
byte-parity vs the current path. Any change that alters pixels (precision reduction, curve
approximation) requires golden corpus + SSIM + Butteraugli before merge.

**Contention warning.** `crates/raw-pipeline/src/pipeline.rs` has uncommitted changes from
another active session. Rebase/coordinate before editing; do not clobber.

---

## Task 1 — Measure the gather (establish the floor) — DO FIRST

**Goal.** Quantify what fraction of `process_into_simd` is pre-LUT gather vs tone vs
post-LUT, so the rest of this handoff is evidence-driven (Blueprint Ch.10 step 1).

**Where.** New bench in `crates/raw-pipeline/examples/` (or extend `pipeline_profile.rs`).

**Do.** Time, over a real 20 MP frame: (a) pre-LUT gather only (u16→f32 SoA), (b)
`apply_tone_bulk` only, (c) post-LUT only (f32→u8), (d) full `process_into_simd`. Report
each as % of (d), single-thread and with rayon.

**Accept.** A table proving gather dominance (expected: a+c ≫ b). If tone (b) is actually
non-trivial under rayon, re-prioritise.

---

## Task 2 — Shrink the pre-LUT to a cache-resident domain (biggest suspected win)

**Goal.** The pre-LUTs are 65536×u16 ×3 = 384 KB — far past L1/L2, so every pixel's gather
is a cache miss. Shrink the index domain so the LUT lives in L1.

**Where.** `pipeline.rs` — `ensure_lut`, `LUT_CACHE`, `process_into_simd` fill loop.

**Approach (measure each).**
1. **12-bit domain.** ORF is 12-bit and DNG often 12–14-bit. If the demosaic output is
   effectively ≤12 significant bits, index the pre-LUT by `value >> shift` (4096 entries =
   8 KB ×3 = 24 KB, L1-resident). **Pixel-changing → SSIM/Butteraugli gate.** Verify the
   true bit depth from `tiff.rs`/`dng.rs` before assuming.
2. **Fold what is linear into the matrix.** WB gains and exposure are linear → they belong
   in `M`, not in a per-channel LUT. Keep only the genuinely non-linear pre-curve in the
   (now smaller) LUT. Reduces both LUT size and a multiply.
3. **SIMD gather** (`_mm256_i32gather_epi32`, 8 indices/instr) as a fallback if the domain
   can't shrink — uncertain; gather throughput is µarch-dependent, bench before adopting.

**Accept.** ≥X% reduction in pre-LUT time (Task 1 baseline). Byte-parity for (2);
SSIM/Butteraugli within budget for (1).

---

## Task 3 — Post-LUT: SIMD or computed curve

**Goal.** Post-LUT is 65536×u8 = 64 KB (L2) + a scalar `clamp→as u16→gather→u8` per
channel (the measured ~160 ms / 10%).

**Where.** `pipeline.rs` `process_into_simd` post loop; LUT build in `ensure_lut`.

**Approach (measure each).**
1. **Computed curve.** The post-LUT is a monotone tone curve (sRGB OETF + shoulder). Replace
   the gather with a SIMD polynomial / `pow` approximation evaluated in `__m256` — no gather
   at all. **Pixel-changing → SSIM/Butteraugli gate**; tune approximation error to ΔE budget.
2. **12-bit post domain** (as Task 2.1) → 4 KB LUT, L1.
3. **SIMD gather + narrow** if a LUT must stay: gather 32-bit lanes, pack to u8.

**Accept.** Post-LUT time down measurably; visual gate passed for any curve approximation.

---

## Task 4 — Keep buffers in WASM; no Uint8↔Float32 between layers (Blueprint Ch.2)

**Goal.** Stop the decoded RGB buffer from being copied/converted as it crosses
WASM→worker→main, and never round-trip u8↔f32 in JS.

**Where.** `packages/jxl-wasm/src/facade.ts` (heap views), `packages/jxl-worker-browser/src/
decode-handler.ts`, `worker.ts`, `src/lib.rs` (`process_orf`/`process_dng` return path).

**Do / audit.**
- Confirm `process_orf`/`process_dng` output is read as a **view into WASM linear memory**
  (zero-copy) and transferred as an `ArrayBuffer`, not `slice().to_vec()`-copied first.
- Grep the worker/session path for any `new Float32Array(uint8…)` / `Uint8Array(float…)`
  conversions between layers — eliminate; keep one representation end-to-end.
- Respect the invariants: transferred `ArrayBuffer`s **detach** (no pooling — CLAUDE.md), and
  `SharedArrayBuffer` needs COOP/COEP. Do not add a pixel pool or drain callback (rejected).

**Accept.** One copy from WASM heap to the transfer buffer, zero JS-side format conversions;
no detach/pooling regressions.

---

## Task 5 — Re-bench and wire the fused primitive once gather is cheaper

**Goal.** After Task 2/3 lower the gather floor, `apply_tone_fused_u16_u8` (no SoA
round-trip, no per-block zeroing) should beat the two-pass.

**Do.** Re-run `tone_fused_bench` after each Task-2/3 change. When fused > two-pass, wire it
into `process_into_simd`'s per-`par_chunks` shard (replaces the zeroed-block fill → tone →
post sequence). One-line switch near `pipeline.rs:1182`, guarded so a regression can't ship.

**Accept.** fused ≥ 1.0× in the bench, then end-to-end `process_into_simd` faster than today
on a real frame (Task 1 harness), byte-parity preserved.

---

## Suggested order

1 (measure) → 2 (pre-LUT shrink — likely the big one) → 3 (post-LUT) → 5 (re-bench/wire fused)
in the Rust/`pipeline.rs` lane; 4 (JS↔WASM boundary) in parallel by whoever owns the worker
layer. Keep `tone_simd.rs` itself frozen — it is done; the remaining tone wins are all in the
caller and the boundary.
