# STATE

## Current Task

none

## Completed

- Read Sections 6, 15, 22, 27, 28.2, and the T-WASM-BUILD brief.
- Confirmed the local workspace has no `emcc`; Docker CLI is installed now, but the daemon is not running.
- Created the `jxl-wasm` package scaffold and build-facing docs.
- Aligned the package name with the worker import path: `@casabio/jxl-wasm`.
- Added `tsconfig.json`, ambient shims, and source typecheck coverage.
- Added a package-root export surface via `src/index.ts` and `package.json` `exports`.
- Declared the package as a file dependency of the browser and node worker packages.
- Added the worker-facing `createDecoder` / `createEncoder` facade contract.
- Replaced the temporary bridge with package-local libjxl WASM ABI glue in `src/facade.ts` and `src/bridge.cpp`.
- Added facade round-trip coverage and rebuilt `dist`.
- Added facade coverage for `header`, `progress`, and `final` decode events.
- Fixed the Docker T-WASM-BUILD path so the Dockerfile is a reusable pinned toolchain image instead of running a hidden build during `docker build`.
- Fixed `scripts/build.mjs --inside-docker` so Linux containers invoke `emcmake` / `em++` directly instead of Windows `cmd /c`.
- Stopped overriding `DOCKER_CONFIG` with an empty temp directory so GHCR credentials from `docker login ghcr.io` are honored.
- Added Docker Hub `emscripten/emsdk:4.0.13` fallback for GHCR anonymous pull denial, with `EMSDK_IMAGE` override for pinned custom images.
- Added an early Docker daemon check with a specific "start Docker Desktop/Linux engine" error before the GHCR pull/build path runs.
- Enabled the package-local `FindAtomics.cmake` shim inside Docker/Emscripten builds, not only host-toolchain builds.
- T-NATIVE-BIND: Added browser tier detection (relaxed-simd-mt / simd-mt / simd / scalar) to facade loadGeneratedLibjxlModule.

## Next

T-NATIVE-BIND

## Decisions

- Use pinned upstream refs rather than floating tags.
- Keep the build package self-contained under `packages/jxl-wasm`.
- Keep the loader self-contained with minimal local Node/IndexedDB shims instead of adding external type packages.
- Use package-local libjxl C++ bridge glue plus generated Emscripten artifacts, not external JS codec wrappers.

## Blockers

- Local non-Docker (`--host-toolchain`) execution now works (emcc 4.0.13 via C:\Users\User\emsdk); demonstrated 2026-06-02 with successful simd+scalar rebuild (no Docker).
- Phase 2: emscriptenTag bumped to 4.0.14 in build config + images + Dockerfile for P2-3 LTO attempt (see build.mjs and DECISIONS.md). Old 4.0.13 success remains valid history.
- PGO input is blocked until `jxl-test-corpus/pgo-manifest.json` lands from the Gemini branch.
- Git commit creation is blocked because this workspace refuses writes to `.git/index.lock`.
- Metadata/ICC extraction, rgba16/rgbaf32, chunked region encode, and the pinned four-tier build matrix still need the generated T-WASM-BUILD artifacts and a runnable Emscripten container (full MT tiers require Docker path).

## Files Touched

- `packages/jxl-wasm/package.json`
- `packages/jxl-wasm/README.md`
- `packages/jxl-wasm/CHANGELOG.md`
- `packages/jxl-wasm/DECISIONS.md`
- `packages/jxl-wasm/STATE.md`
- `packages/jxl-wasm/BLOCKED.md`
- `packages/jxl-wasm/Dockerfile`
- `packages/jxl-wasm/exports.txt`
- `packages/jxl-wasm/scripts/build.mjs`
- `packages/jxl-wasm/scripts/build-pgo.mjs`
- `packages/jxl-wasm/scripts/write-manifest.mjs`
- `packages/jxl-wasm/src/loader.ts`
- `packages/jxl-wasm/src/facade.ts`
- `packages/jxl-wasm/src/index.ts`
- `packages/jxl-wasm/src/shims.d.ts`
- `packages/jxl-wasm/tsconfig.json`
