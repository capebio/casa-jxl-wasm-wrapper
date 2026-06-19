# Spec + Plan — SSIM buffer×engine 4-way flipflop (+ decode-resident Butteraugli)

**Date:** 2026-06-19
**Branch target:** new branch off active dev (not `main` — see CLAUDE.md Branch Management)
**Origin:** Task2-Boundary-Audit "double pass" follow-up. Audit framed Butteraugli's 2× heap copy as
"unavoidable WASM FFI constraint." It is not — see companion analysis. This spec covers the
**JS-side SSIM half** of the convergence loop (`measureConvergenceProfile`, backends.ts:277), which
today copies decoder-output pixels back into a JS `Uint8Array` and runs JS `ssim.js`.

---

## 1. Goal

Decide, with thermally-corrected evidence, the fastest correct way to compute per-pass SSIM in
`measureConvergenceProfile`, across two independent axes:

- **Buffer axis** — `copy` (`new Uint8Array(raw)`, current) vs `view` (`HEAPU8.subarray`, zero-copy).
- **Engine axis** — `js` (`ssim.js`) vs `wasm` (`_jxl_wasm_ssim_compare`, already shipped/exported).

Output: the winning (buffer, engine) cell, confirmed on real camera files, wired into the pipeline.
This rides alongside the Butteraugli decode-resident rework so the whole convergence loop reaches
**zero heap copies** per pass.

## 2. Constraints

- **No rebuild required for the benchmark.** `_jxl_wasm_ssim_compare(ptr1,ptr2,w,h)` exists and is in
  `exports-dec.txt`/`exports-enc.txt`. The 4-way runs on the shipped `dist/jxl-core.*` build.
- **WASM rebuild is approved** and is needed only for the Butteraugli Lever-2 piece (stateful
  `jxl::ButteraugliComparator` replacing the per-compare ref deep-copy in bridge.cpp:3509). The SSIM
  decision does not block on it.
- **Heap-view lifetime:** a `HEAPU8.subarray` view detaches on any subsequent WASM `malloc`/heap-grow
  (takeBufferView docstring, facade.ts:2606). Any `view` variant must consume the view *before* the
  next bridge call that can allocate. WASM-SSIM allocates internally → for `view+wasm` we pass the
  raw `dataPtr` to the bridge (never a JS view), sidestepping the hazard entirely.
- Same WASM module instance for decode + metric → decoder output `dataPtr` is a valid argument to
  `_jxl_wasm_ssim_compare`. Raw offsets survive heap-grow; only JS TypedArray views detach.
- `equal()` cannot guard across the engine axis (JS and WASM SSIM are different implementations →
  different scalars). Correctness is split: within-engine view-vs-copy must be **bit-exact** (proves
  the zero-copy view reads uncorrupted pixels); cross-engine agreement is a tolerance check, not a
  hard guard.

## 3. Edge cases

- Decoder reuses its output buffer per pass → `dataPtr` valid only until next `decoder.push()`.
  Metric must complete synchronously on-receipt (current loop already does).
- `px.length !== finalPixels.length` (dimension mismatch on a pass) → skip, as today.
- Heap-grow during a `view+js` flip would silently feed `ssim.js` a detached/zeroed view → guarded by
  ordering + a one-time bit-exact assert vs `copy+js`.
- Images < 1024px are skipped upstream (backends.ts:288) — corpus must include ≥1024 tiers.
- LibreHardwareMonitor must be running for honest thermal verdict on this desktop (skill note);
  otherwise lean on interleave + stdev, treat thermal as unknown.

## 4. Success criteria

1. `.flipflop/tests/ssim-buffer-engine.mjs` runs 4 interleaved variants, `--print` clean,
   `trust:high` on a cooled box.
2. Within-engine `view` SSIM == `copy` SSIM **bit-exact** (asserted; failure ⇒ abort, view is unsafe).
3. Cross-engine |js − wasm| recorded per input; flagged if any input exceeds tolerance (default 1e-3).
4. A documented winner cell with `%saved` vs the `copy+js` baseline, on fractals **and** real files.
5. Pipeline patched to the winner; convergence curve numbers unchanged within recorded tolerance;
   `pyramid-ingest` tests green.

---

## 5. Flipflop design

### Variants (Stage 1 — 4-way cross product)

