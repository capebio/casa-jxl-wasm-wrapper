1. # JXL Decode Pipeline Optimisation Review (`decode.cc`)

   ## Executive Summary

   The file already follows a relatively efficient streaming design, but several high-impact opportunities remain. The dominant theme is that the implementation still performs avoidable data movement and transient allocations in the codestream path. The largest wins come from:

   1. Eliminating codestream accumulation copies.
   2. Removing per-section heap allocation.
   3. Reusing decode-side scratch structures.
   4. Improving streaming ownership semantics.
   5. Reducing memory churn during frame processing.

   The architecture guidance supplied in sections *1–3* aligns closely with the existing decoder design and confirms that effort should focus on data movement before computational optimisation.

   ------

   # Agent Handoff

   ## Primary Objective

   Do not begin with SIMD, threading, or algorithmic experimentation.

   Execute work in this order:

   1. Instrument copy counts.
   2. Instrument allocation counts.
   3. Replace codestream copy accumulation.
   4. Eliminate per-section heap allocation.
   5. Reuse scratch vectors and buffers.
   6. Verify ownership and lifetime rules.
   7. Re-benchmark.
   8. Only then evaluate SIMD and concurrency tuning.

   ------

   ## Required Validation

   Every pixel-affecting change must run:

   - Golden corpus validation
   - SSIM comparison
   - Butteraugli comparison
   - Visual regression verification

   Performance-only changes should additionally collect:

   - Total allocations
   - Bytes copied
   - Peak RSS
   - Decode throughput
   - Time-to-first-image
   - Time-to-final-image

   ------

   # Findings Index

   | ID   | Fix Type                     | Concise Description of Change                                | Lines                     |
   | ---- | ---------------------------- | ------------------------------------------------------------ | ------------------------- |
   | 1    | Copy Elimination             | Replace `codestream_copy` growth model with ring-buffer or sliding-window ownership model. Current implementation repeatedly appends streamed input into a temporary vector. | 509-523; 597-606; 635-639 |
   | 2    | Copy Elimination             | Avoid full input append during `RequestMoreInput`. Current logic copies all available codestream bytes before returning. | 597-602                   |
   | 3    | Streaming Architecture       | Convert codestream state from copy-based recovery to pointer advancement with stable backing storage. Align with architecture target JS → scheduler → WASM memory → decode. | 558-641                   |
   | 4    | Allocation Reduction         | Remove per-section heap allocation of `BitReader` objects. Use arena allocation, stack-backed storage, object pool, or contiguous ownership container. | 1087-1115                 |
   | 5    | Allocation Reduction         | Reuse `section_info` and `section_status` storage across frame processing instead of rebuilding vectors every call. | 1087-1105                 |
   | 6    | Cache Locality               | Store section metadata and status in a fused structure or contiguous SoA layout to improve traversal locality. | 1087-1135                 |
   | 7    | Ownership Cleanup            | `codestream_copy.clear()` releases logical contents but preserves fragmented growth history. Replace with bounded reusable storage. | 583-593                   |
   | 8    | Session Architecture         | Separate stream ownership bookkeeping from decode execution. Decoder currently owns significant transport responsibilities. | 554-641; 2009-2057        |
   | 9    | Worker Preparation           | Introduce explicit decode-session abstraction before attempting worker pool scheduling. Current lifecycle is decoder-centric. | 671-766; 2009-2057        |
   | 10   | Threading Strategy           | Delay concurrency optimisation until copy elimination is complete. Existing thread-pool setup is not the primary bottleneck. | 845-854; 1149-1155        |
   | 11   | Frame Scratch Reuse          | Preserve reusable frame decode scratch structures across frames where safe instead of rebuilding transient state. | 1350-1481                 |
   | 12   | Output Lifetime Optimisation | Avoid repeated output container clearing where ownership can be reset via generation counters or pooled structures. | 1471-1474                 |
   | 13   | Hot-Path Branch Reduction    | Consolidate codestream state transitions and special-case handling in `GetCodestreamInput`. Current path contains multiple ownership modes. | 610-641                   |
   | 14   | Memory Layout                | Maintain compressed input, decode planes, and output views in a single ownership domain where possible. Minimise layer crossings. | 509-641; 1082-1496        |
   | 15   | WASM Readiness               | Refactor input storage abstraction so backing memory can reside entirely in WASM linear memory without API redesign later. | 554-641                   |
   | 16   | Instrumentation              | Add counters for bytes copied, temporary allocations, section allocations, and buffer growth events. | 509-641; 1082-1145        |

   ------

   # Detailed Notes

   ## Item 1 — Codestream Copy Buffer

   The largest architectural mismatch with the optimisation brief is the existence of:

   ```cpp
   std::vector<uint8_t> codestream_copy;
   ```

   The decoder currently falls back to copy-based retention whenever additional input is needed.

   This directly violates:

   - eliminate copies
   - keep buffers in WASM
   - stable ownership
   - pointer advancement

   Recommended replacement:

   - fixed-capacity ring buffer
   - read pointer
   - write pointer
   - no append-based growth

   Expected result:

   - fewer allocations
   - lower memory bandwidth
   - reduced cache pollution

   Reference:

   - Item 1
   - Item 2
   - Item 3

   Lines:

   - 509-523
   - 597-606
   - 635-639

   ------

   ## Item 4 — Per-Section Heap Allocation

   Current implementation:

   ```cpp
   auto* br = new jxl::BitReader(...)
   ```

   followed by:

   ```cpp
   delete info.br;
   ```

   inside the decode path.

   This creates:

   - allocator pressure
   - heap contention
   - poor locality

   Preferred solutions:

   1. stack-backed storage
   2. arena allocator
   3. object pool
   4. preallocated vector of readers

   This is one of the highest-confidence optimisations in the file.

   Reference:

   - Item 4

   Lines:

   - 1099-1115

   ------

   ## Item 5 + Item 6 — Section Processing Locality

   Each invocation reconstructs:

   ```cpp
   section_info
   section_status
   ```

   from scratch.

   A reusable decode-context cache would:

   - avoid repeated allocations
   - improve cache locality
   - simplify future SIMD scheduling

   References:

   - Item 5
   - Item 6

   Lines:

   - 1087-1135

   ------

   ## Item 8 + Item 9 — Session Ownership Layer

   The supplied architecture target:

   ```text
   JS API
   → Session lifecycle
   → Worker scheduler
   → WASM codec engine
   → SIMD kernels
   → output views
   ```

   is not fully reflected in this file.

   Currently:

   - lifecycle
   - transport state
   - streaming ownership
   - decode orchestration

   are intertwined.

   Introduce:

   ```text
   DecodeSession
       ownership
       cancellation
       backpressure
       scheduling
   
   CodecDecoder
       actual decode work
   ```

   before attempting aggressive worker scheduling.

   References:

   - Item 8
   - Item 9

   Lines:

   - 671-766
   - 2009-2057

   ------

   ## Item 10 — SIMD Timing

   Do not optimise SIMD first.

   The file still contains measurable:

   - copies
   - allocations
   - ownership transitions

   These will dominate memory-bound workloads.

   Follow benchmark order:

   1. remove copies
   2. improve layout
   3. fuse work
   4. SIMD
   5. concurrency

   Reference:

   - Item 10

   ------

   # Major Wins

   ## Win 1 — Remove Codestream Copy Path

   Expected impact:

   - large reduction in memory traffic
   - lower latency during streaming decode
   - improved WASM compatibility

   ## Win 2 — Eliminate BitReader Heap Churn

   Expected impact:

   - lower allocator overhead
   - better cache behaviour
   - smoother multi-thread scaling

   ## Win 3 — Reuse Section Scratch Structures

   Expected impact:

   - reduced transient allocations
   - improved frame-to-frame throughput

   ## Win 4 — Introduce Session Ownership Layer

   Expected impact:

   - cleaner worker scheduling
   - easier backpressure implementation
   - easier WASM memory ownership

   ## Win 5 — Prepare for Kernel Fusion and SIMD

   Expected impact:

   - enables later optimisation work without architectural rewrites

   ------

   # Expected Performance Gain

   Estimated cumulative improvement after successful implementation and validation:

   | Change Group                | Estimated Gain               |
   | --------------------------- | ---------------------------- |
   | Copy elimination            | 10–30%                       |
   | Allocation reduction        | 5–15%                        |
   | Cache locality improvements | 5–10%                        |
   | Session ownership cleanup   | indirect / enabling          |
   | Later SIMD exploitation     | 10–40% depending on workload |

   Overall expectation:

   **~20–50% decode throughput improvement on streaming-heavy workloads**, with larger gains possible in WASM deployments where memory movement is currently more expensive than arithmetic.

   The highest-value work remains copy elimination and allocation removal. SIMD and concurrency should be treated as second-order optimisations after those are complete.
