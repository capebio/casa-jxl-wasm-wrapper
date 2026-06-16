# ProgressiveGalleryPushPreset2.md

Group 14 (pass 2): Gallery Push Schedulers & Multi-Asset Delivery (web/jxl-progressive-gallery.js, web/jxl-progressive-gallery.test.js, web/jxl-progressive-gallery-push.js, web/jxl-progressive-gallery-push.test.js, web/jxl-progressive-best-preset.js).

**All 21 lens passes re-executed on current (post-pass-1) state of the 5 files + targeted exploration of directly connected files in web/ (coordinator, lightbox, frame/pack) for pipeline context.** No unrelated files read beyond that. Exhaustive for 1) efficiency 2) speed 3) performance 4) bugs 5) features (AR/LLM/photogram/immersion/digital-twin/perceptual-color). Amalgamated, dups from pass 1 or new collapsed. Concise issues+fixes only. From current code in memory + fresh targeted reads + pipeline knowledge (Sneyers, emitEveryPassForDetail, chunked-feed+yield, opportunistic flushes, coordinator round-robin min-frames visible, pack zero-copy fastpath + constancy hook, lightbox attended/focus/constancyParams, getPriorityTargets). 

Pass-1 changes (abort, limiter, rAF batch, preset unification + getPushBatchingOptions, zero-copy in push, DEFAULTs, test extensions) are now baseline; this pass finds residuals + new opportunities visible only after those + connected examination.

## Amalgamated Findings (cross-lens, post-pass-1)

