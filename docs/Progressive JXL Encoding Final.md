

```
# Single-Pass Progressive Streaming for JXL: Manifest-Derived Byte Tiers, Saliency, and Fair Gallery Refinement

**Date:** 2026-05-27  
**Status:** Design Proposal  
**Scope:** Progressive streaming delivery of JPEG XL images using single-pass encoding, manifest-derived byte tiers, optional saliency ordering, and viewport-aware fair scheduling for thumbnail galleries.

---

## Goal

Enable high-perceived-quality progressive image delivery for slow networks, dense thumbnail galleries, and lightbox-style viewers using a single canonical JPEG XL file per image.

The system should allow images to become recognisable quickly, then refine progressively as more bytes are fetched and decoded. It should avoid generating separate thumbnail pyramids where possible, avoid re-encoding per quality level, and support optional subject-focused saliency when appropriate.

The preferred runtime behaviour is:

1. Fetch enough bytes to produce an early recognisable render.
2. Decode incrementally through a long-lived decoder session.
3. Render progressive frames when the decoder reports meaningful progression.
4. Upgrade visible images fairly across the viewport rather than completing one image at a time.
5. Fetch full fidelity only for selected, zoomed, exported, or otherwise high-priority images.

The key principle is:

> Do not chunk JPEG XL by theoretical DC/AC assumptions. Chunk it by decoder-observed progression offsets.

---

## Core Idea

JPEG XL supports progressive decoding. A progressively encoded JXL codestream can emit increasingly refined images as more bytes arrive. Rather than treating the image as an all-or-nothing object, the client can feed bytes incrementally into a decoder and render intermediate frames when progression events occur.

The proposed system uses:

- **Single-pass progressive JXL encoding**
- **Optional attention-centre saliency ordering**
- **A sidecar manifest containing byte offsets for useful progression tiers**
- **HTTP range requests or equivalent chunk-aware transport**
- **Long-lived incremental decoder sessions**
- **Viewport-aware weighted round-robin scheduling across visible thumbnails**

This allows a gallery to show all visible thumbnails quickly at coarse quality, then refine them evenly, instead of spending all bandwidth and decode time perfecting one thumbnail while the rest remain blank.

---

## Non-Goals

This design does not attempt to:

- Re-encode separate quality variants for every tier.
- Depend on fixed byte percentages as the primary chunking mechanism.
- Parse the full JPEG XL codestream manually unless a robust parser is explicitly added.
- Support animated JXL in the first implementation.
- Replace compatibility fallbacks where JXL is unsupported.
- Guarantee that saliency improves every image type.
- Force all images to reach full fidelity in thumbnail-grid contexts.

---

## High-Level Architecture

The pipeline is:

```text
Source image
  ↓
Single-pass progressive JXL encode
  ↓
Optional saliency ordering
  ↓
Dry-run progressive decode / profiling pass
  ↓
Manifest generation with byte offsets for useful tiers
  ↓
Storage of .jxl + .jxl.json manifest
  ↓
Client requests manifest
  ↓
Client requests byte range for required tier
  ↓
Long-lived decoder receives incremental bytes
  ↓
Decoder emits progression events
  ↓
Renderer updates thumbnail / preview / full image
```

The important distinction is that the manifest is generated from actual decoder-observed behaviour, not from assumptions such as “10% equals DC” or “40% equals preview”.

------

## Progressive JXL Encoding

Images should be encoded once using progressive JPEG XL settings.

Example command, subject to validation against the pinned libjxl version:

```
cjxl input.png output.jxl \
  --progressive \
  --progressive_dc=2 \
  -e 7 \
  -q 85
```

If saliency is enabled and supported by the installed encoder/toolchain:

```
cjxl input.png output.jxl \
  --progressive \
  --progressive_dc=2 \
  --center_x ${CX} \
  --center_y ${CY} \
  --group_order=1 \
  -e 7 \
  -q 85