| name | buffer | engine | notes |
|------|--------|--------|-------|
| `copy-js` | `new Uint8Array(raw)` | `ssim.js` | **baseline** — current production path |
| `view-js` | `HEAPU8.subarray` | `ssim.js` | zero-copy read, pure-JS consumer (no interleaved malloc) |
| `copy-wasm` | `new Uint8Array` → `HEAPU8.set` | `_jxl_wasm_ssim_compare` | isolates engine cost with copy held constant |
| `view-wasm` | decoder `dataPtr` direct | `_jxl_wasm_ssim_compare(ptr,…)` | zero-copy both sides — the target cell |

- Baseline: `copy-js` (`baseline:true`).
- `quality(out)` returns the SSIM scalar so the journal records each engine's value next to time.
- `equal()` **not** exported (cross-engine differs). Instead `prep()` runs a one-time assert:
  `ssimViewJs === ssimCopyJs` bit-exact and `ssimViewWasm === ssimCopyWasm` bit-exact; throw on mismatch.

### Stage 2 — winner runoff ("winner of each")

After Stage 1 names the per-axis winner, a 2-variant confirm flipflop:
`winning-combo` vs `copy-js` (status quo), on **real files** (`SSIM_REAL=<folder>` via `raw-corpus.mjs`,
same pattern as `jxtc-vs-full-decode.mjs`), longer rounds. Locks the production decision under realistic
pixels (fractals are smooth; photo noise changes SSIM-window cost).

### Corpus / harness

- Default deterministic fractals at sizes `1024,2048,4096` (skip 256/512 — pipeline skips <1024).
- Module loaded once via `setJxlModuleFactoryForTesting` + `Module.wasmBinary` from disk
  (copy the `loadScalar()` pattern from `jxtc-vs-full-decode.mjs:43-51`).
- `setup()` synchronous; all async (decode a real JXL pass to get a heap-resident output buffer +
  its `dataPtr`, build the reference) deferred to a lazy cached `prep()` in `run()` (lands in round 0,
  excluded from `median_warm`).
- To exercise the true `view` path the prep decodes a real progressive pass through the facade and
  keeps the `retainBufferView` handle alive so `dataPtr` + `HEAPU8.subarray` are both available; the
  reference is uploaded once to a fixed heap ptr (mirrors the production ref).

---

## 6. Implementation plan

**Phase 0 — branch.** Verify active branch has commits past `main`; branch from it.

**Phase 1 — facade affordances (thin JS, no rebuild).**
1. Export `computeSsimWasmFromPtr(ptr1, ptr2, w, h)` in facade.ts — same body as `computeSsimWasm`
   minus the malloc/`HEAPU8.set` (callers supply heap ptrs). Keep existing `computeSsimWasm` for the
   copy variant.
2. Ensure `retainBufferView` (facade.ts:2586) exposes `dataPtr` (add to its return shape) so callers
   can hand the live decoder-output offset to the metric bridges.

**Phase 2 — write the test.** `.flipflop/tests/ssim-buffer-engine.mjs` per §5. Dry-run
(`--dry --print`) to shake out load/heap-view wiring before journaling.

**Phase 3 — Stage 1 run.** `node --expose-gc flipflop.mjs .flipflop/tests/ssim-buffer-engine.mjs
--sizes 1024,2048,4096 --print`. Require `trust:high`; re-run cooled if `trust:low`. Record per-axis
winner + cross-engine tolerance table.

**Phase 4 — Stage 2 runoff.** Real files:
`SSIM_REAL="C:\...\tests" node --expose-gc flipflop.mjs .flipflop/tests/ssim-buffer-engine.mjs --print`
(winner-vs-baseline subset). Confirm the win survives photo noise.

**Phase 5 — wire winner into pipeline.** Patch `measureConvergenceProfile` (backends.ts:320-352):
replace `new Uint8Array(raw)` + `ssimFn` with the winning combo; for `view-wasm`, route the live
`dataPtr` to `computeSsimWasmFromPtr`. Reuse the *same* `dataPtr` for the Butteraugli
`compareInHeap` so one resident buffer feeds both metrics (no second read-out).

**Phase 6 — Butteraugli rebuild half (parallel, approved).**
1. bridge.cpp: replace `JxlWasmButterRef` raw-`Image3F`+`InPlace` with libjxl's stateful
   `jxl::ButteraugliComparator` (ref pre-processed once, `.Diffmap(test)` per call) → kills the
   per-compare ref deep-copy (3509-3519) and per-call ref gamma-decode.
