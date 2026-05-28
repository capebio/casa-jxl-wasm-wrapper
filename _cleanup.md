Make appropriate changes to 
c:\Foo\raw-converter-wasm\docs\Overview and features of the CasaWASM JXL wrapper.md
Only if any proposals were rejected then update c:\Foo\raw-converter-wasm\docs\rejected optimizations.md
Noting the affected files where necessary.
Commit changes.
Push changes.
if outstanding work, provide a concise handoff with sufficient context for an agent to continue your tasks

---

## Session handoff — 2026-05-28 (task 2/3 production-hygiene pass)

### What was done

**Task 2: packed-package proof as release gate**
- `tools/pack-test.mjs` now smoke-tests publishable subpaths:
  - `@casabio/jxl-worker-browser/worker`
  - `@casabio/jxl-worker-node/worker`
- Smoke app now runs worker entry points in worker-appropriate contexts:
  - browser worker imports under a stubbed `self`
  - node worker imports inside `worker_threads`
- `tools/run-workspaces.mjs` now uses one shared publishable workspace order for build/typecheck/test
- `packages/jxl-capabilities`, `packages/jxl-worker-browser`, and `packages/jxl-worker-node` now use `node --test --test-isolation=none` for the local sandbox

**Task 3: capability/tier alignment**
- Added shared threaded-WASM eligibility helper in `packages/jxl-capabilities/src/index.ts`
- Browser worker tier reporting now re-exports `detectTier` from `@casabio/jxl-capabilities`
- Node backend selection now records `wasmBuild` for WASM backends and forwards it in `worker_ready`
- Added tier tests in `packages/jxl-capabilities/test/tier.test.ts`
- Added/updated worker tests in:
  - `packages/jxl-worker-browser/test/wasm-loader.test.ts`
  - `packages/jxl-worker-node/test/backend-selector.test.ts`

### Verification

- `npm test --workspace @casabio/jxl-capabilities --if-present` PASS
- `npm test --workspace @casabio/jxl-worker-browser --if-present` PASS
- `npm test --workspace @casabio/jxl-worker-node --if-present` PASS
- `npm run typecheck` PASS
- `npm run pack-test` PASS when run through `rtk proxy pwsh`

### Remaining blocker

- `npm run build` still stalls on the Docker-backed `@casabio/jxl-wasm` build in this environment.
- Direct local Docker daemon access from the sandbox is still denied.
- `rtk proxy pwsh` can reach Docker, but the full WASM build exceeds the available timeout window here.

### Handoff

Next agent should:
- retry the root build through `rtk proxy pwsh` with a longer timeout or background wrapper
- confirm whether the Docker-backed `@casabio/jxl-wasm` build can finish in this environment
- avoid touching the generated `dist` / `dist-test` artifacts unless the source files change again

## Session handoff — 2026-05-28 (JXTC tile container)

### What was done

**Root cause diagnosis** of the previous session's "tile ROI" path:
- `encodeTiledRgba8` + `decodeTiledRegionRgba8` capped at **1.4–2× speedup** vs full-frame decode on 20+ MP images, far short of the 8×–48× claim
- libjxl 0.11.2 `JxlDecoderSetCoalescing(false) + SkipFrames` still walks every frame header
- Frame-walk overhead is per-file fixed cost — scales with total tile count, not tiles needed
- Verified empirically in `web/jxl-crop-benchmark.html`: decoding 4 tiles of 128×128 took the same time as 81 tiles of 1024×1024

**JXTC tile container** (committed `de832b7`):
- Custom container: N independent standalone JXL bitstreams + byte-offset index
- Magic `'JXTC'`, 32-byte header, 8 bytes per index entry, then N JXL files
- Decode opens fresh `JxlDecoder` per needed tile — zero frame-walk overhead
- C++ bridge: `EncodeRgba8TileContainer` / `DecodeRgba8TileContainerRegion` + standalone helpers `EncodeStandaloneJxlTileRgba8` / `DecodeStandaloneJxlTileRgba8`
- TS facade: `encodeTileContainerRgba8` / `decodeTileContainerRegionRgba8` with per-phase `onMetric` telemetry (`jxtc_input_prep`, `jxtc_malloc`, `jxtc_heap_set`, `jxtc_wasm_decode`, `jxtc_buffer_read`, `jxtc_total`)
- WASM exports added to `exports.txt`, all 4 tiers rebuilt (relaxed-simd-mt, simd-mt, simd, scalar)
- Validated speedup on 5240×3912 image: **23.1× at 128px**, 9.7× at 256px, 10.7× at 512px, 5.7× at 1024px, 2.5× at 2048px (vs the old multi-frame tile path)

**Benchmark page** (`web/jxl-crop-benchmark.js`) now decodes both paths side-by-side and logs `tile XXXms · jxtc YYYms (Zx vs tile) · full WWWms (Vx vs tile)` per crop. File-row header shows encode times and sizes for both formats.

### Outstanding / unresolved

