# STATE

## Current Task

T-NATIVE-BIND

## Completed

- Added the `jxl-native` package scaffold.
- Added the native addon loader and source-build binding stub.
- Aligned the package name with the worker import path: `@casabio/jxl-native`.
- Added `tsconfig.json` and ambient shims so the package typechecks without installing `@types/node`.
- Added a package-root export surface via `package.json` `exports`.
- Declared the package as a file dependency of the node worker package.
- Added the worker-facing `createDecoder` / `createEncoder` facade contract.
- Added binding delegation through `createNativeCodecFacade()` and clean `CapabilityMissing` when the addon is absent or lacks codec functions.
- Added codec-shaped addon exports in `src/native.cc` so the native surface matches the facade contract.
- Replaced the codec-shaped C++ stub with a libjxl-backed N-API addon path for one-shot RGBA encode/decode.
- Added facade protection so a scaffold/stub addon identity cannot be treated as loaded native capability.
- Added `binding.gyp` libjxl include/library wiring via `pkg-config` or `JXL_NATIVE_INCLUDE_DIR` / `JXL_NATIVE_LIB_DIR`.

## Next

T-TEST native fixture pass once libjxl headers/libs are installed locally or prebuilds are produced.

## Decisions

- Prefer pure N-API over `node-addon-api` so the package has no extra runtime wrapper dependency.
- Keep the package self-contained with local ambient Node shims instead of adding external type packages in this workspace.

## Blockers

- Native libjxl execution requires a host libjxl install or prebuilt addon artifacts.
- Git commit creation is blocked because this workspace refuses writes to `.git/index.lock`.
- Metadata boxes, region decode, chunked encode, and full progressive pass fidelity remain follow-up native binding work.

## Files Touched

- `packages/jxl-native/package.json`
- `packages/jxl-native/README.md`
- `packages/jxl-native/CHANGELOG.md`
- `packages/jxl-native/DECISIONS.md`
- `packages/jxl-native/STATE.md`
- `packages/jxl-native/BLOCKED.md`
- `packages/jxl-native/binding.gyp`
- `packages/jxl-native/src/index.ts`
- `packages/jxl-native/src/native.cc`
- `packages/jxl-native/src/shims.d.ts`
- `packages/jxl-native/tsconfig.json`
