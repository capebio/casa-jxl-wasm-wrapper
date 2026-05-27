# @casabio/jxl-native

`@casabio/jxl-native` is the server-side libjxl binding package for `jxl-worker-node`.
It tracks Section 15 of `casabio-jxl-wrapper-construction-spec-v2.md`.

## Pins

- libjxl commit: `332feb17d17311c748445f7ee75c4fb55cc38530`
- Node addon ABI target: N-API
- Prebuild targets:
  - Linux x64
  - Linux arm64
  - macOS x64
  - macOS arm64
  - Windows x64

## What ships here

- `binding.gyp` for source builds
- `src/native.cc` as the addon entry point, exporting `version`, `probe`, `createDecoder`, and `createEncoder`
- `src/index.ts` loader that tries prebuilt binaries first, then a source-build binary, then throws `CapabilityMissing`
- package-root `createDecoder` and `createEncoder` facade functions that delegate to a loaded libjxl-capable addon

## Loader order

1. A prebuilt binary under `prebuilds/`
2. A source-build binary under `build/Release/` or `build/Debug/`
3. `CapabilityMissing`

## Build

```bash
pnpm build
```

The addon now binds libjxl directly when the build host exposes libjxl headers and libraries.

Linux/macOS can use `pkg-config libjxl`, or explicit paths:

```bash
JXL_NATIVE_INCLUDE_DIR=/path/to/include \
JXL_NATIVE_LIB_DIR=/path/to/lib \
npm run build
```

Windows builds expect `JXL_NATIVE_INCLUDE_DIR` and `JXL_NATIVE_LIB_DIR` pointing at a libjxl install containing `jxl.lib` and `jxl_threads.lib`.

If libjxl headers are missing, the addon compiles as unavailable and `probe()` returns `loaded: false`; the JS loader rejects that binding and the caller must fall back to WASM.

## Publish

The package is set up for `prebuildify` output through `build:prebuild*` scripts, but the actual publish step stays in the integration pass.

## Current Blockers

See [`BLOCKED.md`](./BLOCKED.md).
