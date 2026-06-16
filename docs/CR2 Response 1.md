# CR2 Decoder Optimisation & Hardening Handoff

This review was performed using the supplied `cr2.rs` implementation. The recommendations were filtered through the optimisation order:

1. Eliminate copies
2. Keep buffers in WASM
3. Improve cache locality
4. Fuse kernels
5. SIMD
6. Concurrency

All pixel-affecting changes should remain gated by golden corpus, SSIM, Butteraugli, and visual regression validation.

------

# Agent Handoff

The decoder is already structurally clean and readable, but it is still dominated by:

- unnecessary metadata allocations
- full-frame copy operations
- repeated TIFF walking allocations
- avoidable bounds checks
- incomplete black-level handling
- non-streaming decode architecture

The highest-value optimisation path is:

1. Remove active-area copy.
2. Decode directly into final destination when cropping permits.
3. Eliminate temporary TIFF vectors.
4. Convert metadata extraction to zero-allocation traversal.
5. Add bounded offset validation helpers.
6. Prepare decode buffers for WASM ownership.
7. SIMD-optimize crop/repack paths only after copy elimination.
8. Benchmark before introducing concurrency.

------

# Change Index

| ID   | Fix Type           | Concise Description                                          | Lines                                |
| ---- | ------------------ | ------------------------------------------------------------ | ------------------------------------ |
| 1    | Correctness        | Fix broken BlackLevel implementation; current code records value but never applies it. | 338-366; 395-399                     |
| 2    | Robustness         | Replace unchecked slice indexing in read_u16/read_u32 with validated access helpers. Prevent malformed-file panic paths. | 33-50                                |
| 3    | Robustness         | Add overflow-safe offset arithmetic (`checked_add`) for TIFF/IFD navigation. Current code relies on manual bounds checks. | 62-99; 124-148; 226-485              |
| 4    | Allocation Removal | Eliminate `Vec<(...)>` creation in `walk_ifd`; switch to callback/visitor traversal. | 124-148; (258-286; 299-313; 330-366) |
| 5    | Allocation Removal | Remove `read_array_u16()` allocation for ColorData; parse directly from source slice. | 84-99; 202-223; 320-334              |
| 6    | Allocation Removal | Avoid unconditional String allocation for Make/Model unless caller requests metadata. | 101-118; 264-285                     |
| 7    | Cache Locality     | Replace repeated IFD scans with tag-directed extraction during traversal. | 258-366                              |
| 8    | Copy Elimination   | Remove final full-frame crop copy by decoding directly into active-area destination or exposing crop view metadata. | 433-469                              |
| 9    | Copy Elimination   | Avoid allocating both `raw_decoded` and `cropped`; current implementation holds two full RAW frames simultaneously. | 407-469                              |
| 10   | WASM Architecture  | Introduce externally-owned decode buffer API (`decode_into`). Prevent allocator churn and support stable WASM memory ownership. | 407-413; 471-485                     |
| 11   | Kernel Fusion      | Combine decode + crop stage when crop geometry is known before decode completion. | 379-469                              |
| 12   | SIMD Readiness     | Align crop/repack path to contiguous row operations suitable for WASM SIMD. | 458-466                              |
| 13   | Robustness         | Validate SOF marker segment lengths before advancing parser. Current parser can be forced into malformed segment traversal. | 156-194                              |
| 14   | Robustness         | Add recursion/chain limits and corruption guards for TIFF structures and IFD offsets. | 124-148; 226-366                     |
| 15   | Robustness         | Validate CR2Slices semantics before width reconstruction. Current code trusts slice metadata. | 385-393                              |
| 16   | Performance        | Replace `String::from_utf8_lossy(...).to_string()` with borrowed parsing where possible. | 101-118                              |
| 17   | Performance        | Convert TIFF tag lookup into compact enum/constants and branch-minimised parsing. | 258-366                              |
| 18   | Memory             | Avoid storing unused `color_matrix` state until implementation exists. | 20-29; 317-328; 471-485              |
| 19   | Cleanup            | Remove dead/commented BlackLevel remnants and unfinished stub logic. | 342-360                              |
| 20   | Benchmarking       | Add allocation-count benchmarks alongside decode timing. Current tests validate correctness but not memory movement. | 488-588                              |

------

# Additional Notes

### Item 8–11 (Largest Expected Win)

Lines 407-469 are currently the dominant avoidable bandwidth consumer.

Current flow:

```text
LJPEG decode
    ↓
raw_decoded (full frame)
    ↓
crop copy
    ↓
cropped (full frame)
```

Target flow:

```text
LJPEG decode
    ↓
active-area destination
```

For large CR2 files this removes:

- one large allocation
- one full-frame memory traversal
- one full-frame copy

This aligns directly with the deployment brief's highest-priority objective.

------

### Item 4–5 (Zero Allocation Metadata Path)

Current metadata path allocates:

- IFD entry vector
- ColorData vector
- multiple metadata strings

even though only a few tags are consumed.

Preferred architecture:

```text
walk_ifd(offset, visitor)

visitor(tag):
    handle only required tags
```

No intermediate entry storage.

------

### Item 10 (WASM Ownership)

Introduce:

```rust
pub fn decode_into(
    src: &[u8],
    dst: &mut [u16],
    scratch: &mut ScratchBuffers
)
```

Benefits:

- stable memory ownership
- reusable decode buffers
- zero allocator pressure in hot paths
- direct WASM memory integration

This aligns with:

```text
JS
 → scheduler
 → WASM
 → SIMD kernels
 → output views
```

------

### Item 13 (SOF Parser Safety)

The SOF parser trusts marker length advancement:

```rust
i += 2 + seg_len;
```

Malformed files can induce pathological traversal patterns. Add:

```rust
seg_len >= 2
next <= buf.len()
checked_add()
```

before advancing.

------

# Final Expected Outcome

## Major Wins

### Tier 1 (High Confidence)

- Remove crop-frame copy
- Remove duplicate RAW buffer
- Zero-allocation TIFF traversal
- Reusable decode buffers

Expected improvement:

**15–35% decode speedup**
**25–50% reduction in peak memory**
**significant WASM allocator pressure reduction**

------

### Tier 2

- Decode/crop fusion
- SIMD-friendly row handling
- Reduced metadata allocations

Expected additional gain:

**5–15% decode speedup**

------

### Tier 3

- WASM SIMD optimisation
- scheduler-aware buffer reuse
- tile-aware decode pipeline

Expected additional gain:

**5–20% depending on image size and platform**

------

