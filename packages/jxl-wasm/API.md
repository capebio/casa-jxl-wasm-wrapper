# JXL WASM Wrapper API

High-level async API for JPEG XL encode/decode in the browser. Uses async iterators for streaming results.

## Encoder

### `createEncoder(options)`

Create encoder instance.

**Options:**
```javascript
{
  format: 'rgba8',           // Input pixel format
  width: number,             // Frame width in pixels
  height: number,            // Frame height in pixels
  hasAlpha: boolean,         // Whether alpha channel present
  distance: null | 0,        // null = lossy mode, 0 = lossless
  quality: null | 0-100,     // Lossy quality (ignored if lossless)
  effort: 1-9,               // Encoder effort (1=fast, 9=slow, 3=default)
  progressive: boolean,      // Enable progressive encoding
  previewFirst: boolean,     // Emit preview before full image
  chunked: boolean,          // Emit incremental chunks
}
```

**Methods:**

- `await encoder.pushPixels(buffer)` — Push frame pixels (Uint8Array or ArrayBuffer)
- `await encoder.finish()` — Finalize encoding, no more pixels
- `for await (const chunk of encoder.chunks())` — Async iterable of encoded JXL bytes
- `await encoder.dispose()` — Release encoder resources

**Example:**
```javascript
const encoder = createEncoder({
  format: 'rgba8',
  width: 1920,
  height: 1080,
  hasAlpha: true,
  quality: 90,
  effort: 3,
  progressive: false,
  previewFirst: false,
  chunked: false,
});

const chunks = [];
const chunkTask = (async () => {
  for await (const chunk of encoder.chunks()) {
    chunks.push(chunk);
  }
})();

await encoder.pushPixels(rgbaBuffer);
await encoder.finish();
await chunkTask;
await encoder.dispose();

const jxlBytes = concatChunks(chunks);
```

## Decoder

### `createDecoder(options)`

Create decoder instance.

**Options:**
```javascript
{
  format: 'rgba8',                // Output pixel format
  region: null | CropInfo,        // Decode only a spatial region
  downsample: 1,                  // Downsample factor (1, 2, 4, 8)
  progressionTarget: 'final',     // 'preview' or 'final'
  emitEveryPass: boolean,         // Emit on every decode pass
  preserveIcc: boolean,           // Preserve ICC profile
  preserveMetadata: boolean,      // Preserve image metadata
}
```

**Methods:**

- `await decoder.push(buffer)` — Push JXL bytes (Uint8Array or ArrayBuffer)
- `await decoder.close()` — Signal no more input bytes
- `for await (const event of decoder.events())` — Async iterable of decode events
- `await decoder.dispose()` — Release decoder resources

**Events:**

Each event has a `type` field:

- `type: 'preview'` — Low-res preview frame (if available)
  - `frame: { pixels, width, height, ... }`
- `type: 'pass'` — Intermediate decode pass (if `emitEveryPass: true`)
  - `frame: { pixels, width, height, ... }`
- `type: 'final'` — Full-resolution final frame
  - `frame: { pixels, width, height, ... }`
- `type: 'metadata'` — Image metadata
  - `metadata: { intrinsicWidth, intrinsicHeight, ... }`

**Example:**
```javascript
const decoder = createDecoder({
  format: 'rgba8',
  region: null,
  downsample: 1,
  progressionTarget: 'final',
  emitEveryPass: false,
  preserveIcc: true,
  preserveMetadata: true,
});

await decoder.push(jxlBytes);
await decoder.close();

let finalFrame = null;
for await (const event of decoder.events()) {
  if (event.type === 'final') {
    finalFrame = event.frame;
  }
}
await decoder.dispose();

// finalFrame.pixels = Uint8Array of RGBA8 pixels
// finalFrame.width, finalFrame.height = dimensions
```

## Buffer Helpers

### `exactBuffer(view: Uint8Array | ArrayBuffer): ArrayBuffer`

