# Changelog

## 0.1.0

- Initial package skeleton for the libjxl WASM build pipeline.
- Added build scripts, loader, manifest plumbing, and Docker build definition.
- Fixed Docker threaded-tier path so the pinned image is toolchain-only and `--inside-docker` uses Linux Emscripten commands directly.
- Docker builds now honor the caller's Docker credential store for GHCR access.
- Added Docker Hub Emscripten image fallback for GHCR anonymous pull denial.
- Applied the Atomics CMake shim to Docker/Emscripten builds so threaded tiers can configure.