```

The exact command-line flags must be validated against the pinned version of `cjxl` used in CI. The build should include a smoke test that performs a known progressive encode and verifies that progression events are emitted during decode.

The encoder metadata should be stored in the manifest so that manifests can be invalidated when encoder settings change.

------

## Bitstream Model

For design purposes, it is useful to think of a progressive JXL as delivering coarse image information before fine detail. However, the implementation must not assume that the file can be safely split into simple contiguous logical sections such as:

```
header | DC | AC-1 | AC-2 | trailer
```

That is a mental model only.

The real implementation should treat the encoded JXL as a byte stream and discover useful progression offsets empirically. The decoder determines when enough bytes have arrived to produce a meaningful progressive image.

Therefore:

> Chunk boundaries should be derived from decoder-observed progression offsets, not from nominal DC/AC percentages.

------

## Manifest-First Chunking Strategy

The manifest is the central abstraction of this design.

Each encoded `.jxl` file should have an accompanying manifest, for example:

```
image.jxl
image.jxl.json
```

The manifest records the byte offsets at which the decoder emitted useful progression events during a profiling pass.

At runtime, the client reads the manifest and requests only the byte range required for the desired tier.

This makes the system robust across:

- Different source image dimensions
- Different image content
- Different encoder settings
- Saliency vs non-saliency encodes
- VarDCT/modular differences
- Colour profile and metadata differences
- Future encoder improvements

Fixed percentage splits may be used only as a prototype fallback when no manifest exists.

------

## Manifest Generation Algorithm

The manifest should be generated immediately after encoding.

Recommended process:

1. Encode the source image once using the chosen progressive JXL settings.
2. Open the resulting `.jxl` file.
3. Feed the file into a decoder in small byte increments, for example 8–32 KiB.
4. Whenever the decoder emits a progression event, record:
   - current byte offset,
   - progression index,
   - approximate decoded dimensions if available,
   - elapsed decode time if useful,
   - optional quality/perceptual metrics if available.
5. Select named tier boundaries from the observed progression offsets.
6. Write a `.jxl.json` manifest beside the image.
7. Store a hash of the JXL file in the manifest.
8. Treat the manifest as invalid if the JXL file changes.

The manifest is an index over one exact encoded byte stream. If the encoded file changes, the manifest must be regenerated.

------

## Example Manifest Format

```
{
  "version": 1,
  "source": {
    "width": 4000,
    "height": 3000,
    "hasAlpha": false,
    "orientation": 1
  },
  "jxl": {
    "bytes": 1843921,
    "sha256": "..."
  },
  "encoder": {
    "name": "cjxl",
    "libjxlVersion": "pinned-version",
    "flags": [
      "--progressive",
      "--progressive_dc=2",
      "-e",
      "7",
      "-q",
      "85"
    ]
  },
  "saliency": {
    "enabled": true,
    "centerX": 0.47,
    "centerY": 0.39,
    "confidence": 0.82,
    "method": "attention-center"
  },
  "tiers": [
    {
      "name": "dc",
      "byteStart": 0,
      "byteEnd": 156320,
      "progressionIndex": 1,
      "intendedUse": "thumbnail"
    },
    {
      "name": "preview",
      "byteStart": 0,
      "byteEnd": 642112,
      "progressionIndex": 3,
      "intendedUse": "visible-card"
    },
    {
      "name": "full",
      "byteStart": 0,
      "byteEnd": 1843921,
      "progressionIndex": "final",
      "intendedUse": "zoom-export"
    }
  ]
}
```

`centerX` and `centerY` should preferably be normalised values from `0` to `1`, not raw pixels, unless the entire pipeline strictly preserves the original coordinate space.

------

## Quality Tiers

The system should use semantic tiers rather than hardcoded byte percentages.

Recommended tiers:

| Tier      | Purpose                      | Byte Selection                                     |
| --------- | ---------------------------- | -------------------------------------------------- |
| `dc`      | First recognisable thumbnail | Manifest-derived first useful progression offset   |
| `preview` | Good visible-card quality    | Manifest-derived medium-quality progression offset |
| `full`    | Final full-fidelity image    | Complete file                                      |

Percentage values should be treated as profiling outputs, not as primary inputs.

For example, a given corpus may show that DC usually appears around 10–20% of file size, but the runtime should not depend on that being true.

------

## Transport Requirements

Progressive decoding alone improves perceived rendering, but bandwidth savings require range-aware delivery.

The client must be able to request only the bytes needed for a given tier.

Supported transport strategies:

1. **HTTP Range requests** against the canonical `.jxl` file.
2. **Pre-split tier blobs** stored alongside the JXL.
3. **Service-worker or cache-layer mapping** from tier requests to byte ranges.
4. **Custom object-store range fetches** if the storage backend supports them.

Without range or chunk-aware transport, the browser may still download the entire file, in which case progressive decoding improves perceived speed but not bandwidth consumption.

------

## Decoder Integration

The client should use one long-lived decoder session per actively displayed image.

The decoder should:

1. Receive bytes incrementally.
2. Preserve unconsumed input correctly.
3. Process input until it needs more bytes or emits a progression event.
4. Flush/render only when a meaningful progressive frame is available.
5. Avoid excessive redraws by debouncing rendering to animation frames.
6. Release resources promptly on cancellation.

Conceptual JavaScript API:

```
const decoder = createDecoder({
  emitEveryPass: true,
  progressiveDetail: 'final'
});

