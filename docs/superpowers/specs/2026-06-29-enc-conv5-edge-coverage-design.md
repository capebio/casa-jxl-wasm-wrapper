# enc_convolve_separable5.cc — edge-coverage optimization pass

**Date:** 2026-06-29
**Branch (both repos):** `perf/enc-conv5-edge-coverage-z3k`
**Worktree:** `C:\Foo\rcw-conv5edge` (super off main `b4a55047`; submodule off main `10783f7e`)
**File:** `external/libjxl-012/lib/jxl/enc_convolve_separable5.cc`

## Background

The big win on this file — the **vertical-band rolling y-ring** (`RingColumn` /
`ConvolveInteriorBand`, `kRowsPerBand=8`, reuse 4-of-5 horizontal convolutions
per row) — is **already landed** on submodule main `10783f7e` (+39–49% WASM on
the hot interior path). The remainder-specialization collapse (`case 0/1/default
→ RunRows<2>`) is also already in.

A 3-round ChatGPT analysis proposed many further ideas. Caller analysis settles
which are real:

**Only two callers in this repo, both full-image:**
- `butteraugli.cc:255` `Blur()` — `Rect(in)` = full XYB image, `pool=nullptr`
  (serial). Encode bottleneck.
- `enc_detect_dots.cc:168-172` — `Rect(orig)` = full image, with pool.

Neither passes tiny / narrow / short geometry. So the ChatGPT "blind-spot"
items (border-dedup, tiny-height, N/N+1 width-cliff) are **dead geometry for
this repo's callers** — they are pursued here only as **upstream-robustness /
general-library correctness+coverage**, explicitly chosen by the user. They must
cost nothing on the hot full-image path.

## Goal

Add byte-exact edge/geometry coverage to `Separable5` without regressing the
hot full-image path, and fix one swallowed error status. Specifically:

1. Eliminate redundant per-pixel `Mirror()` in the scalar tail.
2. Propagate `RunOnPool` failure status (stop swallowing it).
3. Deduplicate horizontal convolutions on border rows (reflected rows alias).
4. Add a dedicated cross-row-reuse kernel for tiny-height images (`ysize ≤ 4`).
5. Add SIMD paths for `xsize == N` and `xsize == N+1` (currently fall to
   `SlowSeparable5`).

## Constraints

- **Isolation:** own worktree, unique branch in BOTH repos; push early/often;
  never commit/push/merge to main; never bump the superproject gitlink. Hand off
  branch names to the integrator. (Agent implementation rules 1–6.)
- **Correctness contract:** `Separable5` already agrees with `SlowSeparable5`
  only within `VerifyRelativeError(1e-5)` (separable 2-pass ≠ 25-tap full).
  `convolve_test.cc` is authoritative; it sweeps `xsize 3..39 × ysize 3..15`.
- **Byte-exactness classes:**
  - Changes 1, 3, 4 are **byte-exact vs the current `Separable5`** — same horz
    function, same `dy`-outer/`dx`-inner / vertical-FMA accumulation order.
    Reuse of an already-computed `V` (dedup) or direct index where `Mirror`
    returns the same value is bit-identical by construction.
  - Change 5 is the **one output change**: for `xsize ∈ {N, N+1}` it switches
    `SlowSeparable5` → SIMD separable. It must match `SlowSeparable5` within the
    same `1e-5` the existing SIMD path already meets (and is *not* byte-identical
    to the old slow output — expected).
- No new tunables/heuristics (CLAUDE.md). No layer/API changes beyond this file.

## Edge cases

- `HWY_TARGET == HWY_SCALAR`: `Neighbors`/`TableLookupLanes` unavailable; the
  new SIMD width-cliff path must be gated out of scalar (scalar uses `min_width
  = 2*kRadius` and direct mirrored loads). Keep scalar behavior unchanged.
- `xsize == N` vs `xsize == N+1`: differ in right-neighbor sourcing — `N` mirrors
  both edges within one loaded vector; `N+1` can `LoadU(row+1)` for the right
  vector and leaves the final pixel to the scalar 25-tap tail.
- Tiny-height `ysize ∈ {1,2,3,4}`: double reflection via existing `kBorderLut`;
  the dedicated kernel reuses that LUT for index mapping so output is identical
  to `ConvolveRow`'s border path.
- `pool == nullptr` (butteraugli): `RunOnPool` runs inline; status propagation
  must still compile/behave.
- `kSizeModN == 0`: no scalar tail (guarded) — Mirror-elision change is a no-op
  there.

## Design

### Change 1 — scalar-tail Mirror elision (byte-exact)

Both scalar tails (`ConvolveRow` and `ConvolveInteriorBand`) currently compute
`Mirror(x+dx, xsize)` for every `dx ∈ [-2,2]` of every tail pixel. For all tail
columns except the final `kRadius`, `x+dx` is in `[0, xsize)` so `Mirror`
returns it unchanged. Split each tail into:
- a **direct-index body** for `x` where `x-kRadius ≥ 0 && x+kRadius < xsize`
  (no `Mirror` call), and
- a **reflected edge** for the final `≤ kRadius` columns (current code path).

Preserve the exact `dy`-outer / `dx`-inner loop order and `clamped_row[idx] *
wx * wy` accumulation. Identical indices → identical values → byte-exact.

### Change 2 — Status propagation (correctness)

