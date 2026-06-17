# JXTC Pre-Production at Ingest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add JXTC (JXL tile container) pre-production at ingest time and wire browser lightbox to decode from JXTC for 10-30× speedup on crop/thumbnail requests.

**Architecture:** JXTC encoding runs in parallel with regular JXL encoding during ingest, storing tile containers in the manifest as optional `jxtcBytes` fields. The browser lightbox detects JXTC availability and routes small-crop requests through `decodeTileContainerRegionRgba8` instead of full decode, with metrics captured at both encode and decode boundaries.

**Tech Stack:** Node.js/TypeScript (ingest), browser WASM (decode), jxl-wasm facade (JXTC encode/decode), pyramid-ingest pipeline.

---

## File Map

- **Ingest Storage Layer**: `packages/pyramid-ingest/src/manifest.ts` (LevelEntry schema) — add optional `jxtcBytes` field
- **Ingest Encoding**: `packages/pyramid-ingest/src/ingest.ts` (encodeLevel logic) — wire JXTC encoding after JXL
- **Ingest Telemetry**: `packages/pyramid-ingest/src/cli.ts` (event reporting) — capture jxtcEncodeMs
- **Browser Discovery**: `packages/pyramid-ingest/src/manifest.ts` (when served to browser) — expose jxtcBytes in card metadata
- **Browser Lightbox**: `web/jxl-progressive.js` — add JXTC routing for crop requests
- **Worker Measurement**: `web/jxl-progressive.js` or dedicated lightbox worker — capture jxtcDecodeMs
- **Test**: `packages/pyramid-ingest/test/ingest.test.ts` — verify JXTC encoding + storage

---

## Phase 1: Understand Current Manifest + Storage Strategy

### Task 1: Read Current Level Entry Schema

**Files:**
- Read: `packages/pyramid-ingest/src/manifest.ts`
- Read: `packages/pyramid-ingest/src/backends.ts` (JxlBackend interface)

- [ ] **Step 1: Examine LevelEntry and related types**

Open `packages/pyramid-ingest/src/manifest.ts` and note:
- Structure of `LevelEntry` (what fields exist, how levels are stored)
- Whether levels are stored as files or in-memory buffers
- How manifest.json links to level data (file references or embedded)

- [ ] **Step 2: Check current JxlBackend contract**

Open `packages/pyramid-ingest/src/backends.ts` and find the `JxlBackend` interface. Note:
- `encode()` method signature
- Return type (what does it produce?)
- Whether it returns only the JXL buffer or metadata

- [ ] **Step 3: Review how levels are written to disk**

In `packages/pyramid-ingest/src/ingest.ts`, search for the call site where level data is written (search for "writeFile" + jxl). Note:
- File naming convention (e.g., `{imageId}-L0.jxl`, `{imageId}-L1.jxl`)
- Whether metadata is separate from binary data
- Directory structure

---

### Task 2: Decide JXTC Storage Strategy

**Decision Point**: JXTC can be stored as:
1. **Separate file per level** (e.g., `{imageId}-L0.jxtc`)
2. **Embedded in manifest.json** (as base64 or hex)
3. **Stored in a sidecar index** (separate `{imageId}.jxtc-index.json`)

Based on the boundary-cost-audit recommendation (§15): "produces tiled/JXTC JXLs at ingest time", the most straightforward approach is **separate file per level**.

- [ ] **Step 1: Note the decision in the plan**

Add a comment to this plan document: "Decision: JXTC stored as separate `{imageId}-L{N}.jxtc` files alongside regular JXL levels. Manifest references via `jxtcPath: string` field in LevelEntry."

- [ ] **Step 2: Verify file naming aligns with existing pyramid structure**

Check `packages/pyramid-ingest/src/ingest.ts` for the exact naming convention used for JXL files. Confirm the pattern you'll use for JXTC (e.g., if JXL is `img-abc123-L0.jxl`, then JXTC is `img-abc123-L0.jxtc`).

---

## Phase 2: Add JXTC Encoding to Ingest Pipeline

### Task 3: Update LevelEntry Schema to Reference JXTC

**Files:**
- Modify: `packages/pyramid-ingest/src/manifest.ts` (LevelEntry type)

- [ ] **Step 1: Add optional jxtcPath field**

Open `packages/pyramid-ingest/src/manifest.ts` and locate the `LevelEntry` interface (or type). Add:

