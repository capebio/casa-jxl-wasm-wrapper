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

## Next

T-DECODE-WASM

## Decisions

- Prefer a pure N-API C addon stub over a placeholder node-addon-api dependency until the integration pass.
- Keep the package self-contained with local ambient Node shims instead of adding external type packages in this workspace.

## Blockers

- Native compilation is not runnable here because `node-gyp`/`prebuildify` toolchain dependencies and libjxl headers are not available.
- Git commit creation is blocked because this workspace refuses writes to `.git/index.lock`.
- The facade is present, but the real `T-NATIVE-BIND` build still needs libjxl headers and the native toolchain before the addon can bind actual codec functions.

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
