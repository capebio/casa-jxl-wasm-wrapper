# CR2 Decoder Optimisation & Hardening Handoff (Round 2)

A second pass through the code using the full deployment strategy (*1*), implementation blueprint (*2*), and optimisation chapters (*3*) shifts the focus from local improvements toward pipeline architecture.

The first review identified obvious copies, allocations, and robustness issues. This review focuses on structural constraints that will limit future SIMD, WASM, streaming, and scheduler work even after the first batch of fixes lands.

------

# Strategic Reassessment

The decoder currently behaves as:

```text
File bytes
    ↓
TIFF parse
    ↓
Metadata extraction
    ↓
Locate LJPEG strip
    ↓
Allocate full decode buffer
    ↓
Decode entire image
    ↓
Allocate crop buffer
    ↓
Copy crop
    ↓
Return image
```

The largest remaining architectural issue is:

> The decoder is still fundamentally "decode everything then transform".

Your optimisation blueprint targets:

```text
Input
    ↓
Ownership layer
    ↓
Decode
    ↓
Output view
```

The current implementation has not yet crossed that boundary.

------

# New Findings

## A. Decoder Is Not Yet Streaming-Capable

The current design requires:

```rust
Vec<u16> raw_decoded
Vec<u16> cropped
```

before returning.

This prevents:

- ring-buffer ingestion
- progressive decode
- tile scheduling
- bounded memory decode
- decode cancellation

The public API itself locks in the old architecture.

### Recommended Future Interface

```rust
decode_into(
    src,
    dst,
    scratch,
    options
)
```

or

```rust
DecoderSession
```

ownership model.

This is the largest long-term architectural blocker.

------

## B. TIFF Parsing Still Performs Multiple Full Metadata Passes

Current flow:

```text
walk IFD0
walk EXIF
walk MakerNote
walk RAW IFD
```

Each pass:

- allocates
- traverses
- branches

This is acceptable for desktop decoding but becomes increasingly visible in WASM deployments processing many images.

A future parser should operate as:

```text
single metadata collector
```

with:

```rust
MetadataBuilder
```

receiving tags as discovered.

------

## C. Active Area Cropping Is Still Post-Decode

Current architecture:

```text
decode
↓
crop
```

Optimal architecture:

```text
decode active area directly
```

or

```text
decode
↓
view
```

when padding can be represented without copy.

This remains the largest memory-bandwidth consumer.

------

## D. Metadata Allocations Dominate Small Images

For large RAWs:

- decode dominates

For small files:

- metadata handling dominates

Current allocations:

```rust
String
Vec<u16>
Vec<(...)>
Vec<u16>
```

before image delivery.

These are unnecessary.

------

## E. LJPEG SOF Scan Is Linear Every Decode

Current:

```rust
parse_ljpeg_sof(...)
```

walks marker-by-marker through the strip.

For individual files this is negligible.

For large batch workloads:

- every decode repeats the scan
- every decode touches compressed bytes twice

Potential future improvement:

- SOF discovery during strip identification
- unified JPEG metadata parse

Not urgent but worth tracking.

------

## F. API Prevents Tile-Based Decode

Current return type:

```rust
Cr2Image {
    raw: Vec<u16>
}
```

assumes:

- full image resident
- contiguous ownership
- final image complete

This blocks:

- progressive display
- tile pipelines
- scheduler ownership
- worker reuse

The implementation blueprint explicitly points toward session ownership rather than image ownership.

------

# Updated Change Index

