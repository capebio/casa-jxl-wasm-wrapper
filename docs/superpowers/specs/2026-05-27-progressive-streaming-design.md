# Single-Pass Progressive Streaming: JXL DC + AC Chunking

**Date:** 2026-05-27  
**Status:** Approved  
**Scope:** Streaming progressive delivery of JXL images without re-encoding

---

## Goal

Enable progressive image delivery for slow networks and thumbnail galleries using **single-pass JXL encoding**. Bitstream naturally orders coarse (DC) bytes first, then refinement (AC) bytes. Stream chunks to decoder; decoder emits progressively better frames as bytes arrive. No mathematical derivation, no re-encoding.

## Use Cases

1. **Thumbnail galleries:** Show 50+ thumbnails at low resolution (DC-only), then upgrade visible items to medium/high as bandwidth allows
2. **Slow network:** Image starts usable in <500ms (DC frame), refines as download continues
3. **Bandwidth optimization:** Send only needed fidelity level; skip refinement bytes for offscreen images
4. **Adaptive quality:** Same bitstream serves multiple quality tiers

## Non-Goals

- Multi-pass encoding (inefficient; use single progressive encode)
- Pixel-level mathematical quality degradation
- Support for non-progressive encodings (assume `progressive: true` always)
- Animated JXL (out of scope)

## Constraints

- Use standard libjxl progressive encoding (`progressiveFlavor='ac'`)
- Decode via existing `DecodeSession` API (or facade for one-shot)
- Maintain UI responsiveness during thumbnail streaming
- Chunk boundaries must align with libjxl packet structure or allow decoder resumption
- Browser and Node.js both supported (via existing worker architecture)

## Architecture

### High-Level Flow

```
Encode (once)
  └─> JXL bitstream: [header | DC | AC-1 | AC-2 | ... | AC-N | trailers]
        └─> Split into chunks
              └─> Chunk-1: DC (coarse, ~10% size)
              └─> Chunk-2: AC-1 (medium, ~25% size)
              └─> Chunk-3: AC-2 (fine, ~30% size)
              └─> Chunk-4: AC-3+ (finest, ~35% size)

Stream chunks progressively
  └─> Decoder consumes chunks as they arrive
        └─> Emit frame at each progression point
              └─> Frame-1: DC (thumbnail quality)
              └─> Frame-2: DC+AC-1 (medium quality)
              └─> Frame-3: DC+AC-1+AC-2 (high quality)
              └─> Frame-Final: full fidelity
```

### Bitstream Structure

JXL progressive encoding with `progressiveFlavor='ac'` produces:

| Component | Content | % Size | Role |
|-----------|---------|--------|------|
| **Header** | Image dimensions, color profile, tiling | ~2–5% | Always needed |
| **DC frame** | Coarse DC component (1×downsampled) | ~10–15% | Thumbnail / preview |
| **AC pass 1** | Lower-frequency AC coefficients | ~20–30% | Medium fidelity |
| **AC pass 2** | Mid-frequency AC coefficients | ~25–35% | High fidelity |
| **AC pass 3+** | Highest-frequency detail | ~20–30% | Full fidelity |
| **Trailer** | Entropy codes, checksums | ~3–8% | Validation |

**Key property:** DC bytes arrive before AC bytes. Decoder naturally emits progressively better frames as subsequent chunks are fed.

### Chunking Strategy

**Option A: Fixed Decode Levels**
- Chunk 1: header + DC → decode with `progressiveDetail='dc'`
- Chunk 2: +AC-1 → decode with `progressiveDetail='lastPasses'` (or intermediate)
- Chunk 3: +AC-2+ → decode with `progressiveDetail='passes'` (or final)
- Overhead: 3 separate decode sessions, or single session with pause/resume

**Option B: Natural Packet Boundaries**
- Use libjxl packet boundaries (VarDCT frame data is packet-structured)
- Parse/extract packet offsets from encoded bitstream
- Feed packets incrementally
- Overhead: custom bitstream parsing (low cost)

**Option C: Byte-Count Split**
- Calculate expected DC + AC-1 boundary (estimated from file size / typical encoding ratios)
- Split at known points (e.g., 12% for DC, 37% for DC+AC-1, 72% for DC+AC-2)
- Feed progressively
- Overhead: none; simple arithmetic

**Recommendation:** Option C (byte-count split). Simple, no parsing, works for typical images. Fine-tune percentages via profiling.

### Decoder Integration

**For streaming thumbnail gallery:**

```js
// 1. Encode once at desired quality
const jxlFull = await encodeImage(pixels, { 
  quality: 85, 
  progressive: true, 
  progressiveFlavor: 'ac' 
});

// 2. Calculate chunk boundaries (or parse packet offsets)
const dcBoundary = Math.ceil(jxlFull.length * 0.12);
const ac1Boundary = Math.ceil(jxlFull.length * 0.37);
const ac2Boundary = Math.ceil(jxlFull.length * 0.72);

// 3. Stream chunks to decoder
const decoder = createDecoder({ progressionTarget: 'final', emitEveryPass: true });
const frames = [];

// DC chunk (fast, shows thumbnail)
decoder.push(jxlFull.slice(0, dcBoundary));
for await (const ev of decoder.events()) {
  if (ev.type === 'progress' || ev.type === 'final') {
    frames.push(ev.pixels);
    if (ev.type === 'final') break; // DC frame ready
  }
}

// AC-1 chunk (medium detail)
decoder.push(jxlFull.slice(dcBoundary, ac1Boundary));
for await (const ev of decoder.events()) {
  if (ev.type === 'progress') frames.push(ev.pixels);
  if (ev.type === 'final') break; // Medium frame ready
}

// Continue for AC-2, final as needed
// ...
```