```typescript
export interface LevelEntry {
  // ... existing fields ...
  jxtcPath?: string;  // Optional path to .jxtc container file (relative to manifest dir)
}
```

- [ ] **Step 2: Verify LevelEntry is serialized to manifest.json**

Check that wherever `LevelEntry` is written to JSON, the new field will be included (usually automatic with TypeScript-to-JSON serialization).

---

### Task 4: Wire JXTC Encoding into Ingest Pipeline

**Files:**
- Modify: `packages/pyramid-ingest/src/ingest.ts` (encodeLevel or buildLadder call)
- Reference: `packages/jxl-wasm/src/facade.ts` (for `encodeTileContainerRgba8` signature)

- [ ] **Step 1: Review how levels are currently encoded**

In `packages/pyramid-ingest/src/ingest.ts`, search for where `backends.jxl.encode()` is called. Note:
- The input RGBA buffer
- The output JXL buffer
- Timing instrumentation (if any)
- Error handling

- [ ] **Step 2: Read encodeTileContainerRgba8 signature**

Open `packages/jxl-wasm/src/facade.ts` and find `encodeTileContainerRgba8`. Note:
```typescript
export async function encodeTileContainerRgba8(
  pixels: ArrayBuffer | Uint8Array,
  width: number,
  height: number,
  options: { tileSize?: number; distance?: number; effort?: number; ... }
): Promise<ArrayBuffer | Uint8Array>
```

- [ ] **Step 3: Add JXTC encoding after JXL encode**

In `packages/pyramid-ingest/src/ingest.ts`, find the location where levels are encoded. Add JXTC encoding in parallel:

```typescript
// Pseudo-location in encodeLevel or buildLadder:
const jxlBytes = await backends.jxl.encode(rgbaPixels, width, height, { effort: 3, ... });

// NEW: Add JXTC encoding
const t0Jxtc = Date.now();
let jxtcBytes: Uint8Array | null = null;
try {
  const { encodeTileContainerRgba8 } = await import("@casabio/jxl-wasm");
  jxtcBytes = await encodeTileContainerRgba8(rgbaPixels, width, height, {
    tileSize: 256,    // Standard tile size (from jxl-crop-benchmark.js precedent)
    distance: 0,      // Lossless (can tune later based on use case)
    effort: 3,        // Match JXL effort for consistency
  });
} catch (e) {
  console.warn(`[ingest] JXTC encode failed (container skipped):`, e);
}
const jxtcEncodeMs = Date.now() - t0Jxtc;
```

- [ ] **Step 4: Write JXTC file to disk**

After JXTC encoding, write it to the same directory as the JXL file:

```typescript
let jxtcPath: string | undefined;
if (jxtcBytes) {
  const jxtcFileName = jxlFileName.replace('.jxl', '.jxtc');
  jxtcPath = join(levelDir, jxtcFileName);
  await writeFile(jxtcPath, Buffer.from(jxtcBytes));
}
```

- [ ] **Step 5: Update the LevelEntry to include jxtcPath**

When constructing the `LevelEntry` for storage in the manifest, add:

```typescript
const entry: LevelEntry = {
  // ... existing fields ...
  jxtcPath: jxtcPath ? relative(manifestDir, jxtcPath) : undefined,
};
```

---

### Task 5: Capture JXTC Metrics in Telemetry

**Files:**
- Modify: `packages/pyramid-ingest/src/cli.ts` (telemetry event reporting)
- Reference: existing jxlEncodeMs / jxlKb fields

- [ ] **Step 1: Find current telemetry event structure**

In `packages/pyramid-ingest/src/cli.ts`, search for where level encoding metrics are reported (search for "jxlEncodeMs" or similar). Note the event format.

- [ ] **Step 2: Add jxtcEncodeMs and jxtcKb fields**

When reporting a level encode event, include:

```typescript
const levelEvent = {
  // ... existing fields ...
  jxlEncodeMs: jxlEncodeMs,
  jxlKb: (jxlBytes.byteLength / 1024).toFixed(0),
  jxtcEncodeMs: jxtcEncodeMs,     // NEW
  jxtcKb: jxtcBytes ? (jxtcBytes.byteLength / 1024).toFixed(0) : null,  // NEW
};
```