| ID   | Fix Type           | Concise Description                                          | Lines                   |
| ---- | ------------------ | ------------------------------------------------------------ | ----------------------- |
| 1    | Correctness        | Fix broken BlackLevel implementation.                        | 338-366; 395-399        |
| 2    | Robustness         | Replace unchecked indexing helpers with validated reads.     | 33-50                   |
| 3    | Robustness         | Add checked offset arithmetic everywhere TIFF offsets are consumed. | 62-99; 124-148; 226-485 |
| 4    | Allocation Removal | Replace `walk_ifd()` vector construction with visitor traversal. | 124-148; (258-366)      |
| 5    | Allocation Removal | Eliminate ColorData temporary vector.                        | 84-99; 202-223; 320-334 |
| 6    | Allocation Removal | Avoid unconditional Make/Model string allocation.            | 101-118; 264-285        |
| 7    | Cache Locality     | Single-pass metadata extraction.                             | 258-366                 |
| 8    | Copy Elimination   | Remove active-area crop copy.                                | 433-469                 |
| 9    | Copy Elimination   | Remove simultaneous full-frame buffers.                      | 407-469                 |
| 10   | WASM Architecture  | Add externally-owned decode buffers.                         | 407-413; 471-485        |
| 11   | Kernel Fusion      | Decode + crop fusion.                                        | 379-469                 |
| 12   | SIMD Readiness     | SIMD-aligned row operations.                                 | 458-466                 |
| 13   | Robustness         | Harden SOF parser against malformed markers.                 | 156-194                 |
| 14   | Robustness         | Add IFD corruption guards and traversal limits.              | 124-148; 226-366        |
| 15   | Robustness         | Validate CR2Slices semantics.                                | 385-393                 |
| 16   | Performance        | Borrowed ASCII parsing.                                      | 101-118                 |
| 17   | Performance        | Reduce TIFF tag dispatch overhead.                           | 258-366                 |
| 18   | Memory             | Remove unused color-matrix state until implemented.          | 20-29; 317-328; 471-485 |
| 19   | Cleanup            | Remove dead BlackLevel remnants.                             | 342-360                 |
| 20   | Benchmarking       | Add allocation-count benchmarks.                             | 488-588                 |
| 21   | Architecture       | Replace image-owned API with session-owned decode lifecycle. | 10-29; 226-485          |
| 22   | Architecture       | Introduce reusable scratch-buffer object.                    | 407-485                 |
| 23   | Architecture       | Separate metadata extraction from decode execution.          | 226-485                 |
| 24   | Streaming          | Enable decode-into destination buffers.                      | 407-485                 |
| 25   | Streaming          | Design for ring-buffer input ownership.                      | 226-485                 |
| 26   | Streaming          | Support progressive/tile decode path.                        | 407-485                 |
| 27   | Cache Locality     | Tile-oriented output abstraction rather than full-frame ownership. | 471-485                 |
| 28   | Memory             | Eliminate second pass over compressed stream for SOF discovery. | 156-194; 373-413        |
| 29   | Scheduler          | Prepare cancellation/backpressure-aware decoder session.     | 226-485                 |
| 30   | WASM               | Keep decode scratch, output planes, and temporary state resident in WASM memory. | 407-485                 |

------

# Additional Strategic Recommendations

## Item 21–30 Form a Single Refactor

These should not be implemented piecemeal.

The target should be:

```text
DecoderSession
 ├── metadata
 ├── scratch buffers
 ├── decode state
 ├── cancellation state
 ├── output views
 └── scheduler hooks
```

This aligns exactly with:

```text
JS API
    ↓
Session Lifecycle
    ↓
Worker Scheduler
    ↓
WASM Codec Engine
    ↓
SIMD Kernels
    ↓
Output Views
```

and avoids redesigning the decoder multiple times.

------

## SIMD Should Still Wait

After the second review the recommendation remains:

Do **not** begin SIMD work yet.

The current bottlenecks are still:

1. memory movement
2. allocations
3. ownership model

SIMD before fixing those issues will likely produce less gain than removing the crop copy.

------

## Concurrency Should Also Wait

The decoder currently performs:

```text
parse
decode
copy
return
```

on a single image.

Concurrency before ownership cleanup risks:

- more memory pressure
- duplicated buffers
- allocator contention

The implementation blueprint's ordering remains correct:

```text
remove copies
↓
fix memory layout
↓
fuse kernels
↓
SIMD
↓
concurrency
```

------

# Updated Conclusion

## Highest-Impact Changes

### Tier 1 — Immediate

- Fix BlackLevel bug
- Remove crop copy
- Remove duplicate image buffers
- Visitor-based TIFF traversal
- Zero-allocation ColorData parsing
- Reusable decode buffers

**Expected gain:**
**20–40% throughput improvement**
**30–60% lower peak memory**

------

### Tier 2 — Structural

- Session-based decoder
- Decode-into API
- Scratch-buffer ownership
- WASM-resident working memory
- Metadata/decode separation

**Expected gain:**
**Additional 10–25% throughput improvement**
**Much lower allocator pressure**
**Major WASM deployment benefits**

------

### Tier 3 — Future Optimisation Layer

After Tier 1 and Tier 2:

- SIMD kernels
- tile scheduling
- worker pools
- progressive decode
- cancellation/backpressure

**Expected gain:**
**Additional 10–30% depending on workload and platform**

------

Final thought:

CR2 is effectively a container.

Think of it like:

```
Container
├─ RAW image
├─ Preview JPEG
├─ EXIF
├─ MakerNotes
└─ Thumbnails
```

A future architecture could expose:

```
read_metadata()
extract_preview()
decode_raw()
```

separately.

Then:

```
decode_raw()
```

never touches preview JPEG data.