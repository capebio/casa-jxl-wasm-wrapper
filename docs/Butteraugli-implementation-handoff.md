# Butteraugli Bridge Implementation — Handoff

**Date:** 2026-06-05  
**Status:** Ready to implement  
**Depends on:** SSIM/effort benchmarks complete (✓ committed b3bae1f)

## What's Complete

- ✓ Streaming SSIM benchmark (measures visual quality at byte cutoffs)
- ✓ Effort sweep benchmark (compares effort 3/5/7 tradeoffs)
- ✓ Both output JSON to `docs/Benchmark results/`

## Butteraugli Task

**Goal:** Add true perceptual quality metric (Butteraugli) to replace/supplement SSIM for byte-cutoff streaming test.

**Why:** SSIM at early cutoffs may not correlate with human perception; Butteraugli designed specifically for visual similarity in image compression contexts.

**Constraint:** Not exposed in current WASM bridge. Requires FFI work.

## Implementation Approach

### 1. Add C++ FFI binding to bridge.cpp

**File:** `packages/jxl-wasm/src/bridge.cpp`

**What to add:**
```cpp
// Around line 575 (known location for new FFI)
// Expose libjxl Butteraugli comparison
extern "C" {
  // jxl_wasm_butteraugli_compare(img1_data, img1_w, img1_h, img2_data, img2_w, img2_h)
  // Returns: float between 0.0 (identical) and 1.0+ (very different)
  // Or: distance value (0 = identical, higher = more different)
}
```

**Dependencies:**
- Link against libjxl metrics library (check CMakeLists.txt in bridge build)
- May need to add `#include <jxl/butteraugli.h>` or similar metrics header
- Forward-declare `jxl_wasm_butteraugli_compare` if not already available (pre-existing blocker noted in CLAUDE.md)

### 2. Add TypeScript facade wrapper

**File:** `packages/jxl-wasm/src/facade.ts`

**Pattern:** Follow existing encoder/decoder option pattern
- Add `ButtergauliOptions` type (if complex; may be simple distance/scale params)
- Export `computeButtergaugli(pixels1, pixels2, width, height): Promise<number>`
- Call via `Module._jxl_wasm_butteraugli_compare()` (wasm-bindgen auto-generated)

### 3. Rebuild WASM

**Command:**
```bash
cd packages/jxl-wasm
node scripts/build.mjs --host-toolchain
```

**Environment:**
- Emscripten already installed at `C:\Users\User\emsdk`
- Fallback Docker: `docker.io/emscripten/emsdk` (not ghcr.io — auth blocked)
- Build scratch dir: `%TEMP%\jxl-wasm-work` (not repo `.work` — ACL issues)

**Expected time:** 15–30 min (full libjxl metrics lib compile)

### 4. Update streaming SSIM benchmark to use Butteraugli

**File:** `benchmark/streaming-ssim-benchmark.mjs`

**Changes:**
1. Import new `computeButtergaugli()` from `packages/jxl-wasm/dist/index.js`
2. Replace or supplement `computeSsimPsnr()` with call to Butteraugli
3. Add env var: `BUTTERAUGLI_THRESHOLD` (e.g., 1.0 for "acceptable quality")
4. Output both SSIM and Butteraugli distances in JSON cutoffs
5. Update "acceptable frame" logic to check Butteraugli instead of SSIM

**API expected:**
```javascript
const distance = await computeButtergaugli(pixels1, pixels2, width, height);
// distance: 0 = identical, ~1.0 = "good enough", >2.0 = noticeable difference
```

## Key Files

| File | Purpose |
|------|---------|
| `packages/jxl-wasm/src/bridge.cpp` | Add jxl_wasm_butteraugli_compare FFI |
| `packages/jxl-wasm/src/facade.ts` | Wrap FFI in TypeScript; export computeButtergaugli() |
| `benchmark/streaming-ssim-benchmark.mjs` | Integrate Butteraugli distance measurement |
| `packages/jxl-wasm/CMakeLists.txt` | Verify metrics library linked (check existing config) |

## Known Blockers / Notes

1. **Forward-declaration issue (pre-existing):** bridge.cpp line 575 may need forward-declare for `jxl_wasm_transcode_jpeg_to_jxl` — same pattern applies to Butteraugli binding.

2. **Metrics lib availability:** Verify libjxl metrics headers/libs are available in Emscripten build. May need to:
   - Check CMakeLists.txt for `jxl_butteraugli` or similar target
   - Add explicit link if missing: `target_link_libraries(... jxl_butteraugli ...)`

3. **Rebuild time:** Full WASM rebuild ~15–30 min due to libjxl metrics compilation. Plan accordingly.

4. **Output format:** Clarify with test data:
   - Is Butteraugli distance 0–1 scale? Or unbounded?
   - What threshold value = "acceptable quality"?
   - Test with same ORF from streaming-ssim-benchmark to calibrate.

## Testing Plan

1. Rebuild WASM with new binding
2. Run streaming-ssim-benchmark with Butteraugli enabled (small limit, 800px target)
3. Compare Butteraugli distances to SSIM values at same cutoffs
4. Adjust threshold (BUTTERAUGLI_THRESHOLD env var) until cutoff results are meaningful
5. Document findings in `docs/Optimal-settings.md` or new doc

## Timeline

- FFI binding: 10 min
- WASM rebuild: 20 min
- Facade wrapper: 10 min
- Benchmark integration: 10 min
- Testing / threshold calibration: 20 min
- **Total:** ~70 min

## Next Steps (for next session)

1. Add FFI binding to bridge.cpp
2. Rebuild WASM (use Emscripten via `node scripts/build.mjs`)
3. Add facade wrapper
4. Integrate into streaming-ssim-benchmark.mjs
5. Test and calibrate thresholds
6. Commit results

---

**References:**
- libjxl Butteraugli docs: https://ds.jpeg.org/whitepapers/jpeg-xl-whitepaper.pdf (§ metrics)
- Session handoff: `docs/Session-handoff-2026-06-05.md` (Priority 3)
- CLAUDE.md: build notes, Emscripten setup, WASM patterns