Ensure buffer has no offset/slicing. Many APIs require exact ArrayBuffer ownership.

```javascript
// Only works if view.byteOffset === 0 and covers entire buffer
const buf = exactBuffer(someUint8Array);
```

### `concatChunks(chunks: (Uint8Array | ArrayBuffer)[]): Uint8Array`

Concatenate encoder output chunks into single JXL file.

```javascript
const allBytes = concatChunks(chunks);
```

## Streaming Patterns

### Progressive encode (preview + full)

```javascript
const encoder = createEncoder({
  quality: 90,
  effort: 3,
  progressive: true,
  previewFirst: true,
});

const chunks = [];
const chunkTask = (async () => {
  for await (const chunk of encoder.chunks()) {
    chunks.push(chunk);
    // Each chunk is a complete JXL file up to that point
  }
})();

await encoder.pushPixels(rgba);
await encoder.finish();
await chunkTask;
```

### Progressive decode (preview + final)

```javascript
const decoder = createDecoder({
  progressionTarget: 'final',
  emitEveryPass: false,
});

const input = new Uint8Array(jxlBytes);
await decoder.push(input.buffer.slice(0, input.byteLength));
await decoder.close();

for await (const event of decoder.events()) {
  if (event.type === 'preview') {
    // Low-res preview while full still decoding
    renderPreview(event.frame);
  } else if (event.type === 'final') {
    // Replace with full-res when ready
    renderFinal(event.frame);
  }
}
```

### Region decode (ROI / zoom/pan)

```javascript
const decoder = createDecoder({
  format: 'rgba8',
  region: {
    left: 256,
    top: 256,
    width: 512,
    height: 512,
  },
  downsample: 1,
});

// Same decode flow, but only decodes specified region
```

### Downsampled decode

```javascript
const decoder = createDecoder({
  downsample: 4,  // Decode at 1/4 resolution
  progressionTarget: 'final',
});

// Useful for thumbnails or mobile low-bandwidth
```

## Benchmarking Notes

### Lossy vs Lossless

- **Lossy** (`quality: 85-95`): Fast decode, small files, good for thumbnails
- **Lossless** (`distance: 0`): Slower decode, larger files, critical for full-res

### Effort levels

- `effort: 1` — Fastest encode, larger files
- `effort: 3` — Default, good balance (recommended)
- `effort: 9` — Slowest encode, smallest files (rarely worth it)

### Size-dependent decoder performance

- Thumbnails (128–512px): libjxl typically faster
- Medium (512–1080px): libjxl preferred, oxide comparable
- Full resolution (1920px+): jxl-oxide faster (~200–400ms)
- **Recommendation**: Use this wrapper for all sizes, benchmark your content

### Batching

For multiple images, reuse encoder/decoder instances where possible to amortize initialization cost. Call `dispose()` only when done.

```javascript
for (const image of images) {
  const enc = createEncoder(opts);
  // ... encode ...
  await enc.dispose();
  // OR reuse: await enc.reset() if available
}
```

## Error Handling

Both encoder and decoder throw on invalid state (push after finish, decode invalid JXL, etc).

```javascript
try {
  await decoder.push(invalidBytes);
  await decoder.close();
  for await (const ev of decoder.events()) {
    // never reached if invalid
  }
} catch (err) {
  // Handle error
} finally {
  await decoder.dispose();
}
```

## Memory Management

- Always call `await encoder.dispose()` and `await decoder.dispose()`
- Large RGBA buffers (1920×1080 = 8.3 MB) stay in memory until GC
- Region/downsample reduce memory footprint
- Streaming chunks prevents holding entire file in memory

## Session Context vs Direct Wrapper

This wrapper is the **direct** codec API. For managed lifecycle (auto-pooling, cancellation, timeouts), use the session context layer:

```javascript
// Direct (this API)
const encoder = createEncoder(opts);

// Session (higher-level)
const session = context.encode(opts);  // Managed pool + timeouts
```
