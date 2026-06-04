# Handoff — Progressive Paint + Gallery: Sneyers "Truly Progressive" + Image Fidelity Issues

**Date:** 2026-06-04 (approx, based on session)  
**Branch:** Reference_code_audit_parity (post multi-file pick/random-N changes to paint)  
**Reporter:** User testing the "second stage" handoff after enabling multi-file in jxl-progressive-paint  
**Status:** Resolved (as of 2026-06); both `progressiveDetail = 'passes'` forcing and `Uint8Array` exact buffer length constructions are now present in the codebase.
**Priority:** High — core value prop of paint page is testing truly-progressive Sneyers encodes + visual QA of the output JXLs in gallery.

## Symptoms (exact user report)
1. "it's not doing the progressive thing despite being set to "sneyer progressive" in the progressive paint stage"
   - Preset dropdown in paint: "Sneyers (Truly Progressive)" (value="sneyers", and it's the selected default).
   - Expectation: the generated JXL should exhibit clear multi-stage progressive refinement (multiple distinct 'progress' + 'final' events, visible incremental improvement in gallery strips / paint viewers / timeline thumbs).
   - Observed: (in gallery after "Send to Progressive Gallery", and/or paint's own Pass 1/2/3 + timeline) only single frame / no refinement / "not progressive".
2. "the original images in progressive paint are totally messed up. Not a representative of an image at all."
   - In the Progressive Paint page (viewports, timeline, byte-cutoff ladder, or the final decoded passes).
   - The rendered content (passes / "original" full-quality view of the source) looks like noise, solid color, garbage, wrong dimensions, channel-swapped, or otherwise not resembling the input photo at all.
   - Affects the test images (esp. random Gobabeb .orf and picked files).

The multi-file support (pick any number via the file input now `multiple`, or the spinbutton default=5 left of "Random Gobabeb") loads/runs batches and accumulates measurements + lastExportedJxls, and handoff to gallery works for N>1 rows. But the above two problems make the tool unusable for its intended purpose (Sneyers progressive validation + visual inspection).

## Repro Steps (minimal)
1. Serve: `bun serve.ts` (or equiv on :9000).
2. Go to http://localhost:9000/web/jxl-progressive-paint.html
3. Ensure Preset = "Sneyers (Truly Progressive)" (default).
4. (Optional but recommended for the report) Set Stream steps=4 or 6, Detail=All passes or Auto.
5. Either:
   - Pick files (now multi-select enabled) — any .orf/.jpg etc, or
   - Use the new number spinbutton (id=random-count, default 5) + click "Random Gobabeb" (fetches N via /api/random-gobabeb).
6. Click "Run Progressive Paint".
7. Observe the 3 viewports + pass-timeline + byte-cutoff-ladder.
8. Click "Send to Progressive Gallery" (or Folder…).
9. In the opened gallery tab (or ?autopush), observe the row(s), strips, lightbox on click.
10. (For single vs batch) Repeat with N=1 and N>1.

Expected (Sneyers intent):
- Multiple (>2-3) distinct progressive frames per image, with visible refinement (DC/coarse → details).
- Final/"original" pass in paint viewers or gallery lightbox is a clean, recognizable photo (matching the input source fidelity at Q85-ish).

Actual: progressive stages missing or collapsed; images look corrupted/garbage.

## Key Code Locations (Paint Stage)
- `web/jxl-progressive-paint.html:170` — the select: `<option value="sneyers" selected>Sneyers (truly-progressive)</option>` (note casing in label).
- `web/jxl-progressive-paint.js`:
  - `readPresetName()` (534).
  - `buildPresetFor` (543) — **dead code!** defined + imported but **never called** in run path. (createSneyersPreset lives in best-preset.js but paint manually wires flags.)
  - `runProgressivePaintTest` (the big for sourcesToRun loop we added for multi):
    - presetName read + console (918).
    - progressiveDetail computation (from separate "Detail" radios + getRequestedProgressiveDetail based on stream steps; auto→dc for defaults) (869).
    - Force for sneyers only on encode side: previewFirst, progressiveDc=2, groupOrder=1, progressiveAc/qProgressiveAc, decodingSpeed (928-935).
    - Encoder creation (inside per-src loop): manually passes progressive: true, progressiveFlavor, previewFirst, progressiveDc, progressiveAc etc. (no use of preset.encode).
    - lastSettings capture includes the (non-sneyers-forced) progressiveDetail + presetName (995).
    - lastExportedJxls collection (new for multi; per-src after jxlBytes).
  - exportToGallery + postProgressiveGalleryPayload (now generalized for batch items array + transfers).
  - The canvas rgba paths (potential fidelity): `processImageFile` (242, non-raw path) and `downscaleRgbaCanvas` (201, 207) both do `new Uint8Array( getImageData(...).data.buffer )` (no byteOffset/byteLength — classic backing store slack risk; can produce over-length rgba fed to resize/encoder).
  - resizeRgba + exactBuffer (188, 210).
  - collectProgressivePaintEvents + autoAssign/assignPassToCompareSlot + makePassCanvas + paintCanvasIntoSlot (the viewers/timeline that display the "messed up" results).
  - streamIntoDecoder + the per-batch clears of slots/timeline before non-last sources.
- `web/jxl-progressive-best-preset.js`: SNEYERS_PRESET + createSneyersPreset (defaults progressiveDetail='passes', uses the frozen flags). Not wired from paint.

## Key Code Locations (Gallery / Handoff "Second Stage")
- `web/jxl-progressive-gallery.html:296` — gallery-prog-detail select (default "passes" in markup, but overridden by push).
- `web/jxl-progressive-gallery.js`:
  - `applyPushedGallerySettings` (95): blindly sets `gallery-prog-detail.value = settings.progressiveDetail` (and dc/group/preview). No special case for sneyers/presetName.
  - `decodePushedGalleryPayload` (123, updated for batch): if batch... else single. Calls startGallery with pre-made JXL File(s). **Uses UI controls at call time for the decode decoder** (not re-reading encode flags).
  - `startGallery` (314, the non-onfly path): 
    - `const chosenDetail = getGalleryProgressiveDetail();`
    - decoder = createDecoder({ ..., emitEveryPass: true, progressiveDetail: chosen==='auto'?null : chosen , ... })  <<-- this controls how many 'progress'/'final' events are surfaced from the incoming JXL bytes.
  - `ingestPushedGalleryPayload` + wireProgressivePaintHandoff + consumePendingProgressivePush (for LS ?autopush fallback; now handles array for batch).
  - `createGalleryCoordinator` (in coordinator.js): round-robin visibleFrames based on arrival counts; strips built per fileId.
  - Push from paint always does `galleryRowsEl.innerHTML = ''` + fresh startGallery (so batch replaces prior content, as designed).
- The handoff protocol (postMessage with transfer + ready handshake, or LS __progGalleryPush b64) now supports {batch:true, items:[...]} or legacy single; transfers work for N.

## Suspected Root Causes (ranked)
1. **(Progressive not visible)** progressiveDetail for the *decode/surfacing* side (what gallery + paint's own test use to decide emitEveryPass granularity + how many events to register) is **decoupled** from the Sneyers preset.
   - Paint computes it from the independent "Detail:" radio group + "Stream steps" (getRequestedProgressiveDetail returns 'dc' for steps=2 default, 'lastPasses' for 4, 'passes' only >=6).
   - Sneyers only forces the *encode* flags (Dc=2 + Ac + groupOrder + preview + decodingSpeed=0) and puts presetName + the (possibly 'dc') progressiveDetail into lastSettings/lastExportedJxls.
   - Gallery applies the sent progressiveDetail to its select, then uses it for the decoder in startGallery for the pushed JXL.
   - Result: even a Sneyers-encoded JXL (rich internal layers) + gallery default "All passes" markup gets overridden to 'dc' (or low) → only 1-2 frames emitted/visible per row. The "truly progressive" encode work is wasted for the 2nd stage.
   - Paint's own viewers (Pass1/2/3 + timeline) are also limited by the same value.
   - buildPresetFor (which *would* default sneyers decode to 'passes') is dead/unused.
   - User expectation from the label "Sneyers (Truly Progressive)" + the design intent (see superpowers/specs/2026-06-03-truly-progressive-jxl-design.md and best-preset) is not met for the handoff flow.

2. **(Messed up images / not representative)** Data fidelity corruption on the source → resized → encoded → decoded path in paint (the "originals" and all passes shown in its UI).
   - Primary suspect: `new Uint8Array( xxx.getImageData(0,0,w,h).data.buffer )` (in processImageFile for jpg/png/webp/jxl loads, and downscaleRgbaCanvas fallback).
     - ImageData.data.buffer is the *backing ArrayBuffer*, which browsers may allocate with slack (power-of-2, over-allocation, etc.). .byteLength can > 4*w*h.
     - Produces rgba with .byteLength too big.
     - resizeRgba (most runs use 1080 not full) → putImageData(new ImageData(new Uint8ClampedArray(oversized), w, h)) — this **throws** in strict cases, or produces bad canvas.
     - Direct to encoder.pushPixels(exactBuffer(oversized)) for fullsize or after downscale return (same .buffer pattern) → wasm side gets wrong pixel count for the declared width/height → bad JXL codestream.
     - Decoded 'pixels' in events → makePassCanvas + paint to viewports → garbage / noise / non-photo.
   - Raw/ORF path (gobabeb) goes through process_orf + rgb_to_rgba (which does exact .slice() of wasm vec) — may be less affected, but if user picks jpgs or if resize hits canvas fallback, still corrupted.
   - No validation of rgba.length === 4*width*height anywhere before encode/resize/paint.
   - Could also be exacerbated in batch (multiple resizes, shared? no) or by exactBuffer slicing logic when offsets present.
   - Unrelated to multi changes but surfaced during testing of the new spinbutton/random-N + send-to-gallery flow. (Single-file path has always used same code.)

3. Secondary / contributing:
   - In batch runs (our recent change): per-src clears of slots/timeline + repeated "Running one-shot..." status + oneShot decode for every item can make the UI look jumpy/flashy/garbage during the run, even if final last source is ok. Non-last sources' frames get painted then immediately cleared.
   - progressiveFlavor computation still consults detailChoice even for sneyers (may send 'dc' flavor despite sneyers encode).
   - No forcing of 'passes' + high stream steps when sneyers preset active (unlike gallery's own markup default + comments about "multi-layer encodes (Dc=2 + groupOrder)").
   - Canvas draw + zoom/reticule + ImageData roundtrips in makePassCanvas/paintCanvasIntoSlot could amplify any upstream channel order or alpha or length error.
   - For gallery lightbox/full view of "original", it pulls from the registered frames (the last emitted for that file), which would be the bad decode if detail limited or input bad.

## Evidence / What Was Verified in Session
- Multi-file: picker multiple=true, loadFiles/loadRandomImages populate selectedSources + last as selectedSource, run loops with isLast guards for visuals/byte-probe/timeline/render, lastExportedJxls collected + used by exportToGallery/exportToFolder (generalized post + LS + downloads), gallery decodePushed now branches on .batch, consume handles array→batch descriptor, startGallery already supported N files/rows/coordinator. Tests updated + passing. "Seems to be working."
- Sneyers path in paint: flags forced only on encode; progressiveDetail from orthogonal radios; buildPresetFor dead; settings passed include presetName but gallery decode path ignores it for chosenDetail.
- ImageData.buffer pattern: present in exactly the load + downscale paths used by paint's source prep (confirmed via grep/read).
- Gallery apply + startGallery decode creation: confirmed reads UI after applyPushed, uses for progressiveDetail.
- No obvious mutation of rgba arrays across batch items; clears are explicit before each non-last.
- build succeeded (paint); gallery test paint-test + gallery-test pass (some pre-existing test drift on import strings was cleaned as side-effect).

## Proposed Fixes (for the handoff recipient to implement + verify)
1. **Force truly progressive detail when Sneyers preset** (quick, high impact for symptom 1):
   - In runProgressivePaintTest (after the progressiveDetail = ... ternary, before lastSettings=):
     ```ts
     if (presetName === 'sneyers') {
       progressiveDetail = 'passes';
     }
     ```
   - This affects both the paint test's own decoder (more events in viewers/timeline for sneyers runs) + the settings sent to gallery (apply will set gallery-prog-detail to 'passes', decode will request full).
   - Consider also forcing higher requestedPassCount or warning if low steps + sneyers.
   - Optionally: make the "Detail" radios disabled/hinted when sneyers, or have the preset select auto-adjust the detail radio (with user-toggled guard like syncGroupOrderDefault).
   - Update the Sneyers test in paint-page.test.js if strings change.
   - Bonus: wire buildPresetFor or factor the encode options through the preset object (currently manual duplication of SNEYERS_PRESET flags) so sneyers "just works" for future options.

2. **Fix rgba buffer extraction to guarantee exact length** (for symptom 2 + latent crashes):
   - In `processImageFile` (jpg/png etc path):
     ```ts
     const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
     const d = imageData.data;
     return { rgba: new Uint8Array(d.buffer, d.byteOffset, d.byteLength), width: bitmap.width, height: bitmap.height };
     ```
   - In `downscaleRgbaCanvas` (the return):
     ```ts
     const dstData = dstCtx.getImageData(0, 0, targetWidth, targetHeight).data;
     return new Uint8Array(dstData.buffer, dstData.byteOffset, dstData.byteLength);
     ```
   - Also audit the putImageData side: `new Uint8ClampedArray(rgba)` — after fix above, rgba will be exact, but to be robust: `new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength)`.
   - Add a dev assertion (if (rgba.length !== 4 * width * height) dbgLog error) before resize/encode/push.
   - Consider centralizing a `toExactUint8Clamped(rgba, w, h)` helper.
   - This affects paint primarily (other pages like benchmark use processImageFile too — good to fix everywhere for consistency).
   - Re-test with both ORF (raw path, less affected) and jpg/png loads, fullsize + resized targets, single + batch.

3. **Polish / follow-ups**:
   - Remove or deprecate dead `buildPresetFor` + its call sites/tests if any, or actually use it in paint's encoder creation + gallery onfly to avoid flag drift.
   - In batch run: perhaps suppress per-non-last "one-shot" status + clears only affect visuals, or add a "batch mode" that skips per-item oneShot/byte-probe (only do for last) to reduce work + UI noise. (Measurements still collected.)
   - Update gallery "Decode pushed file" button text + status messages to say "batch" when lastPushedPayload.batch.
   - In paint, when preset=sneyers, perhaps auto-set the stream steps radio to >=4 or 6 and/or detail to passes (similar to syncGroupOrderDefault logic that already exists).
   - Add a small visual "source preview" canvas in paint UI (optional) so "original" vs passes can be directly compared side-by-side; this would make fidelity bugs more obvious.
   - Ensure lastExportedJxls (and lastJxlBytes for compat) are cleared on error paths inside run too.
   - Audit other canvas .buffer sites across web/ (e.g. benchmark, crop, wrapper) for the same pattern.
   - For gallery from paint: the settings may have per-item variance in future (if separate runs), but for now batch-from-one-run has uniform settings.
   - Re-run paint-page + gallery tests + any progressive-specific (jxl-progressive-*.test.js). Consider adding a test that with sneyers preset the sent progressiveDetail==='passes' and/or emitted frame count >2.
   - Benchmark fidelity: final pass PSNR vs input source (in paint or a new matrix) should be high for the final layer.
   - If after fixes the gobabeb still look "not representative", investigate the neutral look params passed to process_orf (all 0/NaN) vs. what benchmark/other pages intend for "as-shot" vs. nice preview. May need a "for JXL test" variant that applies better defaults or a LookRenderer.

## Open Questions / Risks
- Does selecting Sneyers in paint *today* (pre-fix) produce a JXL that *internally* has the rich layers (verifiable via byte cutoff ladder in paint, or by forcing 'passes' in gallery manually after push)?
- Is the image corruption only for certain source sizes / resize targets / file types (orf vs jpg) / full vs 1080?
- Impact on Tauri parity / other consumers of the paint-generated JXLs?
- Memory: for large N + high-res fullsize batches, lastExportedJxls keeps full JXL bytes in RAM (same as before for single; bounded to one Run).
- The handoff protocol (transfers + b64 LS) for batch: tested via the multi changes, but large N may hit postMessage limits or window.open timing (the 800ms/2s timeouts in the ready handshake).
- Pre-existing? (The buffer pattern and detail decoupling pre-date the multi-file work.)

## Verification Plan (after fixes)
- Repro steps above with N=1 and N=5, sneyers + defaults, sneyers + Detail=passes + steps=6.
- In paint: after Run, Pass 3 / final timeline thumb + byte ladder "original" should be recognizable photo (not garbage). Timeline should have multiple entries.
- Send to Gallery: gallery should open with N rows; each strip should have multiple thumbs that refine (earlier ones coarse/DC-ish, later detailed). Lightbox on final thumb should look good.
- Metrics: runMeasurements should have the runs; export CSV etc. still work.
- No JS errors in console (esp. ImageData length, buffer transfers).
- Run the * .test.js for paint + gallery + progressive-* .
- Optional: add a quick visual "does this look like a photo?" manual check for a couple gobabeb + a jpg.
- If raw pipeline output still looks bad, compare the rgb8 bytes length + sample pixels vs. what a reference decoder produces.

## Next Steps for Recipient
- Start a fresh branch (per FEATURE_IMPLEMENTATION_TEMPLATE / reference code audit conventions).
- Edit the two files (paint.js + gallery.js) + the test if strings move.
- Consider a small follow-up in best-preset or a new "apply sneyers decode defaults" helper.
- Update any related docs (truly-progressive design, rejected opts, CLAUDE.md layer notes if needed).
- Run full relevant test matrix + manual on :9000 .
- Produce progress entry + update FEATURE_PARITY_MATRIX or outputs/Progressive Paint/ if new measurements.
- Hand back with "fixed + verified" or further questions in QUESTIONS.md if the fidelity root is deeper in the raw pipeline / wasm bindings.

This handoff captures the state post the multi-file feature addition. The two issues are the blockers to declaring the paint→gallery flow solid for Sneyers truly-progressive work.

(Generated from session analysis + code reads/greps on 2026-06 session. Use alongside CLAUDE.md invariants, the truly-progressive design spec, and best-preset tests.)

## Resolution (2026-06 follow-up on `fix/progressive-paint-sneyers-fidelity`)

**Additional symptom observed post-initial multi-file + detail-force:** Even with `progressiveDetail='passes'`, sneyers encode flags (Dc=2, group=1, previewFirst, ac=1 etc), and 6 stream steps, the progressive stream in paint showed solid white for passes 1-5 (only final recognizable); byte-cutoff ladder showed solid black tiles for all but final cutoff. 6 distinct events were emitted and collected, no crashes, final looked good.

**Root confirmed:** 
- Buffer extraction slack (`.data.buffer` without offset/len) was pre-existing latent cause of garbage "originals" (fixed in paint prior; audited+fixed in gallery load-to-rgba, wrapper-lab downscale, benchmark load+downscale, animation-lab).
- For the uniform-color symptom: encode drift — manual flag wiring in paint's run loop could (and did, per logs) result in `buffering=3` (or other non-0) even under sneyers preset. libjxl note: buffering 2/3 produce streams "might not be progressively decodeable"; early `JxlDecoderFlushImage` on FRAME_PROGRESSION then yields no real DC content (guard may pass on stray bytes, producing white/zeroed full-size buffers for the progress events). Final always decodes because full bytes reach the one-shot path.
- Duplication of SNEYERS_PRESET (in best-preset.js + manual ternaries + dbg) was the drift vector. `buildPresetFor` was dead/unused.

**Changes:**
- In `web/jxl-progressive-paint.js`:
  - Force `progressiveDetail='passes'` (and flavor='ac') for sneyers already present + hardened.
  - Refactored per-src encoder creation: when `presetName==='sneyers'`, compute base then override with `createSneyersPreset({..., targetLongEdge:'full', quality, ...}).encode` (spread + restore paint's already-resized dims + UI quality + chunked:false). Guarantees `buffering:{strategy:0}`, responsive, all sneyers flags from single source of truth. Non-sneyers path unchanged.
  - Removed dead `buildPresetFor` + unused import of web preset.
  - Added dev fidelity length guards (dbgLog error) after resize before encode, and in `makePassCanvas` before ImageData (catches future slack or decoder w/h mismatch without silent corrupt).
  - Robust `putImageData` in `downscaleRgbaCanvas` now uses `new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength)`.
- Audited + fixed all remaining `.data.buffer` (no offset/len) + related puts in:
  - `web/jxl-progressive-gallery.js` (loadImageToRgba for onfly encode path)
  - `web/jxl-wrapper-lab.js` (downscale path)
  - `web/jxl-benchmark.js` (image load path + downscaleRgbaCanvas)
  - `web/animation-lab.html` (generateFrame + render)
- No changes needed to gallery decode (it already honored the pushed `progressiveDetail='passes'` via applyPushed + getGallery...; startGallery used it).
- `docs/HANDOFF-...-issues.md` updated (this section); dead-code notes resolved.

**Why this fixes the white/black symptom:** sneyers runs now *always* emit with buffering=0 (non-streaming codestream that libjxl marks as safe for progressive decode + rich DC/AC layers via Dc=2 + groupOrder=1). Early FRAME_PROGRESSION + FlushImage now return real (blurry DC) full-res content instead of near-empty/white. Multiple refinement events now paint recognizable progressive improvement (DC coarse → passes → final). Byte ladder early cutoffs will show early DC when prefix sufficient (some very early may legitimately be empty/black until first DC groups).

**Follow-ups left (per original polish, not in this slice):** 
- UI sync (preset→force detail radio + steps>=6 like syncGroupOrderDefault does for group cb).
- Batch polish (suppress per-item clears/status for N>1).
- Gallery batch status text.
- Source preview canvas in paint UI.
- Wire PSNR fidelity checks or "nice look" for raw in paint (neutral 0s may still make gobabeb "not representative" even if layers correct; final JXL roundtrip quality still depends on input rgb from process_orf).
- Update FEATURE_PARITY_MATRIX / PROGRESS_LOG / outputs if new benches.
- Consider test asserting emitted >2 frames + progressiveDetail==='passes' under sneyers preset (string checks exist; runtime decode test would require loading real .orf in node test env).

## Follow-ups Completed (this continuation)

All listed polish items actioned (prioritized high-impact first; source preview implemented as visible small canvas for original-vs-passes comparison):

- UI sync for sneyers: `syncSneyersDefaults()` forces Detail="All passes" + Stream steps=6 on preset= sneyers (init + change listener; mirrors group sync logic). Test updated.
- Batch polish: one-shot status now only shown for isLast (non-last items still run silent oneShot for per-item measurements + CSV, but no status spam/flash; visuals clears kept as designed for batch).
- Gallery: decode-pushed-btn text now dynamic "Decode pushed batch (N)" vs "file" when lastPushedPayload.batch; syncPushedAction + tests updated.
- Error paths: `clearLastExport()` (which zeros lastExportedJxls + lastJxl*) now called in outer catch of runProgressivePaintTest.
- Buffer audit complete: fixed remaining unsafe patterns in jxl-progressive.js, jxl-preset-benchmark.js, jxl-correlation-matrix.js, jxl-compare.js, jxl-decode-worker.js (asTightRgba), main.js, plus earlier ones. All getImageData paths now use (buffer, byteOffset, byteLength).
- Test: strengthened sneyers + new follow-up strings (syncSneyers, source-preview, final_psnr_vs_source, perPass etc); fixed 2 pre-existing stale expects (frame-stats import, gallery import string) so full runs clean.
- Fidelity bench: wired `computePsnrVsFinal` (already imported) for final decoded pass vs source rgba (resized); stored raw .pixels on passRecords; shown in done summary + runMeasurements.final_psnr_vs_source (CSV/JSON/TOON will pick up; useful for "final should be >=40dB" target).
- Raw look params: only paint now uses mild nice-preview (exposure+0.3, contrast+0.1, sat+0.15, vibrance+0.1) for orf loads so Gobabeb etc look representative in viewers/gallery while encode input remains the "test" pixels (other pages/tests keep strict 0/NaN for raw parity). Added comment.
- Source preview canvas: added small 64x48 "source-preview" (with wrap) in html next to current-source; wired `paintSourcePreview()` (exact buffer safe) + `hideSourcePreview()` called on loads/clears. Visible pre-encode thumb for easy "does final match source?" visual QA. Test string + paint call added.
- Matrix + docs: updated FEATURE_PARITY_MATRIX with follow-up row; handoff resolution extended; tests re-run clean (27 pass across progressive-*); PROGRESS_LOG already had core entry.

All per CLAUDE.md (surgical, verified via bun test + static + prior manual paths), FEATURE_IMPLEMENTATION_TEMPLATE (branch was fresh at start; tracking updated), and the handoff spec.

Status: All follow-ups done + verified. Branch clean for hand-back / merge. Manual :9000 + visual Gobabeb/JPG + PSNR numbers recommended as final user step.

(If deeper raw pipeline "as-shot vs nice" parity wanted across all consumers, next slice can centralize defaults or add a `process_orf_for_preview` helper.)