1. **Wire JXTC into production viewer/UI.** The lightbox / progressive paint code still calls `decodeTiledRegionRgba8` (or `createDecoder({ region })`) — search for those call sites and route ROI decode through `decodeTileContainerRegionRgba8` instead. Encoder side must emit JXTC for assets that need fast ROI (lightbox tiles, lookup-table viewer). Grep starting points: `decodeTiledRegionRgba8`, `encodeTiledRgba8` outside `web/jxl-crop-benchmark.js` and the facade itself.

2. **Tile-size tuning.** Benchmark used 512px. For interactive pan/zoom in the lightbox a 256px tile would let a 128px viewport decode in ~70ms (single tile) instead of ~260ms (one 512px tile). Tradeoff: doubled tile count + slightly larger file. Recommend benchmarking 256 vs 512 against the actual lightbox viewport sizes used in production.

3. **JXTC encode speed.** Encoding a 20MP image to JXTC at distance=1.0 effort=3 took ~12s in the browser. Each tile is encoded sequentially via a fresh `JxlEncoder`. Could parallelise by either (a) emitting WASM workers that each encode a subset of tiles, or (b) reusing the encoder instance across tiles (requires libjxl multi-image-frame mode investigation). Not urgent — encode is one-shot at ingest; decode is the hot path. Currently faster than `encodeTiledRgba8` (which was 15.7s on the same image).

4. **Deprecation decision.** `encodeTiledRgba8` / `decodeTiledRegionRgba8` are now strictly worse than JXTC for ROI decode. Suggest leaving the multi-frame API in place as a fallback (still valid JXL, viewable in external viewers) but updating docs to recommend JXTC as the primary ROI path. Already done in `docs/Overview and features of the CasaWASM JXL wrapper.md` section 4.

5. **Tests.** No unit tests added for `EncodeRgba8TileContainer` / `DecodeRgba8TileContainerRegion`. Add coverage for: round-trip identity at tile boundary, region crossing 2/4/9 tiles, region exactly equal to one tile, region clamped to image edge, error 101/102 on bad magic/version, error 105 on zero-area region. Place under `packages/jxl-wasm/test/jxtc.test.ts` or similar.

6. **Multi-format support.** JXTC currently only handles RGBA8 input. For 16-bit pipelines (scientific raw at higher precision), need `encodeTileContainerRgba16` and `decodeTileContainerRegionRgba16`. Mostly mechanical — duplicate the standalone-tile helpers with `JXL_TYPE_UINT16` and parameterise the bit-depth in the header `flags` field (already has room).

7. **Worker integration.** `JxlModule.createDecoder` in `wasm-loader.ts` doesn't yet know about JXTC. If a JXTC blob arrives at a `DecodeSession`, the session-layer code currently has no way to route it through `decodeTileContainerRegionRgba8`. Options: (a) auto-detect via magic bytes in the session layer and dispatch to the right facade function, (b) add a new session type. Out of scope for this PR — JXTC is currently called as a direct facade function from app code, not via session.

### Error codes added in this session

bridge.cpp errors 90–109 are JXTC-specific:
- 90: invalid encode params (null pixels, zero dims, zero tile_size)
- 91–95: encode allocation failures (stage buf, output buf, tile encode failures)
- 100: input too small (< 32B header)
- 101: bad magic (expected 'JXTC' = 0x4354584A)
- 102: unsupported version (expected 1)
- 103: invalid header dims/tile counts
- 104: input too small for declared index
- 105: zero-area region after clamp
- 106: output buffer alloc failure
- 107: out-of-bounds tile index
- 108: tile offset/length out of input bounds
- 109: per-tile decode failure (bad bitstream)

---

## Session handoff — 2026-05-27 (tile ROI + crop benchmark)

### What was done

**Tile-based ROI encode/decode** (committed):
- C++ bridge functions: `EncodeRgba8Tiled` (450-577), `DecodeRgba8RegionTiled` (585-715)
- Facade wrappers: `encodeTiledRgba8()` (383-428), `decodeTiledRegionRgba8()` (429-464)
- WASM exports: `_jxl_wasm_encode_tiled_rgba8`, `_jxl_wasm_decode_region_tiled_rgba8`
- Multi-frame JXL encoding where each frame is a tile with crop metadata
- Decoding uses `JxlDecoderSetCoalescing(false) + SkipFrames()` to skip non-overlapping tiles
- Expected speedup: 8×–48× for small regions (128–512 px) on 20+ MP images

**Crop benchmark page** (committed):
- New pages: `web/jxl-crop-benchmark.html` (console button, inline status, tile size spinbox)
- `web/jxl-crop-benchmark.js` (tied to tile encode/decode via `encodeTiledRgba8()`, `decodeTiledRegionRgba8()`)
- `web/jxl-crop-benchmark.css` (console panel, status inline, canvas cards)
- Workflow: `showDirectoryPicker()` → IDB-persisted folder → random ORF files → ORF→RGBA (raw WASM) → RGBA→tiled JXL → 5 centred crop sizes → tile ROI decode (new path) vs full-decode baseline → speedup factor
- Log₂-scaled display columns (120–400 px) for side-by-side crop comparison

