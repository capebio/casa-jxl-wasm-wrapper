# Optimal Settings Strategy

Central reference for recording encode/decode timings and choosing settings for different scenarios.

## Current Findings (2026-06-05)

### ORF→JXL Progressive (5 files, 1600px long-edge, effort=3, quality=85)

| Metric | Result | Verdict |
|--------|--------|---------|
| **previewFirst** | 0.78–0.90× | ✗ DO NOT USE. Extra DC decode adds overhead vs first pass arrival |
| **downsample=2** | 2.36–2.59× speedup | ✓ SHIP. Thumbnails 2.4× faster |
| **region center 50%** | 2.25–2.72× speedup | ✓ SHIP. ROI lightbox 2.5× faster |

### ORF→JXL JXTC (5 files, transcode pathway)

- `transcodeJpegToJxl` v1 does NOT embed raw JPEG bytes
- Extraction scan (pure JS) would be <1ms if bytes were present
- Feature fires only for container JXLs with explicit JPEG bitstream (v2 or encode-with-recon pathway)

---

## Test Scenarios

### 1. Medium-Size (Thumbnail Generation)

**Goal:** Fast preview for galleries, lightbox thumbs.

**Files:** 3–5 representative ORFs, 4608×3456 px native resolution.

**Encode Settings:**
```javascript
{
  target: 400,        // px long-edge (e.g., 400×300)
  effort: 3,          // balance speed/ratio
  quality: 80,        // acceptable thumb quality
  progressive: true,
  progressiveFlavor: 'ac',
  previewFirst: false,  // disabled (adds overhead)
}
```

**Decode Settings:**
- Full: `{ downsample: 1 }`
- Optimized: `{ downsample: 2 }` → expect ~2.4× speedup
- With cache policy: `{ cachePolicy: 'onFinal' }`

**Success Criteria:**
- Thumb encode < 200ms
- Thumb decode < 100ms
- File size < 50KB per thumb

**Results Template:**
```
| File | Encode (ms) | Size (KB) | Decode Full (ms) | Decode DS2 (ms) | Speedup |
|------|-------------|----------|------------------|-----------------|---------|
|      |             |          |                  |                 |         |
```

---

### 2. Full-Size (Lightbox, Detail View)

**Goal:** Fast first-paint for full-res image view (1600–2400px).

**Files:** 3–5 ORFs at full native resolution (5240×3912).

**Encode Settings:**
```javascript
{
  target: 1600,       // px long-edge (typical lightbox)
  effort: 3,          // 400–800ms encode acceptable
  quality: 85,        // web-standard quality
  progressive: true,
  progressiveFlavor: 'ac',
  previewFirst: false,
}
```

**Decode Paths:**
- **First Paint (via region):** center 50% crop at `downsample: 1`
  - Expect ~2.5× speedup vs full
  - Time to painted pixels: ~300ms
- **Full (streaming):** progressive passes, multiple cutoffs
  - Monitor pass arrival times
- **With cache:** Benchmark `onProgress` vs `onFinal` policies

**Success Criteria:**
- First paint < 400ms (center ROI)
- Full decode < 1000ms
- File size 400–600KB

**Results Template:**
```
| File | Encode (ms) | Size (KB) | First Paint ROI (ms) | Full (ms) | Speedup |
|------|-------------|----------|----------------------|-----------|---------|
|      |             |          |                      |           |         |
```

---

### 3. Progressive Testing (Effort Sweep)

**Goal:** Measure effort vs encode time vs decode smoothness.

**Files:** 1–2 reference ORFs, 1600px target.

**Effort Levels:** 3, 5, 7

**For each:**
```javascript
{ effort, quality: 85, progressive: true, progressiveFlavor: 'ac' }
```

**Metrics:**
- Encode time
- JXL file size
- Decode: first pass arrival, total passes, final time
- Pass timing sequence (when does visual quality plateau?)

**Example Results:**
```
| Effort | Encode (ms) | Size (KB) | Passes | First Pass (ms) | Final (ms) |
|--------|-------------|----------|--------|-----------------|-----------|
| 3      | 450         | 450      | 2      | 280             | 800       |
| 5      | 650         | 420      | 3      | 250             | 900       |
| 7      | 1200        | 380      | 5      | 220             | 1100      |
```

---

### 4. Bulk Image Testing (Galleries)

**Goal:** Measure batch encode/decode for multi-image lightbox.

**Setup:**
- 10 ORFs, medium size (400px target)
- Sequential encode
- Sequential decode (simulating gallery scroll)

**Metrics:**
- Total encode time
- Total decode time
- Average per-image timings
- Peak memory usage

**Results:**
```
| Scenario | Files | Avg Encode (ms) | Avg Decode (ms) | Total Time (s) | Mem Peak (MB) |
|----------|-------|-----------------|-----------------|----------------|---------------|
| Thumb    | 10    |                 |                 |                |               |
```

---

### 5. First-Paint Optimization (Streaming)

**Goal:** Minimize perceived load time in browser.

**Approach:**
1. Encode progressive JXL (effort=3)
2. Measure byte arrival times (cumulative % of file)
3. Decode at each byte cutoff → measure visual completeness
4. Find "first acceptable frame" (e.g., 70% SSIM)

**Test Cases:**
- Full image at different bandwidths (simulated via byte cutoffs)
- Region ROI (center 50%) at same bandwidths
- With/without downsample=2 fallback

**Results Template:**
```
| Bytes (%) | Time (ms) | PSNR | Region Time (ms) | Speedup |
|-----------|-----------|------|------------------|---------|
| 25        |           |      |                  |         |
| 50        |           |      |                  |         |
| 75        |           |      |                  |         |
| 100       |           |      |                  |         |
```

---

## Decision Checkpoints

After each benchmark batch, update:

### Thumbnail Path (400px)
- [ ] Encode time acceptable (<200ms)?
- [ ] File size reasonable (<50KB)?
- [ ] Cache policy worthwhile?
- **Decision:** effort level + quality

### Full-Size Path (1600px)
- [ ] ROI first-paint fast enough (<400ms)?
- [ ] Full decode time <1000ms?
- [ ] Progressive passes visible benefit?
- **Decision:** effort level + quality + cache policy

### Progressive Detail
- [ ] Do more passes improve UX?
- [ ] Effort 3 vs 5 vs 7 trade-off?
- **Decision:** which effort to ship

---

## Implementation Checklist

- [ ] Benchmark p3 features complete (previewFirst, region, downsample)
  - [x] ORF progressive (effort=3): previewFirst disabled, region+downsample ship
  - [ ] Effort sweep (3/5/7): which is optimal?
  - [ ] Streaming byte-cutoff test
- [ ] Verify cache policies in production context
- [ ] A/B test first-paint metrics with real users
- [ ] Document final settings in README/CLAUDE.md
