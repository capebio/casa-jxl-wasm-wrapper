# Handoff: Owl Strategic Review of jxl-preset-benchmark.html (Use-Case Optimization Sweep)

**Date:** 2026-05-31  
**Branch context at creation:** epiccodereview/20260531T005354Z (clean at start of review session)  
**Review Type:** Full Owl multi-perspective strategic review (near/far + day/night lenses)  
**Trigger:** User request for strategic examination of the page after a round of tactical UX improvements (effort controls, format switchers, multi-format copy/save with headers, RAW measurements copy button, etc.).

---

## Executive Summary (Far View)

The `jxl-preset-benchmark.html` page is the **designated browser surface** for intent #5 in the project's benchmark taxonomy: "Optimisation suite for best settings (sweeps, knee-points, preset derivation, auto-tuning)" — with the unique addition of real RAW ingest costing (bench_decode_orf + selective modes + LookRenderer timing) folded into scenario-weighted scoring.

It owns a strategically valuable, hard-to-commoditize capability (per FEATURE_PARITY_MATRIX.md and BENCHMARK_AND_TESTING_HANDOFF.md). Recent tactical patches improved visibility and basic usability.

However, structurally it is misaligned with the project's own engineering standards:
- 2100+ line monolith duplicating logic that `benchmark/option-matrix-engine.mjs` already solved cleanly and reusably.
- Export/artifact production fails the IA principles the handoff document itself set for optimization surfaces.
- The exact cross-link gap called out in the handoff ("Derived 'best preset' outputs (WASM) and thumb-pyramid rules (Tauri) are not cross-linked") remains completely open.

The page has high future value if refactored toward durable scenario cost modeling + high-quality, reproducible artifacts. Left as-is, it will become maintenance drag as base models improve at generic sweeps.

---

## Strengths (Worth Protecting / Doubling Down)

1. **Unique ownership of RAW costing in realistic use-case context** (FEATURE_PARITY_MATRIX.md rows 1,2,4 explicitly assign LookRenderer timing, `process_*_with_flags`, and `bench_decode_orf` to this page for "use-case costing (thumbnails vs 80MP vs gallery)").
2. Solid domain modeling in `SCENARIO_PROFILES` + recent integration of `rawCost` into weights for thumb/massive/gallery.
3. Good recent progress on export richness (TOON + rich `buildExportMeta` with loaded files, selected config, rawIsolation flag, provenance) and graph format differentiation.
4. The page is the only place exercising the full RAW → JXL round-trip + scenario scoring in one interactive browser session.

---

## Critical Deficiencies (Night Vision)

**From Benchmarking Methodology & Reproducibility Lens (subagent 1):**
- Full duplication of sweep/orchestration/knee/derivation logic instead of reusing `benchmark/option-matrix-engine.mjs` (the project's explicit reusable harness).
- Weak statistical hygiene and reproducibility on the exact capability the Parity Matrix highlights as this page's responsibility (RAW isolation).
- No persistent, citable artifacts — everything is ephemeral DOM + clipboard + localStorage.

**From IA / Artifact Quality & Dogfooding Lens (subagent 2):**
- Export UI is inconsistent with `jxl-progressive-paint.html` (tiny select + generic buttons vs. explicit titled CSV/JSON/TOON + Clear row).
- Violates multiple IA principles from `BENCHMARK_AND_TESTING_HANDOFF.md:70-76` (especially #4 "produce actionable artifacts" and #6 "cross-suite synthesis belongs in docs").
- Hero/intent declaration is descriptive but does not meet the handoff's explicit standard for optimization surfaces.
- RAW isolation has its own separate, weaker copy path that doesn't participate in the main export system.

**Cross-cutting:**
- The 2100-line single file is the opposite of the clean engine + thin driver pattern used in the rest of the benchmark tooling.

---

## Prioritized Recommendations

See the full Owl review for detailed rationale. Top actionable items (with rough effort/impact):

**P1 (Low effort, High impact — do immediately)**
- Unify the export UI to the proven explicit titled-button pattern from `jxl-progressive-paint.html:169-174` (CSV / JSON / TOON + Clear). Wire the already-improved `buildExportText`/`buildExportMeta`.
- Refresh the hero with a crisp one-sentence "This page exists to..." intent declaration.

**P2 (Medium effort, Very High impact)**
- Add minimal persistent artifact emission so the core deliverables (scenario recommendations + selected presets + RAW cost summary + provenance) land in `docs/outputs/preset-benchmark/` (or `benchmark/runs/`) alongside a short human-readable note. This directly closes the gap called out at `BENCHMARK_AND_TESTING_HANDOFF.md:68/89`.

**P3 (Medium effort, Highest long-term impact)**
- Refactor the sweep core to be a thin driver (or extension) over `option-matrix-engine.mjs` while keeping the RAW isolation surface as the unique first-class caller of `bench_decode_orf` + selective paths + Look timing.

**P4 (Very low effort, Medium impact — hygiene)**
- Fix RAW isolation fidelity issues (ext gating for `bench_decode_orf`, surface variance on the 3 runs, remove dead `median` helper).

All changes must update `FEATURE_PARITY_MATRIX.md` (Benchmark Exposure column) and `references/PROGRESS_LOG.md`.

---

## Key References & Evidence

- Full Owl review + two subagent lenses (delivered in session 2026-05-31)
- `docs/BENCHMARK_AND_TESTING_HANDOFF.md` (intent taxonomy, IA principles 70-76, remaining work items 89/90)
- `docs/FEATURE_PARITY_MATRIX.md` (Section 1, explicit ownership of RAW costing for this page)
- `benchmark/option-matrix-engine.mjs` (the reusable harness this page should align with)
- `web/jxl-progressive-paint.html:169-174` (export UI gold standard)
- Current page implementation: `web/jxl-preset-benchmark.js` (especially `runSweep`, `derivePresets`, `buildExport*`, `scoreRowForScenario`, RAW isolation block, graph format bar)

---

## Instructions for Next Section / Agent

1. Read this handoff completely.
2. Read the full Owl review context from the conversation if the details are not in the handoff body.
3. Start with P1 (export UI unification + hero declaration) — this is the highest signal-to-noise improvement.
4. Use `todo_write` to track the prioritized list.
5. For any non-trivial change, consider `check-work` skill before claiming completion.
6. When a discrete section (e.g., "Export UI unification") is verified, strongly consider using autoclear to spawn the next clean tab.
7. Every landing must touch the two living tracking docs (FEATURE_PARITY_MATRIX + PROGRESS_LOG).

**Tab title for any autoclear continuation of this workstream:** Use `N-PresetBenchmark-...` format (e.g., `2-ExportUIUnification`).

---

## Deferred / Out of Scope for This Handoff

- Changes to scoring logic or scenario definitions
- New JXL encoder controls or scheduler integration
- Full engine extraction (P3) — treat as a follow-on section after P1/P2 land

**Status:** This handoff captures the complete strategic assessment. The page is now ready for focused, high-leverage execution against the prioritized list.

**Handoff created by:** Grok (Owl mode + subagent lenses) on user request to "turn this into a handoff" + autoclear suggestion.