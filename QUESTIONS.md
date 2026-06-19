# EpicCodeReview — Deferred items & questions

Run: `epiccodereview/20260617T202430Z` (core decode chain, modelswitching)

---

## Section 002 — jxl-core (contract package)

jxl-core itself is a clean, well-built contract package (matches its 5/5 score). One
safe local fix landed (`buffering` inline object deduped to `BufferingControls`). The
rest of the confirmed findings describe **cross-package contract debt whose fix lives in
jxl-session / jxl-worker-* , not in jxl-core** — adding/narrowing shared types from this
section would either break exhaustive consumer switches (tsc can't see them from here) or
add optional fields that nothing populates (a *worse* contract: caller passes a field that
is silently dropped). Per the fixer guardrails these are deferred to the jxl-session /
jxl-worker passes, where the producer/consumer can be wired atomically.

> Heads-up: MEMORY.md records that several of these consumer-side seams were recently fixed
> (jxl-scheduler S1/S2/S3, jxl-worker-node W-1/W-2 identity guard, decode-session). **Verify
> current consumer code before acting** — some items below may already be closed.

### A. Cross-package contract debt (fix in jxl-session / jxl-worker pass)

1. **MsgEncodeStart drops ~15 EncodeOptions fields** — `modular, brotliEffort, decodingSpeed,
   photonNoiseIso, buffering, advancedControls, jpegReconstruction, alreadyDownsampled,
   upsamplingMode, ecResampling, frameIndexing, allowExpertOptions` have no wire field, and
   `progressiveFlavor / progressiveAc / qProgressiveAc` exist on `MsgEncodeStart` but
   `encode-session.ts` never copies them → silently dropped before reaching the worker.
   Root cause + fix → ADR `encode-options-normalization-utility.md`. (Matches prior
   encode-session/types lens handoff: "~15 fields never forwarded".)

2. **Worker error codes are not in `JxlErrorCode`** — workers emit `DuplicateSession,
   UnhandledError, UnhandledRejection, WorkerError, MessageDeserializeError`; both sessions'
   `normalizeCode()` collapse anything unknown to `"Internal"`, losing the real cause. The
   wire `code` field is typed `string`, not `JxlErrorCode`, so TS never catches it
   (e.g. `spawn.ts` emits `code:"WorkerError"`). Fix = decide the canonical code set, then
   widen the union *and* the runtime `KNOWN_JXL_ERROR_CODES` Set together (cross-package).

3. **`MsgWorkerError` has no `sessionId`** (protocol.ts ~305) — a top-level worker crash
   mid-decode is not attributable to the owning session and isn't a terminal message, so
   `done()` can hang. Fix spans worker (set sessionId) + scheduler/session (route + treat as
   terminal). Check whether jxl-worker-node "crash-as-graceful-ack" fix already covers this.

4. **`DecodeFrameMeta` fields dropped by session `makeFrame`** — `sourceScale,
   progressiveSequence, passOrdinal, frameIndex, frameDuration, frameName,
   animTicksPerSecond, progressiveRegion, regionFallback` ride decode_progress/decode_final
   but never reach `DecodeFrameEvent` consumers. Fix in `decode-session.ts makeFrame`.

5. **`decode_budget_exceeded` metadata gaps** — carries no folded metrics; the node backend
   drops `region` (browser keeps it) → backend-divergent shape; it doesn't extend
   `DecodeFrameMeta` so the "best frame so far" loses progressive metadata. Fixes in
   worker(node) + decode-session.

6. **Unbounded / unsanitized error `message` strings** — only the decode path truncates;
   encode/worker paths do not. Truncation belongs in the worker handlers (out of section).

7. **`MsgDecodeError` partial-pixel fields independently optional** (protocol.ts ~142) —
   permits the invalid "pixels present but stride absent/0" state every consumer must defend
   against. A required-together union would fix it but narrows a shared type → needs a
   coordinated change with all producers/consumers.

### B. Needs product/intent decision

8. **`effort` typed `1..9` vs `allowExpertOptions` JSDoc claiming effort 10/11** (types.ts:160,
   MsgEncodeStart:185). Should expert effort 10/11 be representable? If yes, widen both the
   `EncodeOptions.effort` and `MsgEncodeStart.effort` types (+ guarded runtime check); if no,
   correct the JSDoc. Did not guess — needs intent. (Mechanism → ADR
   `numeric-invariant-checking-convention.md`.)

### C. ADR drafts written (awaiting ratification)

- `.epiccodereview/20260617T202430Z/sections/002/adr_draft/encode-options-normalization-utility.md`
  — extract a single typed `encodeOptionsToStartMsg()` mapper with an exhaustiveness guard.
- `.epiccodereview/20260617T202430Z/sections/002/adr_draft/protocol-version-handshake.md`
  — add `PROTOCOL_VERSION` constant + assert at `worker_ready` (keep fire-and-forget intact).
- `.epiccodereview/20260617T202430Z/sections/002/adr_draft/runtime-validation-at-worker-boundary.md`
  — lightweight hand guards for drift-detection (boundary is first-party, not untrusted input).
- `.epiccodereview/20260617T202430Z/sections/002/adr_draft/numeric-invariant-checking-convention.md`
  — dev-mode `assertInvariant` helper for the prose-only numeric contracts.

### D. Inspected and intentionally NOT changed (low value / speculative)

- **errors.ts `Object.setPrototypeOf` / redundant `cause` field** — no concrete failure at
  the package's `target: ES2022` (native classes; `instanceof` works; line 35 re-sets
  `cause`). Only matters if a consumer re-transpiles dist to ES5 — speculative for an ESM
  (`module: ES2022`) lib. Skipped as opportunistic.
- **protocol.ts JSDoc wording on `progressiveDc`/`groupOrder`** — cosmetic, not behavioral.
- **`src/schemas/*.json` (`additionalProperties:false` omits real fields)** — the schemas
  are currently **unconsumed** (no importer; verifier-confirmed). Fixing is low-value until
  wired; folded into the runtime-validation ADR.

### E. Verifier-uncertain (could not confirm from available code)

- `errors.ts:22` — `JxlError.partial` may hold a `DecodeFrameEvent` whose `pixels`
  ArrayBuffer was transferred/neutered; only producer uses a live buffer, no concrete detach.
- `protocol.ts:90-167` — worker→main pixel messages carry `pixelStride/outputBytes/region`
  with no bounds; OOB impact depends on consumer + a forged-message threat model.
- `protocol.ts:137-146` — free-form error `message`; info-leak depends on consumer.
- `types.ts:51-84` — `Region`/resize fields are unconstrained numbers; allocation/OOB impact
  depends on the pipeline, not the contract layer.

---

## Section 000 — crates/raw-pipeline/src/cr2.rs (RAW decode, hot path)

Applied 4 safe guard-only fixes (no valid-CR2 output change): shift-overflow guard on
precision>=16, checked arithmetic in read_ascii, checked offset derivation in MakerNote
WB extraction, and a decoded_width==stride guard (logic-21). The two items below change
valid-file output and need real CR2 files with CR2Slices interleaving to verify, so they
are deferred.

## DEFERRED 000-logic-22 — CR2 in-place crop addresses source by `stride` but bounds/centers by `decoded_width`
- File: crates/raw-pipeline/src/cr2.rs:495-518
- Why deferred: rewriting the crop to use one consistent width changes cropping geometry / output pixels and cannot be proven byte-identical without real sliced CR2 files; the new logic-21 guard now forces `decoded_width == stride` at the crop site, so the latent hazard is contained for now.
- Suggested patch: once `decoded_width == stride` is guaranteed (it now is), collapse the dual representation — use a single `row_width` variable for both source addressing (`src = (top+row)*row_width + left`) and the centering/bounds math, and add a regression fixture decoding a real CR2 (e.g. _MG_1744.CR2) asserting byte-identical raw output before/after.

## DEFERRED 000-contracts-15 — CR2 black/white levels inferred from precision magic table; white never overridden from file, larger legitimate black dropped
- File: crates/raw-pipeline/src/cr2.rs:481-488
- Why deferred: changing the (black,white) inference table, the `black_from_ifd < white` gate, or validating wb_r/wb_b ranges all directly alter rendered colour/levels for valid files and need per-camera ground truth to avoid a colour regression (user is strict on colour parity).
- Suggested patch: parse WhiteLevel IFD tag 0xC61D (DNG) / Canon-specific white from the raw IFD and prefer it over the precision-table guess; relax the black gate to `black_from_ifd < white_resolved`; clamp/validate wb_r,wb_b into a sane multiplier range (e.g. 0.25..8.0) before constructing Cr2Image. Verify against a known Canon body with stored levels.

## Section 000 — crates/raw-pipeline/src/tiff.rs (TIFF/ORF IFD parser)

Applied 8 safe guard-only fixes (no valid-ORF output change): all integer-overflow
hardening on file-controlled offsets — `parse_header` uses `data.get(0..4)` instead of a
panicking slice; `Reader::u16/u32` use `checked_add` for their span; IFD entry address
math `off + 2 + i*12` is checked in `read_ifd`, `parse_orientation`,
`parse_orientation_and_dims`, and all three Olympus sub-IFD parsers; the `abs` closure
saturates instead of wrapping; `as_rational`/`as_rational_triplet`, `extract_thumbnail_jpeg`
(`start + len`), and the MakerNote `base_off + val` / `ptr + N` offsets are all checked; and
`parse()` now validates `strip_offset + strip_byte_count <= data.len()` so callers can slice
the strip without panicking on a crafted ORF. For valid files no offset wraps and no strip is
OOB, so every byte of output is unchanged. The four items below alter output for valid files
or change a public/serde contract and are deferred.

## DEFERRED 000-contracts-4 — OrfInfo.black_level never populated from the file
- File: crates/raw-pipeline/src/tiff.rs:25-26, 236
- Why deferred: wiring `black_level` to a MakerNote/ImageProcessing tag changes the value of `OrfInfo.black_level` for valid ORFs (currently always 0); that is an output-semantics change and needs a decision on which tag is authoritative + ground-truth per-camera black levels (user is strict on colour/level parity).
- Suggested patch: read Olympus ImageProcessing BlackLevel (e.g. tag 0x0600 / per-channel) in `parse_image_processing_subifd`, store into `info.black_level`, and verify the rendered black point against a known body before relying on it; alternatively delete the dead field if no consumer needs it.

## DEFERRED 000-logic-19 — extract_largest_jpeg bounds EOI search at the next SOI
- File: crates/raw-pipeline/src/tiff.rs:66-86
- Why deferred: widening the EOI search window (or making it forward-scan past nested SOIs) can change which blob is selected as the "largest JPEG" for valid files with nested/overlapping previews, altering the emitted preview bytes — exactly the case flagged as must-not-change in the policy.
- Suggested patch: for each SOI, forward-scan for its matching EOI marker honouring nested SOI depth (or scan to `scan_end` and keep the longest SOI→EOI that is itself a well-formed JPEG), then pick the largest; add a fixture with a nested-thumbnail preview asserting the same blob is chosen for current non-nested ORFs.

## DEFERRED 000-contracts-12 — OrfMetadata flattens Option fields into sentinel scalars
- File: crates/raw-pipeline/src/tiff.rs:719-742, 749-775
- Why deferred: changing the serialized `OrfMetadata` fields to `Option<…>` (or adding presence flags) is a public-API + serde wire-format change that alters the deserialized output for every consumer and breaks round-trip with existing data; out of scope for a same-file guard-only pass.
- Suggested patch: make the ambiguous fields `Option<…>` (exposure/fnumber/focal_length tuples, focal_length_35, wb_mode) or add `has_exposure`/`has_focal35` bools mirroring `has_gps`, and update `parse_orf_metadata` to map directly from the `Option`s; coordinate with all `OrfMetadata` consumers.

## DEFERRED 000-contracts-22 — ColorMatrix 0x1011 read without an SSHORT dtype gate
- File: crates/raw-pipeline/src/tiff.rs:597-606
- Why deferred: adding a `dtype == 8` (SSHORT) / `dtype == 3` gate to the 0x1011 reader (to match the 0x0200 sibling) changes which valid ORFs populate `color_matrix`, directly affecting rendered colour — the "ColorMatrix dtype reinterpretation" case the policy says to defer.
- Suggested patch: gate 0x1011 on `cnt == 9 && (dtype == 3 || dtype == 8)` like the 0x0200 reader and decide signed-vs-unsigned interpretation per dtype; verify the colour matrix and rendered colour against a real Olympus body that stores 0x1011 before changing the gate.

## DEFERRED 000-contracts-7 — DNG BlackLevel/WhiteLevel collapsed to a single u16
- File: crates/raw-pipeline/src/dng.rs:87-88, 358-359, 483-489
- Why deferred: black_level/white_level are Option<u16> read via first_f32 (element 0 only); DNG BlackLevel can be per-CFA-channel, so honoring all channels changes subtracted black and therefore rendered colour on cameras with distinct R/G/B black — explicitly DEFER per policy.
- Suggested patch: widen RawIfd.black_level to [u16;4] (read BlackLevelRepeatDim 0xC619 + full 0xC61A array), apply per-CFA-position black in subtract_black_in_place, and verify against a real DNG that stores per-channel BlackLevel before changing output.