- [ ] **Step 3: Verify telemetry is wired to TTY output**

Check that `telemetry-tty.ts` renders these new fields so operators see JXTC metrics during ingest runs.

---

## Phase 3: Browser-Side Discovery + Routing

### Task 6: Add JXTC Discovery in Browser Card Metadata

**Files:**
- Modify: Browser entry point that consumes manifest (likely `web/jxl-progressive-gallery.js` or similar lightbox bootstrap)

- [ ] **Step 1: Locate where manifests are parsed and card objects created**

Find the code that:
- Fetches/parses manifest.json
- Creates card/image metadata objects from LevelEntry
- Passes those to the lightbox

- [ ] **Step 2: Extract jxtcPath and expose on card object**

When building the card object, add:

```typescript
const card = {
  // ... existing fields (imageId, jxlPath, width, height, levels, ...) ...
  jxtcPath: entry.jxtcPath || null,  // NEW: optional path to JXTC container
};
```

- [ ] **Step 3: Verify card is passed to lightbox/decode workers**

Ensure the card object (including the new `jxtcPath` field) is passed to any worker or decode function that will use it.

---

### Task 7: Wire JXTC Routing in Lightbox Decode Path

**Files:**
- Modify: `web/jxl-progressive.js` (or the lightbox worker that handles crop/zoom requests)

- [ ] **Step 1: Find crop/region decode request handler**

Locate the function that handles "user requested a crop" or "user zoomed in" events. This is likely:
- A function that constructs a decode request with a region rect
- Or a worker postMessage handler that receives {region, size, ...}

- [ ] **Step 2: Check if JXTC is available before decoding**

At the start of the crop decode function, add:

```typescript
async function decodeRegion(card, region, size) {
  // Check if JXTC is available
  if (card.jxtcPath) {
    // NEW: Route through JXTC
    return await decodeViaJxtc(card, region, size);
  } else {
    // Fallback to full decode + crop
    return await decodeFullThenCrop(card, region, size);
  }
}
```

- [ ] **Step 3: Implement decodeViaJxtc using decodeTileContainerRegionRgba8**

Add a new function:

```typescript
async function decodeViaJxtc(card, region, size) {
  const t0 = performance.now();
  
  // Fetch JXTC container from card.jxtcPath
  const jxtcResponse = await fetch(card.jxtcPath);
  const jxtcBytes = await jxtcResponse.arrayBuffer();
  
  // Import facade if not already available
  const { decodeTileContainerRegionRgba8 } = await import("@casabio/jxl-wasm");
  
  // Decode region from JXTC
  const regionPixels = await decodeTileContainerRegionRgba8(jxtcBytes, {
    region: { x: region.x, y: region.y, width: region.width, height: region.height },
  });
  
  const jxtcDecodeMs = performance.now() - t0;
  
  // Report metric
  if (window.telemetry) window.telemetry.emit('jxtc_decode', { jxtcDecodeMs, regionSize: size });
  
  return regionPixels;
}
```

- [ ] **Step 4: Ensure error handling falls back to full decode**

Wrap the JXTC path in try-catch:

```typescript
async function decodeRegion(card, region, size) {
  if (card.jxtcPath) {
    try {
      return await decodeViaJxtc(card, region, size);
    } catch (e) {
      console.warn(`[lightbox] JXTC decode failed, falling back to full:`, e);
    }
  }
  return await decodeFullThenCrop(card, region, size);
}
```

---

### Task 8: Add JXTC Decode Metrics to Lightbox Worker

**Files:**
- Modify: Same file as Task 7 (web/jxl-progressive.js or lightbox worker)

- [ ] **Step 1: Capture decode timing in worker**

When decoding via JXTC, capture the time:

```typescript
const t0Decode = performance.now();
const regionPixels = await decodeTileContainerRegionRgba8(...);
const decodeTimeMs = performance.now() - t0Decode;
```

- [ ] **Step 2: Report metric to main thread**

If this is in a worker, post the metric back:

```typescript
postMessage({
  type: 'decode_complete',
  regionPixels,
  metrics: {
    jxtcDecodeMs: decodeTimeMs,
    viJxtc: true,  // flag that this used JXTC path
  }
});
```

- [ ] **Step 3: Verify main thread collects these metrics**

In the main thread lightbox handler, collect the jxtcDecodeMs metrics for telemetry/logging.

---

