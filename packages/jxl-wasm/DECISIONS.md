# Decisions

## 2026-05-21

- Pinned libjxl to release tag `v0.11.2`, resolved to commit `332feb17d17311c748445f7ee75c4fb55cc38530`.
- Pinned Emscripten SDK to release tag `4.0.13`, resolved to commit `404dc1ec13f64fce1af1eaf5c007e18212f63527`.
- Chose Docker-first builds so the toolchain is reproducible and the manifest can record the exact container inputs.
- Kept the loader free of framework-specific assumptions. It uses browser `compileStreaming` when available and falls back to bytes + `WebAssembly.compile` when needed.
- Treated the PGO corpus path as externally supplied by the Gemini branch. The package documents the dependency instead of inventing a local corpus manifest.
