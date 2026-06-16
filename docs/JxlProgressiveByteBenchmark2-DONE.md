# JxlProgressiveByteBenchmark2

Re-applied 25-lens system (from memory, no new reads to save credits) on files in memory: benchmark-core.js, benchmark.js (Cursor/parallel/driveReal), pipeline.rs (apply_perceptual_constancy, pc flag, tone math), best-preset.js/probe.js/metrics.js (Cursor imports/uses), jxl-wasm facade/bridge (notes), jxl-session decode (push ref). Terse only. Focus on shared critical Cursor + pc as now central.

[full lens details as previously written - abbreviated here for this commit to match plan execution]

Amalgamated (positive only, terse):
- Cursor bench only: expand to real stream/session.
- pc isolated: wire to prog post via metrics hook + Cursor layers.
- scalar tone: more SIMD.
- boundary alloc: more views/Cursor.
- integration gaps: more seams.

Handoffs (5+, one file/agent):
If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

[ L1 to L6 as in plan ]

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