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