**For selective quality upgrade:**

```js
// Initialize with DC-only
const dcChunk = jxlFull.slice(0, dcBoundary);
decoder.push(dcChunk);
// Render thumbnail from DC frame

// User zooms / item becomes visible
// Fetch medium detail
const mediumChunk = jxlFull.slice(dcBoundary, ac1Boundary);
decoder.push(mediumChunk);
// Render refined frame
```

## Quality Tiers

Map bytes received to perceptual quality tiers for UI communication:

| Tier | Bytes | Decoder Detail | Use |
|------|-------|---|---|
| **Thumbnail** | ~10–15% (DC only) | `kDC` | Gallery list, offscreen items |
| **Preview** | ~35–40% (DC+AC-1) | `kLastPasses` | Lightbox, on-scroll visible items |
| **Full** | ~100% (all AC passes) | `kPasses` | Zoomed viewport, export |

## Integration Points

### Current Code

- `packages/jxl-wasm/src/facade.ts`: `createDecoder()` already supports `emitEveryPass`
- `packages/jxl-session/src/decode-session.ts`: Already supports `progressionTarget: 'final'`
- `web/jxl-progressive-paint.js`: Reference implementation of progressive streaming
- Chunking: New logic, can be utility function in `packages/jxl-core/src/streaming.ts`

### Changes Needed

1. **Chunk boundary calculator** (`packages/jxl-core/src/progressive-chunks.ts`):
   - Input: JXL bytes, desired tier config
   - Output: byte offsets for DC, AC-1, AC-2 boundaries
   - Use empirical percentages; parameterize for future tuning

2. **Streaming decode helper** (`packages/jxl-core/src/progressive-stream.ts`):
   - Wrapper around `DecodeSession` for chunk-based feeding
   - Emit frame events at tier boundaries
   - Manage pause/resume if decoder doesn't auto-emit per chunk

3. **Gallery integration** (UI layer):
   - Use helper to fetch DC-tier initially
   - Upgrade visible items to preview/full tiers on demand
   - Cancel refinement for offscreen items before bytes are sent

## Overhead Analysis

| Operation | Cost | Notes |
|-----------|------|-------|
| **Single encode** | 100% baseline | `progressive: true` adds ~5–10% vs. non-progressive |
| **Chunking bitstream** | <1% | Arithmetic; no parsing |
| **Decode DC only** | ~15–20% of full decode | Early termination saves work |
| **Decode DC+AC-1** | ~40–50% of full decode | Partial refinement |
| **Decode full** | 100% (same as non-progressive) | No penalty for complete streaming |
| **Total streaming path** | ~105–110% vs. one-shot | Tiny overhead; massive UX benefit |

No re-encoding. Single pass. No quality derivation math.

## Success Criteria

1. **Thumbnail tier appears in <500ms** on simulated 3G (1.6 Mbps)
2. **Gallery list remains responsive** while streaming 50+ thumbnails
3. **Visible item upgrades** from thumbnail to preview in <2s on 3G
4. **No visual artifacts** during tier transitions (frame flicker, color banding)
5. **Cancellation works:** offscreen items stop streaming mid-refinement without decoder state corruption

## Testing

### Unit Tests

- Chunk boundary calculator produces correct offsets for various image sizes
- Boundary edges align with decoder progression points (no truncation mid-packet)

### Integration Tests

- Stream DC-only → verify frame matches `progressiveDetail='dc'` decode
- Stream DC+AC-1 → verify frame matches `progressiveDetail='lastPasses'`
- Stream DC+AC-2 → verify frame matches `progressiveDetail='passes'`
- Cancel mid-AC-1 → decoder stable, next image decodes correctly
- Thumbnail + upgrade to full → no duplicated bytes, correct final frame

### Performance Tests

- Measure decode time at each tier (DC, AC-1, AC-2, full)
- Verify <500ms thumbnail on 3G latency profile
- Concurrent 50-thumbnail streaming: maintain 60fps UI

## Rollout Plan

1. Add chunk boundary calculator utility
2. Add progressive streaming decode helper
3. Update `jxl-progressive-paint.js` to use streaming chunking (proof-of-concept)
4. Add integration tests
5. Profile and tune chunk percentages on real images
6. Wire into gallery UI (selective tier upgrade on visibility)

## Decision Record

**Chosen:** Native JXL progressive bitstream (DC + AC passes) with chunked streaming.

**Rationale:**
- Bitstream naturally orders coarse→fine; no mathematical derivation needed
- Single encode; no re-encoding overhead
- Leverages existing libjxl progressive infrastructure (already working)
- Decoder naturally emits progressive frames as chunks arrive

**Rejected alternatives:**
- Quantization-based derivation (re-encodes 3–4 times)
- Residual encoding (3× encode cost, custom decoder logic)
- Coefficient truncation (complex bitstream parsing, optimization loss)

## References

- libjxl progressive decode example: https://github.com/libjxl/libjxl/blob/main/examples/decode_progressive.cc
- Current progressive paint test: `web/jxl-progressive-paint.html` (reference implementation)
- Existing progressive detail plumbing: `packages/jxl-wasm/test/progressive-detail.test.ts`