## DEFERRED 000-logic-11 / 000-contracts-5 — align_to_rggb never corrects column phase (Grbg/Bggr)
- File: crates/raw-pipeline/src/dng.rs:297-313
- Why deferred: fixing the col_off==1 arms changes the CFA→RGGB alignment (R<->G assignment) and thus demosaiced colour; needs real Grbg/Bggr DNGs to validate — explicitly DEFER per policy. (Currently dead code: no in-crate callers, so latent only.)
- Suggested patch: for col_off==1 crop one leading column (and row_off rows) so the returned buffer starts on the R site, adjusting width/height accordingly; validate demosaic output against real Grbg and Bggr sensors before enabling.

## DEFERRED 000-contracts-25 — AsShotNeutral not validated for finite non-zero components
- File: crates/raw-pipeline/src/dng.rs:80-85, 1052-1057 (and read_as_shot_neutral :627-661)
- Why deferred: rejecting/normalizing a degenerate neutral (0/NaN → wb≈1e6) changes the WB multipliers, which for any file the validation reclassifies alters rendered colour — DEFER since it can affect valid output.
- Suggested patch: in read_as_shot_neutral return None (not 0.0) when any of the 3 components is non-finite or <= 0, so decode_bytes falls back to neutral wb=1.0; confirm no currently-valid DNG relies on the present 0.0-then-clamp behaviour.

## DEFERRED 000-contracts-17 / 000-errors-8 — decode_bytes_demosaiced ignores rgb_write_row != height
- File: crates/raw-pipeline/src/dng.rs:1248-1251 (empty if body) and the &mut rgb[(rgb_write_row*width*3)..] slices :1303,:1319
- Why deferred: turning the silent "keep going" into a hard bail!/error could reject edge tile geometries that currently produce accepted output, and proving rgb_write_row == ah holds for every valid DNG geometry needs an output-correctness test the crate lacks — DEFER per "unsure whether valid-file output changes".
- Suggested patch: after the loop, `if rgb_write_row != ah { bail!("DNG: demosaic produced {rgb_write_row} of {ah} rows") }`, but only after validating against the real DNG corpus (incl. tiny/edge tile geometries) that valid files always reach rgb_write_row == ah.

## DEFERRED 000-performance-11 — band/ctx fully zero-filled before being overwritten
- File: crates/raw-pipeline/src/dng.rs:1220-1221 (band.fill(0)) and :1250-1251 (ctx.fill(0))
- Why deferred: cannot prove output-identical — when width % tw != 0 (and on partial edge tiles) the uncovered tail columns of band/ctx are NOT written by decode_tile, so the fill(0) supplies the values demosaic reads at the right edge; dropping/narrowing it would change edge-pixel output. Policy: apply trivial perf only if provably identical.
- Suggested patch: replace the blanket fill with clearing only the uncovered tail region (band[width*row_h .. ] is already handled by resize; clear per-row the columns >= coltiles*tw within each band row) after confirming via the real DNG corpus that right-edge pixels stay byte-identical.

## DEFERRED 000-performance-22 — per-tile output Vec allocated inside the parallel map
- File: crates/raw-pipeline/src/dng.rs:175-186 (decode_one) + collect at :189-194
- Why deferred: rated complex; eliminating the N simultaneous tile Vecs means blitting directly into disjoint `out` regions from parallel tasks (changes the threading/borrow model) and requires benchmark evidence — out of the safe trivial-perf class.
- Suggested patch: keep correctness as-is; if pursued, have each parallel task write its active rect straight into a disjoint &mut out region (split_at_mut / par chunks) instead of allocating buf then serial-blitting, and benchmark before/after on a tiled DNG.

## DEFERRED 000-contracts-11 — has_alpha detected on full-res but applied to downscaled preview/thumb buffers
- File: crates/raw-pipeline/src/casabio_encode.rs:128 (detect), 184/192/198/210/214/218 (apply)
- Why deferred: changing the channel-count decision per-buffer alters the (pixels, num_channels) contract handed to the encoder, which can change the encoded output (3ch vs 4ch) of preview/thumb. The current behavior (opaque RAW -> false -> 3ch) is the documented, intended fast path and a prior 4ch->3ch fix lives in main; re-measuring per buffer is an output-affecting change, so it is out of the SAFE scope.
- Suggested patch: compute `has_alpha` independently for each buffer that is actually encoded, e.g. in `encode_into`/`encode_variant` derive `let has_alpha = has_meaningful_alpha(pixels);` instead of threading the full-res flag in. Then drop the `has_alpha` parameter from `encode_into`/`encode_variant`/`encode_distance_into` and from the call sites (lines 184/192/198/210/214/218/523/531). VariantSet.has_alpha would report the full-res measurement (or the OR of all buffers). Needs a round-trip test that a partially-transparent source whose Lanczos3 resize introduces/loses alpha<255 still encodes the correct channel count per level. Note: opaque->opaque is already safe today, so this is a structural-coupling/drift hardening, not a live bug.

## DEFERRED 000-performance-16 — encode_variants_from_rgb16_with_progressive clones the whole RGB16 buffer when texture/clarity set
- File: crates/raw-pipeline/src/casabio_encode.rs:337-343
- Why deferred: `apply_unsharp_masks` requires `&mut [u16]` but the public fn receives `rgb16: &[u16]` (shared borrow). Avoiding the `rgb16.to_vec()` clone requires either changing the signature to take `&mut [u16]` / an owned `Vec<u16>` (caller/signature change, outside the single-file SAFE scope) or rerouting unsharp into the toned RGBA output path (changes where/how the mask is applied -> risks changing output). Per policy (clone avoidable only with a signature/caller change), defer.
- Suggested patch: add a sibling `encode_variants_from_rgb16_owned(rgb16: Vec<u16>, ...)` (or `&mut [u16]`) that applies unsharp in place with no clone, and have the Tauri ingest caller (which owns the buffer) use it; keep the `&[u16]` variant clone-on-write for borrow callers. Peak memory then drops from rgb16 + rgb16_copy + rgba to rgb16(owned, mutated) + rgba. Verify pixel parity against the current clone path.

## DEFERRED 000-contracts-14 — analyze() silently zero-pads short pixel buffer
- File: crates/raw-pipeline/src/frame_stats.rs:181-194 (zero-pad branch at :184-186)
- Why deferred: changing the short-buffer branch from zero-padding to `Err`/clamp changes behavior for truncated inputs that currently "succeed" (return stats over the declared full pixel_count). It is unconfirmed whether time-lapse callers rely on the current padded/full-count result. Changing pixel_count to the real count, or returning Result, alters the public contract and the values consumers compare across frames. Policy: DEFER unless callers are confirmed to never rely on padding.
- Suggested patch: change `analyze` to return `Result<FrameStats, _>` (or document+clamp pixel_count to pixels.len()/4) ONLY after auditing every `analyze()` caller (raw-pipeline + the wasm mirror in src/lib.rs) to confirm none feed deliberately-truncated buffers expecting full-frame stats.

## DEFERRED 000-performance-1 — truncated input forces full zero-padded heap copy
- File: crates/raw-pipeline/src/frame_stats.rs:182-186 (zero_padded alloc+memcpy at :196-201)
- Why deferred: the obvious fix (clamp px to pixels.len()/4 and skip the pad) changes the reported pixel_count and the padded-black-pixel contributions for short inputs — i.e. it changes stats OUTPUT for the truncated path (same semantics question as 000-contracts-14). The analyze_scalar bounds-clamp already applied here makes the pad unnecessary for OOB safety, but removing the pad from analyze() still alters output magnitude (no padded zero pixels) and pixel_count. Touches padding semantics → DEFER.
- Suggested patch: once the padding contract is resolved (see 000-contracts-14), drop the `zero_padded` copy and call `analyze_scalar(pixels, px)` directly (the kernel now self-clamps), OR keep full-count semantics by zero-accounting the partial tail without materializing the px*4 buffer. Requires the same caller audit before changing observable output.

## DEFERRED 000-logic-12 — luma_variance /65536 scale vs ~255^2 luma magnitude
- File: crates/raw-pipeline/src/frame_stats.rs:43-47 (constant at :46)
- Why deferred: luma weights 54/183/18 sum to 255 so l_max ~= 255*255 = 65025; variance is divided by 65536 = 256^2 (not 65025). Changing the divisor alters every reported luma_variance value — a direct OUTPUT/contract change for telemetry consumers comparing variance thresholds across frames. The /65536 is plausibly intentional fixed-point (power-of-two, cheap) scaling and is internally consistent (scalar and AVX2 use the same constant). Low severity, cosmetic-unit only. Policy: output change → DEFER.
- Suggested patch: if a clean per-channel 0..255 luma-variance unit is desired, divide by 65025.0 (255^2) instead of 65536.0, and document the unit; but only after confirming no consumer has a calibrated threshold against the current value (it would silently shift all stored/compared variances).

## DEFERRED 000-contracts-13 — frame_stats hash is endianness/lane-order dependent (DELIBERATE STABLE CONTRACT)
- File: crates/raw-pipeline/src/frame_stats.rs:19-25 (combine_lanes), per-pixel word u32::from_le_bytes at :64/:160, lane = p&7 at :65/:161
- Why deferred / DO NOT TOUCH: frameHash is a HARD consumer contract, kept stable on purpose (time-lapse batch change-detection / near-duplicate id). The little-endian word packing, 8-lane (p&7) assignment, and fixed combine_lanes fold order are exactly what makes the hash reproducible across the scalar and AVX2 paths (asserted bit-identical, test :219-229) and across producers. Adding a version field, changing endianness handling, lane count, or fold order would change the hash for identical pixels and break the documented cross-process contract. This is intentional, not a bug. Do not change the hash algorithm/representation.
- Suggested patch: none. If portability to big-endian hosts is ever required, that is a new versioned hash format (additive, opt-in) and must not alter the existing default hash for current consumers.

## DEFERRED 000-performance-2 — AVX2 luma accumulation drops to scalar f64 per-lane
- File: crates/raw-pipeline/src/frame_stats.rs:127-135 (per-chunk scalar f64 l_sum/l_sq loop)
- Why deferred: rated complex; vectorizing the per-pixel luma sum / sum-of-squares into f64x4 (or i64) lanes reduced once at the end is a SIMD micro-optimization that must not change the final l_sum/l_sq bits (scalar/AVX2 parity is asserted bit-identical at :219-229). f64 reassociation across a different accumulation order can change rounding → could break the parity test and shift mean_luma/luma_variance. The kernel is documented memory-bound, so payoff is limited. Needs benchmark evidence AND a proof of bit-identical (or accepted) results. Policy: perf/SIMD needing evidence → DEFER.
- Suggested patch: accumulate luma in i64 lanes (exact, no FP reassociation risk since inputs are integers <= 65025*8 per chunk and fit i64), reduce horizontally once at loop end, convert to f64 there; benchmark on the 2.46MP/1.05MP cases in native_bench and re-run scalar_avx2_parity before adopting.

## DEFERRED 000-performance-4 — Unsharp clarity pass is single-threaded under `parallel`
- File: crates/raw-pipeline/src/pipeline.rs:701-714
- Why deferred: adding a `#[cfg(feature="parallel")] par_chunks_mut().zip()` path is a parallelization change that needs benchmark evidence (CLAUDE.md: no tunables/perf changes without data) and must be proven bit-identical to the serial blend before adoption.
- Suggested patch: mirror the texture branch (lines 681-688) — `rgb16.par_chunks_mut(width*3).zip(blurred.par_chunks(width*3))` running the same per-element `4.0*v*(1-v)` clarity blend; keep the serial `while i < n` as the `not(parallel)` fallback; verify byte-equal output and benchmark on a 20MP frame.

## DEFERRED 000-performance-5 — apply_luminance_nr blend loop single-threaded under `parallel`
- File: crates/raw-pipeline/src/pipeline.rs:1393-1401
- Why deferred: parallelizing the lerp blend is a perf change requiring benchmark evidence; per-element `round()` ordering could differ — must be proven output-identical first.
- Suggested patch: add a `#[cfg(feature="parallel")]` `par_chunks_mut().zip(blurred.par_chunks())` variant of the lerp (round/clamp identical per-element, so output is invariant), serial fallback retained; benchmark on high-ISO 20MP frame before adopting.