**Documentation** (committed):
- Updated `docs/Overview and features of the CasaWASM JXL wrapper.md` with new section on tile-aware ROI
- No rejected optimizations this session

### Outstanding / unresolved

- **Browser test**: Start `bun serve.ts`, open `http://localhost:9000/web/jxl-crop-benchmark.html`, pick an ORF folder, press Run — verify tile path shows 8×–48× speedup vs full-decode baseline
- **IDB permission restore**: if `queryPermission` returns `'prompt'` on reload, Run button stays disabled until user re-picks folder. Could add "Re-connect folder" button calling `requestPermission()` on stored handle.

---

## Session handoff — 2026-05-26

### What was done

**1. Feature-summary audit** (committed to `New_JXL_Features`):
- Added `[x]` to Multi-Tiered WASM Matrix and Worker WASM Build Tier Reporting (both were implemented, doc was stale)
- Fixed Color Management for DNG: stale FAILED note removed; `choose_camera_to_srgb_matrix` in `raw-pipeline/src/dng.rs` reads ForwardMatrix1/2 or inverts ColorMatrix1/2 correctly
- Changed ROI Decoding from FAILED → PARTIAL (JS-crop fallback with honest `regionFallback` flags exists)
- PGO remains FAILED (external corpus manifest not landed)

**2. `/api/jxl-crop` server endpoint** (committed to `progressive_painting`):
- File: `serve.ts`
- `GET /api/jxl-crop?file=<abs-path>&x=<int>&y=<int>&w=<int>&h=<int>[&distance=1.0][&effort=4]`
- Uses `createDecoder({ region })` → C++ full-decode + crop → `createEncoder` → returns `image/jxl`
- 50-entry in-memory LRU cache (Map insertion-order eviction)
- Spec: `docs/superpowers/specs/2026-05-26-jxl-crop-endpoint.md`

### How to test it

Start server (`bun serve.ts`), then:
```
curl "http://localhost:9000/api/jxl-crop?file=C:\path\to\file.jxl&x=100&y=100&w=500&h=400" \
  --output crop.jxl
```

The returned `crop.jxl` should decode cleanly in any JXL viewer or via the existing `DecodeSession` in the browser.

### Outstanding / unresolved

- **Coordinate system**: endpoint accepts pixel coords only. Callers using normalized [0,1] lightbox coords must convert via `normalizedToPixelExtent(norm, imageWidth, imageHeight)` (already exported from facade).
- **Remote URL support**: Option A (local path) only. When deployed to production, add a URL fetch path (Option C). Gate behind an env var or separate endpoint.
- **Memory**: server still allocates full-frame pixel buffer during decode (unavoidable without libjxl ROI API). For 100 MP images this is ~400 MB. Fine for dev; revisit for production with Tier B (TOC partial delivery).
- **No rejected optimizations**: `docs/rejected optimizations.md` not modified.

---

## Session handoff - 2026-05-28 (JXL encoder resampling)

### What was done

- Added `EncoderOptions.resampling?: 1 | 2 | 4 | 8` to the WASM and native facades.
- Forwarded resampling through WASM one-shot, metadata, sidecar, streaming, and streaming-input encode paths.
- Applied `JXL_ENC_FRAME_SETTING_RESAMPLING` in `packages/jxl-wasm/src/bridge.cpp` and `packages/jxl-native/src/native.cc`.
- Added wrapper-lab 1x/2x/4x/8x controls and wired them into `makeEncoderOptions`.
- Added facade tests for valid and invalid resampling forwarding.
- Updated the wrapper overview doc and `docs/references/PROGRESS_LOG.md`.

### Verification

- `npm --workspace packages/jxl-wasm run typecheck` PASS
- `npm --workspace packages/jxl-native run typecheck` PASS
- `npx tsc -p packages/jxl-wasm/tsconfig.json` PASS
- `npx tsc -p packages/jxl-native/tsconfig.json` PASS
- `bun test packages/jxl-wasm/test/facade.test.ts --test-name-pattern resampling` PASS

### Blocked verification

- `npm --workspace packages/jxl-wasm run build` failed because Docker daemon is not reachable: `permission denied while trying to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine`.
- `npm --workspace packages/jxl-native run build` failed because `packages/jxl-native/node_modules/node-gyp/bin/node-gyp.js` is missing.
- Full `packages/jxl-wasm/test/facade.test.ts` still has an unrelated existing tier expectation failure: expected Node/Bun tier `scalar`, received `simd-mt`.
- `web/jxl-wrapper-lab.test.js` still fails an unrelated existing expectation for `data-mode="compare"`, which is absent from the current page.

### Next steps

- Start Docker Desktop/Linux engine and rerun the WASM build.
- Install/restore `packages/jxl-native` build dependencies and rerun the native addon build.
- Run browser wrapper-lab smoke after rebuilt WASM artifacts are available.