await decoder.push(firstTierBytes);

decoder.on('progress', frame => {
  renderThumbnail(frame);
});

await decoder.push(previewTierBytes);

decoder.on('progress', frame => {
  renderPreview(frame);
});
```

The wrapper should hide low-level decoder details, but internally it must handle:

- Incremental input
- Unconsumed input
- Decoder progression events
- Flush behaviour
- Cancellation
- Backpressure
- Memory limits
- WASM instance limits

------

## Decoder Lifecycle Rules

Recommended rules:

- One `DecodeSession` per actively displayed image.
- Cap the number of active decoders.
- Queue lower-priority images rather than creating unlimited sessions.
- Retain downloaded byte ranges in cache when useful.
- Flush only on progression events.
- Render on animation frames to avoid layout thrashing.
- Cancel or pause offscreen refinement.
- Keep decoded preview bitmaps where useful for fast return to recently viewed thumbnails.
- Fully release sessions for images that are far outside the viewport.

When an image leaves the viewport, the scheduler should decide whether to:

1. Keep its current decoded bitmap.
2. Retain its downloaded bytes but close the decoder.
3. Keep the decoder warm for a short grace period.
4. Abort and discard all transient state.

The right choice depends on memory pressure and scroll behaviour.

------

## Fair Progressive Refinement

For galleries, progressive loading should be scheduled across the visible image set rather than completing one image at a time.

A greedy strategy loads:

```
Image A: DC → Preview → Full
Image B: DC → Preview → Full
Image C: DC → Preview → Full
```

This can produce poor perceived performance because one image may become excellent while neighbouring images remain blank.

The preferred method is:

> Viewport-aware weighted round-robin progressive refinement.

This means the scheduler advances each visible image by one progressive quantum or manifest tier in turn.

A fair strategy loads:

```
Image A: DC
Image B: DC
Image C: DC

Image A: Preview
Image B: Preview
Image C: Preview

Image A: Full, if needed
Image B: Full, if needed
Image C: Full, if needed
```

This ensures that the whole visible viewport becomes recognisable early, then improves together.

------

## Progressive Quantum

A progressive quantum is the smallest useful unit of advancement for an image.

It may be:

- The next manifest tier,
- the next decoder-observed progression boundary,
- or a bounded byte range when no manifest exists.

The system should avoid describing this as “10% of the image” except as a rough fallback. A 10% byte range may or may not correspond to a meaningful visual improvement.

Preferred wording:

> Advance each visible thumbnail by one progressive quantum, normally the next manifest-derived tier.

------

## Viewport-Aware Weighted Round-Robin Scheduling

The scheduler should maintain a queue of visible and near-visible images.

Each image has:

- current tier,
- target tier,
- visibility state,
- priority,
- last service time,
- bytes already fetched,
- decoder state,
- memory cost.

Priority should be assigned roughly as:

1. Selected lightbox image
2. Image under pointer or keyboard focus
3. Images fully visible in viewport
4. Images partially visible in viewport
5. Images near viewport
6. Recently visible images
7. Offscreen images

The scheduler then advances jobs fairly, ensuring no single image monopolises bandwidth or decode time.

------

## Example Scheduler Model

```
type Tier = 'none' | 'dc' | 'preview' | 'full';