## DEFERRED 000-performance-19 — rgb16 integer-factor downscale fast path not parallelized
- File: crates/raw-pipeline/src/pipeline.rs:1503-1518
- Why deferred: only the rgb16 integer fast path runs serial `for dy`; converting to `par_chunks_mut` is a parallelization change needing benchmark evidence (the per-sub-row base-index recompute is the same loop, so a no-op hoist there could be safe, but the value is the parallelism, which needs data).
- Suggested patch: route the integer-factor `for dy` loop through `out.par_chunks_mut(dw*3).enumerate()` like the rgb16 general path (line 1524) and rgb8 fast path (line 1573); prove byte-equal and benchmark the common 1800→360 (5×) thumbnail case.

## DEFERRED 000-logic-20 / 000-contracts-18 / 000-architecture-16 — apply_orientation passes through mirror/transpose 2/4/5/7
- File: crates/raw-pipeline/src/pipeline.rs:1701-1713 (and rotate helpers :1722-1814)
- Why deferred: implementing EXIF orientations 2/4/5/7 changes the emitted geometry for those valid inputs (currently silent no-op), so it is an output change for affected images — out of the SAFE bucket.
- Suggested patch: add a mirror_horizontal/mirror_vertical helper and compose 5/7 as transpose(+flip); extend the `match` to handle 2 (mirror H), 4 (mirror V), 5 (transpose), 7 (transverse), returning correctly-swapped dims; gate behind a test corpus with known-orientation files since Olympus ORF rarely uses these.

## DEFERRED 000-contracts-8 — color_matrix None collapses absent/identity/Olympus
- File: crates/raw-pipeline/src/pipeline.rs:1033-1038 (fallback repeats at :1159/:1235/:1284/:1410)
- Why deferred: changing the `unwrap_or(&CAM_TO_SRGB)` fallback semantics (e.g. None→identity, or splitting intents) changes colour output for any frame whose `color_matrix` is None — a colour-parity change the user is strict about.
- Suggested patch: distinguish the three intents at the type level (e.g. `enum ColorMatrix { Identity, Camera([[f32;3];3]), GenericOlympus }`) or require callers to pass an explicit matrix; needs cross-crate caller audit (cr2.rs/dng.rs/orf.rs set color_matrix) and user sign-off on the per-format default, since it shifts colour for DNG/Canon frames that currently get the Olympus matrix.

## DEFERRED 000-concurrency-4 — process_into_auto SIMD vs scalar tolerance boundary undocumented at parity layer
- File: crates/raw-pipeline/src/pipeline.rs:1154-1219
- Why deferred: process_into_auto routes the plain path to process_into_simd (tone_simd::apply_tone_bulk), whose output is only tolerance-equal (≤0.05 abs / <1e-3 rel) to byte-exact process_into; adding/altering the routing or tightening tolerance changes output for valid inputs and needs an end-to-end parity test + decision.
- Suggested patch: add a test asserting process_into_auto vs process_into stay within 1 LUT step end-to-end (pre-LUT→tone→post-LUT) on a representative frame, and document the tolerance contract at the dispatch site; do NOT change the routing without that guard.

## DEFERRED 000-architecture-10 — apply_look_params 12 positional f32 args
- File: crates/raw-pipeline/src/pipeline.rs:1643-1694
- Why deferred: replacing the 12 positional args with a `LookParams`/`LookDelta` struct is a public-signature/architectural refactor touching every call site (out of single-file SAFE scope).
- Suggested patch: introduce a `LookDelta { exposure_ev: Option<f32>, ... }` (or named-field struct) folded by `apply`, deprecate the positional fn, and migrate callers in lib.rs / look renderer in a dedicated change.

## DEFERRED 000-errors-24 — demosaic single-row degenerate output vs error
- File: crates/raw-pipeline/src/demosaic.rs (demosaic_bayer / demosaic_rggb; demosaic_rggb_half already errors at :796-798)
- Why deferred: demosaic_rggb_half already returns Err on degenerate (hw==0||hh==0). The finding's actual gap is that the quality/bilinear paths (demosaic_bayer, demosaic_rggb, validate() only checks zero dims) accept 1xN/Nx1 and clamp edge neighbours, yielding a degenerate-but-non-erroring image. Adding a min-dimension Err to those paths changes behavior for currently-valid 1xN inputs (the m10c test exercises 1x1/1xN/Nx1 without panic) — a valid-output/behavior change, outside SAFE scope.
- Suggested patch: introduce an opt-in `validate_min_dims(raw, w, h, min)` (or a separate strict entry point) so callers that treat sub-2 dims as invalid can request an Err, without changing the default clamping contract or breaking the m10c test.

## DEFERRED 000-contracts-24 — demosaic_rggb native-vs-wasm internal path drift
- File: crates/raw-pipeline/src/demosaic.rs:152-158
- Why deferred: on wasm32 demosaic_rggb early-returns demosaic_rggb_simd (the production SIMD kernel, fresh alloc); on native it routes through demosaic_rggb_into. This is not pure dedup: removing the wasm early-return would swap the production wasm SIMD kernel for the scalar `_into` path (perf regression / different production kernel) and the `_into` reuse contract is a separate public fn. Output is documented bit-identical; impact is low. Resolving it is an architectural decision, not a SAFE in-place fix.
- Suggested patch: if unifying is desired, make demosaic_rggb_simd write into a caller buffer (demosaic_rggb_simd_into) and have demosaic_rggb call the `_into` variant on both targets, with a documented note that wasm still uses the SIMD kernel — verify byte-identity via the existing flip-flop harness before landing.

## DEFERRED 000-contracts-23 — decode_jxl_rgba8/rgba16 return Vec<u8> with no 4-vs-8 byte type distinction
- File: crates/raw-pipeline/src/jxl_decode.rs:489-503 (was jxl_lowlevel.rs:434-495; file renamed in BSD-clean own-FFI refactor)
- Why deferred: both decoders return Option<(Vec<u8>,u32,u32)> with the bytes-per-pixel contract (4 vs 8) living only in the function name. decode_jxtc_region recomputes bpp separately from header.bits_per_sample, so a wrong-decoder / mismatched-bpp call mis-strides rows with no type error. Fixing this means a type-level signature change (e.g. distinct return types or a tagged buffer carrying bpp) touching all callers — architectural, outside single-file SAFE scope.
- Suggested patch: introduce a small `RgbaBuffer { bytes: Vec<u8>, bpp: u8, w: u32, h: u32 }` (or separate Rgba8/Rgba16 newtypes) returned by the decoders and consumed by decode_jxtc_region so bpp is carried with the buffer instead of re-derived; migrate callers in a dedicated change.

---

### Section 008 — jxl-scheduler (deferred)

**`contracts-0f5c3a02` — No runtime assertion of the one-primary-per-sourceKey invariant**
- File: `packages/jxl-scheduler/src/dedupe.ts`, lines 26–47
- Finding: `register()` silently overwrites an existing `keyToSession` entry if called twice
  for the same `sourceKey`. There is no `DEBUG` assertion or invariant-throw to catch callers
  that double-register, so a missed `complete()` / lifecycle bug in the scheduler silently
  replaces the live primary reference and orphans the original session's worker.
- Why deferred: this is an ADR opportunity (add a dev-mode `assertInvariant` guard), not a
  mechanical fix. Implementing it here would require deciding the assertion strategy
  (throw/log/no-op in production vs. dev-only) and coordinating with the broader
  numeric-invariant-checking convention (see Section 002 ADR). Out of scope for the
  single-bug direct_fix pass.
- Suggested approach: in `register()`, add `if (this.keyToSession.has(sourceKey)) { /* assert */ }`
  gated behind a `DEBUG` flag or a package-level `strictMode` option (same pattern as the
  Section 002 `assertInvariant` ADR); log or throw in dev, no-op in prod. Verify the scheduler
  never legitimately double-registers by auditing all `this.dedupe.register()` call sites in
  `scheduler.ts` (should only be called after `findPrimary` returned null).

#### dedupe.ts (continued)

#### budget.ts — Unbounded waiter queue: should acquire() have a hard cap?

**Task IDs:** `008-errors-a1f3c2d0-0016-4b11-9e21-100000000016`,
             `008-security-8f6d3e51-acbb-4e8d-9f2a-6b7c4d1e5a08`

`CoreBudget.acquire()` enqueues waiters with no upper bound. In practice the waiter count
is bounded by `sum(pool.maxSize)` across all pools sharing the budget (each live pool worker
calls acquire exactly once, and pool.maxSize is a construction-time constant). However, if
multiple JxlContext instances share `globalCoreBudget` at runtime their combined pool sizes
could grow unbounded.

**Question for design review:** Is `globalCoreBudget` intended to be shared across an
open-ended number of JxlContext/pool instances, or is the total number of pools sharing it
a fixed constant (e.g. 2-3 pools per JxlContext, 1 context per page)? If unbounded sharing
is possible, the right fix is a configurable `maxWaiters` cap on `acquire()` that rejects
(throws) when exceeded — but the value needs to come from the design (e.g. `capacity * 4`
as a reasonable sentinel). Changing it to reject without a documented cap risks breaking
legitimate MT-pool queuing under load.

**Suggested approach:** Document the intended sharing model in a JSDoc comment on
`globalCoreBudget`. If the answer is "bounded by construction," close this as won't-fix.
If unbounded, add `maxWaiters?: number` to the constructor and reject in `acquire()` when
`this.pendingCount >= maxWaiters`.

#### scheduler.ts deferrals

- `packages/jxl-scheduler/src/scheduler.ts:686,695` — signalDrain double-decrements queueDepth (covers tasks `008-concurrency-c3e8f402-9d63-4f4c-be33-50219ab3d403`, `008-logic-a1c3e7d2-0001-...`, `008-errors-a1f3c2d0-0007-...`). DEFERRED per fixer guardrail: verifiers disagreed — one confirmed an over-decrement, two could not prove a defect because the worker coalesces `worker_drain` (decode-handler.ts:152, one drain covers multiple chunks), so the strict 1:1 push↔drain invariant the finding assumes does not hold, and the per-waiter decrement at L695 is defensible under a "depth = pushes still counted toward HWM" model. Direction: do NOT change the arithmetic without a runtime trace establishing the intended invariant; if confirmed, the fix is to drop the second `bp.queueDepth = Math.max(0, bp.queueDepth - 1)` inside the resolve loop (a resolved waiter is proceeding, not drained). Needs benchmark/trace evidence before touching adaptive HWM accounting.

- `packages/jxl-scheduler/src/scheduler.ts:556-562` — promotion subscriber→primary counter assumes promotedRecord.state is final (task `008-errors-a1f3c2d0-0020-...`). DEFERRED: verifier verdict is "currently-correct-but-fragile" — the worker-transfer branch never sets `promotedRecord.state='running'` but subscribers are always created with `state:'running'`, so the L560-562 dispatch coincidentally lands correct. Not a live bug. Direction: an explicit invariant assertion (DEV-only) or normalising `promotedRecord.state` in the transfer branches before the counter dispatch — but this is hardening, not a confirmed defect, and overlaps the broader counter-reconciliation ADR (`008-logic-a1c3e7d2-0010`).

- `packages/jxl-scheduler/src/scheduler.ts:417-421` (send) / 465-466 (bufferedChunks) — per-session bufferedChunks queue is unbounded for a queued session under worker starvation (task `008-security-2e8a6f44-5c77-4b1d-9e3a-6f4b2c1d8e04`). DEFERRED: a hard cap is a behavioral policy decision, not a mechanical fix — when the cap is hit the scheduler must either drop chunks (silent data loss) or fail/error the queued session, both of which change the queued-`send()` contract that jxl-session relies on. Backpressure for queued (pre-assignment) sessions is a genuine gap but the correct layer/semantics (e.g. surface a `decode_error`/queue-overflow event vs. apply waitForDrain-style blocking to queued sessions) needs a contract decision. Direction: decide the overflow policy with the jxl-session owner, then enforce at the scheduler layer (not facade/session).

---

## Section perceptual — crates/raw-pipeline/src/perceptual/simd/avx512.rs

### DEFERRED 001-security-7 — downsample_avx512 OOB-write on unvalidated w/h/dw/dh
- File: crates/raw-pipeline/src/perceptual/simd/avx512.rs (downsample_avx512, ~L118-149)
- Why: Out of fixer scope for this file's task allotment (only pixels_to_xyb_avx512
  and scale_err_avx512 were assigned as SAFE). Same class of fix as the two applied
  (an entry debug_assert on src.len()>=w*h && dst.len()>=dw*dh && dw==(w+1)/2 && dh==(h+1)/2),
  but the dw/dh halving relation is a real precondition worth confirming against the
  caller (dn2 / dispatcher) before asserting, to avoid a false trap. Defer to a pass
  that can see the caller. Sibling downsample_avx2 has the same unenforced invariant.
- Suggested patch: at fn entry,
  `debug_assert!(src.len() >= w * h && dst.len() >= dw * dh, "downsample_avx512: src/dst shorter than dims");`
  (omit the dw/dh==halved assertion unless the caller contract is confirmed).

