# Reference Implementations for CasaWASM JXL

This directory contains notes and extracts from mature open-source wrappers and the official libjxl tools. These serve as design and implementation references when creating feature design notes.

## Current Reference Materials

| File | Source | Purpose | Size | Notes |
|------|--------|---------|------|-------|
| `cjxl_main.cc.reference.txt` | Official libjxl `tools/cjxl_main.cc` | Best real-world usage of the full encoder option surface (progressive, modular, photon noise, brotli_effort, extra channels, container, etc.) | 726 B | Primary reference for most design notes |
| `cjxl_main.cc.note.txt` | - | Short description of the above | Tiny | - |
| `jpegxl-rs_encode.rs.note.txt` | inflation/jpegxl-rs | High-level Rust wrapper patterns + escape hatch usage | Tiny | Recommended model for Tauri side |
| `jpegxl-rs_additional.note.txt` | inflation/jpegxl-rs | Additional notes on the Rust wrapper | Tiny | - |
| `libvips_jxl_sources.note.txt` | libvips (jxlsave / jxlload) | Production C wrapper choices for what to expose | Tiny | Good negative examples (features deliberately omitted) |
| `chafey_JpegXLEncoder.hpp.note.txt` | chafey/libjxl-js | Thin Embind C++ binding | Tiny | Baseline for minimal exposure |
| `chafey_JpegXLDecoder.hpp.note.txt` | chafey/libjxl-js | Decoder side of thin binding | Tiny | - |
| `chafey_jslib.cpp.note.txt` | chafey/libjxl-js | Main JS binding glue | Tiny | - |
| `libjxl_encode_oneshot.cc.note.txt` | Official libjxl examples | Raw one-shot encode usage | Tiny | - |

## Organization Notes

- Most files in this directory are currently small notes or pointers rather than full source copies.
- The richest actual usage examples come from `cjxl_main.cc` (via the `.reference.txt` file and direct inspection during design work).
- For deeper research, the design notes in `designs/` record exactly which sections of these references were most valuable.

## How These Are Used

1. When starting a new feature design note, consult `REFERENCE_INDEX.md` first.
2. Pull relevant sections from the files above (especially `cjxl_main.cc.reference.txt` and the jpegxl-rs notes).
3. Compare approaches across the thin binding (chafey), high-level Rust (jpegxl-rs), and production C (libvips).
4. Document the synthesis in a new `designs/<feature>.md` file.

## Future Improvements

- Consider moving larger extracts into a `sources/` subdirectory if full files are ever checked in.
- Keep this README as the single source of truth for what each reference file contains.

See `REFERENCE_INDEX.md` for feature-by-feature mapping to these sources.

**Parity & Completeness:** The authoritative cross-build (WASM vs Tauri/Native) + Benchmark exposure view lives in `../FEATURE_PARITY_MATRIX.md` (docs/ root). It was extended to full coverage and is the single source of truth after the 2026-06 unification pass. All new work must update it.
