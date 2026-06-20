# ScannerBot Lenses

A lens taxonomy for sweeping this codebase. Each **Category** is a self-contained
lens-set ordered top-down by level: **strategic** (A) → **structural** (B) →
**algorithm** (C) → **kernel/memory** (D) → **code & mathematics** (E, the lowest),
plus a cross-cutting **safety** category (F). Categories are independently selectable:
a sweep may request "Category A and C" and skip the rest.

Every lens is generalized from a change that **actually succeeded here** (cited by
short SHA, with measured result where one exists). The point is not novelty — it
is to re-find the *shapes of win this repo has repeatedly paid out on*.

Two overlays (**V — Verification**, **X — Anti-lenses**) are **mandatory on every
sweep regardless of category** and are not individually selectable.

---

## How to invoke a sweep

> "ScannerBot, sweep `crates/raw-pipeline/src` with **Category A + C**."

- Pick categories by leverage you want, not by file. A+C = architecture + algorithm
  (skip kernel micro-opts and FFI-boundary nits). D alone = a hot-path tuning pass.
  E alone = a correctness audit.
- Lens IDs are stable (`A1`, `C4`, …) so a sweep can narrow further: "A1–A3, C5".
- Overlays V and X always apply. A finding that violates X is dropped on sight; a
  finding that cannot pass V's gate is deferred, never committed.

| Want… | Pick |
|-------|------|
| Re-think structure / where things live | **A** (+ B for the seams) |
| **Speed / performance** | **C → D → E** (C highest-yield; E lowest grain) |
| Hot-loop / kernel & memory tuning | **D** |
| Instruction- & math-level tuning | **E** |
| Pre-release safety pass | **F** (+ B) |
| "Find anything" | A–F (expensive; expect mostly C/D/E hits) |

**Performance is concentrated in C, D and E — the three lowest levels.** **C**
(algorithm & data — the *seam*-level wins) is highest-yield; **D** (kernel & memory)
is data-movement tuning; **E** (code & mathematics) is the finest grain — algebraic
fusion, transcendental→LUT, strength reduction, CSE/branchless. A pure speed sweep is
**C + D + E**. `A3`/`A4` carry perf too (lifecycle pooling, work placement) but at
architectural scale.

---

## Category A — Strategic: whole-system architecture

**Scope:** cross-file, cross-layer. ADR-worthy. Rare, highest leverage.
**Output kind:** `adr_draft` for ratification — **never a unilateral edit.**

- **A1 Layer-boundary leak** — a responsibility implemented in the wrong layer.
  Backpressure outside the scheduler/worker boundary; dedupe outside `scheduler.ts`;
  session-protocol knowledge in cache/stream; format validation outside libjxl.
  *Proven:* the entire "Layer Invariants" contract in `CLAUDE.md`; `cef45ac0`
  (backpressure cleanup belongs at scheduler, not session).
- **A2 Dependency ownership** — a heavy/licence-encumbered dep that should be owned
  in-repo. *Proven:* `988f8b94` GPL `jpegxl-rs` → BSD `jxl-ffi` clean-room crate.
- **A3 Lifecycle / handle ownership** — repeated expensive construct/destroy that a
  RAII owner or pool collapses. *Proven:* `4dd9d75e` decoder-pool (reuse JxlDecoder
  across sessions); `jxl_casadecoder`/`jxl_casaencoder` RAII handle reuse.
- **A4 Pipeline placement** — work done per-request that belongs at ingest, or
  per-frame work that belongs once-per-session. *Proven:* pyramid sidecar built at
  ingest (RAW decode is the cost centre); session-level budget, not per-stage.

**Gate:** ADR draft + human sign-off. Cite the layer invariant it restores.

---

## Category B — Structural: module, interface, contract

**Scope:** one crate/package, or one seam between two. Edits land if the contract
on the other side is pinned and a non-build check exercises it.

- **B1 ABI / struct-stride drift** — producer and consumer disagree on record size
  or field order across an FFI/serialization boundary. *Proven:* `89e9b787`
  TS wrote 72-byte extra-channel records; C++ read 20-byte (heap corruption ≥2 EC).
- **B2 Flag / bit-field collision** — two constants share a bit. *Proven:* `b08c0d31`
  `OUT_NO_ORIENT` and `OUT_FULL_16` both = 8.
- **B3 Feature-gate hygiene** — a native-only / heavy path not excluded from WASM or
  not behind a `cfg`/feature. *Proven:* `f3bcc8fe` parallel gates under
  `cfg(feature="parallel")` so WASM is unaffected; `jxl-codec` gating pattern.
- **B4 State-machine completeness** — an unhandled state, off-by-one loop bound, or
  cleanup path that can hang/leak. *Proven:* `a335474f` idle-reap loop bounds;
  `cef45ac0` paused-cancel/shutdown unblock.
- **B5 Cross-package protocol wiring** — types/error-codes/metadata that drift between
  packages. *Proven:* `c6645a86` EncodeOptions + error codes + metadata wiring.