### DEFERRED 001-logic-2 — scale_err_avx512 f32-accumulator precision divergence vs scalar f64 oracle
- File: crates/raw-pipeline/src/perceptual/simd/avx512.rs (scale_err_avx512, ~L32/L60/L63)
- Why: This is a metric-value concern (could change reference numbers) and tail-math
  cleanup — explicitly DEFER per fixer policy. The 16-wide f32 accumulator +
  _mm512_reduce_add_ps tree reduction rounds differently from the scalar f64 sum and
  from the AVX2 path, so the three backends can disagree on large images. Any change
  here alters output values and needs ADR sign-off + AVX-512 hardware to verify (dev
  machine lacks AVX-512; parity test is skipped, only n=1000).
- Suggested patch (for review, not applied): widen accumulation to f64 (e.g. accumulate
  e2*root per-lane into an f64 running sum, or split-add the reduced f32 partials less
  often), matching the scalar oracle — but this is a deliberate accuracy/perf tradeoff,
  not a no-op, so it must not land as a "safe" fix.

---

## DEFERRED 001-logic-1 — SIMD scale_err f32 accumulator vs scalar f64 oracle
- File: crates/raw-pipeline/src/perceptual/simd/avx2.rs:38,71,86 (scale_err_avx2 `acc`)
- Why: The scalar oracle (butteraugli.rs) sums each `e2*sqrt(e2+eps)` term in f64; the AVX2 path accumulates in an f32 `_mm256` register and only widens at `hsum256`. Promoting the lane accumulator to f64 (e.g. two f64x4 accumulators or periodic reduce) CHANGES the valid-input metric value — the parity test (n=1000, rel<1e-4) passes today, and the magnitude of drift at full resolution is unverified. Out of FIXER SAFE policy (must not change valid-input metric values). Also mirrored in avx512.rs / wasm.rs — a uniform change is an architecture decision.
- Suggested patch: replace single f32 `acc` with two f64x4 accumulators (`_mm256_cvtps_pd` the term, add into f64 lanes) or periodically reduce the f32 acc into an f64 running sum; apply consistently across avx2/avx512/wasm and re-tighten the parity tolerance with a full-resolution validation.

## Section perceptual — crates/raw-pipeline/src/perceptual/simd/wasm.rs

Applied 2 safe guard-only fixes (no valid-input value change), mirroring the
established `scale_err_avx512` debug_assert pattern:
- 001-security-9: entry `debug_assert!` on `scale_err_wasm` tying the seven f32
  slices' lengths to `n` (v128_load OOB guard, debug-only, release no-op).
- 001-security-8: entry `debug_assert!` on `pixels_to_xyb_wasm` requiring
  `px.len() >= n*4` and each output plane `>= n` (get_unchecked / v128_store OOB
  guard; matters most on wasm32 where usize is 32-bit and width*height can wrap).
Verified: wasm32-unknown-unknown +simd128 build compiles clean; native
`cargo test --no-default-features --lib` stays green (104 passed, 7 ignored).
wasm intrinsics are not exercised under cargo test (module is cfg(wasm32)).

## DEFERRED 001-logic-3 — scale_err_wasm f32 v128 accumulator vs scalar f64 oracle
- File: crates/raw-pipeline/src/perceptual/simd/wasm.rs:35,51,55 (scale_err_wasm `acc`)
- Why: Same precision-divergence class as 001-logic-1 (avx2) and 001-logic-2 (avx512).
  The wasm path accumulates `e2*root` into an f32x4 v128 lane accumulator and only
  widens at `hsum` before the f64 tail. Promoting to an f64 accumulation CHANGES the
  valid-input metric value and would diverge from the avx2/avx512 siblings (which keep
  the f32 accumulator). Per fixer policy the overflow/precision change is only SAFE if
  it RESTORES scalar parity — here it would instead become a new numeric path that the
  in-tree tests cannot verify (wasm intrinsics can't run under `cargo test`; the module
  is verified only against the JS reference in Node). A uniform f32→f64 change across
  avx2/avx512/wasm is an ADR-level architecture decision, not a no-op. DEFER.
- Suggested patch: apply the same fix proposed in 001-logic-1 (two f64 lane
  accumulators, or periodic reduce of the f32 acc into an f64 running sum) consistently
  across avx2/avx512/wasm, then re-tighten the parity tolerance with a full-resolution
  validation in Node for the wasm path.

## DEFERRED 001-contracts-9 — pixels_to_xyb LUT raw `*const f32` leaks the 256-entry invariant
- File: crates/raw-pipeline/src/perceptual/simd/avx2.rs:150-188 (and avx512.rs:80-102)
- Why: `pixels_to_xyb_avx2`/`_avx512` take `lut: *const f32`, gather with u8-derived indices 0..255, and reconstruct `from_raw_parts(lut, 256)` in the tail. The 256-entry requirement is documented only in a comment. Encoding it as `&[f32; 256]` (as wasm.rs:65 already does) is a SIGNATURE CHANGE that also touches the avx512 mirror and the `sqrt_lin_lut_ptr()` caller — outside the single-file SAFE scope.
- Suggested patch: change both x86 signatures to `lut: &[f32; 256]`, drop the `from_raw_parts`, and update `xyb::sqrt_lin_lut_ptr()`/callers to pass the array reference.

## DEFERRED 001-architecture-11 — ssim_moments_avx2 is scalar; name + target_feature mislead
- File: crates/raw-pipeline/src/perceptual/simd/avx2.rs:130-148
- Why: `ssim_moments_avx2` contains no AVX2 intrinsics (a tight scalar u64 loop) yet carries `#[target_feature(enable="avx2")]` "purely for call-site uniformity". Renaming/moving it beside the scalar SSIM in ssim.rs and repointing the dispatcher is a multi-file refactor (touches mod.rs dispatch + ssim.rs) — outside single-file scope and not a correctness change.
- Suggested patch: move to ssim.rs as `ssim_moments` (drop the feature gate), and have the x86 dispatch arm call the shared scalar fn directly.

## DEFERRED 001-performance-10 — AVX2 XYB gather built from a scalar 8-iteration byte loop
- File: crates/raw-pipeline/src/perceptual/simd/avx2.rs:165-177
- Why: `pixels_to_xyb_avx2` scalar-loads 24 bytes into ri/gi/bi then issues three `_mm256_i32gather_ps`. Replacing the gather with shuffle-deinterleave + arithmetic sRGB decode (or a cache-resident LUT) is a complex perf rework that risks changing valid-input float values; flagged low-priority given documented memory-bound profiling.
- Suggested patch: benchmark a shuffle-based deinterleave that decodes sRGB arithmetically (no gather); only adopt if it both wins on the bench AND holds the <1e-6 parity tolerance.

