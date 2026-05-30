# Strategic Overview: Production Readiness

Date: 2026-05-27

## Executive Read

The wrapper is close at the codec/runtime layer, but not yet production-ready as a distributable product. Core pieces exist: real libjxl WASM artifacts, tiered loader, browser and Node worker hosts, session facade, scheduling/backpressure, metadata-preserving encode, progressive decode, exact-size viewport helpers, RAW/DNG pipeline integration, cache/stream/capability packages, and a broad test set.

Main remaining work is strategic, not architectural invention:

1. Make the package graph and release process coherent.
2. Fix the verification harness until CI can prove the current state.
3. Decide what v1 honestly supports for ROI, native Node, PGO, and threaded WASM.
4. Turn docs from implementation notes into a production integration guide.

My read: if v1 ships as WASM-first with honest ROI fallback and no native guarantee, this is likely a short hardening pass away. If v1 must promise native Node acceleration, true bitstream ROI, threaded browser tiers everywhere, and PGO-optimized builds, those are still product milestones.

## What Looks Solid

- `packages/jxl-wasm` has real `dist/` artifacts for scalar, SIMD, SIMD-MT, and relaxed-SIMD-MT, with hashes and build provenance in `build-manifest.json`.
- `packages/jxl-wasm/src/facade.ts` is now a meaningful facade, not scaffolding: progressive decode, multi-format pixels, metadata encode, sidecars, viewport resizing, downsample selection, region fallback flags, metrics, cancellation, and streaming pixel input.
- `packages/jxl-wasm/src/bridge.cpp` preserves ICC/EXIF/XMP, supports progressive encoder knobs, has stateful progressive decode, region crop fallback, chunked output, sidecars, and JPEG transcode exports.
- `packages/jxl-worker-browser` and `packages/jxl-worker-node` have real session routing, cold-start buffering, shutdown, cancellation, queue caps, and error reporting.
- `packages/jxl-scheduler` has priority lanes, dedupe, worker-pool hardening, budget handling, and pause/resume preemption semantics.
- `packages/jxl-session` is the right public shape: caller-facing decode/encode sessions over a scheduler and environment-specific worker factory.
- `src/lib.rs` no longer matches some stale docs: DNG color matrix and ISO are now pulled from `raw_pipeline::dng` when present, with fallback only when metadata is absent.
- Rust source checks successfully when using an isolated target dir: `CARGO_TARGET_DIR=tmp/cargo-check-target cargo check`.

## Production Blockers

### 1. Package/Release Hygiene

Current package graph is not release-grade:

- Root `package.json` has no workspaces and no root build/test scripts.
- Several packages use `file:` dependencies plus package-local `node_modules`, which allows stale copies of `@casabio/jxl-core` and related packages to diverge.
- `@casabio/jxl-wasm` is marked `"private": true`, so it cannot be published as-is.
- Generated `dist/` output is not consistently rebuilt from source before tests. Example: `packages/jxl-capabilities/src/index.ts` exports `recommendedEffort`, but `dist/` does not, breaking `jxl-session` typecheck.
- Published/browser asset layout needs an explicit `npm pack` or fixture install test. Worker packages rely on sibling package paths resolving under `node_modules/@casabio/...`; likely correct, but must be proven from packed artifacts.

Production task: define one workspace contract, one lockfile, one root `build`, `typecheck`, `test`, `pack-test`, and `clean` command. Rebuild all `dist/` from source, remove stale package-local dependency copies, then test from packed packages.

### 2. Verification Harness Not Trustworthy Yet

Tests are numerous, but current harness is not green.

Observed this pass:

- `bun test packages/jxl-wasm/test/facade.test.ts ...` had 40 pass, 3 fail, 1 error.
- `detectTier()` returned `simd-mt` in Bun while test expected `scalar`. Source uses `SharedArrayBuffer` but not `crossOriginIsolated`; capabilities code does require cross-origin isolation for MT. Align these.
- Browser decode-handler final-only metric test missed `time_to_first_pixel_ms`.
- `packages/jxl-worker-browser/test/wasm-loader.test.ts` could not resolve `@casabio/jxl-wasm` from source.
- `npm test --prefix packages/jxl-session` fails typecheck: stale `recommendedEffort`, `sidecarSizes` with `exactOptionalPropertyTypes`, and duplicated `@casabio/jxl-core` type identity.
- `npm test --prefix packages/jxl-scheduler` references Jest, but Jest is not installed in that package.
- `npm test --prefix packages/jxl-stream` built tests, then Node test runner failed with `spawn EPERM` in this sandbox. CI needs a clean environment check.
- Direct `bun test packages/jxl-session/test ...` is the wrong runner because those tests import `node:test`.

