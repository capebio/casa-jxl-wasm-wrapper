# Follow-Up Issues

Context: resampling controls were added for the CasaWASM JPEG XL encoder on 2026-05-28. The source changes expose `EncoderOptions.resampling?: 1 | 2 | 4 | 8`, forward it through the WASM and native encode paths, and add wrapper-lab controls. Some follow-up work remains blocked by local environment/build issues.

## 1. Rebuild WASM Artifacts

Status: blocked in current environment.

Command run:

```powershell
rtk npm --workspace packages/jxl-wasm run build
```

Observed failure:

```text
Docker CLI is installed, but the Docker daemon is not reachable. Start Docker Desktop/Linux engine and retry.
permission denied while trying to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine
```

Why this matters:

- `packages/jxl-wasm/src/bridge.cpp` now calls `JXL_ENC_FRAME_SETTING_RESAMPLING`.
- Generated WASM binaries in `packages/jxl-wasm/dist/*.wasm` must be rebuilt before browser/runtime validation proves the C++ bridge path works end to end.

Follow-up:

1. Start Docker Desktop/Linux engine.
2. Rerun `rtk npm --workspace packages/jxl-wasm run build`.
3. Run a browser smoke test from `web/jxl-wrapper-lab.html` with resampling factors `1`, `2`, `4`, and `8`.

## 2. Rebuild Native Addon

Status: blocked in current environment.

Command run:

```powershell
rtk npm --workspace packages/jxl-native run build
```

Observed failure:

```text
Cannot find module 'C:\Foo\raw-converter-wasm\packages\jxl-native\node_modules\node-gyp\bin\node-gyp.js'
```

Why this matters:

- `packages/jxl-native/src/native.cc` now parses `resampling` and applies `JXL_ENC_FRAME_SETTING_RESAMPLING`.
- Native binary rebuild is required before Node/N-API runtime validation.

Follow-up:

1. Restore/install `packages/jxl-native` dependencies so `node-gyp` exists locally, or update the build script to use the workspace/root `node-gyp`.
2. Rerun `rtk npm --workspace packages/jxl-native run build`.
3. Add or run a native encode/decode smoke test with `resampling: 2`.

## 3. Existing Full Facade Test Failure

Status: unrelated pre-existing test expectation failure.

Command run:

```powershell
rtk bun test packages/jxl-wasm/test/facade.test.ts
```

Observed failure:

```text
detectTier > returns scalar in Node/Bun (no cross-origin isolation)
Expected: "scalar"
Received: "simd-mt"
```

Why this matters:

- Focused resampling tests pass, but full facade suite remains red due this tier-detection expectation.
- Current Node/Bun environment exposes capabilities that make `detectTier()` return `simd-mt`.

Follow-up:

1. Decide whether Node/Bun should force scalar or allow threaded/SIMD tier detection.
2. Update test or implementation accordingly.
3. Rerun full `packages/jxl-wasm/test/facade.test.ts`.

## 4. Existing Wrapper Lab Test Failure

Status: unrelated pre-existing test/page mismatch.

Command run:

```powershell
rtk bun test web/jxl-wrapper-lab.test.js
```

Observed failure:

```text
Expected to contain: "data-mode=\"compare\""
```

Why this matters:

- Current `web/jxl-wrapper-lab.html` has `race`, `existing`, and `wrapper` mode buttons, but no `compare` button.
- Resampling UI was added successfully to the page, but this stale expectation keeps the test red.

Follow-up:

1. Decide whether `compare` mode should return or whether test should reflect current modes.
2. Update `web/jxl-wrapper-lab.test.js` or `web/jxl-wrapper-lab.html`.
3. Rerun wrapper lab tests.

## Resampling Changes To Verify After Blockers Clear

Key files:

- `packages/jxl-wasm/src/facade.ts`
- `packages/jxl-wasm/src/bridge.cpp`
- `packages/jxl-wasm/test/facade.test.ts`
- `packages/jxl-native/src/index.ts`
- `packages/jxl-native/src/native.cc`
- `web/jxl-wrapper-lab.html`
- `web/jxl-wrapper-lab.js`
- `docs/Overview and features of the CasaWASM JXL wrapper.md`
- `docs/references/PROGRESS_LOG.md`

Focused verification already passing:

```powershell
rtk npm --workspace packages/jxl-wasm run typecheck
rtk npm --workspace packages/jxl-native run typecheck
rtk npx tsc -p packages/jxl-wasm/tsconfig.json
rtk npx tsc -p packages/jxl-native/tsconfig.json
rtk bun test packages/jxl-wasm/test/facade.test.ts --test-name-pattern resampling
```

