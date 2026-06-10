# Blocked

## 2026-05-21

- Local execution of the WASM build pipeline is blocked in this workspace because `emcc` is not installed and `docker` is not available.
- Docker CLI is installed (`29.4.3`) and Docker Desktop can run. GHCR anonymous pull for `ghcr.io/emscripten-core/emsdk:4.0.13` returned `403 Forbidden`; the build now falls back to `docker.io/emscripten/emsdk:4.0.13`.
- The PGO path is blocked until `jxl-test-corpus/pgo-manifest.json` is merged from the Gemini branch.
- Git commit creation is blocked because this workspace refuses writes to `.git/index.lock`.
- `createDecoder` / `createEncoder` now target package-local libjxl WASM bridge glue in `src/bridge.cpp`.
- Still blocked on generating the four-tier T-WASM-BUILD artifacts and wiring the remaining progressive flush events, metadata/ICC handling, rgba16/rgbaf32, and chunked region encode paths.

## 2026-06-02
- WASM rebuild (jxl-bridge) succeeded using `--host-toolchain` (local emsdk at C:\Users\User\emsdk, emcc 4.0.13) with no Docker daemon required.
- Phase 2 bump targets 4.0.14 images; prior 4.0.13 host success is the baseline for bisecting flag effects.
- Command: `cmd /c "call C:\Users\User\emsdk\emsdk_env.bat >nul && set EMSDK_QUIET=1 && cd /d C:\Foo\raw-converter-wasm && node packages\jxl-wasm\scripts\build.mjs --host-toolchain"`
- Produced updated `dist/jxl-core.simd.{js,wasm}` + `scalar` (non-MT tiers only, as designed for host-toolchain); MT tiers left from prior docker build.
- `build-manifest.json` now records `"buildMode": "host-toolchain"`, `skippedTiers: ["relaxed-simd-mt", "simd-mt"]`.
- Unblocks local iteration on the WASM bridge (facade, bridge.cpp changes) when Docker Desktop daemon is unstable or unavailable.
- Full 4-tier (incl. pthreads MT) still requires the Docker path for now.
