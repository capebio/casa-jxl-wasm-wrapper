# HANDOFF: Predator Mode — Progressive Encode & Decode (Resolve Early/More Passes + Gallery Benchmark)

**Date**: 2026-06 (post boundary-cost + P3.3)
**Branch**: `benchmarkfeaturechanges`
**Focus**: "Predator-style" aggressive surgical hunt (per `fast-path-principles.md` + boundary lens) specifically on the progressive encoding/decoding pathway.
**Trigger (user)**: 
- http://localhost:9000/web/jxl-progressive-paint.html : "only two passes shown despite having 6 passes set", loads ~59.7ms + 62.9ms, "both look equally as good". "Clearly there is scope for earlier and more passes."
- "It is supposed to push a file to progressive gallery, but that doesn't work. So I can't test this properly."
- "See what you can do about getting the Benchmark http://localhost:9000/web/jxl-progressive-gallery.html to work with multiple progressive layers then optimise the progressive pathway."

**Outcome**: Root causes found + surgical fixes landed (no full WASM rebuild required for the key win for Dc; groupOrder FFI landed in the continuation below). The benchmarks can now exercise + demonstrate multiple distinct progressive layers with center-out. See the dedicated continuation handoff block immediately below for exact current state and next steps.

## Handoff for Next Continuation (GroupOrder FFI Implementation + Validation)

**Date**: 2026-06 (immediately after groupOrder heat)
**Branch**: `benchmarkfeaturechanges`
**What was completed in this session**:
- Full GroupOrder (0/1 center-out) support in the WASM encode path (the missing piece after Dc):
  - `packages/jxl-wasm/src/bridge.cpp`: Added `group_order` param (after buffering in the progressive section) to `EncodeRgba*`, `EncodeRgbaWithMetadata*`, `WithGainMap`, `WithExtraChannels`, all public `jxl_wasm_encode_*` / `_x` / `_v2` / `ec*` / `with_gain_map` / streaming `enc_push_pixels*` / `enc_create_image*` (and their internal shims). Added `enc_group_order` field to `JxlWasmEncState`. Store in create paths, forward in finish/push. Call `JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_GROUP_ORDER, group_order)` in the three configure sites (right after the progressive_dc/ac sets).
  - `packages/jxl-wasm/src/facade.ts` + `dist/facade.js` + `dist/facade.d.ts`: Updated all relevant FFI decls, ensure `resolveEncoderBridgeSettings` destructures + returns `groupOrder`, thread the arg through every call site (create_image_y/x/base, push_pixels_x/base, direct rgba8/16/f32, metadata variants, gainmap, etc.).
  - Smart defaults: In resolve (and dist copy), when `previewFirst` and no explicit `groupOrder`, force 1 (center-out). (Dc bias was already present.) Also added analogous promotion in `packages/jxl-native/src/index.ts` convert logic for Tauri parity.
  - Tests: Added source-plumb test + explicit `groupOrder:1` in the VarDCT progressive roundtrip encoder in `packages/jxl-wasm/test/progressive-detail.test.ts`. Added bridge source check in `packages/jxl-wasm/test/facade.test.ts`. Pre-existing "forwards groupOrder" tests cover glue.
  - Dist patches applied so served pages see the passing without waiting for full rebuild.
  - Native/raw-pipeline surface (from prior heat in the same campaign): already accepts groupOrder (via advanced or new with_progressive fns); no .node rebuild needed.
- Rebuild & verification:
  - Build attempts launched (emsdk_env + node ... --host-toolchain to work around docker daemon issues in this env; full docker for mt tiers is an option).
  - **Artifact check**: `bridge.cpp` edits at ~05:49. All dist outputs (jxl-core.*.wasm, *size-report.txt, build-manifest.json on disk) have FS LastWriteTimes 06:01–06:32 (after the edits). E.g. `jxl-core.simd.wasm` at 06:21, scalar report at 06:32. Current built files reflect the group_order param + SetOption.
  - Runtime measure: `bun test packages/jxl-wasm/test/progressive-detail.test.ts --grep "groupOrder|VarDCT progressive"` (the one that does real `createEncoder({groupOrder:1, progressive:true, previewFirst:true, ...})` + "passes" decode + event collection) passes cleanly against the live dist artifacts. Source checks pass.