interface ProgressiveImageJob {
  id: string;
  visible: boolean;
  nearViewport: boolean;
  selected: boolean;
  currentTier: Tier;
  targetTier: Tier;
  priority: number;
  lastServedAt: number;
  bytesLoaded: number;
  byteBudget?: number;
}

function tierRank(tier: Tier): number {
  switch (tier) {
    case 'none': return 0;
    case 'dc': return 1;
    case 'preview': return 2;
    case 'full': return 3;
  }
}

function needsWork(job: ProgressiveImageJob): boolean {
  return tierRank(job.currentTier) < tierRank(job.targetTier);
}

function fairnessScore(job: ProgressiveImageJob, now: number): number {
  const starvationBonus = Math.min((now - job.lastServedAt) / 1000, 5);
  const underRefinedBonus = 3 - tierRank(job.currentTier);

  return job.priority + starvationBonus + underRefinedBonus;
}

function scheduleNextJob(jobs: ProgressiveImageJob[], now: number) {
  return jobs
    .filter(job => job.visible || job.nearViewport || job.selected)
    .filter(needsWork)
    .sort((a, b) => fairnessScore(b, now) - fairnessScore(a, now))[0];
}
```

This is not intended as final production code, but it expresses the scheduling policy: prioritise important images, but include a starvation bonus so that lower-priority visible thumbnails still progress.

------

## Gallery Runtime Policy

Default gallery behaviour:

1. Use `IntersectionObserver` to identify visible and near-visible images.
2. Request the manifest for each visible image.
3. Load `dc` tier for all visible thumbnails first.
4. Once all visible thumbnails have reached `dc`, upgrade them fairly to `preview`.
5. Do not fetch `full` for ordinary thumbnails.
6. Fetch `full` only for selected, zoomed, exported, or lightbox images.
7. Cancel or pause refinement for images that leave the viewport.
8. Resume from cached byte ranges if the image returns to the viewport.

This gives the user a filled, recognisable viewport as quickly as possible.

------

## Saliency Integration

Saliency is an optional enhancement, not a requirement.

When enabled, the encoder can use an attention centre so that important regions receive earlier refinement. This may improve perceived quality for portraits, products, single flowers, insects, or other subject-focused images.

However, saliency is not universally beneficial.

It may be weak or counterproductive for:

- landscapes,
- herbarium sheets,
- botanical plates,
- microscopy images,
- maps,
- habitat shots,
- images with multiple important subjects,
- diagnostic botanical images where peripheral details matter.

Recommended policy:

> Use attention-centre saliency only when a focal subject is confidently detected or manually supplied. Disable saliency when diagnostic detail is spatially distributed.

The manifest should record whether saliency was used and what centre was applied.

------

## Saliency Fallback Rules

Use this policy:

1. If a high-confidence subject centre exists, encode with saliency.
2. If multiple important centres exist and the toolchain supports multiple centres, use them.
3. If multiple centres exist but only one centre is supported, either choose the most important one or disable saliency.
4. If confidence is low, disable saliency.
5. If the image type is map, plate, herbarium, microscopy, or multi-subject diagnostic image, disable saliency by default.
6. Allow manual override in specialist workflows.

For Casabio-style biodiversity imagery, saliency should be treated carefully. A macro photograph of a flower may benefit. A whole-plant record shot or habitat image may not.

------

## Cache Strategy

Cache by content hash, not URL alone.

Recommended cached objects:

- Manifest JSON
- JXL byte ranges by tier
- Complete JXL file, if downloaded
- Decoded DC bitmap, where useful
- Decoded preview bitmap, where useful

The manifest should include a hash of the encoded JXL file. If the hash does not match, the manifest is stale and must not be used.

Invalidation rules:

- Re-encoding invalidates the manifest.
- Encoder-setting changes invalidate the manifest.
- Saliency changes invalidate the manifest.
- Source-image changes invalidate the JXL and manifest.
- Manifest version changes may require migration or regeneration.

------

## Memory and Concurrency

Dense galleries can easily produce excessive memory pressure if each image owns a decoder, buffers, and decoded bitmap.

The implementation should impose hard limits:

- Maximum active decoders
- Maximum concurrent range requests
- Maximum decoded bitmap memory
- Maximum pending queued jobs
- Maximum retained offscreen decoded previews

When limits are reached:

1. Keep selected/lightbox image resources.
2. Keep visible thumbnails.
3. Keep near-viewport thumbnails.
4. Drop far-offscreen decoders.
5. Retain byte cache if economical.
6. Drop decoded bitmaps before dropping manifests.

------

## Failure Modes

### No progression events emitted

Possible causes:

- Encoder flags did not produce a progressive file.
- Decoder wrapper is not requesting progressive output correctly.
- Unsupported libjxl behaviour.
- Bug in incremental input handling.

Fallback:

- Decode full image.
- Regenerate with verified progressive settings.
- Flag the image in diagnostics.

### Manifest missing

Fallback:

- Request conservative initial byte range.
- Attempt progressive decode.
- If useful events occur, generate manifest server-side later.
- Otherwise fetch full file.

### Manifest stale

Fallback:

- Ignore manifest.
- Fetch full file or regenerate manifest.
- Log hash mismatch.

### Range requests unsupported

Fallback:

- Download full JXL.
- Still render progressively as bytes arrive if streaming is available.
- Mark bandwidth optimisation unavailable for that backend.

### Saliency confidence low

Fallback:

- Encode without saliency.

### Image leaves viewport mid-decode

Fallback:

- Cancel or pause the job.
- Retain already fetched bytes if useful.
- Release decoder if memory pressure is high.

### Too many active images

Fallback:

- Apply scheduler limits.
- Prioritise visible and selected images.
- Delay preview/full upgrades.

------

## Performance Expectations

This system should be evaluated against a representative image corpus.

Useful metrics:

- Time to first recognisable render
- Time to all visible thumbnails recognisable
- Time to preview quality for visible images
- Bytes fetched per thumbnail
- Bytes saved versus full-image loading
- Decode CPU time
- WASM memory use
- Main-thread blocking time
- Scroll smoothness
- Cancellation latency
- Cache hit rate
- User-perceived gallery readiness

Avoid absolute claims such as “thumbnail tier in under 500ms on 3G” unless tied to a defined test corpus and simulated network profile.

Better success criterion:

> For the target image corpus and network profile, all initially visible thumbnails should reach first recognisable render within the defined UX budget.

------

## Testing Plan

### Unit Tests

- Manifest schema validation
- Tier selection logic
- Hash mismatch detection
- Scheduler fairness
- Priority calculation
- Cache invalidation
- Range calculation
- Missing manifest fallback

### Integration Tests

- Encode → manifest → range fetch → progressive decode
- DC → preview → full transition
- Cancellation during fetch
- Cancellation during decode
- Resume from cached byte range
- Multiple visible thumbnails
- Selected image priority boost
- Range unsupported fallback
- Saliency and non-saliency variants

### Performance Tests

- 10-thumbnail viewport
- 50-thumbnail gallery
- 100-thumbnail stress case
- Fast scroll cancellation
- Slow network simulation
- High-latency network simulation
- Low-memory device simulation
- WASM decoder concurrency limits

### Perceptual Tests

- Compare DC/preview/full tiers visually
- Record Butteraugli or similar metrics if useful
- Measure subject recognisability with and without saliency
- Test botanical macro images separately from landscape/habitat images
- Test maps/plates/herbarium sheets with saliency disabled

------

## Suggested Components

### `progressive-manifest.ts`

Responsible for:

- Manifest schema
- Manifest validation
- Tier lookup
- Hash validation
- Version migration if needed

### `progressive-profile.ts`

Responsible for:

- Dry-run decode
- Recording progression byte offsets
- Choosing tier boundaries
- Writing manifest JSON

### `progressive-stream.ts`

Responsible for:

- Range requests
- Feeding decoder incrementally
- Managing unconsumed bytes
- Emitting progressive frames
- Handling cancellation

### `progressive-scheduler.ts`

Responsible for:

- Viewport-aware queueing
- Weighted round-robin advancement
- Priority boosts
- Fairness/starvation control
- Concurrency limits

### `progressive-cache.ts`

Responsible for:

- Manifest cache
- Byte-range cache
- Decoded bitmap cache
- Hash-based invalidation

### `saliency-policy.ts`

Responsible for:

- Deciding whether saliency should be used
- Normalising centre coordinates
- Recording saliency metadata
- Handling low-confidence fallback

------

## Rollout Plan

### Phase 1: Progressive Encode and Decode Proof of Concept

- Encode a small image corpus with progressive JXL settings.
- Build dry-run decoder profiler.
- Record progression offsets.
- Confirm visible progressive frames appear.

### Phase 2: Manifest-Based Tier Loading

- Define manifest schema.
- Generate manifests after encode.
- Load `dc`, `preview`, and `full` tiers using byte ranges.
- Validate hash and stale-manifest behaviour.

### Phase 3: Long-Lived Streaming Decoder

- Implement incremental decoder wrapper.
- Handle unconsumed input correctly.
- Emit frames on progression events.
- Add cancellation and cleanup.

### Phase 4: Gallery Scheduler

- Add `IntersectionObserver`.
- Implement viewport-aware weighted round-robin refinement.
- Load DC for all visible thumbnails first.
- Upgrade visible thumbnails fairly to preview.
- Reserve full quality for selected images.

### Phase 5: Saliency Integration

- Add optional saliency detection/manual centre.
- Encode with attention centre when appropriate.
- Record saliency settings in manifest.
- Compare subject-focused images with and without saliency.

### Phase 6: Performance Hardening

- Add concurrency limits.
- Add cache strategy.
- Stress-test 50+ thumbnails.
- Test slow network behaviour.
- Optimise memory use.
- Add diagnostics.

------

## Decision Record

### Chosen

Progressive JPEG XL encoding with optional saliency ordering, served through manifest-derived byte tiers and decoded through long-lived incremental decoder sessions.

Gallery refinement should use viewport-aware weighted round-robin progressive scheduling so that all visible thumbnails receive approximately equal early attention.

### Rationale

- Uses one canonical encoded asset.
- Avoids re-encoding per quality tier.
- Allows early recognisable previews.
- Can reduce bandwidth when paired with range-aware transport.
- Allows saliency to improve subject-focused images.
- Prevents one image from monopolising bandwidth and decode time.
- Gives dense galleries better perceived performance.

### Rejected

- Fixed-percentage chunking as the primary strategy.
- Greedy per-image completion in galleries.
- Re-encoding separate quality variants as the main path.
- Saliency as a universal default.
- Manual codestream parsing as a first implementation requirement.
- Full-image fetch for every thumbnail unless required by fallback constraints.

------

## Final Design Principle

The implementation should be guided by three rules:

1. **Measure progression, do not guess it.**
    Use decoder-observed progression offsets to create manifests.
2. **Refine the viewport fairly.**
    In galleries, advance all visible images to recognisable quality before perfecting any one image.
3. **Use saliency selectively.**
    Attention-centre ordering is valuable for clear focal subjects, but should be disabled where diagnostic detail is spatially distributed.

This turns progressive JXL from a codec feature into a practical streaming and gallery-rendering strategy.