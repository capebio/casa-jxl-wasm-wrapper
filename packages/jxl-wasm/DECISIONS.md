# Decisions

## 2026-05-21

- Pinned libjxl to release tag `v0.11.2`, resolved to commit `332feb17d17311c748445f7ee75c4fb55cc38530`.
- Pinned Emscripten SDK to release tag `4.0.13`, resolved to commit `404dc1ec13f64fce1af1eaf5c007e18212f63527`.
- Chose Docker-first builds so the toolchain is reproducible and the manifest can record the exact container inputs.
- Kept the loader free of framework-specific assumptions. It uses browser `compileStreaming` when available and falls back to bytes + `WebAssembly.compile` when needed.
- Treated the PGO corpus path as externally supplied by the Gemini branch. The package documents the dependency instead of inventing a local corpus manifest.
- Aligned the published package name with the rest of the monorepo: `@casabio/jxl-wasm`.
- Do not override `DOCKER_CONFIG` during Docker builds; GHCR pulls must use the caller's existing Docker credential store.
- Use `docker.io/emscripten/emsdk:4.0.13` as fallback when GHCR denies anonymous `ghcr.io/emscripten-core/emsdk:4.0.13` pulls.

## Phase 2 build flags (size+speed)
- Bumped Emscripten to 4.0.14 (from 4.0.13) to retry full -flto at compile (P2-3). Added --closure 1 (P2-1), -sEVAL_CTORS=2 (P2-2), -mnontrapping-fptoint (P2-4) to the generator in build.mjs. Link-only flags recorded into build-manifest.tiers[*].flags. P2-5 (MINIMAL_RUNTIME=2) and P2-6 (per-module malloc) deferred/rejected per risk + "benchmark first" notes in the request. See build.mjs:56 and linkBridge for exact placement. Rebuild required to materialize deltas in dist/build-manifest.json.