## Phase 4: Testing + Verification

### Task 9: Add Unit Test for JXTC Encoding in Ingest

**Files:**
- Modify/Create: `packages/pyramid-ingest/test/ingest.test.ts`

- [ ] **Step 1: Write test that verifies JXTC is encoded and stored**

```typescript
test('ingest produces JXTC files alongside JXL', async () => {
  const testDir = tmpDir(); // or use existing test fixture
  const ingestResult = await ingestSingleImage(testFixture.largePng, {
    outDir: testDir,
    // ... other options ...
  });
  
  // Verify JXTC file exists
  const manifestPath = join(testDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  
  const level0 = manifest.levels[0];
  expect(level0.jxtcPath).toBeDefined();
  
  const jxtcFullPath = join(dirname(manifestPath), level0.jxtcPath);
  const jxtcStats = await stat(jxtcFullPath);
  expect(jxtcStats.isFile()).toBe(true);
  expect(jxtcStats.size).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run test to verify it fails initially**

Run: `npm test -- ingest.test.ts` (or appropriate test runner)

Expected output should show the test failing because `jxtcPath` is not yet populated.

- [ ] **Step 3: Verify test passes after Tasks 3-5 are implemented**

After JXTC encoding is wired into the ingest pipeline, re-run the test to confirm it passes.

---

### Task 10: Integration Test for Browser JXTC Decode

**Files:**
- Create: `web/test-jxtc-lightbox.html` (simple manual test harness, or add to existing test suite)

- [ ] **Step 1: Create a minimal test that loads an image with JXTC and decodes a crop**

```html
<!DOCTYPE html>
<html>
<head>
  <title>JXTC Decode Test</title>
</head>
<body>
  <div id="results"></div>
  <script type="module">
    import { decodeTileContainerRegionRgba8 } from "./pkg/jxl_wasm.js";
    
    async function testJxtcDecode() {
      // Fetch a .jxtc file from the test corpus
      const jxtcResponse = await fetch('/test-assets/sample-image.jxtc');
      const jxtcBytes = await jxtcResponse.arrayBuffer();
      
      // Decode a small region (e.g., center 128×128)
      const t0 = performance.now();
      const pixels = await decodeTileContainerRegionRgba8(jxtcBytes, {
        region: { x: 100, y: 100, width: 128, height: 128 },
      });
      const elapsedMs = performance.now() - t0;
      
      const resultDiv = document.getElementById('results');
      resultDiv.innerHTML = `
        <h1>JXTC Decode Test</h1>
        <p>Decoded 128×128 region in ${elapsedMs.toFixed(1)} ms</p>
        <p>Pixel count: ${pixels.byteLength / 4}</p>
        <canvas id="preview"></canvas>
      `;
      
      // Draw to canvas for visual inspection
      const canvas = document.getElementById('preview');
      canvas.width = 128;
      canvas.height = 128;
      const ctx = canvas.getContext('2d');
      const imageData = new ImageData(new Uint8ClampedArray(pixels), 128, 128);
      ctx.putImageData(imageData, 0, 0);
    }
    
    testJxtcDecode().catch(e => {
      document.getElementById('results').textContent = `Error: ${e.message}`;
    });
  </script>
</body>
</html>
```

- [ ] **Step 2: Test locally by opening in browser**

Open the test harness in a browser (after building WASM and setting up test fixtures) to verify JXTC decode produces visible pixels.

---

### Task 11: Run Crop Benchmark to Verify JXTC Speedup

**Files:**
- Reference: `web/jxl-crop-benchmark.js` (already exists and measures JXTC)

- [ ] **Step 1: Generate test JXTC files from ingest**

Run an ingest on a small test dataset to produce .jxtc files:

```bash
node packages/pyramid-ingest/dist/cli.js ingest /path/to/test-images /tmp/test-pyramid --force
```

- [ ] **Step 2: Copy JXTC files to web-accessible location**

Make the generated .jxtc files available to the crop benchmark (e.g., in `web/test-assets/`).

- [ ] **Step 3: Run crop benchmark and compare timings**

Open `web/jxl-crop-benchmark.js` in a browser and run it on a test image. Verify:
- JXTC is encoded successfully (check console for "Encoded JXTC container")
- JXTC decode is faster than full decode for crops (should see jxtcMs << fullMs for small sizes)
- Example: 128px crop should decode in ~10-15ms via JXTC, vs 2500+ms for full decode + crop

---

## Phase 5: Cleanup + Documentation

### Task 12: Update docs/boundary-cost-audit.md with Implementation Status

**Files:**
- Modify: `docs/boundary-cost-audit.md` (section 15, Tier 1 Decision)

- [ ] **Step 1: Add implementation note at the start of section 15**

```markdown
## 15. Decision Summary — TIER 1 JXTC Implementation (June 2026)

