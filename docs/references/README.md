# Reference Implementations for CasaWASM JXL

This directory contains curated reference material and indices used when designing and implementing JXL features.

## Primary Reference Material

- `designs/` — Feature design notes (the main living reference content).
- `REFERENCE_INDEX.md` — Feature-by-feature mapping to source material (cjxl, jpegxl-rs, etc.).
- `REFERENCE_CODE_AUDIT.md` — Deep audits against real libjxl / jpegxl-rs usage.
- `FEATURE_IMPLEMENTATION_TEMPLATE.md` — The required process template for new features.
- `HANDOFF.md` — Current master handoff / restart document.

## Historical Artifacts

Dated handoff, completion, and action-plan documents from the 2026 agent workflow live in `historical/`.  
These are retained for traceability only. The current source of truth is `PROGRESS_LOG.md` + `FEATURE_PARITY_MATRIX.md` + the `designs/` notes.

## How This Folder Is Used

1. Start with `REFERENCE_INDEX.md` when researching an encoder/decoder option.
2. Read the relevant note in `designs/`.
3. Check status + parity in `../FEATURE_PARITY_MATRIX.md`.
4. Record progress in `PROGRESS_LOG.md`.

**Parity & Completeness:** The authoritative cross-build (WASM vs Tauri/Native) + Benchmark exposure view lives in `../FEATURE_PARITY_MATRIX.md`. All new work must update it and the Progress Log.
