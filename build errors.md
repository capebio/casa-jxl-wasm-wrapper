# Build Errors

## Context

Observed while running:

```powershell
cmd /c "call C:\Users\User\emsdk\emsdk_env.bat >nul && node packages/jxl-wasm/scripts/build.mjs --host-toolchain"
```

The build got much farther than before. It now reaches real libjxl configure and partial compilation, but it still does not complete the full four-tier artifact set.

## Errors Uncovered

### 1. Old repo `.work` checkout was not writable

Initial failure:

```text
error: could not write config file C:/Foo/raw-converter-wasm/packages/jxl-wasm/.work/libjxl/.git/config: Permission denied
```

Cause:

- Build script was cloning libjxl into `packages/jxl-wasm/.work`.
- That path inherited bad ACL / lock state from previous attempts.

Fix applied:

- Build workdir moved to `%TEMP%\jxl-wasm-work`.

### 2. Docker daemon available, but GHCR image pull blocked

Failure:

```text
failed to fetch anonymous token ... ghcr.io ... 403 Forbidden
```

Cause:

- Docker build path tried to pull `ghcr.io/emscripten-core/emsdk:4.0.13`.
- This environment could not authorize that image pull.

Fix applied:

- Added `--host-toolchain` path so repo can build against local `emsdk`.

### 3. `emcmake` / `em++` wrapper resolution on Windows

Failure:

```text
Error: spawn emcmake ENOENT
```

Then:

```text
'C:\Users\User\emsdk\emcmake.bat' is not recognized ...
```

Cause:

- Emscripten wrappers live under `C:\Users\User\emsdk\upstream\emscripten\`.

Fix applied:

- Build script now resolves the full wrapper paths and invokes them through `cmd /c`.

### 4. CMake thread / atomics checks failed for host-toolchain configure

Failures included:

```text
Could NOT find Threads
Neither lock free instructions nor -latomic found.
```

and later:

```text
Highway library (hwy) not found
```

Cause:

- libjxl configure expects a full dependency tree and several CMake probes that do not line up cleanly with the Windows host build.

Fixes applied:

- Added a host-only `cmake-shims/FindAtomics.cmake`.
- Added `deps.sh` bootstrap for libjxl third-party sources.
- Moved host-toolchain build to non-thread tiers only.

### 5. `CMAKE_MODULE_PATH` needed forward slashes

Failure:

```text
Invalid character escape '\F'
```

Cause:

- Windows backslashes were passed into a CMake string context.

Fix applied:

- Build script converts module paths to forward-slash form before passing them to CMake.

### 6. Emscripten compile flags were leaking into every object compile

Failure:

```text
em++: error: exports.txt: file not found parsing argument: EXPORTED_FUNCTIONS=@exports.txt
```

Cause:

- `-sEXPORTED_FUNCTIONS=@exports.txt` was still being injected into the per-file compile command.

Fix applied:

- Removed it from compile flags and kept it for the final bridge link step only.

### 7. Bridge export list was too broad

Failure:

```text
wasm-ld: error: symbol exported via --export not found: JxlDecoderGetICCProfile
wasm-ld: error: symbol exported via --export not found: JxlEncoderFrameSettingsDestroy
wasm-ld: error: symbol exported via --export not found: JxlMemoryManagerSetCustomFunctions
wasm-ld: error: symbol exported via --export not found: JxlMemoryManagerInit
```

Cause:

- `exports.txt` was still carrying old libjxl symbols that the bridge does not call directly.

Fix applied:

- Trimmed `exports.txt` to bridge-only exports.

### 8. Build eventually timed out after partial success

Result:

```text
command timed out after 1204082 milliseconds
```

Observed state after timeout:

- `packages/jxl-wasm/dist/jxl-core.simd.js`
- `packages/jxl-wasm/dist/jxl-core.simd.wasm`
- `packages/jxl-wasm/dist/simd.size-report.txt`

Interpretation:

- Host-toolchain path is now real and partially working.
- Full four-tier build still needs more time and likely further cleanup, but the fake `icodec` path is gone.

## Next Build Moves

1. Let host-toolchain build run longer or tier-by-tier until `scalar` completes.
2. Decide whether host mode stays as a fallback or if Docker needs a mirror/base image accessible from this machine.
3. Once scalar finishes, verify `loadGeneratedLibjxlModule()` against the generated artifact set.

## 2026-05-21 Follow-Up

Latest attempt:

```powershell
rtk proxy node packages/jxl-wasm/scripts/build.mjs --host-toolchain
```

Result:

```text
error: could not write config file C:/Foo/raw-converter-wasm/buildtmp/jxl-wasm-work/libjxl/.git/config: Permission denied
fatal: could not set 'core.repositoryformatversion' to '0'
```

Interpretation:

- The next real WASM artifact cannot be generated from this workspace because the libjxl clone step cannot initialize a writable checkout.
- The generated scalar/simd outputs already exist, so the immediate follow-up is either:
  1. move the build worktree to a writable location that does not inherit the repo ACL issue, or
  2. consume the existing `dist/` outputs and continue with non-build codec work.

## Follow-On Files

- Build script: [`packages/jxl-wasm/scripts/build.mjs`](./packages/jxl-wasm/scripts/build.mjs)
- Bridge ABI: [`packages/jxl-wasm/src/bridge.cpp`](./packages/jxl-wasm/src/bridge.cpp)
- Facade behavior: [`packages/jxl-wasm/src/facade.ts`](./packages/jxl-wasm/src/facade.ts)
- WASM test coverage: [`packages/jxl-wasm/test/facade.test.ts`](./packages/jxl-wasm/test/facade.test.ts)
- Native parity stub: [`packages/jxl-native/src/native.cc`](./packages/jxl-native/src/native.cc)
- Top-level handoff: [`HANDOFF.md`](./HANDOFF.md)