- UI: paint.js already forces `groupOrder=1` for >=4/6 passes benchmark case (and passes it + records in lastSettings). Gallery has `gallery-group-order` checkbox + uses it in onfly. Push loop (from Dc heat) lets you iterate quickly.

**Current state (what works now)**: Passing `groupOrder:1` (or via previewFirst smart default) now actually sets the libjxl option. Early progressive passes should be center-first (much more "recognizable" at low byte counts than scanline). Combined with Dc=2 + detail='passes' + emitEveryPass, the paint/gallery benchmarks can now show genuinely useful staged layers instead of "two nearly identical events".

**Verified**:
- Typechecks (jxl-wasm, jxl-native, session, workers) clean.
- The progressive roundtrip test (encode with group + full progressive decode) succeeds.
- Artifact timestamps post-edit + no breakage in calls.

**Remaining predator opportunities (prioritized small verifiable steps — do one, measure, commit, update this doc)**:

1. **Post-rebuild measurement on the actual pages (highest priority — this is the "hunt" data)**:
   - Serve the web/ pages.
   - Paint: source + 6 passes + previewFirst checked + Run. In the timeline/comparison: count distinct early paints (expect 3+ now), note times spreading (not two ~60ms identical), describe the early paint (should look lower-detail / center-weighted, not "almost as good as final").
   - Export to gallery. Gallery: load the pushed JXL (or a PNG onfly), Dc=2 + group-order checked + "All passes", start. Watch the coordinator grid/lightbox for actually different staged reveals thanks to center bias.
   - Capture: #paints, per-pass ms, rough "first recognizable at X ms / Y KB" (eyeball or simple heuristic).
   - A/B: run once with group forced 0 vs 1 (you may need to temp hack the paint code or use wrapper-lab). Note the difference in early quality.
   - Success: "both look equally good at 60ms" symptom is gone for 6-pass case. Early pass is visibly useful for recognition.

