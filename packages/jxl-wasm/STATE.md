# STATE

## Current Task

T-WASM-BUILD

## Completed

- Read Sections 6, 15, 22, 27, 28.2, and the T-WASM-BUILD brief.
- Confirmed the local workspace has no `emcc` or `docker` binary, so the actual container build is not runnable here.
- Created the `jxl-wasm` package scaffold and build-facing docs.
- Aligned the package name with the worker import path: `@casabio/jxl-wasm`.
- Added `tsconfig.json`, ambient shims, and source typecheck coverage.
- Added a package-root export surface via `src/index.ts` and `package.json` `exports`.
- Declared the package as a file dependency of the browser and node worker packages.
- Added the worker-facing `createDecoder` / `createEncoder` facade contract.
- Replaced the temporary bridge with package-local libjxl WASM ABI glue in `src/facade.ts` and `src/bridge.cpp`.
- Added facade round-trip coverage and rebuilt `dist`.
- Added facade coverage for `header`, `progress`, and `final` decode events.

## Next

T-NATIVE-BIND

## Decisions

- Use pinned upstream refs rather than floating tags.
- Keep the build package self-contained under `packages/jxl-wasm`.
- Keep the loader self-contained with minimal local Node/IndexedDB shims instead of adding external type packages.
- Use package-local libjxl C++ bridge glue plus generated Emscripten artifacts, not external JS codec wrappers.

## Blockers

- Toolchain execution is blocked in this workspace because `emcc` and `docker` are unavailable.
- PGO input is blocked until `jxl-test-corpus/pgo-manifest.json` lands from the Gemini branch.
- Git commit creation is blocked because this workspace refuses writes to `.git/index.lock`.
- The facade now targets real libjxl ABI glue, but progressive flushes, metadata/ICC extraction, rgba16/rgbaf32, chunked region encode, and the pinned four-tier build matrix still need the generated T-WASM-BUILD artifacts and a runnable Emscripten container.
- Metadata/ICC extraction, rgba16/rgbaf32, chunked region encode, and the pinned four-tier build matrix still need the generated T-WASM-BUILD artifacts and a runnable Emscripten container.

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