**Status: IMPLEMENTED**
- ✅ JXTC encoding wired into ingest pipeline (stores as .jxtc files alongside JXL)
- ✅ Browser lightbox routing to decodeTileContainerRegionRgba8 when JXTC available
- ✅ Metrics captured: jxtcEncodeMs/jxtcKb at ingest, jxtcDecodeMs at lightbox
- ✅ Verified 10-15ms decode for 128px crop via JXTC (vs 2500+ms full decode)

### Implementation Details
- **Ingest**: JXTC produced with tileSize=256, distance=0, effort=3 (lossless)
- **Storage**: Separate .jxtc files, referenced in manifest.json via LevelEntry.jxtcPath
- **Browser**: Card metadata includes jxtcPath; crop requests route through JXTC if available
```

---

### Task 13: Create Handoff Document for Tier 2 Work

**Files:**
- Create: `docs/boundary-cost-audit-tier2-handoff.md`

- [ ] **Step 1: Document what's left for Tier 2**

```markdown
# Boundary Cost Audit — Tier 2 Opportunities (Post-Implementation)

## Animation Frame Marshaling (§15 unquantified)
- Estimated 4-6 full buffer copies (malloc+set per frame)
- **Opportunity**: Batch into single allocation with index table
- **Effort**: Medium (affects `marshalAnimationFrames` in facade.ts)
- **Priority**: Low until multi-frame JXL workflows measured

## Worker toArrayBuffer Copy Optimization (§15 unquantified)
- Current: `slice()` copy when buffer geometry doesn't match exactly
- **Opportunity**: Audit call sites to ensure direct ownership path used more often
- **Effort**: Low (code audit + targeted fixes in decode-handler.ts)
- **Priority**: Low (slice cost unmeasured)

## JXTC Scope Expansion
- Currently: Single JXTC per level at ingest
- **Opportunity**: Produce multiple JXTC variants with different tile sizes / quality settings
- **Effort**: High (requires tile parameter discovery + storage schema)
- **Priority**: Deferred until lightbox usage shows tile-size sensitivity

## Measurement Harness Enhancements
- **Opportunity**: Add per-file JXTC vs full decode comparison in lightbox
- **Effort**: Low (metrics already wired, just need UI/CSV export)
- **Priority**: Nice-to-have for validation runs
```

---

## Completion Checklist

- [ ] Phase 1 tasks complete: Manifest schema updated, storage strategy decided
- [ ] Phase 2 tasks complete: JXTC encoding wired, metrics captured
- [ ] Phase 3 tasks complete: Browser routing implemented, fallback safe
- [ ] Phase 4 tasks complete: Unit test + integration test passing
- [ ] Phase 5 tasks complete: Documentation updated, handoff created
- [ ] All tests pass: `npm test` (ingest + frontend suites)
- [ ] Crop benchmark shows 10-15ms for JXTC vs 2500+ms for full decode
- [ ] No regression in regular pyramid ingest (existing tests still pass)

---

## Critical Unknowns (Defer to End of Implementation)

1. **JXTC for all levels or subset?**  
   Current decision: Produce JXTC for all levels. If disk space is a concern, only produce for full-res + 1-2 downsamples.

2. **Subject crop boundaries at ingest time?**  
   Current decision: JXTC covers entire image. Subject crops are discovered at decode time (user requests a region). If EXIF orientation or known subject rects exist, they can be used to optimize tile placement in a future pass.

3. **JXTC file lifecycle / cleanup?**  
   Current decision: .jxtc files are co-located with .jxl files and follow the same lifecycle (cached, invalidated together). If storage is a concern, they can be regenerated on-demand.

4. **Tile size selection (256 default)?**  
   Current decision: Use 256px tiles (matches jxl-crop-benchmark.js). If lightbox usage shows better results with different sizes, add a config parameter in future.

---
