# Session Handoff — 2026-06-05

## Status

**Branch:** `Grand_unification_plan_Grok` (merged into single clean head)

**Commits this session:** 4 feature + 1 benchmark

```
7e41b58 benchmark(p3): ORF→progressive JXL test, findings + optimal-settings strategy doc
94896e1 build(jxl-scheduler): rebuild dist-test with backgroundIds() and queue optimizations
3ffbb12 feat(p3.1): JXTC extraction, previewFirst, region/downsample decode + benchmark
7ffaefa feat(cache+preview): add cache policy + previewFirst + downsample constants
87e2613 feat(animation+jxtc): add animation metadata + JXTC extraction to facade
```

---

## Completed Work

### 1. P3.1 Features (all wired, tested, benchmarked)

**JXTC Extraction** (`web/jxl-decode-worker.js`)
- `extractEmbeddedJpegs()` scans container for JPEG SOI/EOI markers
- Posts `jxl_recon_jpeg` message before progressive decode
- Gated by `data.jpegReconstructionAvailable` (opt-in)
- Caveat: `transcodeJpegToJxl` v1 doesn't embed raw JPEG bytes; v2 or encode-with-recon pathways needed for real-world use

**Animation Metadata** (`packages/jxl-wasm/src/facade.ts` + worker)
- Fields added: `frameIndex`, `frameDuration`, `frameName`, `isLastFrame`, `animTicksPerSecond`, `animLoopCount`
- Forwarded in all progress/final decode events
- Worker merges them via `buildAnimMeta()` helper

**previewFirst** (DC-only at downsample=2)
- Wired in worker: `decodeProgressive()` handles `previewFirst` flag
- Emits `jxl_preview` event before main decode
- **Verdict:** 0.78–0.90× (SLOWER on 2-pass effort=3 JXL — pure overhead)
- Default: disabled in `web/main.js` `_pumpJxlQueue` (opt-in only: `next.options?.previewFirst === true`)

**Region/Downsample Decode** (both wired, both beneficial)
- Region format: `{ x, y, w, h }` (origin + size)
- Downsample: `1 | 2 | 4 | 8`
- Benchmarks:
  - Downsample=2: **2.36–2.59× speedup** → ship
  - Region center 50%: **2.25–2.72× speedup** → ship
  - Region+ds=2: **2.28–2.69× speedup**
- Implementation: passed through `_pumpJxlQueue` → worker → `createDecoder()`

### 2. Benchmarks

**p3-features-benchmark.mjs** (new)
- Processes ORFs via RAW WASM pipeline
- Encodes as progressive JXL (effort=3, quality=85, progressiveFlavor='ac')
- Tests previewFirst, downsample, region
- One-shot full-file decode (all bytes available immediately)
- Results written to `docs/Benchmark results/p3-features-benchmark-TIMESTAMP.json`

**Test data (5 ORFs, 1600px target):**
- 3–5 pass JXLs
- ~400–500KB file sizes
- ~800ms full decode time

### 3. Strategy Document

**docs/Optimal-settings.md** (new)
- Central reference for encode/decode settings decisions
- 5 test scenarios defined:
  1. Thumbnail (400px, effort=3, quality=80)
  2. Full-size (1600px, effort=3, quality=85)
  3. Effort sweep (3/5/7 comparison)
  4. Bulk galleries (10 files, batch timings)
  5. Streaming first-paint (byte-cutoff + visual quality)
- Results templates for recording timings
- Decision checkpoints for setting finalization

---

## Pending Work

### Priority 1: Streaming First-Paint Benchmark

**What:** Measure visual quality (SSIM/PSNR) at progressive byte cutoffs.

**Approach:**
1. Port `buildByteCutoffPlan()` from `progressive-byte-benchmark.mjs`
2. Push JXL in byte chunks (simulating network arrival)
3. Decode at each cutoff, measure arrival time
4. Compare decoded pixels to reference (full file) via SSIM + PSNR
5. Find "acceptable frame" threshold (e.g., SSIM > 0.9)

**Metrics to collect:**
```
| Bytes (%) | Time (ms) | SSIM | PSNR | Region Time (ms) | Region SSIM |
```

**Use:** `compute-ssim` npm package (no build changes needed)

**Owner:** Haiku can handle (SSIM wiring + benchmark runner)

**Timeline:** 30–45 min

### Priority 2: Effort Sweep (3 vs 5 vs 7)

**What:** Determine which effort level balances quality/speed for web.

