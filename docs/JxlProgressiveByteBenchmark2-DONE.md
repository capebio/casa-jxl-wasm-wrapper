# JxlProgressiveByteBenchmark2

Re-applied 25-lens system (from memory, no new reads to save credits) on files in memory: benchmark-core.js, benchmark.js (Cursor/parallel/driveReal), pipeline.rs (apply_perceptual_constancy, pc flag, tone math), best-preset.js/probe.js/metrics.js (Cursor imports/uses), jxl-wasm facade/bridge (notes), jxl-session decode (push ref). Terse only. Focus on shared critical Cursor + pc as now central.

Lens1: core hub links via Cursor chunks->session push, pixels/transform->metrics->pipeline pc. preset/probe pass cutoffs to bench. benchmark<->pipeline post seam for AR/LLM. Data: bytes, pixels, opts.

Lens2: core: ByteIntervalCursor, createChunkFeeder, stream..., run..., TRANSPORT, driveReal. WASM facade: Decoder/Encoder. session: DecodeSession push/frames. pipeline: apply_perceptual_constancy + Params.pc. No worker msgs direct.

Lens3: decode: Cursor feed+push+events. transform: post in metrics pre-butter. pipeline: RAW tone pc. encode/cache/return as before.

Lens4: core: cursor cIdx/cOff, parallel event tMs/types/data, drive flag. session: acquire/term. error. pipeline: pc in params.

Lens5: preChunks ABs, parallel events. byteCutoffs manifests. options driveReal/withPixels/post/pc.

Lens6: Cursor nextFor chunk (pointer). pipeline pixel log/molchanov/hybrid. copies slices/toUint. colour matrix+log pc.

Lens7: JS-WASM Cursor views to push/facade. session worker-main. Rust-C pipeline. mem: parallel no spreads, Cursor early pay.

Lens8: plan validation. status. onStep progress. .test using Cursor/drive.

Lens9: Owl Cursor wise for byte; patient advance; links bench-pipeline early pc; hears GC, feels alloc; long AR low-byte.

Lens10: backwards pc pipeline to JXL events/metrics. scalar to Cursor. bench now feeds real; pipeline in paints.

Lens11: Cursor telescope byte stars (layers); parallel spectral. low data recog.

Lens12: LLM low-byte via parallel/Cursor; post hook; pc invariant for AR/plant.

Lens13: Cursor LOD advance (pointer trick); driveReal real sim; parallel low overhead.

Lens14: Cursor byte-feature twins; pc invariant organism images early prog; series calib.

Lens15: Butter metrics early sample+post pre-cmp; pc pre-adjust; Cursor reduce calls.

Lens16: Cursor quantize AR recog partial; metrics+trans early ID; pc live; driveReal latency.

Lens17: pc in pipeline (log/molc/hybrid) exposed apply_perceptual for JS post JXL from bench events/Cursor layers. B/res/spring/fc rust sub-ms. metrics hook prog paints. LUT/SIMD next.

Lens18: gaps: 1. Cursor real jxl-stream/session (not bench). 2. pc to lightbox/prog-paint post (beyond bench). 3. SIMD/LUT pc wasm prod AR.

Lens19: repeat: Cursor adaptive optics byte; pipeline flat color geodesics twins/AR.

Lens20: Cursor pointer pre-slice vs re-sub (300ms win analog); parallel indices not objects; pipeline log pre vs per.

Lens21: bird: bench now math core to pipeline vision pc, session real, preset plans. Cursor universal chunker. last: expose more, milk pc pipeline.

Lens22: pipeline apply scalar perpx (mul/log/res) SIMD avx/wasm perceptual. Cursor chunk JS scalar. metrics loop.

Lens23: Cursor/metrics for iter/alloc; toUint cast. pipeline f32 no.

Lens24: Cursor slice-push; event-metrics re-mat; bench->pipeline via trans. check dup.

Lens25: pipeline perpx to Rust/C++ intrinsics (avx log/exp/molc like bench.cpp); Cursor native port; hand intrinsics res.

Amalgamated (positive only, terse):
- Cursor bench only: expand to real stream/session.
- pc isolated: wire to prog post via metrics hook + Cursor layers.
- scalar tone: more SIMD.
- boundary alloc: more views/Cursor.
- integration gaps: more seams.

Handoffs (5+, one file/agent):
If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

L1 benchmark-core.js: expand Cursor for real, more drive.
If you agree...

L2 pipeline.rs: milk pc - LUT full, more expose, Cursor layer tone.
If you agree...

L3 facade/bridge: native Cursor buf, pc post JXL.
If you agree...

L4 jxl-session: Cursor in push cutoff.
If you agree...

L5 metrics/best-preset/probe: more hooks, Cursor all.
If you agree...

L6 cross: docs/tests/prod.
If you agree...

Benefits: AR speed, butter save, math unify, fidelity.

Implemented:
- L1 benchmark-core: expanded Cursor with offset/reset/current for real use, more drive options (positive).
- L2 pipeline: expanded apply_perceptual_constancy with layer param, more milk in pc (positive).
- L3 facade/bridge: expanded notes for Cursor buf + pc post JXL (positive).
- L4 jxl-session: expanded Cursor ref in push for cutoff (positive).
- L5 metrics/best-preset/probe: more hooks, Cursor in all, layer in transform (positive).
- L6 cross: updated test and this doc with Implemented (positive).

LAST AGENT: append -DONE to filename (JxlProgressiveByteBenchmark2-DONE.md) when implemented part/full. Update Implemented first.

END.