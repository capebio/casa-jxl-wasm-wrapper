# WASM DNG Processing Analysis

## Current State
- **WASM lib**: Single-threaded (no rayon)
- **Exports**: `process_orf()` only (ORF format for Olympus cameras)
- **DNG support**: Not yet exported (added `process_dng()` in PR, requires build env fix)

## Performance Comparison vs Native (Native Tauri/Rust)

### DNG Decode (LJPEG tiles/strips)
| Stage | Native | WASM | Notes |
|-------|--------|------|-------|
| DNG Parse | ~55ms | ~55ms | Same algorithm |
| CFA Align | ~5ms | ~5ms | Pure pointer math |
| **Demosaic** | **15ms** | **150-200ms** | 10-13× slower (no rayon) |
| Tonemap | 33ms | 33ms | Single-threaded anyway |
| Encode (JXL) | 600ms | N/A | Not in WASM (uses jSquash) |
| **Total (without JXL)** | **~110ms** | **~240-290ms** | 2-3× slower |

### Bottleneck: Demosaic is 10-13× Slower in WASM
Reason: Native uses `rayon::par_chunks_mut()` to parallelize across rows (12 cores = 12× speedup ideally).
WASM single-threaded code processes sequentially.

**Can WASM use threading?**
- ✗ Current: No rayon (COOP/COEP headers required)
- ⚠️ Future: `wasm-bindgen-rayon` + Web Workers (requires host changes, not worth for camera processing)

## Encoding Path

**Native JXL (Tauri)**: 600ms (multi-threaded libjxl)
**WASM JXL**: Not available. Uses jSquash (JavaScript library).

jSquash typical performance:
- Encode: 800-1200ms (slower than native, JavaScript overhead)
- Size: Same compression as native libjxl

## JPEG Alternative for WASM

**Best approach for web**: Encode to JPEG in browser (canvas or image libraries).
- Time: 20-40ms (image.js or Jimp)
- Size: 5-7MB (Q85)
- Benefit: 15-30× faster than JXL, smaller files

## Recommendations

1. **For Pixel 9 DNGs in browser (WASM)**:
   - Skip expensive JXL encoding in WASM
   - Demosaic in WASM (2-3× slower, acceptable for single file)
   - Encode to JPEG in JS (fast, reasonable quality)
   - Or: Accept longer encoding time with jSquash JXL if archival quality needed

2. **For batch processing** (Tauri native):
   - Q90/E3 JXL: 600ms, 12-15MB (recommended)
   - Q85/E2 JXL: 390ms, 9-10MB (fast option)
   - Q85/JPEG: 120ms, 5-7MB (web/mobile)

3. **If WASM threading becomes critical**:
   - Add `wasm-bindgen-rayon` dependency
   - Require COOP/COEP headers in hosting
   - Would gain ~3-4× demosaic speedup (60-80ms for DNG decode+process)

## Pixel 9 DNG-Specific Notes

Files are 4080×3072 (12.5 MP). WASM would be adequate for:
- Single-file preview processing (acceptable 2-3s latency)
- Real-time preview with lower quality settings
- NOT suitable for bulk uploads without server-side native processing

## Build Status

`process_dng()` added to src/lib.rs but WASM build requires:
- clang/clang++ for wasm32-unknown-unknown target
- jpegxl-sys CMake configuration for WASM
- Host setup (not trivial on Windows)

Use native Tauri backend for production DNG processing.