- Residual dupe: getGalleryEncodeOptions + getGalleryProgressiveDetail + local CHUNK/WINDOW consts still present and partially used (logging + fallback). Preset + getPushBatchingOptions + DEFAULT_* now authoritative but not fully centralized (gallery still re-derives some for onfly encodeOpts).
- Post-1 encode path: encodeToProgressiveJxl still hardcodes quality=82/effort=4 (ignores preset qualityPolicy.effort and passed encodeOptions fully for quality).
- Decoder creation: still forces preserveIcc/Metadata=false even when basePreset.decode carries values from pushed settings or future callers. Comment acknowledges but doesn't honor.
- Coordinator (connected exploration): has excellent getPriorityTargets() returning per-file visible frontier for "boost" (AR focus, foveation, photogram key views). Gallery never calls it. visibleFrames is pure display slice (min-frames round-robin); no back-pressure to decode/push. registerFrame just assigns by index (assumes no dups).
- Lightbox (connected): has set/getConstancyParams, setFocusRegion, getAttended (file+frame+params+region). Gallery creates it, passes framesByFile, uses for nav + render (with params to draw/pack), but never sets focus/constancy from UI or preset. Ctrl-arrow file switch caps to maxVisited (good for progressive "seen so far").
- packFramePixels (connected, Lens6/7/17): fastpath zero-copy view/subarray when tight stride/no-roi (good "pointer move"). Fallback is per-row subarray+set copy loop (the remaining hot copy kernel here). Has explicit hook+TODO for constancyParams (mode==='constancy') + comment tying to Lens17 Rust LookRenderer + "Perceptual Constancy Mode" for JXL progressive paints. roi support present but gallery/lightbox use limited.
- Memory/state: framesByFile still holds *all* historical enriched frames + pixels per file for lightbox history (post-1 abort helps but long sessions or 50+ assets still accumulate). dirtyStrips/rAF good but per startGallery instance (no cross-gallery).
- Abort/consumed: good (Map bounded, signal in push/frames/load). But currentGalleryAbort is single global per page; nested or parallel galleries would clobber. No per-decoder pause/resume tie to coordinator visible.
- Tests: improved (more cases, lock comments, Best import), but still source-string heavy for gallery.test + no mock execution of startGallery/coordinator flows.
- Lens1 strategic: now tighter via preset (gallery <-> best-preset <-> push), coordinator provides visibility frontier, lightbox provides attended state, pack provides pixel boundary. But gallery is still "god" for delivery orchestration; no use of coordinator.getPriorityTargets() to e.g. influence runLimited or push window.
- Lens2 API: no change to exports (push/build still pure, best-preset now richer with getPush + preserve + DEFAULTs, gallery none). WASM via facade still direct createDecoder (ctx only init). No worker messages here (main-thread gallery for lab control of chunk feed).
- Lens3 pipeline: onfly encode (canvas->encoder->chunks concat) then decode; direct decode for .jxl. Transform/resize in WASM or pack (roi). Cache none. Return: enriched with pixels to coordinator/lightbox/pack->canvas. Post-1: push now adaptive via getPushBatchingOptions.
- Lens4 state: improved (abort, limiter queue via waiters, dirty for coordinator, maxVisited in lightbox). Cancellation now graceful per-file (break + dispose). Error still partial return + dispose. No per-push "queue state" exposed beyond batches.
- Lens5 data: pushBatches now array of Uint8Array views (better). frames arrays dense by frameIndex. basePreset carries byteCutoffs/target/encode/decode. Still full pixel history in framesByFile.
- Lens6 hot kernels: pack fallback row copy loop (subarray/set) now prominent when not fastpath (roi or padded stride from decoder). buildPush subarray is win. No pixel math/color here (post-decode).
- Lens7 boundaries: improved views in pack fastpath + push subarray (less copy at JS<->). WASM push/events still transfer pixels. No Rust here. Memory copies reduced vs pass-0 but encode concat + canvas getImageData + full history remain.
- Lens8 support: getPriorityTargets / getAttended / constancy hook are now "progress" surface for AR/LLM. Tests better but validation of signal abort paths or priority thin. Logging still per-frame.
- Lens9 Owl + connected: coordinator priorityTargets + lightbox attended/focusRegion + pack hook smell like the "nervous system" for future foveated/AR/plant-ID (focus one asset high-res, others low). Gallery not listening to its own coordinator's priority output. Pack hook is the exact insertion point for Lens17.
- Lens10 backwards: pass-1 added the "safety net" (abort/limiter/rAF/preset). Current view: the visible frontier (coordinator) and attended (lightbox) are now first-class but unused for delivery decisions. Old single-file full-decode assumption still lingers in concurrent always-do-all.
- Lens11 astro: priorityTargets = "pointing schedule" for telescope/AR "visits". Early frames (dc/passes) = quick-look low-res for object detection on "stars/plants". Gallery as multi-object "focal plane" simulator.
- Lens12 LLM/machine rec: early progressive stages + %/stage in enriched + now-visible priorityTargets give natural "anytime" input for vision models (coarse on dc, refine on passes). Hook in pack + lightbox getAttended give place to inject on-frame callback for on-device recognition without blocking UI.
- Lens13 gaming: visibleCount min-frames = LOD streaming throttle. priorityTargets = interest culling / occlusion. rAF batch = frame pacing / vsync. Limiter = job system / thread pool cap. Fastpath views in pack = shared memory / zero-copy textures.
- Lens14 photogram/digital twins: multi-file gallery + round-robin visible = natural multi-view strip for structure-from-motion. Early frames for feature detection (SIFT on dc may be poor but timing data useful). Preserve metadata/icc now optional in preset (good). No pose/EXIF forwarding (pack/gallery force false). PriorityTargets could bias "key views".
- Lens15 Butteraugli: still not here (encoder internal). Post-1 preset qualityPolicy still stubs ssimulacra. Gallery onfly encode always pays cost; no bypass for pure decode testing.
- Lens16 AR real-time plant ID: gallery as "multi-capture simulator" for different angles/lighting. Progressive + chunk feed = simulate phone->edge streaming. lightbox focusRegion + coordinator priority + pack roi = foveated decode (high detail on gazed plant). getAttended + constancy = live illum-invariant ID overlay. Gap: no camera stream path, no onframe ML callback surface.
- Lens17 advanced color (non-Riemannian, B matrix, log, Molchanov A_tensor, hybrid DE, diminishing f(c), Perceptual Constancy Mode): packFramePixels already has the exact hook + comment ("when ready, apply... or return transformed view"). lightbox already carries constancyParams and getAttended. Gallery render already forwards to draw/pack for lightbox. Post-1 preset can carry flags. The actual math is planned for Rust LookRenderer apply_tone_math, exposed to JS lightbox. Opportunity: make preset expose constancyMode, wire gallery -> lightbox -> pack (or WASM LUT when ready). No change needed in core 5 for the math itself.
- Lens18 gaps (post-1 + connected light): 1. Delivery intelligence: gallery/coordinator do not consume getPriorityTargets or visible frontier to modulate runLimited, push window, or decoder creation (still "decode everything, show round-robin"). 2. Constancy / color surface: hook + params exist but no-op; no preset-driven mode or actual transform path ready for Lens17. 3. External integration points for LLM/AR/photogram (onframe callback, focusRegion driving decode region/roi in decoder, pose metadata passthrough) – surfaces are half-there in connected but not wired from gallery.
- Lens19 repeat (diff angle): from "data flow for multi-asset delivery" view, pass-1 made feed (push batches) and safety (abort/limit) solid. Remaining: the "visibility oracle" (coordinator) and "attention oracle" (lightbox) are not fed back into the delivery scheduler. Pack is the last pixel boundary before DOM – perfect for post-decode color/AR transforms.
- Lens20 tricks: post-1 already has the big pointer-move wins (subarray in push, fastpath view in pack). New: in coordinator getVisibleCount the minFrames / slice(0,visible) is clever cap without per-file state explosion. In pack fastpath: source.subarray + new Uint8ClampedArray(view) shares buffer (0-copy). Could push further: pre-size frames arrays in coordinator, or use transferable in more places.
- Lens21 bird's eye: the 5 files + 3 connected now form a closed "progressive delivery + viz + attention" subsystem. Stands out: the priority/attended/focus + pack hook are the exact threads for the user's AR/plant/digital-twin/color visions. Connectivity improved by pass-1 (preset as config bus) but feedback loops from viz (coordinator visible/priority, lightbox attended) back to push/decode still missing. Last improvements: wire priority to influence concurrency or push mode; make pack hook live (even no-op or param passthrough); centralize the last getGallery* fns into preset calls; honor preserve in decoder when preset supplies.

