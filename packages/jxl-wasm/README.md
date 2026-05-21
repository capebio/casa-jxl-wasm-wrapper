# @casabio/jxl-wasm

`@casabio/jxl-wasm` is the build package for the browser-side libjxl WebAssembly artifacts.
It tracks Section 6 of `casabio-jxl-wrapper-construction-spec-v2.md`.

## Pins

- libjxl commit: `332feb17d17311c748445f7ee75c4fb55cc38530`
- Emscripten SDK tag: `4.0.13`
- Docker base image: `ghcr.io/emscripten-core/emsdk:4.0.13`

## Outputs

The build produces these artifacts in `dist/`:

- `jxl-core.relaxed-simd-mt.js`
- `jxl-core.relaxed-simd-mt.wasm`
- `jxl-core.simd-mt.js`
- `jxl-core.simd-mt.wasm`
- `jxl-core.simd.js`
- `jxl-core.simd.wasm`
- `jxl-core.scalar.js`
- `jxl-core.scalar.wasm`
- `build-manifest.json`

The build manifest records:

- libjxl commit
- Emscripten version
- build flags
- file SHA-256 values
- file sizes
- PGO profile hash for `relaxed-simd-mt` when `build:pgo` is used

## Build Matrix

The matrix matches Section 6.1 of the spec.

| Tier | Threads | SIMD | Relaxed SIMD |
|---|---|---|---|
| `relaxed-simd-mt` | yes | yes | yes |
| `simd-mt` | yes | yes | no |
| `simd` | no | yes | no |
| `scalar` | no | no | no |

## Build

```bash
pnpm build
```

The default build path is Docker-first. The container:

- clones libjxl at the pinned commit
- uses the canonical Section 6.2 Emscripten flags
- emits the four build tiers
- writes `dist/build-manifest.json`

## PGO

```bash
pnpm build:pgo
```

PGO is opt-in and off by default in CI. Run it when:

- a libjxl version bump lands
- the hot-loop audit finds a regression
- a benchmark target misses by more than 10%

The PGO driver reads `jxl-test-corpus/pgo-manifest.json`, which is owned by the corpus task on the Gemini branch. Until that lands, the `build:pgo` path is blocked by that missing input.

## Loader

`src/loader.ts` implements:

- browser `compileStreaming(fetch(url))`
- IndexedDB compiled-module caching keyed by `${buildId}:${wasmSha}`
- Node compile-once-and-reuse behavior

## Current Blockers

See [`BLOCKED.md`](./BLOCKED.md).
