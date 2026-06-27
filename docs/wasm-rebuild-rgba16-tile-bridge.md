# WASM rebuild requirement — RGBA16 JXTC tile bridge

**Status:** build-gated. Blocks the lightbox 16-bit tiled → WebGL HDR render path end-to-end.

## Problem

The modular pyramid gallery's HDR lightbox decodes a tiled level as **RGBA16** and feeds it to
the WebGL float renderer:

```
pyramid-lightbox.loadLevel (level.tiled && is16bitMode)
  → pyramid-decode.decodePyramidLevel → decodeTiledViewportPooled (pool + tiled-decode-worker)
    → facade.decodeTileContainerRegionRgba16 → _jxl_wasm_decode_tile_container_region_rgba16   ← MISSING
  → levelRaw16 → webgl-pipeline.renderRgba16AdjustedToCanvas (WebGL float texture)
```

`_jxl_wasm_decode_tile_container_region_rgba16` (and its encode counterpart) **do not exist in any
shipped WASM build**. Probed 2026-06-27 across `jxl-core.scalar`, `jxl-core.simd`, `jxl-core.enc.simd`,
`jxl-core.dec.simd`:

| symbol | present |
|---|---|
| `_jxl_wasm_encode_tile_container_rgba8` | ✅ (enc + monolithic) |
| `_jxl_wasm_decode_tile_container_region_rgba8` | ✅ (all) |
| `_jxl_wasm_encode_tile_container_rgba16` | ❌ everywhere |
| `_jxl_wasm_decode_tile_container_region_rgba16` | ❌ everywhere |

`facade.ts` already wires `encodeTileContainerRgba16` / `decodeTileContainerRegionRgba16` to these
symbols; calling them throws `CapabilityMissing: Tile container … requires a rebuilt WASM with JXTC
bridge`. `packages/jxl-pyramid/test/decode-pool.worker.integration.test.ts` even comments the gap
("the scalar test WASM may not support rgba16 … we use a dummy container + bits=16 source").

Note: `exports.txt:31` already lists `_jxl_wasm_decode_tile_container_region_rgba16` — an export entry
added in anticipation of an impl that was never written. Emscripten prunes the dangling export, which
is why the symbol is absent rather than a link error.

## Verified to work (so only the rgba16 bridge is missing)

Headless Chromium, real JXTC fixture, 2026-06-27:
- **rgba8** tiled pool + the v1-protocol `tiled-decode-worker.js` decode a real container end-to-end,
  pixel-correct (4×256² tiles, ±1 from JXTC near-lossless).
- **16-bit HDR adjust → dither → canvas (CPU path)** renders correct output; restored
  `buildColorMatrix('NONE')` identity matrix confirmed.
- WebGL GPU float path: can't confirm headless (SwiftShader float-FBO readback returns zeros); CPU
  fallback verified.

## Work required

### 1. C++ impl — `packages/jxl-wasm/src/bridge.cpp`

Mirror the existing rgba8 path (the exact template):
- `EncodeRgba8TileContainer` (line ~1617) → add **`EncodeRgba16TileContainer`**
- `DecodeRgba8TileContainerRegion` (line ~1710) → add **`DecodeRgba16TileContainerRegion`**
- the per-tile standalone helpers `EncodeStandaloneJxlTileRgba8` / `DecodeStandaloneJxlTileRgba8`
  → add **`…Rgba16`** variants
- the two extern-"C" exports at line ~3356/3362 → add `jxl_wasm_encode_tile_container_rgba16`
  and `jxl_wasm_decode_tile_container_region_rgba16`

Deltas from the rgba8 versions (all mechanical):
- **Stride:** tile stage + output are 8 bytes/px (RGBA16), not 4. `tile_stage_bytes = tile_size*tile_size*8`;
  `out_size = rw*rh*8`. `memcpy` row widths use `tw*8` / `width*…*8`.
- **Pixel format:** the standalone tile encode/decode must use `JXL_TYPE_UINT16` (the codebase already
  maps this — see `FormatToDataType` / `bits==16 → JXL_TYPE_UINT16` at bridge.cpp ~258/291) instead of
  `JXL_TYPE_UINT8`. Endianness: match the rgba8 helper's convention (`JXL_NATIVE_ENDIAN` is used for the
  regular encode; the facade reads/writes LE — confirm the standalone tile path matches `take_rgba16_le`).
- **Header:** the JXTC format already reserves flags **bit1 = 16-bit** (see `tiling.ts`); the rgba8
  encoder writes only `h32[7]=has_alpha` (bit0). The rgba16 encoder should set bit1 as well. `MakeBufferFromOwned`
  is called with `bits=16` (the rgba8 path passes `8`).
- The byte-offset index table + magic/version header layout are identical (bit-depth-agnostic).

No format/spec change — the container layout is unchanged; only the per-tile codec bit depth differs.

### 2. Export lists — `packages/jxl-wasm/`

Add the two symbols to the whitelists consumed by `scripts/build.mjs` (`-sEXPORTED_FUNCTIONS=@<file>`):
- `exports-enc.txt`: add `_jxl_wasm_encode_tile_container_rgba16` **and**
  `_jxl_wasm_decode_tile_container_region_rgba16` (the enc tier ships both currently for rgba8).
- `exports-dec.txt`: add `_jxl_wasm_decode_tile_container_region_rgba16` (decode tier — this is the one the
  lightbox actually loads at runtime).
- `exports.txt` (monolithic): the decode entry is already present (line 31); add the encode entry if the
  monolithic tier should encode.

### 3. Rebuild

Emscripten build regenerates all tiers' `dist/*.wasm` + `*.js`. Per the repo's toolchain notes
(emsdk at `C:\Users\User\emsdk`, or `docker.io/emscripten/emsdk`):

```
cmd /c "call C:\Users\User\emsdk\emsdk_env.bat >nul && node packages/jxl-wasm/scripts/build.mjs"
```

(work dir `%TEMP%\jxl-wasm-work`, not the repo `.work`, per the ACL note). No JS changes needed —
`facade.ts` already references the symbols.

### 4. Verify

- Unit: extend `packages/jxl-pyramid/test/decode-pool.worker.integration.test.ts` to encode a **real**
  rgba16 JXTC (`encodeTileContainerRgba16`) and round-trip it through the pool (today it uses a dummy
  container because the symbol was missing).
- E2E: regenerate the headless fixture as **tiled + bitsPerSample:16** and drive the modular gallery
  lightbox with the 16-bit toggle on → confirm the tiled-pool 16-bit decode feeds `levelRaw16` →
  `renderRgba16AdjustedToCanvas` (on a real-GPU/headed browser for the WebGL path; CPU path is already
  verified).

## Separate blocker (not this rebuild)

The modular gallery's full in-browser image **load** also hit a node-builtin import
(`@casabio/jxl-cache` barrel re-exporting `./node.js`) — fixed 2026-06-27 (commit 6202e2de, point the
importmap at `jxl-cache/dist/browser.js` + complete the `jxl-core` subpath entries). A further deeper
issue remains in the `jxl-session` → `jxl-worker-browser` + OPFS decode path (0 frames + an OPFS
"detached ArrayBuffer" write in headless) — tracked separately; independent of this WASM rebuild.