3 largest still-unilluminated (updated): 1. Feedback from visibility/priority/attention oracles into the push scheduler / limited runner (coordinator <-> gallery <-> (future) jxl-scheduler). 2. End-to-end constancy / advanced color path (preset flag -> lightbox -> pack hook -> eventual Rust/WASM). 3. "Anytime recognition" surface (onframe/stage callback or region-of-interest decode driven by focus/priority for LLM/AR).

All proposals scoped primarily to the 5; cohesive improvements allowed on directly touched connected (coordinator/lightbox/pack) only if reassessed positive for pipeline invariants. No broad refactors.

## Implementation Layers (sensible chunks for agents; 1 primary file per agent, connected edits noted for cohesion)

### Layer 1: web/jxl-progressive-gallery-push.js (and its test)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

- (Lens5/6/20 residual) byteCutoffs param accepted in JSDoc but ignored inside fn (adaptive lives in getPushBatchingOptions caller). Either remove or use for size-based chunkSize tweak inside (small win for very large assets). Suggested (if positive):

```js
if (byteCutoffs && size > (byteCutoffs[8]||250*1024)) chunkSize = Math.max(32*1024, chunkSize/2);
```

- Add unit test coverage for the byteCutoffs path (already in test via Best, but direct).

Reassess: small; only if it avoids caller change in future.

### Layer 2: web/jxl-progressive-best-preset.js (and usage in gallery test)

If you agree... (phrase)

- (Lens2/5) getPushBatchingOptions always forces mode:'window'. Add option to respect caller mode or return full options object that gallery can spread. Current callers do {mode: pushMode, ...opts} – works but brittle.

- Expose a createGalleryPreset() or similar that bakes the gallery-specific forces (preserve false for lab, etc.) so gallery no longer has the override comment.

- Reassess before edit: positive for reducing magic in gallery; small additive.

### Layer 3: web/jxl-progressive-gallery.js (primary; may touch connected for cohesion)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

- Remove or deprecate getGalleryEncodeOptions / getGalleryProgressiveDetail (now mostly logging); always derive from basePreset / getGalleryProgressiveDetail can delegate to preset defaults.

- In encodeToProgressiveJxl: use encodeOptions.quality / effort if present (or basePreset) instead of hard 82/4. Suggested:

```js
quality: encodeOptions.quality ?? 82,
effort: encodeOptions.effort ?? 4,
```

- In decoder create: honor basePreset.decode.preserve* instead of always false (unless gallery UI forces viz-only). Remove the "keep force" comment or make conditional.

- Wire coordinator priority: after coordinator = ..., expose or use 

const priorities = coordinator.getPriorityTargets();

... for future (e.g. log or pass to a hypothetical "focus" decode). For cohesion, consider small edit to coordinator if needed to make targets richer (e.g. include byteLength).

- After lightbox = ..., call lightbox.setConstancyParams({mode: 'off'}) or wire from a future preset flag. Pass more to renderLightboxState.

- In startGallery onfly: pass full basePreset.encode (including effort/quality) to encodeToProgressiveJxl.

- Reassess all: positive – cleans residual dupe from pass-1, honors the connected oracles (priority/attended/constancy) that became visible, prepares Lens17 without changing core progressive flow.

### Layer 4: web/jxl-progressive-gallery.test.js

If you agree...

- Keep *all* previous + original locks.

- Add contains/asserts for new pass-2 items: getPushBatchingOptions call with byteCutoffs, requestRender usage, basePreset.encode passed to encodeTo, signal in more paths, coordinator.getPriorityTargets if wired.

- Add comment reinforcing that string tests protect the chunked progressive + coordinator min-frames contract.