Production task: one canonical runner per package, no mixed stale dependencies, no source-vs-dist ambiguity, and CI must run the same commands contributors run locally.

### 3. ROI Is Honest But Not True Bitstream ROI

Region decode exists, but current bridge decodes full image with downsample, then crops in C++ or JS. The facade exposes honest `regionFallback: "full-frame-then-crop"` and `getDecodeGridInfo()` returns no tile metadata.

This is acceptable for v1 if documented clearly. It is not acceptable if the product goal is deep zoom over very large JXLs with low memory and latency.

Production decision:

- v1: ship viewport helpers plus honest fallback metrics.
- v1.1+: use libjxl crop/tile APIs if available, expose grid info, and add memory/latency benchmarks proving region decode avoids full-frame decode.

### 4. Native Node Path Is Not A Production Feature Yet

`packages/jxl-native` has a real-looking N-API shape, but production requires more than source:

- Confirm host libjxl headers/libs or vendor them.
- Build prebuilt binaries for target platforms.
- Test native decode/encode and fallback behavior in CI.
- Decide metadata, region decode, progressive pass fidelity, and chunked encode parity with WASM.

If native is not in v1, docs and capabilities should say "WASM fallback in Node" rather than market native acceleration.

### 5. Threaded WASM Needs Deployment Contract

Artifacts exist for `simd-mt` and `relaxed-simd-mt`, but browser threading requires correct COOP/COEP headers and worker/WASM hosting. `detectTier()` and `getCapabilities()` should use the same rule for threaded tiers.

Production task: document required headers, asset paths, cache headers, MIME types, and fallback behavior. Add a browser integration test that loads each tier under expected isolation.

### 6. PGO Is Not Operational

Docs mention PGO; a corpus manifest exists, and build scripts exist. Production still needs:

- Real fixture corpus committed or fetched reproducibly.
- `build:pgo` run in CI/release.
- Manifest proving PGO artifacts were consumed.
- Performance comparison against non-PGO builds.

If PGO is not in v1, remove it from "done" language and call it a later optimization.

## Strategic Priority Order

1. **Freeze v1 scope.** Recommend: WASM-first, browser + Node via WASM, metadata-preserving encode/decode, progressive preview, viewport helpers, honest ROI fallback, no native guarantee, no PGO guarantee.
2. **Normalize packaging.** Add root workspaces/scripts, rebuild all packages, remove stale nested package copies, make `npm pack` or equivalent fixture install pass.
3. **Make CI green.** Typecheck every package, run correct test runner per package, run Rust check with clean target dir, run packed-artifact smoke tests.
4. **Fix capability/tier logic.** Align `detectTier()` with `getCapabilities()` around `crossOriginIsolated` and thread requirements. Ensure worker-ready never reports an unusable tier.
5. **Fix session/package type breaks.** `recommendedEffort` dist export, `sidecarSizes` exact optional type, duplicated `jxl-core` identity.
6. **Document deployment.** Headers, WASM MIME/cache, worker URLs, Node requirements, memory limits, fallback behavior, security reporting.
7. **Benchmark acceptance gates.** Keep current lab, but add repeatable CLI/browser benchmark thresholds for cold start, first pixel, final decode, encode, peak memory, and fallback ROI.
8. **Security and abuse hardening.** Fuzz malformed JXL/RAW inputs, verify dimension/pixel caps, quota behavior, OOM recovery, cancellation under load, and no unbounded worker queues.

## Suggested V1 Acceptance Criteria

- Fresh clone can run one documented command to install, build, typecheck, and test.
- Packed packages install into a separate smoke app and can:
  - create browser context,
  - create Node context,
  - encode/decode a small RGBA fixture,
  - preserve ICC/EXIF/XMP through encode path,
  - emit progressive or synthetic progress,
  - return honest ROI fallback flags,
  - shut down workers cleanly.
- Browser deployment sample serves `worker.js`, WASM tiers, and COOP/COEP headers correctly.
- CI records artifact hashes and fails if `dist/` is stale.
- Docs avoid stale claims: DNG metadata status, ROI limitation, native status, PGO status.

## Bottom Line

Wrapper core is near production. Remaining risk sits mostly in release engineering, stale generated artifacts, test runner drift, and scope honesty. Ship a WASM-first v1 with explicit ROI/native/PGO limitations, then iterate on native prebuilds and true ROI as separate milestones.
