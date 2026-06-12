# Rejected Optimizations

This document records optimizations proposed during pipeline reviews that were formally analyzed and rejected, along with the technical and empirical rationale.

## D-5: JS-Side Speculative Chunk Coalescing

### Proposed Optimization
Coalesce multiple incoming small chunks using `Buffer.concat` before calling `decoder.push()` when the worker queue depth is high and the total size is under 1 MiB.

### Technical Rationale for Rejection
1. **Speculative Memory & GC Overhead:** Performing `Buffer.concat` in JS-land introduces an additional heap allocation and an explicit memory-copy pass. For smaller chunk frequencies, the garbage collection pressure and intermediate buffer allocations can easily outweigh the savings of reducing JS-to-native FFI boundary crossings.
2. **First-Paint Progression Latency:** Coalescing introduces speculative buffering delays, which directly conflicts with progressive JXL stream decoding goals. By delaying the execution of early chunks, we defer first-pixel metrics and progression events, which degrades progressive rendering performance on lossy or slow networks.
3. **No Empirical Benchmark Support:** In alignment with `CLAUDE.md` foundational directives, heuristic or adaptive performance changes cannot be integrated without rigorous, isolated benchmark evidence proving a clear, net-positive improvement on standard test corpora under realistic constraints.

---

## E-1: Cumulative Byte-Boundary Tracking using `sidecarSizes`

### Proposed Optimization
Track sidecar cumulative byte offsets in the node worker's `readEncoderChunks` loop by comparing cumulative bytes against `sidecarSizes` boundaries rather than assuming one chunk maps to one sidecar.

### Technical Rationale for Rejection
1. **Conceptual Type/Domain Mismatch:** The proposed fix incorrectly treats `this.opts.sidecarSizes` as an array of *byte sizes*. In our system architecture, `sidecarSizes` represents the *pixel dimensions* (long-edge max pixel size, e.g., `[256, 512, 1024, 2048]`) of the requested thumbnails, not their compressed byte sizes.
2. **Severe Data Corruption Hazard:** Comparing cumulative output bytes to pixel dimensions (e.g., checking if `totalBytes >= 256` or `512` bytes) would trigger false completions of sidecar offsets at extremely early stages of encoding. This would emit incorrect `sidecarOffsets` (e.g. 256 bytes instead of the actual compressed JXL size of several kilobytes), resulting in truncated/corrupted thumbnail image fetches when clients perform range-prefix requests.
3. **Architecture Guarantee:** In both our WASM and native bindings, the encoding engine is guaranteed to yield each sidecar thumbnail as a single, discrete, complete JXL container chunk before the main codestream. Thus, tracking the end-of-chunk boundaries of the first `sidecarSizes.length` chunks is the mathematically correct and byte-accurate representation of cumulative sidecar boundaries.