2. facade: add `ButteraugliComparator.compareInHeap(ptr)` taking a decoder `dataPtr`.
3. Rebuild WASM (`node scripts/build.mjs` from `packages/jxl-wasm`; docker emsdk). Update
   `exports-*.txt` if signatures change.

**Phase 7 — verify.** `cd packages/pyramid-ingest && npm test`. Convergence curve values unchanged
within the recorded cross-engine tolerance. Document final numbers in this file's results section.

---

## 7. Decision rule

- If `view-wasm` wins both stages with `trust:high` → adopt; convergence loop reaches zero heap copies.
- If `wasm` wins engine but `copy` ties `view` (decode buffer not actually reusable in prod) → adopt
  `copy-wasm`, note the view path blocked and why.
- If `js` wins engine on real files (ssim.js SIMD vs WASM boundary) → keep `ssim.js`, adopt only the
  `view` buffer change; record that WASM SSIM lost (matches prior "WASM hash boundary tax" findings —
  small ops can lose to the JS↔WASM crossing).
- Any `trust:low` that won't cool → defer, do not ship the number.

## RESULTS (executed 2026-06-19)

Test: `.flipflop/tests/ssim-buffer-engine.mjs`. Build loaded: `jxl-core.dec.simd.js` (only split
`dec.*/enc.*` builds export `_jxl_wasm_ssim_compare`; monolithic `simd`/`scalar` do not). Bit-exact
view==copy guard passed every input.

**Stage 1 — fractals, warm medians (fbm,branch):**

| size | copy-js (base) | view-js | copy-wasm | view-wasm |
|------|---------------:|--------:|----------:|----------:|
| 1024 | ~155 ms | −2 to +3% | **−93.6%** | **−93.9%** |
| 2048 | ~731 ms | −0.5 to +3.6% | −95% | −94.9% |
| 4096 | ~4590 ms | +3 to +4% | −96.5% | −96.8% |

**Stage 2 — real CR2/DNG/ORF, trust:high, geomean −96.3%:** copy-js 3.2–7.5 s → view-wasm
130–250 ms. view-js even −9.6% (slower) on CR2.

**Verdict:**
- **Engine axis = the entire win.** WASM SSIM 93–97% faster than ssim.js everywhere.
- **Buffer axis is dead** — view vs copy 0–4% (often negative) at warm steady state; the dry-run's big
  copy→view gap was cold-start alloc, not steady state. `view-wasm ≈ copy-wasm`.
- **Cross-engine Δ 1e-3…1.3e-2, image-dependent** (DNG: ssim.js 0.999 vs WASM 0.975). Real risk =
  curve shift, not speed.

**Plan revision:** Phase 1 + the "view" buffer change are **dropped for SSIM** — no measurable gain.
The win is swapping to the already-shipped `computeSsimWasm` (`copy-wasm` cell). No facade change, no
rebuild for SSIM.

**Phase 5 implemented** (backends.ts `measureConvergenceProfile`): WASM SSIM primary, ssim.js
fallback. Facade loads `enc.<tier>` (has ssim) first → prod gets the win.

**Phase 7 verify:** `tsc --noEmit` my change clean (10 pre-existing `manifest.ts` errors unrelated);
`bun test` 53 pass / 13 fail — **identical to HEAD baseline** (failures pre-existing, structural API
mismatches in ingest tests that never run `--profile-convergence`).

**OPEN — needs decision (not shipped):**
1. **`SSIM_CONVERGED = 0.9995` recalibration.** Calibrated to ssim.js; WASM SSIM reads ~1–2% lower →
   ssim gate shifts conservatively (never under-quality; possibly later `convergedByteEnd` = slightly
   larger client download). `butteraugli<=1.1` is the primary gate. Needs user's calibration intent.
2. **Phase 6 — Butteraugli decode-resident rework + WASM rebuild** (stateful `jxl::ButteraugliComparator`
   killing the per-compare ref deep-copy bridge.cpp:3509-3519 + `compareInHeap(ptr)`). Approved, not
   started; SSIM win is independent of it.

## 8. Out of scope

- PSNR path (`computePsnrWasm`) — same shape, fold in later if SSIM win generalizes.
- Moving SSIM fully off the worker / into the decode kernel.
- The one-shot `computeButteraugli` legacy path (only the cached comparator path is hot).