**Test:** 1–2 ORFs at each effort level (1600px target)
- Encode time
- File size
- Decode: first pass arrival, total passes, final time
- Visual quality at progressive cutoffs (reuse streaming benchmark)

**Decision point:** Is effort=5 worth +200ms encode for smaller file?

**Timeline:** 20 min (reuse streaming benchmark infrastructure)

### Priority 3: Butteraugli Comparison (optional, later)

**What:** True perceptual quality metric for byte-cutoff test.

**Challenge:** Not exposed in current WASM bridge. Would require:
- Add `jxl_wasm_butteraugli_compare()` FFI binding to bridge.cpp
- Link against libjxl metrics library
- Rebuild WASM

**Recommendation:** Start with SSIM. If signal isn't clear, invoke Opus for Butteraugli bridge work.

---

## Key Files Modified

| File | Changes |
|------|---------|
| `web/jxl-decode-worker.js` | +194 lines: extractEmbeddedJpegs, buildAnimMeta, decodeProgressive (JXTC, previewFirst, region/downsample) |
| `web/main.js` | +5 lines: _pumpJxlQueue forwards previewFirst, region, downsample, frameIndex, jpegReconstructionAvailable |
| `packages/jxl-wasm/src/facade.ts` | Animation fields + CachePolicy type + DOWNSAMPLE constants |
| `benchmark/p3-features-benchmark.mjs` | New: ORF→JXL streaming test runner |
| `docs/Optimal-settings.md` | New: benchmark strategy + decision framework |
| `packages/jxl-scheduler/dist-test/` | Compiled output from queue.ts backgroundIds() + optimizations |

---

## Current Findings

### previewFirst
- **ORF progressive (2 passes):** 0.78–0.90× (slower)
- **Reason:** First progress pass arrives ~280ms; DC-only at ds=2 takes ~330ms
- **When beneficial:** Only on large 5+ pass JXLs where DC is <10% of decode time
- **Status:** Opt-in, disabled by default

### downsample=2
- **Speedup:** 2.36–2.59×
- **Use case:** Thumbnails, gallery previews
- **Status:** Ship enabled

### Region ROI
- **Speedup:** 2.25–2.72× (center 50%)
- **Use case:** Lightbox zoom, crop preview
- **Status:** Ship enabled

### JXTC Extraction
- **Feature:** SOI/EOI scan works
- **Limitation:** `transcodeJpegToJxl` v1 doesn't embed raw JPEG bytes
- **When fires:** Only on container JXLs with literal JPEG bitstream (v2 transcode or encode-with-recon)
- **Status:** Wired but low real-world value with current pipeline

---

## Next Session Checklist

- [ ] **SSIM streaming benchmark** (45 min)
  - Byte-cutoff plan
  - Streaming decode
  - SSIM + PSNR per cutoff
  - Identify "acceptable frame" threshold
- [ ] **Effort sweep** (20 min)
  - effort 3 vs 5 vs 7 on 1–2 ORFs
  - Encode time / file size / decode time trade-offs
- [ ] **Decision: optimal settings**
  - Thumbnail: effort=?, quality=?
  - Full-size: effort=?, quality=?
- [ ] **Update Optimal-settings.md** with results
- [ ] (Optional) **Butteraugli bridge** if SSIM signal unclear (Opus task)

---

## Branch Status

- Clean on `Grand_unification_plan_Grok`
- Ready to merge to `main` after:
  - SSIM streaming test complete
  - Effort sweep complete
  - Final settings documented

---

## Code Notes

**previewFirst opt-in pattern:**
```javascript
// main.js _pumpJxlQueue
postMessage({
    // ... other options
    previewFirst: next.options?.previewFirst === true,  // only if explicitly set
});
```

**Region format (IMPORTANT):**
```typescript
region: { x: number; y: number; w: number; h: number }  // origin + size
// NOT { x0, y0, x1, y1 }
```

**Animation metadata forwarding:**
```javascript
// worker buildAnimMeta()
if (ev.frameIndex !== undefined) m.frameIndex = ev.frameIndex;
if (ev.frameDuration !== undefined) m.frameDuration = ev.frameDuration;
// ... etc
```

---

## References

- `docs/Optimal-settings.md` — benchmark strategy & templates
- `docs/Benchmark results/p3-features-benchmark-*.json` — latest ORF test results
- `packages/jxl-wasm/src/facade.ts` — event types, encoder/decoder options
- `web/jxl-decode-worker.js` — full implementation of all three features
- `benchmark/progressive-byte-benchmark.mjs` — reference for byte-cutoff + streaming patterns
