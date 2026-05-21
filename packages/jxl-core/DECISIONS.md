# jxl-core — DECISIONS.md

## D-001 format_downcast and region_fallback_full_frame in CodecMetric

Spec mentions both in Sections 8.1 and 9.1 but omits them from the Section 5 `CodecMetric` union. Added with restrictive types (`value: number` for format_downcast, `value: 1` sentinel for region_fallback). Worker implementations must emit these. If spec is revised to exclude them, remove.

## D-002 ContextOptions shape

Section 5 names `ContextOptions` in the function signatures. Sections 12 and 14 define the fields in prose. Shape derived conservatively from those sections. `poolSize`, `memoryCapBytes`, `idleTimeoutMs`, `wasmUrl`, `cache` are the only fields. No extras invented.

## D-003 MsgReleaseState in protocol

The existing `jxl-worker.js` file (pre-spec) handles `release_state`. Carried forward in `protocol.ts` to avoid breaking the live worker. If the Codex agent's worker implementation drops this, remove.

## D-004 verbatimModuleSyntax

Enforces `import type` discipline. Breaking for any import that accidentally pulls a value from this types-only package. Chosen as the more restrictive option per operating rule 1.

## D-005 exactOptionalPropertyTypes

Prevents setting optional props to `undefined` explicitly. Chose strict per operating rule 1. If downstream hits `Type 'undefined' is not assignable`, add explicit `| undefined` to the field in types.ts — that is the correct fix.

## D-006 Effort default not encoded here

Spec Section 11.3 lists effort defaults (2/4/7) but those are policy defaults, not type-level. They live in `jxl-policy`, not `jxl-core`. The type allows the full 1–9 range.