`RunInteriorRows` does `Status status = RunOnPool(...); JXL_DASSERT(status);
(void)status;` then `RunRows`/`Run` always return `true`. Thread `Status`
through `RunInteriorRows`, `RunBorderRows`, `RunTinyHeight` (new), `RunRows`, and
`Run` with `JXL_RETURN_IF_ERROR` so a pool failure is reported, not masked.

### Change 3 — border-row horizontal dedup (byte-exact)

`ConvolveRow` (always called with `kBorder=true` today) computes 5 horizontal
convolutions per SIMD column (`row_t2,row_t1,row_m,row_b1,row_b2`). After
reflection these pointers frequently alias (`row_t1==row_m`, etc.). Introduce a
helper `BorderColumn<kSizeModN,kRegion>(rows[5], x, …)` that:
- computes `h2=HorzPick(rows[2])` then each of `h1,h3,h0,h4` as a **pointer-equality
  chained dedup** (reuse an already-computed `V` when the row pointer matches a
  prior one; else `HorzPick`), and
- applies the **identical** vertical combine
  `conv0=Mul(h2,wv0); conv1=MulAdd(Add(h1,h3),wv1,conv0);
  conv2=MulAdd(Add(h0,h4),wv2,conv1)`.

`HorzPick<kSizeModN,kRegion>` (already present, used by `RingColumn`) dispatches
First/interior/Last. Refactor `ConvolveRow`'s three column loops to call
`BorderColumn`, then the (now Change-1) scalar tail. DRYs the function and gives
borders dedup for free. Byte-exact: dedup only avoids recomputing a deterministic
pure function; combine order unchanged.

### Change 4 — dedicated tiny-height kernel (byte-exact)

For `in->ysize() ≤ 2*kRadius`, dispatch from `Run()` to `RunTinyHeight<kSizeModN>()`.
For each SIMD column region (first / interior / last, plus scalar tail), compute
`hrow[j] = HorzPick(in->ConstRow(j) + rect.x0(), x, …)` once for each unique
source row `j ∈ [0, ysize)` (≤4 convs/column total) — the same base pointers
`ConvolveRow` derives from `kBorderLut` — then for every output row
form the 5 tap indices via the existing `kBorderLut` mapping and apply the same
vertical combine as `ConvolveRow`. This achieves full cross-row reuse (vs
`ConvolveRow` recomputing per output row). Output identical to the border path →
byte-exact. (`ConvolveRow`'s tiny-height branch remains as the reference the
A/B harness checks against.)

### Change 5 — SIMD width-cliff `xsize ∈ {N, N+1}` (within-tolerance output change)

In `Run()`, before falling back to `SlowSeparable5`, handle:
- `xsize == N` (non-scalar targets): a single-vector kernel mirroring **both**
  edges from one `LoadU` — left via `Neighbors::FirstL1/L2`, right via
  `TableLookupLanes(c, ml1/ml2)` (== `HorzConvolveLast` `kSizeModN==0` right
  logic). Run the vertical ring/border combine down the column.
- `xsize == N+1`: SIMD covers lanes `0..N-1` using `LoadU(row+1)` as the right
  neighbor vector; the final pixel (index `N`) goes to the scalar 25-tap tail.

Gated out of `HWY_SCALAR`. Validated against `SlowSeparable5` at `1e-5` (the
established bound; `convolve_test` already exercises these sizes). This path is
never hit by butteraugli/detect_dots — it is general-library coverage only.

## Verification (rules 9 / 10)

1. **Authoritative correctness:** native build + run `convolve_test` gtest in the
   submodule worktree (covers borders, tiny-height, N/N+1, scalar tail; `1e-5`).
2. **Byte-exact gate (1/3/4):** new native A/B harness `tools/conv5_ab.cc`
   (superproject) — FNV-1a of `Separable5` output across geometry configs
   **excluding** `xsize ∈ {N,N+1}`; require `FNV(OLD) == FNV(NEW)`. OLD via
   path-checkout + incremental rebuild (per memory recipe).
3. **Width-cliff gate (5):** harness asserts NEW vs `SlowSeparable5` ≤ `1e-5`
   for `xsize ∈ {N,N+1}`.
4. **Timing flipflop:** interleaved OLD-vs-NEW on **full-image** geometry (real
   caller shape) — require non-regression on the hot path; edge geometries
   reported separately. Targets: AVX2 + WASM SIMD ("measure real WASM").
5. **Keep/drop:** keep Change 1 if neutral-or-better and byte-exact (rule 10).
   Any measured regression → revert + log to `docs/1 rejected optimizations.md`.

## Out of scope (deferred → `Questions_deferred.md`)

- Parallelizing butteraugli `Blur` (currently `pool=nullptr`) — butteraugli.cc
  refactor, behavioral, separate change.
- In-place `Separable5` variant (butteraugli guards `&in != out` today).
- Caller-side materialization/halo fusion above this file.
- Weight-family dispatch (identity / 3-tap / 1-D) — needs coefficient telemetry.

## Success criteria

- `convolve_test` passes (native, AVX2 + at least one 128-bit target).
- FNV(OLD)==FNV(NEW) for all non-`{N,N+1}` geometry configs.
- Width-cliff configs match `SlowSeparable5` ≤ `1e-5`.
- Full-image timing non-regressing vs OLD on AVX2 + WASM.
- Branches pushed (both repos), main untouched, gitlink unbumped, handed off.