## DEFERRED 001-contracts-5 — PSNR includes alpha channel while SSIM/butteraugli ignore it
- File: crates/raw-pipeline/src/perceptual/psnr.rs (and mod.rs:242-247 SIMD ssd_avx2)
- Why: The doc comment documents an explicit contract — "alpha included, to match the legacy JS `computePsnrVsFinal`". Dropping alpha from the MSE would change the PSNR value for every valid non-identical RGBA input (e.g. constant-alpha buffers shift ~25%). That is a MAX-value / cross-metric-contract change, which policy says to DEFER. Also requires a matching change in the SIMD path (mod.rs ssd_avx2, outside this file's scope) to keep scalar/SIMD parity.
- Suggested patch (if the cross-metric 3-channel contract is desired): iterate only the RGB bytes (skip every 4th byte) and divide sum_sq by `3 * (a.len()/4)` in BOTH psnr::psnr and the SIMD ssd path; update the doc comment and the `known_mse_matches_formula` test. Confirm with the user whether legacy-JS parity must be preserved before changing.

## DEFERRED 001-errors-8 — psnr returns +inf for two empty buffers (conflates "identical" with "no data")
- File: crates/raw-pipeline/src/perceptual/psnr.rs:12-13 (and mod.rs:243 SIMD branch)
- Why: For `a.len()==0` the loop never runs, sum_sq stays 0, and the `sum_sq==0` branch returns f32::INFINITY. Changing the empty-buffer return (e.g. to NaN) is a sentinel-contract change: the `sum_sq==0 -> INFINITY` branch is the documented "identical inputs" contract (test `identical_is_infinite`), and distinguishing empty from identical would require either a separate `a.is_empty()` check returning a different sentinel or reworking the contract. Policy classifies sentinel-contract changes as DEFER; in practice n==0 is only reachable via a zero-extent image (Comparer has no width/height>0 check).
- Suggested patch: add `if a.is_empty() { return f32::NAN; }` before the `sum_sq==0` check in psnr::psnr, and the equivalent guard in mod.rs::psnr before the SIMD `sum_sq==0` branch; OR add a `width>0 && height>0` check in `Comparer::new`. Confirm desired empty-buffer semantics (NaN vs error vs current +inf) with the user.

## DEFERRED 001-performance-2 — channel_moments recomputes per-channel sum/sum-of-squares already produced by the SSIM moment pass
- File: crates/raw-pipeline/src/perceptual/ssim.rs:94-113 (channel_moments) + mod.rs:287-293 (all)
- Why: The reuse cannot be done within ssim.rs without value-neutral fusion across two metric paths and a signature change. The SSIM sums sa[c]/saa[c] are accumulated inside ssim_with_ref (scalar) / ssim_moments_avx2 (SIMD) and consumed by finalize_ssim, then discarded — they are never returned to `all()`. Deriving mus=sa/np and vars=saa/np-mu*mu would require: (a) returning sa/saa from the ssim path (signature change), and (b) rewiring `all()` in mod.rs (out-of-target file). FIXER policy classifies signature changes and fusion-across-metrics (architecture) as DEFER. The math is provably identical (both use f64 sum/np - mu*mu), so this is a safe perf win once the plumbing is approved.
- Suggested patch: Have `ssim()`/`ssim_moments_avx2` optionally surface (sa, saa) for channels 0..3, and in `Comparer::all()` derive ChannelMoments from those instead of calling channel_moments — eliminating one full-image read. Keep channel_moments as the standalone fallback. Verify `all_matches_individual_calls` still passes within 1e-6.

## DEFERRED 001-contracts-8 — ssim_with_ref returns 0.0 for np==0 while psnr returns +inf and butteraugli returns NaN (divergent empty-input contract)
- File: crates/raw-pipeline/src/perceptual/ssim.rs:35-37 (np==0 -> 0.0)
- Why: Changing the np==0 return value is a value-changing edge-case + cross-metric contract decision. The current `0.0` guard already prevents div-by-zero/panic for empty input; it just disagrees with psnr (+inf) and butteraugli (NaN) on what "empty" means. Harmonising the three is an architecture/contract call (which sentinel: NaN, error, or current per-metric values), not a localised safety fix. Policy: value-changing + cross-metric → DEFER.
- Suggested patch: Decide a single empty-input contract (recommend NaN = "no data", reserving the existing best/worst values for genuine identical/degenerate non-empty input) and apply consistently across ssim/psnr/butteraugli; OR reject zero-extent images in Comparer::new. Confirm desired semantics with the user.

## DEFERRED 001-contracts-13 — SSIM correctness depends on an unenforced call-order pairing between ref_moments and ssim_with_ref/finalize_ssim
- File: crates/raw-pipeline/src/perceptual/ssim.rs:9-23 (ref_moments), :27-54 (ssim_with_ref), :58-83 (finalize_ssim)
- Why: Marked `complex`. The contract that ref_moments(b, np, ch) must be paired with ssim_with_ref/finalize_ssim using the same np, the same reference buffer, and a compatible ch (the AVX2 path deliberately precomputes ch=4 then finalizes wch=3, valid only because 0..3 is a prefix) is implicit and unenforced. Enforcing it requires a type/contract change (e.g. a RefMoments newtype carrying np/ch, or finalize taking np/ch from the precompute) — a signature/architecture change beyond the SAFE-task scope.
- Suggested patch: Introduce a `struct RefMoments { sb, sbb, np, ch }` returned by ref_moments and consumed by ssim_with_ref/finalize_ssim, with a debug_assert that the finalize np/wch match the precompute. Wire through Comparer fields. Verify ssim parity tests + scalar_avx2_parity remain green.

---

### Section 015 — jxl-worker-browser (deferred)

**D-015-1 — MAX_OUTPUT_BYTES_GUARD ceiling is a conservative default, not a validated policy limit**
- File: `packages/jxl-worker-browser/src/decode-handler.ts`, new constant `MAX_OUTPUT_BYTES_GUARD`
- The 1 GiB ceiling (at 1 byte/pixel minimum = ~1 billion pixels) was chosen as a clearly-generous overflow guard, not a policy resolution. If the platform legitimately needs to decode images larger than ~32K×32K, this constant must be raised. A future policy decision should align the ceiling with the actual maximum supported canvas size (which may vary by platform/browser and is not currently documented in CLAUDE.md).
- Suggested action: Document the intended maximum decode resolution in CLAUDE.md or a capabilities doc, and set `MAX_OUTPUT_BYTES_GUARD` to `maxWidth * maxHeight * maxBytesPerPixel` rather than the current conservative 1 GiB floor.

**D-015-2 — output_bytes vs copied_bytes metric semantics are inconsistent across budget paths**
- File: `packages/jxl-worker-browser/src/decode-handler.ts`, budget arms
- The progress/final budget-check-2 arms post `copied_bytes` (only when `transfer.copied`) AND let `postBudgetExceeded` post `output_bytes` (always). The codec-emitted `budget_exceeded` arm (after this fix) only posts `output_bytes` via `postBudgetExceeded`. A consumer cannot tell whether `copied_bytes` or `output_bytes` is the canonical metric for buffer size on the budget path — two names, sometimes one present, sometimes both. Consider unifying to a single `output_bytes` metric posted by `postBudgetExceeded` for all paths, and removing `copied_bytes` from the check-2 arms as well, or documenting the semantics difference explicitly.

**D-015-3 — pre-existing typecheck failures in encode-handler.ts and worker.ts**
- `encode-handler.ts:365` — `finishPromise.catch()` called on `void | Promise<void>` (introduced by another section's fix to the finish-timeout/unhandled-rejection bugs)
- `worker.ts:588` — `Location` type not found (from the worker_ready tier-handshake fix)
- These must be resolved in their respective section fix passes, not here. They do not affect decode-handler.ts typecheck correctness.

### Section 015 — jxl-worker-browser (deferred)

Single-file fixer scope: packages/jxl-worker-browser/src/encode-handler.ts. The
following pending tasks were deferred (perf/info nicety, not mirrorable without
behavior risk). All confirmed-bug tasks for this file were fixed.

## DEFERRED 015-performance-...006fa2b6c406 — onPixels allocates a wrapper object per inbound pixel chunk
- File: packages/jxl-worker-browser/src/encode-handler.ts:113-118 (onPixels)
- Why: severity=info. The encode input queue is a plain `Array<{chunk, region?} | undefined>`
  with a read index + compactQueue, NOT the decode handler's pre-allocated power-of-two
  ChunkRing. Each chunk must carry an optional `region`, so a flat `ArrayBuffer` ring (as in
  decode) cannot represent the pair without a parallel region ring or an object wrapper. The
  guardrail says fix only if mirrorable WITHOUT behavior change; converting to a paired ring is
  a structural refactor of the queue (region pairing, compaction, takeNextPixels/drain math) with
  real behavior risk and no benchmark evidence. Deferred per "else DEFER (perf nicety, not worth risk)".

## DEFERRED 015-performance-...003fa2b6c403 — takeNextPixels calls compactQueue on every drained chunk
- File: packages/jxl-worker-browser/src/encode-handler.ts:271-293 (takeNextPixels / compactQueue)
- Why: severity=low. Same root cause as above — the array+read-index queue compacts per drained
  chunk where decode's ChunkRing is O(1) shift with no compaction. Eliminating the per-chunk
  compaction means replacing the queue data structure with a ring (paired with region), the same
  structural refactor deferred above. compactQueue already uses no-alloc copyWithin and only
  compacts past index 64, so the hot-loop cost is bounded. Deferred to avoid behavior risk.

## DEFERRED 015-performance-...004fa2b6c404 — feedEncoder takes two performance.now() per loop for wait-timing
- File: packages/jxl-worker-browser/src/encode-handler.ts:295-328 (feedEncoder)
- Why: severity=info. The decode handler reuses one post-push timestamp for both push-latency and
  drain coalescing because its drain gate is driven from inside the push loop with `now` passed in.
  The encode handler's maybePostDrain() reads its own `performance.now()` (it is called without a
  timestamp argument, also from onPixels-adjacent paths). Threading a single timestamp through
  maybePostDrain would change its signature/call sites and the drain interval semantics slightly;
  micro-optimization with no benchmark evidence. Deferred per "else DEFER".

Note: 015-errors-...2c4e6a8b0c13 (feedEncoder maybePostDrain after await / drain-after-terminal)
was NOT deferred — it is already adequately guarded: feedEncoder returns early via
`if (this.isTerminal()) return;` immediately before maybePostDrain(), and maybePostDrain only
emits an advisory worker_drain (no state mutation, no terminal interaction). No change needed.

## Section perceptual — crates/raw-pipeline/src/perceptual/mod.rs

Applied 3 safe guard-only fixes (no valid-input metric-value change): 001-security-1/001-errors-3
(checked_mul overflow guard on width*height and *4 in Comparer::new), 001-concurrency-1 +
001-concurrency-2 (runtime is_x86_feature_detected! gate on BackendChoice::Force(id) via a new
resolve_forced_backend free fn, falling back avx512->avx2->scalar; the AVX-512 backends additionally
require avx2+fma since their SSIM/PSNR reuse the avx2 kernels), and 001-errors-6 (length guard in
all() so a short test buffer no longer panics OOB in channel_moments after the three metrics already
degraded to NaN). For a supported CPU on valid input, backend selection and every metric value are
unchanged. cargo test --no-default-features --lib green: 104 passed, 7 ignored incl scalar_avx2_parity.

## DEFERRED 001-contracts-1 — Comparer assumes 8-bit (0..255) RGBA, no range contract
- File: crates/raw-pipeline/src/perceptual/mod.rs:88-93
- Why: Fixing needs an API/doc contract decision. The 0..255 domain is baked into three independent constants (256-entry LUT in xyb.rs, PSNR 255.0, SSIM C1/C2). Feeding 16-bit-derived bytes yields silently meaningless scores. No runtime check can distinguish valid 8-bit from packed 16-bit without changing the signature/contract.
- Suggested: ADR — document the 0..255 invariant on Comparer::new/metric methods, or add a bit-depth parameter and parameterize the LUT/PSNR-max/SSIM-C constants.

## DEFERRED 001-contracts-3 — Metrics return bare f32 with NaN/Inf as undocumented sentinels
- File: crates/raw-pipeline/src/perceptual/mod.rs:202-251 (butteraugli/ssim/psnr/all)
- Why: f32::NAN overloads "size-mismatch error"; psnr also returns f32::INFINITY for a legitimate perfect score. Forcing callers to handle both needs a Result/Option (or newtype) return — a public API/signature change.
- Suggested: ADR — return Result<f32, MetricError> / Option<f32>, or at minimum document the sentinel semantics on each pub method.

## DEFERRED 001-contracts-2 — SSIM SIMD path hardcodes RGBA stride 4 / 3 channels vs scalar ch param
- File: crates/raw-pipeline/src/perceptual/mod.rs:221-233
- Why: ssim_moments_avx2 unconditionally uses stride 4 / channels 0..3 while scalar ssim_with_ref honors an explicit ch. Masked today: Comparer is always constructed RGBA, so no value divergence on valid input. A structural fix (plumb ch into the AVX2 entry point) is an API change; no guard applied since the divergence is unreachable under the RGBA-only construction.
- Suggested: ADR — restrict the AVX2 entry point contract to RGBA explicitly, or add a ch parameter to match the scalar contract before SSIM is wired for grayscale/RGB stride.

## DEFERRED 001-performance-1 — Comparer::all() walks the test buffer ~4 times
- File: crates/raw-pipeline/src/perceptual/mod.rs:283-289
- Why: Perf restructure (fuse XYB/SSIM/PSNR/channel-moments into one deinterleave pass). Needs benchmark data per CLAUDE.md; the doc comment already notes the fused SIMD override is deferred to a later task.
- Suggested: fused single-read kernel computing SSD + 5 SSIM moments + channel mus/vars off one test+ref read; gate on benchmark.

## DEFERRED 001-performance-3 — downsample_dispatch copies planes back into tx/ty/tb each scale
- File: crates/raw-pipeline/src/perceptual/mod.rs:196-198
- Why: Pure memory-traffic perf change (mem::swap the (tx,dx)/(ty,dy)/(tb,db) roles instead of copy_from_slice). No value change, but it restructures the downsample dataflow + scale_err read source; needs benchmark and care that scale_err_dispatch reads the right buffer.
- Suggested: ping-pong buffers (index toggle or mem::swap); benchmark before/after.

## DEFERRED 001-performance-6 — Reference pyramid clones 3 planes per level + fresh dn2 allocs
- File: crates/raw-pipeline/src/perceptual/mod.rs:97-107
- Why: One-time reference-side allocation cost (low severity). Removing the clone-into-Level / preallocating dn2 outputs is a perf restructure of the pyramid build.
- Suggested: move buffers into Level when no longer needed for the next downsample; have dn2 write into preallocated level storage.

## DEFERRED 001-performance-12 — ssim() and psnr() each stream test+ref independently
- File: crates/raw-pipeline/src/perceptual/mod.rs:221-251
- Why: Perf fusion (SSD + SSIM moments in one paired pass), compounds with perf-1. Needs benchmark.
- Suggested: single fused pass over paired RGBA bytes for both metrics in all().

## DEFERRED 001-errors-2 — Comparer::new panics (assert_eq!) on bad ref buffer instead of Result
- File: crates/raw-pipeline/src/perceptual/mod.rs:88-90
- Why: Constructor hard-panics on caller data while metric methods return NaN — inconsistent. Making it recoverable requires changing new to return Result, a public API/signature change. (The overflow root cause IS fixed via checked_mul under 001-security-1; an oversized-dims input now gets a clear panic message rather than a wrapped length.)
- Suggested: ADR — Comparer::new(...) -> Result<Self, ComparerError>; unify the bad-length convention with the metric methods.

## DEFERRED 001-architecture-8 — Comparer::new is a god-method (XYB+pyramid+blur+ssim+backend)
- File: crates/raw-pipeline/src/perceptual/mod.rs:88-142
- Why: Refactor — extract build_reference_pyramid and resolve_backend. Partially started (resolve_forced_backend extracted under 001-concurrency-1), but the full pyramid decomposition is an architecture change with no behavior delta.
- Suggested: ADR — extract build_reference_pyramid(rgba,w,h,scales) -> Vec<Level>; constructor reads as compose(pyramid, ref_moments, backend).

## DEFERRED 001-architecture-5 — AVX-512 SSIM/PSNR route through avx2 module (misplaced coupling)
- File: crates/raw-pipeline/src/perceptual/mod.rs:225-251
- Why: ssim/psnr fold Avx512 backends into the avx2 arm calling simd::avx2::ssd_avx2 / ssim_moments_avx2 (no avx512 impl exists). Results correct; relocating the byte-reduction kernels to a backend-neutral reduce submodule is an architecture change touching other files. (The runtime-safety side — avx2 must be present when an AVX-512 backend is selected — IS now guarded via resolve_forced_backend, see 001-concurrency-2.)
- Suggested: ADR — move ssd/ssim_moments into a backend-neutral module; stop naming the SSE2-width kernel "avx2".

## DEFERRED 001-contracts-6 — butteraugli() mutates tx/ty/tb scratch; call-order invariant only in a doc line
- File: crates/raw-pipeline/src/perceptual/mod.rs:202-233
- Why: Latent leaky invariant — no current bug (ssim/psnr read raw bytes + ref, not the XYB scratch). Enforcing it structurally is a design change with no value impact today.
- Suggested: ADR — give butteraugli its own scratch, or encode the call-order ordering.

## DEFERRED 001-logic-8 — butteraugli divides by hard-coded 7.0, ignoring Opts.weights
- File: crates/raw-pipeline/src/perceptual/mod.rs:210-218
- Why: 7.0 == sum of default weights [4,2,1]; the divisor is not derived from weights. Changing it to weights.iter().sum() WOULD change valid metric values for any caller supplying non-default weights — a valid-input output change. DEFER per policy (when unsure whether valid metric values change -> DEFER), even though it is arguably a normalization bug. Low real-world reach (WASM/example only pass Opts::default()).
- Suggested: divisor = self.opts.weights.iter().sum() (fallback to 7.0 when sum==0). Confirm no downstream baseline depends on the literal 7.0 before applying.

## DEFERRED 001-contracts-7 — Avx512 SSIM/PSNR contract is "whatever AVX2 does", asymmetric dispatch
- File: crates/raw-pipeline/src/perceptual/mod.rs:226-251
- Why: butteraugli has distinct avx512 arms; ssim/psnr group avx512 into the avx2 arm. Results equal by construction — no value change. Fixing the asymmetry is structural (overlaps 001-architecture-5).
- Suggested: ADR — same as architecture-5; or add a doc note that SSIM/PSNR intentionally share the 256-wide reduction across AVX2/AVX-512.

## DEFERRED 001-contracts-12 — Force(id) silently maps unknown/WasmSimd ids to Scalar
- File: crates/raw-pipeline/src/perceptual/mod.rs:109-117 (now resolve_forced_backend)
- Why: The unguarded-feature UB aspect IS fixed (001-concurrency-1). What remains is the "silent fallback is invisible" reporting — surfacing an error/warning on an invalid forced id requires the constructor to return an error/log (an API change, ties into 001-errors-2 Result return).
- Suggested: ADR — return Result or log a warning on unknown/unsupported forced ids so a typo'd bench id is visible.

## DEFERRED 001-logic-10 — reference XYB always scalar while test XYB uses SIMD backend
- File: crates/raw-pipeline/src/perceptual/mod.rs:144-167 (test) vs :93 (ref)
- Why: Reference built with scalar pixels_to_xyb; test routed through SIMD (FMA Y-channel) — injects a tiny (<tolerance) nonzero butteraugli on an identical image under a SIMD backend. Building the reference with the same backend changes valid metric values (the identical-image score shifts toward exact 0) -> valid-input output change. Also a structural change to Comparer::new.
- Suggested: ADR — route ref XYB through the same fill_*_xyb backend, or document the scalar/SIMD reference asymmetry as intentional within tolerance.

## DEFERRED 001-performance-8 — dn2 allocates a fresh output Vec on every call
- File: crates/raw-pipeline/src/perceptual/butteraugli.rs:40-43 (caller: mod.rs:102-110 Comparer::new)
- Why: Eliminating the per-call `vec![0f32; dw*dh]` requires an in-place / caller-owned-scratch variant — a signature change to the pub(crate) `dn2` plus a matching edit in Comparer::new (outside this single-file safe scope). No correctness impact (one-time reference-pyramid cost: 3 planes × 2 levels = 6 allocs per reference). Policy: DEFER signature changes / restructure.
- Suggested: add `dn2_into(src, w, h, dst: &mut Vec<f32>) -> (usize, usize)` (mirroring the existing downsample_inplace at mod.rs:293) that resizes `dst` to dw*dh and writes box-averaged samples; have Comparer::new reuse a preallocated level buffer instead of the clone-and-reassign move. Keep the 0-extent guard from 001-errors-5.

## DEFERRED 001-performance-4 — box_blur vertical pass column-walks a row-major buffer (cache anti-pattern)
- File: crates/raw-pipeline/src/perceptual/blur.rs:26-37
- Why: The vertical pass has x outer / y inner, touching tmp[y*w+x] and dst[y*w+x] with stride w (one cache line miss per step for w beyond a line). A tiled/transposed or column-block sliding-window rewrite restructures memory access and is a parallelization/perf change needing benchmark evidence; it also risks subtly changing float accumulation/output. Policy: DEFER restructure-needing-benchmark / when-unsure-output-changes. Impact is reference-build-only (3 scales, Comparer::new mod.rs:104), so one-time, not a per-test hot loop.
- Suggested: transpose tmp→a column-major scratch, run the horizontal sliding-window kernel on it, transpose back into dst; OR process columns in cache-friendly blocks (e.g. 8/16-wide column tiles) so each sliding-window step touches contiguous lines. Must prove bit-identical against scalar reference (the sliding-window add/sub order per output pixel is unchanged, only iteration order differs) and benchmark before landing.

## DEFERRED 001-performance-5 — box_blur heap-allocates tmp + dst per call with no reuse
- File: crates/raw-pipeline/src/perceptual/blur.rs:4-8
- Why: Removing the two per-call w*h f32 Vecs requires either a caller-owned scratch arena or an `_into` variant — a signature change plus a matching edit in Comparer::new (mod.rs:104), outside the single-file safe scope. No correctness impact (one-time reference-side cost: 3 separate tmp+dst allocations per reference, masks recomputed per reference not per test). Policy: DEFER signature changes.
- Suggested: add `box_blur_into(src, w, h, r, tmp: &mut Vec<f32>, dst: &mut Vec<f32>)` that resizes both scratch buffers to w*h (or early-returns when n==0) and writes the blurred plane into dst; keep the existing `box_blur` as a thin wrapper. Have Comparer::new (or the future fused per-test pass, if blur ever moves there) reuse a single tmp scratch across scales. Keep the n==0 guard already added for 001-errors-4.

### Section 010 — jxl-session (deferred)

#### DEFERRED 010-contracts-7a1c0e22-0002 + 010-logic-7a1c9e02-0003 — ~12 EncodeOptions knobs with no MsgEncodeStart wire field (cross-package)
- File: `packages/jxl-session/src/encode-session.ts` (field copy site), `packages/jxl-core/src/protocol.ts` (MsgEncodeStart), worker encode-handler(s)
- Fields missing wire representation: `modular`, `brotliEffort`, `decodingSpeed`, `photonNoiseIso`, `buffering`, `advancedControls`, `jpegReconstruction`, `alreadyDownsampled`, `upsamplingMode`, `ecResampling`, `frameIndexing`, `allowExpertOptions` (EncodeOptions types.ts:161–300).
- Why deferred: cannot forward from encode-session.ts alone — requires (1) new optional fields on MsgEncodeStart in `jxl-core/protocol.ts`, (2) copy in encode-session.ts constructor, (3) consumption in the worker encode-handler(s). Three-package coordinated change; adding wire fields to protocol.ts changes the contract surface for all encode-handler implementations.
- Suggested approach: add the fields as optional on MsgEncodeStart; encode-session copies them with the same `if (opts.x != null) (startMsg as any).x = opts.x` pattern; worker encode-handler reads and passes through to libjxl encoder options.

#### DEFERRED 010-logic-7a1c9e02-0005 + 010-errors-c9d0e1f2-0009 — abort-order asymmetry (acquire before pre-aborted check)
- File: `packages/jxl-session/src/encode-session.ts:111–136`
- Issue: On the synchronous (non-Promise) scheduler path, `initAcquire` (and thus `acquireSlot`) runs before the pre-aborted check at line 135. DecodeSessionImpl checks `abortSignal.aborted` FIRST and bails before any acquire. The `if (this.terminated) return` guard added in Fix 2 covers the async (Promise) scheduler path; the synchronous path still races.
- Why deferred: Reordering requires restructuring the constructor so the abort check runs before the `isPromiseLike` branch, and `acquirePromise` is assigned to `Promise.resolve()` in the pre-aborted case — functionally equivalent to what decode-session.ts:87–92 does. Low severity (cancelSession is expected to release the just-acquired slot), but the fix requires moving the `abortHandler` setup above the `acquirePromise` assignment block, crossing the `acquirePromise` field initialisation. Scope requires careful ordering to avoid a regression on the `acquirePromise` no-op catch (line 100).

#### DEFERRED 010-contracts-7a1c0e22-0006 — No shared EncodeOptions→MsgEncodeStart mapper (adr_draft)
- File: `packages/jxl-session/src/encode-session.ts:65–96`
- Issue: The projection is open-coded with mixed literal and ad-hoc conditional assigns and no exhaustiveness check. Finding 0001 (dropped progressive AC fields) was a direct consequence of this pattern.
- Suggested: Extract a `buildEncodeStart(id, opts): MsgEncodeStart` function (or mapper object) with a field-coverage unit test that enumerates every forwarded key. Coordinate with the 12-field wire gap above.

#### DEFERRED DS-SPREAD-01 — makeFrame conditional-spread allocates a temporary object per meta field per frame
- File: `packages/jxl-session/src/decode-session.ts` — `makeFrame()` (lines ~222–238 after section 010 fix)
- Issue: each `...(field !== undefined ? { field } : {})` spread creates a short-lived object literal (~9 per frame). The frame rate for JXL progressive is low (<30fps), so this is negligible in profiling. Collapsing to a single-result-object mutation loop over a `FRAME_META_KEYS` array would be allocation-free but changes code structure and needs a benchmark before adoption.
- Why deferred: performance micro-optimization with no benchmark evidence; current pattern is idiomatic TS.
- Suggested: build base result object, iterate `const FRAME_META_KEYS: ReadonlyArray<keyof DecodeFrameMeta> = [...]`, assign each key to result only when defined.

#### DEFERRED DS-BUDGETEXCEEDED-META-01 — MsgDecodeBudgetExceeded missing 8 of 9 DecodeFrameMeta fields
- File: `packages/jxl-core/src/protocol.ts` — `MsgDecodeBudgetExceeded` (and `decode-handler.ts` emit site)
- Issue: `MsgDecodeBudgetExceeded` only carries `region?` from `DecodeFrameMeta`; the other 8 fields (`sourceScale`, `progressiveSequence`, `passOrdinal`, `frameIndex`, `frameDuration`, `frameName`, `animTicksPerSecond`, `progressiveRegion`, `regionFallback`) are absent. After the makeFrame fix, decode-session.ts will correctly pass those fields through IF the wire message carries them — but it never will until the protocol is extended.
- Why deferred: protocol change in jxl-core (extend MsgDecodeBudgetExceeded with `extends DecodeFrameMeta`) + decode-handler.ts change to call `assignFrameMeta()` on the budget-exceeded emission. Cross-package change → defer.
- Suggested: change `MsgDecodeBudgetExceeded` to extend `DecodeFrameMeta` in protocol.ts; update decode-handler `postBudgetExceeded()` to call `assignFrameMeta(msg, state)` before posting (same pattern as `decode_progress`/`decode_final`).

#### DEFERRED DS-SINGLEPASS-SLOT-01 — worker continues decoding after local early-finish (header/single-pass mode)
- File: `packages/jxl-session/src/decode-session.ts` — `finish(info, localEarlyFinish=true)` paths
- Issue: After `completeSession()` removes the scheduler record, the worker hosting the session is still alive and continues decoding. It never receives a `decode_cancel` message. Late messages from it are discarded by the scheduler's stale-session guard (discard set), so no correctness issue, but the worker burns CPU on work nobody wants until it naturally completes.
- Constraint: `scheduler.send()` is fire-and-forget and safe to call after `completeSession()` even though the session record is removed — it will be a no-op (CLAUDE.md contract). But `completeSession()` may have already re-assigned the worker to another session; sending `decode_cancel` to a recycled worker slot would cancel the new session. The right fix is a scheduler-side "retire this worker slot without waiting for a terminal ack" path that also dispatches `decode_cancel` before re-assigning — scheduler-side change → defer.
- Suggested: Add a `Scheduler.earlyCompleteSession(sessionId)` method that (1) sends `decode_cancel` to the worker before removing the record, (2) registers the sessionId in `discardSessions` so the late terminal ack is dropped, (3) then calls `cleanupSession()`. The session would call this instead of `completeSession()` on the `localEarlyFinish` path.

---

### Section 012 — jxl-stream (deferred)

**012-contracts-abort — `fromNodeReadable` abort contract diverges from `fromReadableStream`**

- File: `packages/jxl-stream/src/node.ts` (L38–74) vs `packages/jxl-stream/src/browser.ts` (L115–121)
- Finding: On mid-stream abort, `fromNodeReadable` exits the loop via `break`, then falls through
  to `if (signal?.aborted) { await session.cancel(...); }` and **returns** `delivered` (the byte
  count up to the abort point). By contrast, `fromReadableStream` (browser) **throws** a
  `DOMException('Aborted', 'AbortError')` from `if (signal?.aborted) throw …` at the top of its
  loop, which causes the `catch` block to run `cancelBoth()` and rethrow, so callers receive a
  rejection.
- Why deferred: aligning them changes a public-API behavior — callers that `await fromNodeReadable`
  and handle a normal return on abort would break if it starts rejecting, and browser callers that
  currently catch the AbortError would break if it starts resolving with a count. Which is
  canonical (reject-on-abort, matching the Fetch/ReadableStream web convention, or resolve-with-count
  as a Node-friendly "partial delivery" model) is a product decision that needs explicit sign-off.
  The mechanical teardown bugs (racy onAbort, unhandled stream error, inconsistent abort-check
  position) are fixed in Section 012 independently of this contract question.
- Question: **Which behavior is canonical for abort mid-stream?**
  1. **Reject with AbortError** (matches browser `fromReadableStream` and web conventions) — callers
     must catch on abort to read partial `delivered`; partial byte count is lost unless surfaced
     another way (e.g. via a separate callback or error property).
  2. **Resolve with partial count** (current Node behavior) — callers can distinguish abort from
     error by checking `signal.aborted` after the await; partial bytes are visible in the return
     value without a try/catch.
  Choose one and apply it to both `fromNodeReadable` (node.ts) and verify `fromReadableStream`
  (browser.ts) matches. Update CLAUDE.md stream-layer contract docs accordingly.

### Section 012 — jxl-stream (deferred)

Fixer scope was ONE file: `packages/jxl-stream/src/browser.ts`. The following
section-012 tasks are deferred because they require editing other files (node.ts,
test files) or are test/ADR drafts. All confirmed; none masked.

#### DEFERRED 012-contracts-7d3f1a02 (high) + 012-contracts-3a91c5e7 (med) + 012-concurrency-4c8b2d88 (low) + 012-concurrency-7f1d3e99 (low) + 012-errors-a91f5e73 (low) — node.ts abort parity & teardown
- File: `packages/jxl-stream/src/node.ts` (out of scope — fixer limited to browser.ts).
- Issues: (a) `fromNodeReadable` RESOLVES on mid-stream abort while browser `fromReadableStream` REJECTS (public-surface divergence); (b) node abort check happens AFTER awaiting the chunk but BEFORE pushing (ordering differs from browser pump); (c) `onAbort` destroys readable + cancels session concurrently with pending `it.next()`/push, then the aborted-break path cancels again (double-cancel — same shape now fixed in browser via the idempotent `cancelBoth` guard); (d) `toNodeReadable` generator `finally` and the `'close'` handler can both fire `session.cancel()` (the `finally` never sets `finished=true`); (e) `readable.destroy(new Error('Aborted'))` can surface as an unhandled `'error'` event for consumers with no error handler.
- Why deferred: all in node.ts. Recommended: mirror the browser fixes — idempotent single-cancel flag shared by `onAbort` + post-loop + the generator `finally`/`'close'`; decide the abort contract (resolve vs reject) and align both pumps (this is the *browser-node-parity* root — pick one and pin it with the parity test below); use `readable.destroy()` with no error on abort (matching the maxBytes cutoff) or attach a no-op error handler.

#### DEFERRED 012-contracts-c4517f9a (med, adr_draft) — no cross-impl parity test
- File: `packages/jxl-stream/test/node.test.ts`.
- A parity table asserting identical (delivered, pushes[], closed, cancelled, resolve-vs-reject) outcomes across `fromNodeReadable` and `fromReadableStream`. This is exactly the gap that let the resolve/reject abort divergence above go unnoticed. Deferred: test-file edit + depends on first picking the unified abort contract.

#### DEFERRED 012-performance-3c1a9d42 (low, adr_draft) — no prefetch-overlap regression test
- File: `packages/jxl-stream/test/node.test.ts`.
- A test using a session whose `push()` blocks on a deferred while a flag records whether the next `reader.read()`/`it.next()` was already dispatched, locking the one-ahead overlap contract. Deferred: test-file edit. (Note: the browser-side `inflight` mirror added in this fix keeps the one-ahead prefetch intact; a regression test would guard it.)

#### DEFERRED 012-contracts-9f2a1b6d (low, adr_draft) — no 200-fallback-short-resource test
- File: `packages/jxl-stream/test/range.test.ts`.
- Test for a 200 response whose body ends DURING the skip phase (resource shorter than `start`). The browser fix now flags this via `RangeNegotiation.underDelivered`; a test should assert `underDelivered === true` and `delivered === 0`. Deferred: test-file edit.

#### DEFERRED 012-logic-e81b3f57 (info, adr_draft) — no round-trip resume-window invariant test
- File: `packages/jxl-stream/test/range.test.ts`.
- Property/round-trip test asserting `createByteRangeResumeState` + resume reconstructs exactly `[start+delivered, endExclusive)` with no gap/overlap, including the DEFAULT path (originalStart omitted, `absoluteStart` threaded). The browser fix now threads `absoluteStart` and bounds the end by `fullSize`; a generative test would lock the inclusive-range math. Deferred: test-file edit.

#### DEFERRED 012-logic-4a7d2c81 (info, adr_draft) — no resume-200-no-ETag test
- File: `packages/jxl-stream/test/range.test.ts`.
- Negative test: resume + 200 fallback + NO ETag header must fail (the version-skew guard hole). The browser fix now fails ANY 200 fallback while resuming (the `resuming` flag), regardless of ETag presence; a test should assert this rejects with `/resource changed/`. Deferred: test-file edit.

#### NOTED (already deferred by the verifier, recorded for completeness)
- 012-errors-3f1a8c20 (missing fetch timeout) — verdict UNCERTAIN; deliberate design (caller owns cancellation via signal). Not implemented.
- 012-security-1d7b3e64 (SSRF surface) — verdict UNCERTAIN; exploitability depends on untrusted-URL callers outside this layer. Not implemented.

---

## Section 014 — jxl-wasm (facade.ts + bridge.cpp)

**Environment limit:** the WASM build is Docker/emsdk-gated and CANNOT be compiled or
behaviorally tested in this environment (only `tsc` type-checks facade.ts). Therefore only
*type-checkable, additive, can't-make-worse* facade.ts fixes were applied this pass; every
ABI-coupled change and ALL bridge.cpp (C++) fixes are deferred for the user to apply **with a
real WASM build + the facade.test/vitest suite** — an un-built FFI/heap change can silently
corrupt encodes or the WASM heap.

### Applied this pass (facade.ts, tsc-gated — baseline 1 error → 0)
- Added `onMetric` to `EncoderOptions` (fixes the pre-existing `facade.ts:1942` TS error;
  `LibjxlEncoder` already reads it).
- Added `if (ptr === 0) throw` OOM guards to 4 unchecked `_malloc` sites (transcodeJpegToJxl,
  back-compat streaming push, buffered-encode pixels, sidecar dims) — matching the file's
  existing guarded pattern (L902/944/1095/1152).

### A. facade.ts ABI/contract bugs — fix surface is TS but UNTESTABLE here (apply + rebuild + test)
1. **HIGH — `encode_rgba8_with_metadata` arg-shift** (facade.ts:~340 call vs bridge.cpp:2456):
   the bridge inserts `group_order`+`resampling` after `buffering`; the facade TS call omits both,
   shifting ALL ICC/EXIF/XMP pointer args by 2 on the buffered-metadata encode path → metadata
   corruption. Fix = add the 2 args in the correct ABI position; rebuild + round-trip ICC+EXIF.
2. **HIGH — 6 encoder options dropped by the facade** (`orientation, intrinsicSize,
   disablePerceptualHeuristics, codestreamLevel, centerX, centerY`): callers forward them and the
   bridge supports them (`enc_create_image_z`:3019 + setters), but `EncoderOptions` (facade.ts:137)
   declares none and never calls the setters → silent no-ops.
3. **MED (latent) — ExtraChannel struct stride mismatch**: TS serializer 72-byte stride vs 20-byte
   C++ `WasmExtraChannel`. No call site yet (latent) — corrupts `num_ec >= 2` encodes once wired.
4. **MED — `perceptualConstancyApplyBulk` scalar fallback returns identity** (facade.ts:~3152):
   copies input→output, reports success, never applies the transform; also passes JS Float32Arrays
   where the C symbol wants `float*`. NOTE: `_perceptual_apply_full` is not linked in the default
   WASM build (MEMORY: "c-perceptual link-fails wasm") — fix the link first.
5. **MED — leaks on throw**: progressive decoder handle (facade.ts:1377) + `wasmEncState`
   (facade.ts:2074) leak if a malloc/alloc throws before the owning try/finally. Hoist into scope.
6. **MED — rgb8 progressive pixelStride**: `eventsProgressive` uses a 4-byte stride for rgb8
   (3-channel) (facade.ts:~1435) → byte-total mismatch (the long-rumored "rgb8 stats" issue,
   located here → ADR adr-shared-channel-stride-helper).
7. **LOW — hot-path `console.log` spam** (facade.ts:968/1171/2289) — redundant with `onMetric`.

### B. bridge.cpp — C++, CANNOT build here, ALL deferred (by severity)
1. **HIGH/security — JXTC encode integer overflow** (bridge.cpp:1611/1618): `tile_count =
   tiles_x*tiles_y` 32-bit multiply can wrap; the loop writes `tile_bytes[idx]` at the un-wrapped
   index → heap overflow. (The JXTC *decode* counterpart at 1713 was a verified FALSE POSITIVE —
   its `idx >= tile_count` guard + `input_size < header+index_bytes` check bound every index read.)
   **→ PATCHED IN SOURCE (commit on this branch):** compute `tiles_x*tiles_y` in 64-bit, reject when
   0 or `> JXTC_MAX_TILES` (2^24) before allocating, narrow to uint32 only once safe. **NOT yet
   build-verified** — bridge.cpp can't be compiled here; rebuild WASM + run the jxl-wasm suite to
   confirm (the guard is additive and rejects only the overflow case, so valid encodes are unaffected).
2. **MED/security — unvalidated FFI lengths**: extra-channel `plane_ptr/size` (1022), custom-box
   `data_ptr/size` (356), rgb16_planar planes (2404), butteraugli/PSNR/SSIM direct pointers (3377),
   `EncodeAnimation` `wf.width*wf.height` with no `pixels_size` check (1884) + unbounded `name_size`
   memcpy (1906).
3. **MED — gain-map `gm_capacity*2u`** doubling has no overflow guard (2311); sibling `input_buf` IS guarded.
4. **LOW — tiled-decode signed `crop_x0/y0` cast to uint32** (1403) → crafted-JXL OOB read.
5. **LOW — unhandled `JxlDecoderStatus`** (no default branch, 2143) → spin; `BOX_NEED_MORE_OUTPUT` bare continue (2311).
6. **LOW/perf — `EM_ASM console.log`** per encode chunk (2918) / per `enc_finish` (3102).

### C. ADR drafts (sections/014/adr_draft/) — awaiting ratification
- adr-ffi-abi-contract-test.md — CI smoke test: every facade-called symbol exists w/ right arity +
  single source of truth for the FFI layout (root cause of A1/A2/A3).
- adr-overflow-checked-size-helpers.md — `checked_size_mul` (bridge.cpp) + `assertHeapWrite` (facade.ts) (B1/B2/B3).
- adr-structured-libjxl-error-mapping-raii.md — status→typed-error map + RAII C++ cleanup + missing `default:`.
- adr-shared-channel-stride-helper.md — single `pixelLayout(format)` helper (fixes A6).

---

# EpicCodeReview run 20260619T093126Z — src/lib.rs

Target: src/lib.rs (2842 lines, Rust/WASM). Mode: workalone. Branch: epiccodereview/20260619T093126Z.
Confirmed findings: 37 (section) + 25 (global). Applied: 4 safe guards (commit a5a2c5d7). Rest deferred below.
Full detail: .epiccodereview/20260619T093126Z/{sections/000,global}/verified.json

## A. Needs a human decision (public-API / output-contract / intent — no-go for auto-fix)

1. FLAG COLLISION — `OUT_FULL_16 == OUT_NO_ORIENT == 8` (src/lib.rs:551,556). Independently flagged by 4 agents. Any caller setting bit 8 gets full-res-16 AND orientation suppressed; cannot request one independently. One verifier read the adjacent comment as "load-bearing by design (undocumented)"; others rate it critical. DECISION: intentional? If not, move OUT_NO_ORIENT to a free bit (e.g. 16) — but that changes a JS-visible flag value (ABI) and needs your sign-off + a JS-side update.
2. DNG/CR2 exposure-time absent sentinel `den=1` vs ORF `den=0` (JS checks `den==0`). Visible to JS. Confirm desired sentinel.
3. `color_matrix_from_mn` is always true for DNG (dng.rs supplies a default ColorMatrix) — misleads JS vs ORF. Confirm intended semantics / rename.
4. `input_ptr` / `take_*` ownership + invalidation contract undocumented (structure-015). Doc-only, but it is a public contract.

## B. Perf-sensitive — MEASURE before applying (gate: >=5% + output parity)
Repo flipflop benchmarks kernels in isolation, not these WASM export paths; each needs a kernel flipflop or a new bench first:
- ORF double demosaic (planar + MHC always; MHC dropped on preview-only) — hacker-001 / architecture-004,006 / structure-003,010
- pack_rgb16_full redundant full-res pass; fuse or LE-transmute — hacker-002 / architecture-011
- unpack_rgb16_le 12MB copy per LookRenderer ctor; LE-transmute — hacker-003 / architecture-003
- rgb_to_rgba scalar 3->4 scatter; wasm128 shuffle — hacker-004 / architecture-013
- ORF thumb from full planar vs cascade from lightbox (DNG already cascades) — hacker-005 / architecture-005
- integer downscale: 3 divides/pixel -> reciprocal-multiply — hacker-006
- float downscale recomputes x-bounds per (dy,dx) -> hoist — hacker-007
- downscale_rgb16_planar SoA SIMD horizontal-add — hacker-008
- LookRenderer::render clones ~13MB per slider tick -> reusable scratch — hacker-010 / architecture-007
- fs_core_simd re-reads 16 bytes already in v128 -> extract_lane — hacker-012
- fs_core_trunc_word per-pixel checks -> fast/tail split — hacker-013

## C. Structural opportunities (ADR-worthy; not auto-edited)
- 14-16 positional f32 params per export -> params struct (structure-011)
- bench exports (fstats_*) ship ungated in production WASM -> feature-gate (structure-013)
- DngDecoded == Cr2Decoded; unify (structure-019)
- MAX_DIM 16384 (ORF) vs 8192 (DNG/CR2) inconsistent (structure-002)
- NR not applied to planar preview; previews noisier at high ISO (structure-023)
- tonemap dispatch: ORF process_into_auto vs DNG process_auto (structure-005)
- duplicated integer box-filter impls (structure-006)
- ~360MB WASM heap at 24MP all-flags; no memory budget (architecture-014, P7)
- ProcessResult couples pixels+telemetry; rgb()/rgba() double-copy (architecture-007,009)
- only 2 tests for 2842 lines; no flag/downscaler/LookRenderer/PerceptualComparer coverage (structure-020)

## D. Vision (long-horizon ADR drafts)
ML recognition entry (thumb+GPS already present); photogrammetry linear-16 contract + sensor-pitch for COLMAP; AR <15ms preview + crop-render ROI; gaming LOD via OpaqueDecodeHandle; multi-frame stacking; non-Riemannian Perceptual Constancy Mode hook (pipeline.rs already has perceptual_constancy + log-euclidean; LookOverrides lacks the field — vision-nonriemannian01). Sample draft: .epiccodereview/20260619T093126Z/global/adr_draft/0001-output-flag-gated-decode.md

### RESOLVED — run 20260619T093126Z §A.1 (flag collision)
OUT_FULL_16 vs OUT_NO_ORIENT (both =8): determined ACCIDENTAL via git (b2cb8dc9 2026-06-03 vs 1674aa11 2026-06-08, independent additions) + no caller sets bit 8 (raw-backend uses process_orf=7; OUT_FULL_16 is v1 test/synthetic only). Fixed: OUT_NO_ORIENT -> 16. Private consts, no ABI change. Commit follows on branch epiccodereview/20260619T093126Z.

---

# EpicCodeReview 20260619T124908Z (facade.ts, bridge.cpp, backends.ts, 2× .flipflop)

FIXED this run: EC descriptor stride drift (72B writer vs 20B C++ struct → multi-extra-channel heap corruption). Commit f6821bb1. See EpicCodeReview-20260619T124908Z.md.

## Needs WASM rebuild to verify (bridge.cpp) — Phase-6 territory
1. Butteraugli ref deep-copy per compare (bridge.cpp:3509-3519, HIGH perf). `...InPlace` consumes args → full 3-plane memcpy of ref every pass; use non-consuming `ButteraugliInterface(const Image3F&,…)` (butteraugli.h:80). Flipflop after rebuild. **Bundle into Phase-6 decode-resident rebuild?**
2. JXTC `tile_count` 32-bit overflow (bridge.cpp:1724, MED/security). `tiles_x*tiles_y` uint32 on attacker-controlled header; encode path guards uint64 (1624-1630). Mirror the guard.
3. `ssim_block_luma` two-pass per block (bridge.cpp:3571, MED perf). Fuse mean+variance to one pass.

## Flipflop-gated TS perf (low expected value — buffer-copy axis measured = noise)
4. `ButteraugliComparator.compare` per-call malloc/free of constant-size candidate (facade.ts:748) → grow-only slot.
5. No `SsimComparator`; `computeSsimWasm`/PSNR re-malloc+copy the fixed ref every pass (facade.ts:689,816).

## Correctness, testable — not yet fixed
6. **JPEG-end scanner rejects real JPEGs** (facade.ts:2740). `findValidJpegEnd` bails at SOS (0xDA) → `extractJpegReconstructionFromJxl` returns null for all genuine embedded JPEGs. Fix marker walk (SOS→entropy→EOI) + unit test. **Recommended next fix** (no rebuild).

## Policy / calibration (human)
7. `SSIM_CONVERGED=0.9995` build-dependent (backends.ts:216): calibrated to ssim.js, loaded build may use WASM SSIM (~1-2% off) → `convergedByteEnd` shifts. Recalibrate to WASM scale, or keep ssim.js for the gate? Needs your intent.
8. `deferredRelease` 1080p hard cap + transfer-detach footgun (facade.ts:1411-1447). Opt-in, no prod caller. Grow + document no-transfer, or leave until a caller needs it?

## Architecture ADR-drafts (ratify before building)
9. Decode-resident metric (zero-copy SSIM/Butteraugli on the decoder heap buffer) — see docs/SSIM-buffer-engine-flipflop-spec-2026-06-19.md.
10. Separate measurement pipeline from render/transfer decode path (P2).
11. Pool decoders in profiler / source ref from progressive `final` event (drop 2nd full decode).

## Vision ADR-drafts (aspirational)
12. Interleaved-RGBA perceptual-constancy entry on decoder output (engine exposed via `perceptualConstancyApplyBulk`, but planar-SoA only).
13. Emit perceptual-hash/recognition features from already-decoded qualityCurve pixels (organism ID).
14. Populate `getDecodeGridInfo()` ({} today) for LOD/streaming; produce `DecodedExtraChannel` (depth/selection).

## Uncertain — could not resolve from in-scope code
- `take_flushed` borrowed-view lifetime (bridge.cpp:2361): caller copies before yield — safe today, contract comment-only.
- Decoder cancel()/dispose() free WASM state only in generator `finally` (facade.ts:1876): leak only if a consumer abandons the iterator undrained — does any?
- jxtc `prep()` caches a rejected promise permanently (.flipflop/tests/jxtc-vs-full-decode.mjs:70) — transient first-file failure poisons the run. Intended?
- Encoder pending-push error lost on cancel; SSIM length-guard silently skips a pass's metric — gated on out-of-scope session/decoder behavior.

### FALSE POSITIVE worth recording
"Perceptual-Constancy engine completely unexposed" — WRONG. `perceptualConstancyApplyBulk` + `getPerceptualConstancySupport` already exist (facade.ts:3120/3136, also in dist). Engine IS exposed; only the interleaved-RGBA convenience entry is missing (#12).

---

## EpicCodeReview 20260619T130214Z — raw-pipeline parsers/decoders

Target: `tiff.rs cr2.rs dng.rs ljpeg.rs decompress.rs demosaic.rs`. 61 findings → 56 confirmed / 5 false-positive / 0 uncertain. 13 correctness issues fixed + committed (782a28b8). Remaining = opportunities deferred for ratification (no-go: public-signature/cross-file/platform). Full proposals: `.epiccodereview/20260619T130214Z/global/adr_draft/ADR-drafts.md`.

**Deferred ADR drafts (need owner decision):**
1. **ADR-1** Shared bounded TIFF/IFD value reader — consolidate the read_u16/u32/ascii/IFD-walk triplication across tiff/cr2/dng (root cause of the bounds-drift we hand-patched). Proceed?
2. **ADR-2** Unified `RawError` enum replacing anyhow/String/bail mix at the decode seam.
3. **ADR-3 (HIGH, platform)** Calibrated scene-referred `RawImageMeta` — currently drops black/white/iso/bits and collapses camera→XYZ to sRGB at decode (dng.rs:113-123); add a "linear, not-tone-mapped" mode + re-enable CR2 per-model colour matrix (cr2.rs:228-240). Public struct change → needs sign-off. See [[project-non-riemannian-colour-plan]], [[project-cr2-colordata-matrix-todo]].
4. **ADR-4 (MEASURED +22%)** Demosaic phased-MHC split + MHC SIMD + Laplacian CSE. flipflop demosaic-mhc: RGGB-specialized is ~22% faster than the generic per-pixel CFA-dispatch path (16–28%/size, trust:high). Approve the refactor?
5. **ADR-6** Fast embedded-preview/LOD tier for CR2+DNG (ORF-only today) + wire `demosaic_rggb_half` AR tier.
6. **ADR-7** Collapse 3× SOF3 parsers + 2× BitReaders.
7. **ADR-8** Wire "Perceptual Constancy Mode" (depends on ADR-3).

**Measured & REJECTED (do not pursue without cleaner box):**
- **ADR-5** DNG tile-decode endianness-branch hoist — flipflop dng-tile-decode: geomean **3.8% slower**, −25%…+19% swing, trust:low 11/12 rows. Below 5% gate; path is cold + bandwidth-bound. Branched code left as-is.

**Trivial deferrals (need owner confirm):**
- `align_to_rggb` (dng.rs) is dead in production — doc/naming fixed; full removal pending confirm it stays dead.
- DNG `CFAPattern != 4-entry` → silent RGGB fallback (dng.rs:569-573): hard-error vs warn is a product call.

---

## QUESTIONS from EpicCodeReview progressive-scheduler.ts (2026-06-19)

### Q1 — tick() sort dirty-flag optimization (hacker-m3n4)
**Deferred** from progressive-scheduler.ts correctness fix pass.  
**Measured speedup:** 73-80% at 200-500 jobs (38 µs → 10 µs median per tick at 200 jobs).  
**Why deferred:** Requires careful dirty-state tracking across all state-change methods (observe, unobserve, select, deselect, handleIntersection, startDecode completion). The `decoderAbort` filter is the key risk: if a job transitions to `decoderAbort !== null` inside a tick() call and the cached candidate list isn't updated, the next RAF tick with dirty=false would attempt to start a second decode for the same job.  
**Implementation sketch:** Add `private candidatesDirty = true` field. Set it to `true` in observe, unobserve, select, deselect, handleIntersection, and at the end of startDecode's finally block. In tick(), if `!candidatesDirty`, recompute scores in-place (still need to update starvationBonus which is time-dependent) and re-sort the existing array without rebuilding. When dirty, rebuild from scratch and set `candidatesDirty = false`.  
**Gate:** ≥5% faster at 200 jobs AND test suite green. Current tests exercise tick() at lines 503, 545, 602 of scheduler.test.ts.

### Q2 — armEarliestRetryTimer incremental tracking (structure-x6y7z8)
**Deferred** from progressive-scheduler.ts correctness fix pass.  
**Measured speedup:** 97% at 200-500 jobs (3.4 µs → 0.1 µs). Absolute cost is tiny (3.4 µs) and the existing guard (`if (armedRetryAt === earliest && retryTimerId !== null) return`) already makes the re-arm path O(1) when nothing changed.  
**Why deferred:** Maintaining a `minNextRetryAt` field incrementally requires updating it in every place that mutates `job.nextRetryAt` (observe, select, deselect, setTargetTier, startDecode catch block) and recomputing on unobserve (O(n) scan unavoidable when the removed job was the minimum). Net gain in the real-world case (job removal drives a scan anyway) is marginal.  
**Recommendation:** Not worth implementing — the guard already handles the fast path. Close.

### Q3 — teeFetch tee() double-buffering (hacker-w3x4)
**Deferred** from progressive-scheduler.ts correctness fix pass.  
**Confirmed:** `ReadableStream.tee()` buffers up to 1 full tier in memory when the JXL decoder stalls (slow consumer). For a 10 MB tier this means 20 MB peak.  
**Fix approach:** Replace `resp.body.tee()` with a `TransformStream` that writes each chunk to both `onChunk()` (synchronously) and passes it through to the decoder. Zero extra buffering because the intercept is in-line with the consumer.  
**Why deferred:** The `teeFetch` return type (`{ fetchImpl: typeof fetch; settled: () => Promise<void> }`) wraps a full `fetch` implementation. Replacing tee with a TransformStream changes how the response body is wrapped and requires verifying that `fromResponse`/`fromReadableStream` still sees a correctly-formed readable stream. This is an architectural change to the fetch abstraction.  
**Gate before implementing:** Measure actual tier sizes in production; if P95 tier < 2 MB, 2× is only 4 MB peak and not worth the complexity. If P95 is 10+ MB, this is worth doing.

### Q4 — profile.test.ts failure: "dc tier byteEnd is less than full file size"
**Status:** Pre-existing test failure in `progressive-profile.ts` (not touched in this pass).  
**Symptom:** The test was unreachable before this fix pass because the TS compile errors at lines 260/384 blocked compilation. After fixing those errors, the test now runs and fails.  
**Location:** `packages/jxl-progressive/test/profile.test.ts` line 86.  
**The test asserts:** `dcEvent.byteOffset < totalBytes` — i.e. dc tier should not span the full file.  
**Likely cause:** The synthetic JXL test data used in `profileJxl` tests may not produce a real DC progression event, causing `selectTiers` to fall back to a heuristic that picks the full file size as the dc byteEnd. Needs investigation in `progressive-profile.ts`.

### Q5 — testFetchTierWithPrefix TS exactOptionalPropertyTypes workaround
**Status:** The `(this as any).testFetchTierWithPrefix = (opts as any).testFetchTierWithPrefix` cast in the constructor (line 175) remains as-is.  
**Why:** `private readonly testFetchTierWithPrefix?: typeof fetchTierWithPrefix` declares an optional field. With `exactOptionalPropertyTypes: true`, you cannot assign `T | undefined` to a target typed as `T`. The direct assignment `this.testFetchTierWithPrefix = opts.testFetchTierWithPrefix` causes TS2412.  
**Clean fix:** Change the field declaration to `private testFetchTierWithPrefix: typeof fetchTierWithPrefix | undefined = undefined` (not optional, but explicitly union with undefined). Then the assignment in the constructor is valid without a cast.