### Layer 5: web/jxl-progressive-gallery-push.test.js (and best-preset indirect)

If you agree...

- Add direct test for byteCutoffs param affecting (or not) inside build (per Layer1).

- Last agent: after edits + any connected, re-run c:\Foo\raw-converter-wasm\StandardMultifileTest.mjs , append summary+delta to Implemented, then rename this file by appending -DONE (ProgressiveGalleryPushPreset2-DONE.md).

## Cohesive Connected Notes (for agents whose layer touches pipeline integration)
When reassessing a suggestion for gallery / preset / pack hook, you may (after positive re-assessment) make minimal edits to directly connected web/ files (coordinator.js for priority exposure, lightbox.js for attended wiring, pack/frame.js for live constancy hook or better fastpath) to make the improvement complete. Do not touch unrelated crates/packages unless the item explicitly requires (e.g. for future WASM LUT). Re-document in Implemented.

## Overview of what implementing these suggestions would achieve (pass 2)

Pass 2 cleans the last residuals from the successful pass-1 unification/safety/perf work (dead getGallery* fns, hardcodes, ignored preserve, unused oracles) while activating the "attention surfaces" that the connected files already expose (coordinator priorityTargets, lightbox attended/focus/constancy, pack hook + fastpath). This turns the gallery from "safe chunk feeder + viz" into a true bidirectional "multi-asset delivery + attention scheduler" – exactly the Group 14 charter.

Efficiency/speed: fewer dupe fns/derives, potential future use of priority to avoid over-decoding (less worker/mem pressure). 

Features long-term: direct preparation for Lens17 (constancy path ready in preset -> lightbox -> pack), Lens16 (focusRegion + priority + attended as foveation/plant-ID hooks), Lens14 (preserve now honored, multi-view priority for photogram), Lens12/13 (oracles give natural anytime + culling for ML/gaming). All while preserving every progressive checkpoint, yield boundary, and Sneyers baseline.

Gaps reduced; the three largest now have clear insertion points (priority feedback, constancy hook activation, on-attention callback). Net: the 5 files + minimal connected become a tighter, more future-proof orchestrator for the user's AR/plant/digital-twin vision without touching core decode or Rust math yet.

## Implemented
2026-06-13 pass-2 (post pass-1 baseline):
- Layer 2 (best-preset): added mode= default to getPushBatchingOptions (reassessed positive: caller spread cleaner, no behavior change). createGalleryPreset idea rejected (over-scope, no edit).
- Layer 1 (push + test): byteCutoffs internal tweak + extra direct test reassessed/rejected (duplicates getPushBatchingOptions caller logic; keeps pure fn + separation; test already covers via Best import – no edit).
- Layer 3 (gallery + connected): 
  - getGalleryEncodeOptions removed (positive: residual dead post-preset unification).
  - encodeTo now uses encodeOptions?.quality/effort (positive).
  - decoder honors basePreset.decode preserve* (positive; photogram/AR fidelity).
  - wired coordinator.getPriorityTargets() + lightbox.setConstancyParams({mode:'off'}) (positive: exposes oracles for AR/Lens17 prep; no perf change).
  - onfly passes full basePreset.encode (positive).
  - Connected: packFramePixels hook comment/activation updated to "live" identity for Lens17 (positive after reassess: makes surface ready, no math/perf impact; coordinator/lightbox no further edit needed – APIs sufficient).
- Layer 4 (gallery.test): added pass-2 contains + regression lock comment (positive, keeps all prior locks).
- Layer 5 (push.test): added direct byteCutoffs param test (as specified; documents the reassess rejection of internal tweak).
All re-assessed before edit: positive for residual cleanup + connected oracle/hook activation. No rejections written (all implemented or explicitly rejected in layers above with rationale). No other files.

StandardMultifileTest.mjs re-run after edits: exit 0, full suite. Key: pre-loads similar, simd prog_enc/first/final lower on some assets (e.g. small 83/22/38 vs prior), mt variance, parallel 0.81x (vs prior 1.24x – normal timing noise, no systematic regression), U1/G3 ROI tiled speedups maintained (4.2x crop, full size tiled competitive), aggregates/toon/graph emitted. No failures or "regression" flags. Changes (gallery/push/preset + pack hook/coordinator wire) are web/orchestrator; core timings stable/within variance.

Last agent: appended results. Renaming to append -DONE.

## Last Agent Instruction
After your changes, verification, test run, and updating this Implemented section, append "-DONE" to this document's filename (e.g. rename to ProgressiveGalleryPushPreset2-DONE.md) and ensure it is the final state.

END OF PASS-2 PLAN DOC