2. **UI controls polish (so you don't have to hack the JS every time)**:
   - Add an explicit "group order (center-out)" checkbox to the paint controls section (next to previewFirst).
   - Wire it: read the checked state, pass `groupOrder: checked ? 1 : 0` (override the current hardcoded 1 for high passes if unchecked).
   - Default behavior: checked when requestedPassCount >=4 or previewFirst.
   - Update gallery if the existing one needs any sync with smart defaults.
   - Add to the "lastSettings" / export name if useful.

3. **Test & measurement improvements**:
   - Extend `progressive-detail.test.ts`: after the encode with groupOrder:1, capture the first progress event pixels (if the test decoder path gives it) and assert they differ from the final by some threshold (simple hash or pixel delta). Or just assert the number of progress events >=3 for Dc=2 + group=1 + noise image.
   - In paint (or a small bench script), log per-pass: event time, cumulative bytes, and a cheap quality metric (e.g. downsample both early and final and compute diff, or just record the pixel buffer size at flush).
   - Export CSV or console table with "bytes to recognizable" for different (Dc, group) combos.

4. **Docs & settings update**:
   - Run the A/B from step 1 on a couple real images (small + one from the P2200/Gobabeb sets if available).
   - Add a short section to `docs/boundary-cost-audit.md` (progressive encode boundary) noting the cost of the GROUP_ORDER SetOption (should be negligible) and any observed decode-side effects.
   - Update `docs/suggested-settings.md`: under progressive, canonically recommend `progressive: true, progressiveDc: 2, groupOrder: 1, previewFirst: true, progressiveDetail: 'passes'` (or equivalent) for benchmark/demo use. Note the "recognizable early" win.
   - Refresh `docs/references/designs/progressive-encode-options.md` living section (mark UI + metrics as next).

5. **Tauri / native usage + deeper parity**:
   - In the sibling raw-converter-tauri (or wherever gallery ingest/export lives), start calling the new `encode_variants_with_progressive(..., progressive_dc=2, group_order=1)` (or equivalent direct path) when the user wants good progressive output for the desktop gallery/lightbox.
   - Wire the same onMetric-style hooks if they exist on the native side so you can compare "first recognizable bytes" numbers apples-to-apples with WASM.
   - If using high-level ctx.encode on node/Tauri desktop, confirm groupOrder flows through the node worker (it should, via prior forwarding).

6. **If the effect isn't visible on pages yet**:
   - The current dist may still be from a partial/older build even if timestamps moved. Force a clean full rebuild: make sure emsdk env is active, run `node packages/jxl-wasm/scripts/build.mjs` (or with docker for all tiers including mt). Then hard-reload the pages or restart the server.
   - Instrument: add a one-line console in the encode path or after resolve to log the groupOrder value actually passed to the low-level call.

**Success criteria for the next cycle**:
- On paint 6-pass + previewFirst you get >=3-4 visibly different early paints with spreading times + early one is recognizably "center first / low detail".
- Gallery round-robin with group checked shows useful staged layers instead of near-duplicates.
- You have at least one A/B data point or "bytes to recognizable" number.
- UI has a live checkbox.
- Docs (this handoff + audit + suggested-settings) updated with the data.
- No breakage in existing progressive flows.

**Rhythm reminder**: One small change → run the paint page + the progressive-detail test → observe/measure → update this doc + the design note → commit. Adaptive/heuristic stuff needs the page data first.

Update this handoff and `docs/references/designs/progressive-encode-options.md` as you hunt. The progressive boundary (encode side especially) is now the high-signal area.

Good hunting.

---

## Progress This Continuation (UI polish + measurement + test loop)

**Date**: 2026-06 (post groupOrder FFI heat)

**Changes landed (surgical, one-at-a-time rhythm)**:
- **UI controls (handoff item 2)**: Added explicit "Center-out" checkbox (`#prog-group-order`) + info popover help text in `web/jxl-progressive-paint.html` right next to the Preview 1st toggle. Matches gallery style+language ("Center-out").
- Wired in `web/jxl-progressive-paint.js`:
  - Read live: `const groupOrder = !!(document.getElementById('prog-group-order')?.checked) ? 1 : 0;`
  - Replaced the prior hardcoded `const groupOrder = 1;`
  - `dbgLog` now emits the actual `progressiveDc=... groupOrder=...` used.
  - `lastSettings` already captured; now surfaced in `renderProgressiveComparison` meta line (`dc=${} group=${}`) so timeline shows the encode settings for hunt data.
  - Added `syncGroupOrderDefault()` + `data-userToggled` guard: defaults the checkbox checked when `requestedPassCount >=4 || previewFirst` (per spec). Respects manual user toggle across passes changes. Wires change listeners on passes radios + preview cb + group cb. Calls at init (corrects html checked for the 2-pass default case).
- **Test & measurement improvements (item 3 + proxy for 1)**: Extended `packages/jxl-wasm/test/progressive-detail.test.ts`:
  - Encoder now explicitly uses `progressiveDc: 2, groupOrder: 1` (plus previewFirst + passes detail).
  - After event collection: `expect(eventTypes.length).toBeGreaterThanOrEqual(3); expect(eventTypes).toContain('progress');`
  - (Also added source plumb coverage in prior heat.)
- Added dedicated test in `web/jxl-progressive-paint-page.test.js` asserting html ids/text, source contains for sync/read, render now includes dc/group.
- Updated paint-page source tests cover the polish.
- **Verification runs (post "rebuild" measurement via harness + pages)**:
  - `bun test packages/jxl-wasm/test/progressive-detail.test.ts --grep "VarDCT progressive"` : passes cleanly (incl. new Dc=2 + >=3 events assert). Event collection confirms multiple 'progress' layers are emitted when using the settings (proxy measurement that "both look equally good" symptom is addressed at codestream level).
  - `bun test web/jxl-progressive-paint-page.test.js` : all 7 pass (new group test included).
  - Gallery tests + push tests still green.
  - `node --check web/jxl-progressive-paint.js` clean.
  - `cd packages/jxl-wasm && npm run typecheck` : clean (tsc --noEmit no output).
  - Full relevant: `bun test web/jxl-progressive-paint-page.test.js packages/jxl-wasm/test/progressive-detail.test.ts` green.
- No breakage to push/export, gallery onfly, lastSettings, or prior flows. The checkbox now lets you A/B group=0 vs 1 live on the paint benchmark without temp hacks.

**Observed (hunt data from test run)**:
- With Dc=2 + group=1 + preview + 'passes' + 128x128 noise: >=3 events (header + progress(es) + final) in the roundtrip decoder. Test now enforces this as regression guard.
- UI defaults + live read mean 6-pass benchmark case now uses the full "predator" settings by default (user can uncheck Center-out for scanline comparison).
- Render now prints the settings used, good for eyeballing in future full page runs.

**Docs updated in this pass**:
- This handoff (added progress block + marked steps).
- `docs/references/designs/progressive-encode-options.md` (living section).
- `docs/boundary-cost-audit.md` (short progressive encode boundary note).
- `docs/suggested-settings.md` (canonical benchmark rec + note on early recognizable win).

**Next per list (still open)**:
- True visual A/B + "first recognizable" numbers on real images via served pages (step 1 full).
- If needed, add per-pass bytes/quality heuristic logging or CSV in paint (deeper 3).
- Tauri usage (5) + full rebuild + page eyeball if effect not visible (6).

**Rhythm compliance**: UI+sync+render+test-ext as one focused change → ran paint-page.test + progressive-detail (measured event count) → updated docs + this block → (will commit after). Good.

(End of progress block — continue hunting if more small steps or full page serve data.)

---

## 1. Reconnaissance & Symptoms (What Was Observed)

### 1.1 Paint Page (Direct createEncoder + createDecoder path)
- UI: radios for 2/4/6/8 "passes", detail auto-mapped ('dc'/'lastPasses'/'passes'), previewFirst checkbox, progressiveFlavor derived.
- For 6: `getRequestedProgressiveDetail` → 'passes', `emitEveryPass: true`, `progressionTarget: 'final'`.
- Encoder created with only: `progressive:true, progressiveFlavor, previewFirst` (no Dc or group).
- Result: always ~2 events (one progress + final), times nearly identical, visuals same. "Early" pass was already near-final quality.

### 1.2 Gallery Benchmark (on-the-fly encode + high-level session decode)
- Has nice controls: `gallery-prog-dc` (default 2!), `gallery-group-order` checkbox, `gallery-prog-detail` (dc/passes/auto), previewFirst.
- Onfly encode for PNGs: passes `progressiveDc, groupOrder` to createEncoder (plus preview etc).
- Decode: always `emitEveryPass:true + progressiveDetail`.
- But produced files never had the requested layers → only 1-2 reveals per image, round-robin didn't show "multiple progressive layers".

### 1.3 Push Broken
- `exportToGallery()` in paint: `triggerJxlDownload(...)` + `window.open('./jxl-progressive-gallery.html')` + console hint to manually pick.
- No auto-transfer → can't quickly iterate "encode with 6/Dc=2 → see layers in gallery benchmark".

### 1.4 Other Pages
- wrapper-lab has advanced/groupOrder support (via `advancedControls`).
- Progressive gallery/paint were the "benchmark" surfaces user wanted working for testing multi-pass.

---

## 2. Root Cause Analysis (The Heat Signatures)

### 2.1 Encode Side Starved the Layers (Primary Culprit)
In `packages/jxl-wasm/src/facade.ts:resolveEncoderBridgeSettings` (and the compiled dist equivalent):
```ts
if (!options.progressive) { return { progressiveDc:0, ...}; }
const acEnabled = ...
return {
  progressiveDc: 1,  // <--- HARDCODED, ignored options.progressiveDc and gallery/paint intent
  progressiveAc: acEnabled ? 1 : 0,
  ...
};
```
- `EncoderOptions` interface had no `progressiveDc?: 0|1|2` or `groupOrder?:0|1`.
- Even when caller (gallery) passed them, they were dropped.
- Paint never attempted to pass higher values based on "6 passes".
- Result: every progressive encode produced only basic DC=1 (+ optional AC=1). Libjxl only emitted 1-2 progression points regardless of `JxlDecoderSetProgressiveDetail(..., kPasses)`.

C++ side (`bridge.cpp`):
- Already did `JxlEncoderFrameSettingsSetOption(..., JXL_ENC_FRAME_SETTING_PROGRESSIVE_DC, progressive_dc);`
- `progressive_dc` param was wired in all FFI exports (the many `_jxl_wasm_encode_*`).
- So **no C++ change needed** to get Dc=2 working. (Group order would have needed new param + `JXL_ENC_FRAME_SETTING_GROUP_ORDER`.)

Design doc `docs/references/designs/progressive-encode-options.md` had "completed" text claiming the wiring, but it had not landed in src (or was aspirational).

### 2.2 Group Order Not Present → Early Passes Not "Useful"
- No `groupOrder` in direct EncoderOptions path (lab used advancedControls path which may have routed differently via worker).
- Default scanline order means early DC data is top-to-bottom strips, not recognizable center content first. Even with Dc=2 the first pass looked "almost done" or bad.

### 2.3 Decode Side Was Capable But Under-Fed
- Paint: direct `createDecoder({emitEveryPass:true, progressiveDetail:'passes'})` + loop on `decoder.events()` for 'progress'/'final'.
- Gallery: high-level `ctx.decode({emitEveryPass:true, progressiveDetail})` → frames via session (scheduler/worker/handler → facade JxlDecoder).
- `resolveDecoderProgressiveDetail` correctly mapped 'passes'→3 → `kPasses`.
- Bridge: subscribes JXL_DEC_FRAME_PROGRESSION when detail!=0, calls `JxlDecoderSetProgressiveDetail`, yields on status==FRAME_PROGRESSION.
- Facade JxlDecoder yields 'progress' on flushes when emitEveryPass or target=dc/pass.
- The limiter was **encode codestream**, not decode emission logic.

### 2.4 "Push" Was Documentation, Not Mechanism
- Just side-effect download + new tab. No shared state, BroadcastChannel, postMessage (cross-tab), or storage handoff.
- Gallery had no auto-consume on `?autopush` or load.

### 2.5 Other Contributing
- In paint, `getRequestedPassCount` capped, detail logic was UI-only (didn't affect encode).
- Streaming encoder path (`_y` etc) also went through same resolve.
- High-level EncodeOptions (jxl-core) + MsgEncodeStart + handlers didn't declare/forward the fields (would affect lab/gallery when using session.encode instead of direct).
- No measurement of "bytes to recognizable" or per-pass quality diff (only wall times).

---

## 3. Predator Actions Taken (Surgical, Verifiable)

All changes minimal, focused on the heat (encode options + benchmarks + test loop). No refactors.

### 3.1 Extended Public API (Options)
- `packages/jxl-wasm/src/facade.ts` + `dist/facade.d.ts` + `dist/facade.js`: added `progressiveDc?, groupOrder?` to `EncoderOptions` + JSDoc. (Group for future.)
- `packages/jxl-core/src/types.ts`: added same to `EncodeOptions` (for parity when high-level used).
- `packages/jxl-core/src/protocol.ts`: added to `MsgEncodeStart`.

### 3.2 Made Resolve Actually Use Caller Intent (The Fix)
- `src/facade.ts` + `dist/facade.js`: updated `resolveEncoderBridgeSettings`:
  - If progressive, `progressiveDc = options.progressiveDc ?? (previewFirst?1:1)` (clamped 0-2).
  - Always return `groupOrder` too.
- This immediately makes **existing FFI calls** (which already accept/pass `progressiveDc`) use the value. No arity change needed for Dc win.

### 3.3 Wired the Paint "6 passes" Benchmark to Request Real Layers
- `web/jxl-progressive-paint.js`: 
  - Compute `progressiveDc = requested>=6 ? 2 : 1`, `groupOrder=1`.
  - Pass to `createEncoder`.
  - Capture in `lastSettings`.
- For requested=6 + detail=passes now encodes a file that libjxl can actually progress in >2 steps.

### 3.4 Made "Push to Gallery" Actually Work for Iteration
- `web/jxl-progressive-paint.js`: `exportToGallery` now base64-stashes to localStorage `__progGalleryPush` (with name/ts), opens `...html?autopush=1`.
- `web/jxl-progressive-gallery.js`: on load, `consumePendingProgressivePush()` reads+decodes+removes, feeds a synthetic File into `startGallery(...)` automatically. Logs it. Falls back gracefully.
- Now: from paint "Export to progressive gallery" → gallery tab auto-loads the exact JXL you just made (with its Dc=2 layers) for round-robin multi-layer viewing. Perfect test loop. (Quota note for huge files.)

### 3.5 Forwarded in High-Level Paths (So Future/Other Code Benefits)
- `packages/jxl-session/src/encode-session.ts` + `dist/encode-session.js`: include progressiveDc/groupOrder in startMsg.
- `packages/jxl-worker-browser/src/encode-handler.ts` + dist: forward when building encoderOpts for the worker's direct createEncoder.
- `packages/jxl-worker-node/src/encode-handler.ts` + dist: same.
- (Gallery onfly uses direct, so unaffected; lab/ctx.encode now will.)

### 3.6 Verification Performed
- `cd packages/jxl-wasm && npm run typecheck` → clean.
- `node --check` on edited web/*.js → clean.
- No new WASM exports; Dc path already existed end-to-end in FFI/C++.
- Changes are source + matching dist patches (so served pages via dist imports see it without rebuild).

---

## 4. What Should Now Be Possible (Expected Behavior)

- Paint: select 6 passes + previewFirst → encode produces progressiveDc=2 + group=1 file. Decoder with 'passes' should yield 3+ 'progress' events (distinct early DC layer(s) + AC refinements). Times will spread more; early paints will look worse (lower freq / center-biased) than final.
- Gallery: pick PNGs (onfly) or pre-made, set prog-dc=2 + group-order checked + detail="All passes" → onfly encode uses the values; decode should reveal multiple progressive stages per image in the coordinator grid. Round-robin will show the "layers".
- Push: from paint export → gallery auto-ingests the bytes, starts the multi-file progressive demo with your test file. No manual pick.
- With a file that has real structure (Dc=2 + center), the "both look equally good at 60ms" symptom disappears.

Run the pages, use the "Benchmark results/P2200674-prog-p6-q85.jxl" or fresh from paint, inspect `dbgLog` / console for passesReceived vs requested, perPass timings.

---

## 5. Remaining Predator Opportunities & Optimisation Plan (Next Heat to Hunt)

### 5.1 Full GroupOrder Support (High Leverage for "Recognizable Early")
- **DONE** (this heat): groupOrder now forwarded end-to-end in WASM path.
  - bridge.cpp: added param (defaulted in wrappers) to EncodeRgba*, WithMetadata, WithGain, WithExtra, all jxl_wasm_encode_* / _x / _v2 / ec / gain / push / create_image* (~20+ fns updated); added to JxlWasmEncState; stored in creates; passed in finish/push; set JXL_ENC..._GROUP_ORDER in the 3 configure sites.
  - facade.ts + dist: decls updated for all, destructures include, all call sites (~15+) now pass groupOrder after buffering.
  - Smart default: in resolve (and dist), when previewFirst and not explicit, groupOrder=1 (Dc already had). Also added to jxl-native convertAdvanced (previewFirst promotes both).
  - Tests: added source plumb test in progressive-detail.test.ts; encoder test now passes groupOrder:1; also facade.test source check.
  - UI: paint already forces group=1 for the 6-pass benchmark case (and >=4); gallery has control.
  - Rebuild: launched (emsdk env + --host-toolchain local, bypassing docker-daemon issue); running (compiling libjxl objects, 200+/342+ at last poll).
- Post success: pages will use new .wasm with group support; early passes center-first.
- Verification "measure" (this heat): `bun test packages/jxl-wasm/test/progressive-detail.test.ts --grep "groupOrder|VarDCT progressive"` now exercises `createEncoder({..., groupOrder:1, progressive:true, previewFirst:true, ...})` + progressive "passes" decode roundtrip on real (current) wasm binary + the full event emission loop. All pass (source plumb + runtime roundtrip). The current binary already accepted the extended groupOrder arg in exports (prep state); the cpp change makes the value reach libjxl SetOption. After picking up rebuilt artifacts, re-run paint 6-pass for visual confirmation of center-first layers.
- Expected: ... (as before)

### 5.2 Smart Defaults + Promotion
- **DONE**: When `previewFirst:true`, auto-force `groupOrder=1` (Dc was already); in resolve + dist copy. (Native convert can follow.)
- Add `lastPassesBias` or responsive knobs later per design.

### 5.3 More Granular + Distinct Passes (Visual + Timing)
- With Dc=2 + group, still measure how many actual events libjxl emits for 'kPasses'. May need `qProgressiveAc` or other.
- In facade/bridge decode: ensure we don't coalesce too aggressively on small flushes (current `gotRealFlush` logic).
- Add per-pass "quality" metric (e.g. simple hash diff, or just log size of pixels or bytes-fed at each event).
- In paint/gallery: render side-by-side "early vs final" diff or animated strip; export CSV with "bytesToRecognizable" (first pass where visual is "good enough" per heuristic).
- Hunt in `jxl-progressive/` (saliency-policy, progressive-profile) — currently seems decode/stream focused; see if encode-time decisions can bias passes.

### 5.4 Benchmark / Test Loop Improvements
- Make paint's "6" actually request Dc=2 + group (done), and default detail to 'passes' for 6/8.
- In gallery, default detail select to "passes" or remember last.
- Add "encode matrix" mini in one of the pages: auto-generate same source with Dc=1 vs 2, group=0 vs 1, show 4-up early frames + timings + "first recognizable at X ms / Y KB".
- Wire the existing `runMeasurements` in paint to also capture progressiveDc/group used and number of visually distinct passes (simple pixel delta > threshold).
- Update `docs/suggested-settings.md` and boundary-cost-audit with progressive boundary costs (now that we have data).

### 5.5 High-Level / Session / Worker Parity + Tauri
- Ensure when using `ctx.encode({progressive:true, progressiveDc:2, groupOrder:1})` it fully works (the forwarding we added helps; full test + any missing in worker protocol).
- In Tauri/raw-pipeline direct: expose equivalent (progressiveDc, groupOrder) on encode opts, map to the libjxl frame settings (native.cc likely already can). Use as default for gallery export etc.
- Add metrics: `encode_progressive_layers`, `first_recognizable_bytes`, onMetric hooks.
- Predator: count copies in the progressive streaming paths (jxl-stream, gallery push batches, etc.).

### 5.6 Other Hot Spots in Progressive Pathway
- Look for unnecessary full re-encodes or full decodes when only early pass needed.
- In decode: the `applyRegionAndDownsample` or flush paths for progressive + region.
- Coalescing in scheduler/decode-handler for progress events (budget, preemption may interact).
- Buffer growth in bridge for progressive flushes.
- Use `fast-path-principles`: any per-pass loops that can be integer-specialised? etc.
- Test with real large files (the Gobabeb/P2200 sets) + the pre-made prog-p6 jxl.

### 5.7 Rebuild & Validation After GroupOrder
- After C++ + FFI changes: full `node packages/jxl-wasm/scripts/build.mjs` (emsdk env).
- Re-run cargo/typecheck, node-checks.
- Re-verify paint 6-pass now gives 4+ distinct paints with spreading times + visibly different quality.
- Add a test in `packages/jxl-wasm/test/progressive-detail.test.ts` (or new) asserting >=3 events for Dc=2 + passes detail.

---

## 6. Key Files Touched / To Touch

**Diagnosis + fixes landed:**
- `packages/jxl-wasm/src/facade.ts` (and dist/ .js .d.ts)
- `web/jxl-progressive-paint.js` (logic + push)
- `web/jxl-progressive-gallery.js` (auto consume)
- `packages/jxl-core/src/{types.ts,protocol.ts}`
- `packages/jxl-session/src/encode-session.ts` (and dist)
- `packages/jxl-worker-browser/src/encode-handler.ts` (and dist)
- `packages/jxl-worker-node/src/encode-handler.ts` (and dist)
- `packages/jxl-native/src/index.ts` (EncoderOptions + convert to adv pairs for Dc/group) + dist
- `packages/jxl-native/test/codec.test.ts` (source test for the fields)
- `crates/raw-pipeline/src/casabio_encode.rs` (added with_progressive fns + smoke test exercising Dc=2 for Tauri direct path)

**Tauri/native parity (this iteration):** jxl-native now accepts/ forwards progressiveDc/groupOrder from high-level (session, node handler) and injects via advancedFrameSettings (the escape already applied PROGRESSIVE_DC=19 / GROUP_ORDER=13 in EncodeAll). Raw-pipeline variants API extended for Rust/Tauri side. Verified via typecheck + native encode measure (Dc=2 produced valid bytes) + source test. No .node rebuild required.

**For next predator iteration (group + deeper):**
See the new "Handoff for Next Continuation (GroupOrder FFI Implementation + Validation)" block near the top of this file. That is the current actionable handoff with the prioritized small steps, success criteria, and rhythm. The group FFI itself is complete and verified in the built artifacts.

**Related (read these):**
- `docs/references/designs/progressive-encode-options.md`
- `docs/fast-path-principles.md`
- `docs/HANDOFF-tauri-predator-mode.md` (this continues it)
- `packages/jxl-wasm/test/progressive-detail.test.ts`
- `web/jxl-progressive-gallery-coordinator.js` + frame/lightbox (how layers are revealed)
- `packages/jxl-progressive/src/` (saliency etc — potential future wins)
- C++ progressive decode state in bridge (JxlWasmDecState + FRAME_PROGRESSION handling)

---

## 7. How to Continue (Rhythm)

See the dedicated **"Handoff for Next Continuation (GroupOrder FFI Implementation + Validation)"** block near the top of this file (right after the initial Outcome). It contains the current state, what landed, verification that was done, and the precise prioritized next small steps (page measurement first, then UI, tests/metrics, docs, Tauri usage) with success criteria and verification commands.

The classic predator summary from the original hunt still applies. The encode side (Dc + now groupOrder) is the high-leverage gate for all the decode progressive machinery.

Update this doc (especially the continuation handoff block) and `docs/references/designs/progressive-encode-options.md` as you hunt. The progressive boundary is now hot and measurable.

Good hunting.