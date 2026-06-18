# ADR: Property-based boundary tests for validateManifest

**Status:** Proposed  
**Date:** 2026-06-18  
**Finding:** logic-10 — packages/jxl-progressive/test/manifest.test.ts:1-131

## Context

`validateManifest` in `progressive-manifest.ts` is the trust boundary for manifests that arrive from untrusted network sources. It enforces:

- Structural shape (required fields, correct types)
- Numeric range constraints on saliency fields (`centerX`, `centerY`, `confidence` all in `[0, 1]`)
- Tier validity (`byteStart`/`byteEnd` are `number`, `progressionIndex` is `number | "final"`)

The current test suite has six hand-crafted cases. Several confirmed gaps (logic-3, security-2) involve edge values — `byteEnd < byteStart`, negative bytes, duplicate tier names, `NaN`, `Infinity`, saliency values just outside `[0, 1]` — that are reachable from the network but never exercised by any test.

## Decision

Add a boundary-sweep test block to `manifest.test.ts` using Node's built-in `node:test` and `node:assert` (already used in the file — no new dependencies). The sweep covers:

1. **Saliency numeric boundary values** — values exactly at `0`, `1`, just below `0` (`-0.001`), and just above `1` (`1.001`) for each of `centerX`, `centerY`, and `confidence`. The validator must accept `[0, 1]` and reject outside that range.

2. **Inverted byteStart/byteEnd** — a tier where `byteStart > byteEnd`. The current validator does not check this (confirmed gap from logic-3). Either the validator must be tightened to reject it and the test asserts a throw, or the test documents the current permissive behaviour with a `// TODO` so the gap is visible and tracked.

3. **Negative byteEnd** — a tier where `byteEnd < 0`. Same as above: validate vs. document.

4. **NaN and Infinity in numeric fields** — `typeof NaN === "number"` passes the existing type check but `NaN` is not a valid byte count. The boundary test should exercise `jxl.bytes = NaN`, `jxl.bytes = Infinity`, and `source.width = -1` to document whether those are accepted or rejected.

5. **Duplicate tier names** — two tiers with `name: "dc"`. `lookupTier` returns the first match; a duplicate is likely a manifest authoring bug. The test should document current behaviour (accepted silently).

## Consequences

### Positive

- Makes gaps visible as executable tests rather than comments. Either the test asserts a throw (if the validator is tightened in the same PR) or it asserts acceptance with a `TODO` note that is greppable for future hardening.
- No new runtime dependencies; uses the same `node:test` + `node:assert/strict` harness already in the file.
- Running cost: trivial (< 1 ms; all synchronous).

### Negative / Risks

- The "document permissive behaviour" path means some tests assert that bad inputs are *accepted*. This is intentional: it makes the current contract explicit so that any future tightening of the validator produces a deterministic, reviewable diff to those tests.
- Full property-based fuzzing (e.g. fast-check) is out of scope here. The package has no `devDependency` on a PBT library and adding one requires a separate decision. The boundary sweep described above covers the confirmed gaps without new dependencies.

## Implementation Note

The fix is a pure test addition to `manifest.test.ts`. No changes to `progressive-manifest.ts` are required unless the team decides to tighten the validator for `NaN`/`Infinity`/inverted ranges at the same time (recommended but separate PR). The ADR is the decision vehicle; the code change is a straightforward append to the `describe("validateManifest", ...)` block.
