# Feature Summary Handoff

Scope: remaining failed items from `docs/feature-summary.md`.

## Still Failed

* PGO (Profile-Guided Optimization): blocked until the corpus-side PGO manifest lands.
* Color Management: ORF path is covered, but DNG still uses the identity placeholder matrix.
* Region-of-Interest (ROI) Decoding: current bridge still full-decodes then crops; not true bitstream ROI.

## Fix Handoff

* PGO: wire the build to the corpus manifest task, then re-run the PGO build path and verify the produced artifacts are consumed by the tiered WASM matrix.
* Color Management: finish the DNG upstream plumbing so the DNG path receives real color-matrix data instead of the placeholder identity matrix, then re-check the lightbox and export flows.
* ROI: move the bridge from full decode + crop to a true crop-aware libjxl path if the linked version supports it; otherwise keep the fallback explicit and document the limitation in the feature summary.

## Verification

* Re-audit `docs/file-summary/_index.md` and the relevant package summaries after each fix.
* Update `docs/feature-summary.md` only when the implementation is confirmed in code, not when the design exists on paper.