**Gate:** typecheck/unit test on the *consumer* side of the seam; parity if data-shape.

---

## Category C — Subsystem: algorithm & data structure

**Scope:** within a module. The repo thesis — *wins live in seams, not functions.*
This is the highest-yield perf category here.

- **C1 Algorithm swap** — a general-purpose routine where a domain-specific one
  suffices. *Proven:* `0d97a90e` SHA-256 → FNV-1a (−69%; filenames need no crypto).
- **C2 Serialization format** — verbose text where tight binary wins (server/native).
  *Proven:* `0d97a90e` JSON → binary manifest (−73%). *(See X6: loses in-browser.)*
- **C3 Cache-invalidation granularity** — rebuild-everything where dependency sets are
  disjoint. *Proven:* `64b3a37b` LUT-cache split: tone-drag −65%, wb/exp-drag −35%;
  `96cb4373` scheduler dirty-flag.
- **C4 Domain shrink** — oversized table/precision the output doesn't need.
  *Proven:* `17abde03` compact 4096-entry strided pre-LUT; `64b3a37b` sRGB EOTF as a
  cached lerp (build 91% faster, ≤1 LSB).
- **C5 Traversal / kernel fusion** — two passes over the same buffer that fuse into
  one (bandwidth, not flops). *Proven:* `9d67106a` frame-stats + histogram (1.36×,
  26.6% bandwidth); `9ba556aa` single-pass PSNR+SSIM.
- **C6 Zero-copy boundary** — a copy at a layer hand-off that a shared reference or
  borrow removes. *Proven:* `28ea1364` drop SAB→ArrayBuffer copy at pixel emit
  (99.5–100%); `678aa16e`/`bd83d389` SAB zero-copy `get()`.

**Gate:** flipflop/flipflopdom A/B, ≥5% on the relevant size, output parity
(bit-exact, or stated ΔE/LSB). Below gate → revert, defer with numbers.

---

## Category D — Tactical: kernel & memory

**Scope:** single hot function — *how data moves through the machine.* Measured hot
paths only (per-frame / per-group / per-pixel).

- **D1 SIMD layout** — a fixed shuffle/reduction the scalar loop does element-wise.
  *Proven:* `4ca1b432` pshufb/swizzle rgb_to_rgba (−49%); `0f852a38` channel-as-lane
  SSIM moments (1.33–1.51×). Pick the layout the bench proves — deinterleave was a
  wash; channel-as-lane won.
- **D2 Boundary split** — hoist clamps/guards out of the interior by splitting
  border/interior/border. *Proven:* `7fffea87` DNG MHC interior (−32%, byte-exact).
- **D3 Bulk copy** — per-element repack where a `memcpy`/`extend_from_slice` works
  (esp. little-endian). *Proven:* `c3ea10ef` rgb16 pack/unpack; `ad87ab9b` per-row
  tile/strip; `16124431` CR2 multi-slice reassembly.
- **D4 Parallelize** — an embarrassingly-parallel per-pixel loop, `cfg`-gated.
  *Proven:* `f3bcc8fe` NR blend 6.6× + downscale 2.37× (deterministic, byte-identical).

**Gate:** same as C. Watch the inlining trap — `7fffea87` notes a closure factor that
**regressed −50%** by blocking inlining; flipflop caught it. Measure, don't assume.

---

## Category E — Code & mathematics (lowest level)

**Scope:** the instructions and the math themselves, inside one function. The finest
grain — mirrors the "hacker" finder's **pure-math lens (L18)**: compose/precombine
transforms; kill work that is invariant, associative, or recomputed. Individual wins
are small but compound, and are nearly free once measured.

- **E1 Algebraic precombination** — fold associative/distributive ops into one
  precomputed form. *Proven:* `733d1d6b` collapse vib_zero tone to a single 3×3
  `M' = S·M` (saturation folded into the colour matrix), decoupling luma from matrix.
- **E2 Transcendental → table/lerp** — replace `powf`/`exp`/`log` in a hot loop with a
  cached LUT or lerp. *Proven:* `64b3a37b` sRGB EOTF `powf` → cached lerp (build 91%
  faster, ≤1 LSB). *Counter:* `powf`→polynomial measured **negligible** and rejected —
  don't chase a transcendental the LUT already amortizes.
- **E3 Strength reduction** — divide → reciprocal-multiply; `mul_add`/FMA; shift for
  ×/÷ by powers of two; integer where float isn't needed. *Proven:* `51f656c0`
  mul_add/FMA across LUT/tone/demosaic; reciprocal downscale (under flipflop,
  `FLIPFLOP_C7_DOWNSCALE_RECIPROCAL_RESULTS.md`).
- **E4 Invariant hoist / CSE** — lift a loop-invariant or common subexpression out of
  the hot path. *Proven:* `51f656c0` CSE neighbour sums; `1779d71f` CSE + hoist;
  `d6e939e6` hoist bounds constants.
