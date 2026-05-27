Make appropriate changes to 
c:\Foo\raw-converter-wasm\docs\Overview and features of the CasaWASM JXL wrapper.md
Only if any proposals were rejected then update c:\Foo\raw-converter-wasm\docs\rejected optimizations.md
Noting the affected files where necessary.
Commit changes.
Push changes.
if outstanding work, provide a concise handoff with sufficient context for an agent to continue your tasks

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
