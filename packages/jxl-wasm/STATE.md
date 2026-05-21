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

## Next

T-NATIVE-BIND

## Decisions

- Use pinned upstream refs rather than floating tags.
- Keep the build package self-contained under `packages/jxl-wasm`.
- Keep the loader self-contained with minimal local Node/IndexedDB shims instead of adding external type packages.

## Blockers

- Toolchain execution is blocked in this workspace because `emcc` and `docker` are unavailable.
- PGO input is blocked until `jxl-test-corpus/pgo-manifest.json` lands from the Gemini branch.
- Git commit creation is blocked because this workspace refuses writes to `.git/index.lock`.
- The actual libjxl WASM codec still needs the real T-WASM-BUILD toolchain/artifact before decode/encode workers can do meaningful codec work.

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
- `packages/jxl-wasm/src/index.ts`
- `packages/jxl-wasm/src/shims.d.ts`
- `packages/jxl-wasm/tsconfig.json`