- **E5 Branchless** — replace a per-element branch with arithmetic / mask / select.
  *Proven:* `ea3fca93` branchless Olympus predictor (1.27× on decompress); `1779d71f`.
- **E6 Allocation / call elision** — `reserve` before a grow-loop; hoist `Vec::new()`
  out of a loop; cache a repeated pure call. *Proven:* `9edb33be` `sym_cost` +
  `inv_remap` reserve; `cff91979` single LRU lookup; `99ac440b` cache `_isProduction()`.

**Gate:** same as C/D — but watch **V5 (noise floor):** many E-wins are sub-µs and only
show on a tight kernel bench, not end-to-end. Sub-gate → it is code-quality, *not* a
"perf fix" (see this repo's `enc.cc` micro-opts). Parity is usually bit-exact; state
any LUT-index / FMA-reassociation LSB drift.

---

## Category F — Correctness & boundary integrity

**Scope:** cross-cutting safety. Run before a release or after a churny merge.
Most produce `direct_fix`; high-risk colour/auth/ABI → defer for sign-off.

- **F1 Integer overflow** — unchecked `w*h*c` / tile-count that wraps on 32-bit/WASM
  and slips a wrong-sized buffer past a guard. *Proven:* `a5a2c5d7` lib.rs guards;
  `857e1d04` JXTC tile-count; `checked_mul` in `jxl_casaencoder` size validation.
- **F2 Mutation during iteration** — a callback that mutates the collection being
  iterated (silent message loss per JS Set spec). *Proven:* `daf21267` snapshot Set
  in fan-out dispatch.
- **F3 Cleanup-path hang/leak** — a wait/promise that never resolves on
  cancel/shutdown/error. *Proven:* `cef45ac0` waitForDrain hangs on paused-cancel.
- **F4 Boundary stride/ABI** — (see B1) but as a *bug already shipped*, not a design
  nit. *Proven:* `89e9b787`.
- **F5 Detached/aliased buffer** — using an ArrayBuffer after `postMessage` transfer
  detaches it, or recycling a transferred buffer. *Proven:* the `CLAUDE.md` "pixel
  buffer pool" rejection; `28ea1364` transferList() SAB handling.

**Gate:** a regression test that fails before, passes after. Never infer destructive
intent.

---

## Overlay V — Verification (mandatory)

The gate every finding passes before it is allowed to land. Non-negotiable.

- **V1 Measure, A/B** — perf claims via `flipflop` (native/CPU) or `flipflopdom`
  (WASM/OPFS/SAB/DOM), interleaved, thermal-cancelled. No unmeasured perf commit.
- **V2 ≥5% gate** — below 5% on the relevant size → revert + defer with the numbers.
  Micro-opts that are sub-gate are *code-quality*, labelled as such, not "perf fixes".
- **V3 Parity** — bit-exact, or the finding's stated ΔE / LSB bound. State which.
- **V4 Build-gated** — a C++/WASM/bindgen edit that can't be compiled in-session is
  `build-unverified`: revert, defer with the exact build command. (Exception: pinned
  in-repo contract + a non-build check on the other side — say so.)
- **V5 Noise floor** — if encode/op time ≫ the saving (e.g. a 49 µs memset vs a 34 ms
  encode), the bench can't see it; don't claim a win from noise. Report honestly.

---

## Overlay X — Anti-lenses (reject on sight)

Proposed and rejected here repeatedly. A sweep that surfaces one of these **drops it
without writing a finding.** Full log: `docs/rejected optimizations.md` and the
"Recurring False Claims" table in `CLAUDE.md`.

- **X1 Output pixel-buffer pool** — transferred ArrayBuffers detach; no safe release.
- **X2 Drain/onDrain callback on the decoder/facade** — wrong layer (backpressure is
  scheduler/worker).
- **X3 Soft preemption / yield mid-push** — WASM `decoder.push()` is synchronous; hard
  cancel between chunks is already "soft".
- **X4 Per-stage budget reset** — silently changes budget to `budgetMs × N_stages`.
- **X5 WASM hash / WASM for memory-bound work** — boundary marshalling cost exceeds the
  compute win (hash +37–52% *slower*).
- **X6 Binary manifest in-browser** — V8 `JSON.stringify` is fast; binary loses ~−202%
  in-page (it *wins* native — see C2; pick by runtime).
- **X7 3D LUT + trilinear for tone** — ~3× slower + shadow banding.
- **X8 Closure-factoring a hot kernel** — can block inlining and regress (see D2 note).
- **X9 Dedupe-aware / sourceKey caching** — doubles storage accounting; cache is
  content-agnostic.

---

## Lens provenance

Lenses are mined from merged history (`git log`), the layer contract in `CLAUDE.md`,
and `docs/rejected optimizations.md`. When a sweep invents a candidate that matches no
A–F lens and no X anti-lens, it is *new* — hold it to V's gate and, if it pays out,
append it here as a numbered lens with its SHA so the next sweep inherits it.
