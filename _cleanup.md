Make appropriate changes to 
c:\Foo\raw-converter-wasm\docs\Overview and features of the CasaWASM JXL wrapper.md
Only if any proposals were rejected then update c:\Foo\raw-converter-wasm\docs\rejected optimizations.md
Noting the affected files where necessary.
Commit changes.
Push changes.
if outstanding work, provide a concise handoff with sufficient context for an agent to continue your tasks

---

## Session handoff — 2026-05-26 (crop benchmark)

### What was done

**Crop benchmark page** (uncommitted, current branch):
- New page `web/jxl-crop-benchmark.html` + `web/jxl-crop-benchmark.js` + `web/jxl-crop-benchmark.css`
- Nav link added to all 6 existing HTML pages
- Workflow: `showDirectoryPicker()` → IDB-persisted folder handle → random ORF files → ORF→RGBA (raw WASM) → RGBA→JXL (`createEncoder`) → 5 centred crop sizes decoded via `createDecoder({ region })` → painted in log₂-scaled columns
- Overview doc updated with crop benchmark entry

### Outstanding / unresolved

- **Not yet tested** in browser — start `bun serve.ts` and open `http://localhost:9000/web/jxl-crop-benchmark.html`, pick an ORF folder, press Run
- **IDB permission restore**: if `queryPermission` returns `'prompt'` on reload, the Run button stays disabled until the user re-picks the folder (by design — browser security requires user gesture). Could improve UX by showing a "Re-connect folder" button that calls `requestPermission()` on the stored handle.
- **No rejected optimizations** this session.

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
