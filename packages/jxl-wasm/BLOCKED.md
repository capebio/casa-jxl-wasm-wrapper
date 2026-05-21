# Blocked

## 2026-05-21

- Local execution of the WASM build pipeline is blocked in this workspace because `emcc` is not installed and `docker` is not available.
- Docker CLI is installed (`29.4.3`) and Docker Desktop can run. GHCR anonymous pull for `ghcr.io/emscripten-core/emsdk:4.0.13` returned `403 Forbidden`; the build now falls back to `docker.io/emscripten/emsdk:4.0.13`.
- The PGO path is blocked until `jxl-test-corpus/pgo-manifest.json` is merged from the Gemini branch.
- Git commit creation is blocked because this workspace refuses writes to `.git/index.lock`.
- `createDecoder` / `createEncoder` now target package-local libjxl WASM bridge glue in `src/bridge.cpp`.
- Still blocked on generating the four-tier T-WASM-BUILD artifacts and wiring the remaining progressive flush events, metadata/ICC handling, rgba16/rgbaf32, and chunked region encode paths.
