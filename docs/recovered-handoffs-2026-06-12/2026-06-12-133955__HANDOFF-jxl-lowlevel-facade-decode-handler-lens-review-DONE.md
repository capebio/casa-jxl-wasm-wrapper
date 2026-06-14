# Handoff: `jxl_lowlevel.rs` + `facade.ts` + `decode-handler.ts`

## Strategic map

`[crates/raw-pipeline/src/jxl_lowlevel.rs](/abs/path/C:/Foo/raw-converter-wasm/crates/raw-pipeline/src/jxl_lowlevel.rs:48)` is the native low-level JXL stateful decode reference. It owns the Rust ↔ libjxl boundary and defines the native parity shape for progressive flush, first-pixel timing, and future ROI decode.

`[packages/jxl-wasm/src/facade.ts](/abs/path/C:/Foo/raw-converter-wasm/packages/jxl-wasm/src/facade.ts:550)` is the hot JS ↔ WASM boundary. It normalizes decode options, owns progressive and one-shot decode behavior, performs crop/downsample/resize fallback work, and exposes Butteraugli. This file currently carries the largest boundary-cost and memory-risk surface.

`[packages/jxl-worker-browser/src/decode-handler.ts](/abs/path/C:/Foo/raw-converter-wasm/packages/jxl-worker-browser/src/decode-handler.ts:46)` is the worker session orchestrator. It owns queue state, backpressure, cancellation, budget enforcement, event forwarding, and transfer to the main thread. It is mostly mechanically sound, but it inherits expensive buffer decisions from `facade.ts` and adds a few avoidable copies and latency checks of its own.

## Consolidated findings

- Critical bug: `[takeBufferView](/abs/path/C:/Foo/raw-converter-wasm/packages/jxl-wasm/src/facade.ts:2221)` returns `HEAPU8.subarray(...)` and then frees the WASM buffer in `finally`. That is a use-after-free hazard on every progressive decode path that touches the returned view later in JS.
- Highest-cost boundary path: progressive decode in `[eventsProgressive](/abs/path/C:/Foo/raw-converter-wasm/packages/jxl-wasm/src/facade.ts:1204)` can do `WASM buffer -> JS crop/downsample copy -> JS resize copy -> worker toArrayBuffer copy -> postMessage transfer`. For large progressive frames this is the dominant avoidable tax.
- Downsample policy gap: `[pickDownsample](/abs/path/C:/Foo/raw-converter-wasm/packages/jxl-wasm/src/facade.ts:2610)` only auto-picks when both `region` and target size are set. Full-frame thumbnail/lightbox requests with target dimensions still default to `1`, forcing needless full-resolution decode.
- Worker budget timing gap: `[readDecoderEvents](/abs/path/C:/Foo/raw-converter-wasm/packages/jxl-worker-browser/src/decode-handler.ts:362)` copies pixels into an `ArrayBuffer` before budget enforcement. When over budget, the expensive copy has already happened.
- Native parity gap: `[decode_progressive_frames](/abs/path/C:/Foo/raw-converter-wasm/crates/raw-pipeline/src/jxl_lowlevel.rs:126)` clones the full RGBA buffer on every flush and ignores `JxlDecoderSetImageOutBuffer` return codes. Good reference shape, but not yet robust enough for long-lived native production use.

## Agent 1

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article.

Target file: `[packages/jxl-wasm/src/facade.ts](/abs/path/C:/Foo/raw-converter-wasm/packages/jxl-wasm/src/facade.ts:1204)`

Objective: remove the progressive decode use-after-free hazard and make buffer ownership explicit.

Why:

- `takeBufferView()` frees the buffer handle before the caller consumes the returned `Uint8Array` view.
- Today this is accidentally masked by later copies in some paths, but it is undefined behavior and blocks any true zero-copy optimization.

Required changes:

- Replace `takeBufferView()` with an ownership-safe pattern.
- Easiest safe form: return a copied buffer for progressive decode now.
- Better form: introduce a retained wrapper `{ handle, data, release() }` and release only after crop/downsample/resize has finished.
- Keep zero-copy only for cases where the view is consumed before release and never crosses an `await`.

Suggested shape:

```ts
interface RetainedBufferView extends LibjxlBuffer {
  release(): void;
}

function retainBufferView(module: LibjxlWasmModule, handle: number, operation: string): RetainedBufferView {
  const { dataPtr, size, width, height, bitsVal, alphaVal } = readBufferFields(module, handle, operation);
  let released = false;
  return {
    handle,
    data: module.HEAPU8.subarray(dataPtr, dataPtr + size),
    width,
    height,
    bitsPerSample: normalizeBitsPerSample(bitsVal),
    hasAlpha: alphaVal !== 0,
    release() {
      if (!released) {
        released = true;
        module._jxl_wasm_buffer_free(handle);
      }
    },
  };
}
```

Then in `eventsProgressive()`:

```ts
const retained = retainBufferView(module, handle, "decode");
try {
  const pixels = applyRegionAndDownsample(retained.data, retained.width, retained.height, ...);
  ...
} finally {
  retained.release();
}
```

Verification:

- Progressive decode still emits identical image content for `dc`, `pass`, and `final`.
- No freed-heap view survives past release.
- No regression to the required progressive visible-pass behavior.

## Agent 2

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article.

Target file: `[packages/jxl-wasm/src/facade.ts](/abs/path/C:/Foo/raw-converter-wasm/packages/jxl-wasm/src/facade.ts:2374)`

Objective: reduce JS hot-path pixel work and make downsample selection match actual consumer intent.

Why:

- `applyRegionAndDownsample()`, `[bilinearResize()](/abs/path/C:/Foo/raw-converter-wasm/packages/jxl-wasm/src/facade.ts:2458)`, and `[applyTargetResize()](/abs/path/C:/Foo/raw-converter-wasm/packages/jxl-wasm/src/facade.ts:2565)` allocate and recompute per progressive frame.
- `[pickDownsample()](/abs/path/C:/Foo/raw-converter-wasm/packages/jxl-wasm/src/facade.ts:2610)` misses the common full-frame thumbnail case.
- Butteraugli work is expensive; this file is the right place for a cheap multi-stage gate before full compare.

Required changes:

- Extend `pickDownsample()` to also consider full-frame target sizing when `region === null`.
- Precompute normalized region and resize axes once after header dimensions become known in `eventsProgressive()`.
- Reuse scratch buffers for repeated progressive frames when output dimensions and stride stay constant.
- Add an optional fast Butteraugli prefilter path for very large images: compare a downsampled proxy first, skip full-resolution compare when the proxy is already well under threshold.

Suggested `pickDownsample()` adjustment:

```ts
const sourceLongEdge = region ? Math.max(region.w, region.h) : Math.max(targetWidth * 8, targetHeight * 8);
```

Better version:

- Accept source width/height once known.
- Choose the largest factor whose decoded long edge still meets `targetLongEdge`.

Suggested progressive-state cache:

```ts
let resizeCache:
  | { srcW: number; srcH: number; dstW: number; dstH: number; bpc: 1 | 2 | 4;
      xAxis: ReturnType<typeof buildResizeAxis>; yAxis: ReturnType<typeof buildResizeAxis>; }
  | null = null;
```

Notes:

- Keep semantics unchanged for `cover` and `contain`.
- Do not weaken correctness for `rgba16` or `rgbaf32`.
- Remove stale `rgb8` dead branches if type-level investigation confirms they are unreachable in this package.

Feature angle:

- The Butteraugli prefilter can become a perceptual budget gate for AR/lightbox pipelines, photogrammetry dedupe, and LLM dataset triage without paying full compare cost on obviously-similar frames.

## Agent 3

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article.

Target file: `[packages/jxl-worker-browser/src/decode-handler.ts](/abs/path/C:/Foo/raw-converter-wasm/packages/jxl-worker-browser/src/decode-handler.ts:303)`

Objective: tighten queue machinery, budget behavior, and cancellation latency.

Why:

- Current queue compaction is decent but still periodic `copyWithin` churn under long streams.
- Budget checks happen after expensive `toArrayBuffer()` copies.
- `decoder.push()` latency alone is not the full congestion signal; copied-output cost matters too.

Required changes:

- Replace the grow-and-compact array queue with a ring buffer or chunk deque.
- Add a pre-copy budget check in `readDecoderEvents()` before `toArrayBuffer()`.
- Keep the existing post-copy path only if you need a second check for strict wall-clock semantics.
- Track and emit a separate metric for `copy_to_transfer_ms` versus raw decode time.
- Consider factoring `output copy cost` into backpressure, not only `pushLatencyEma`.

Suggested budget shape:

```ts
if (this.checkBudget()) {
  this.postBudgetExceeded(event.stage, event.info, new ArrayBuffer(0), event.format, event.pixelStride, event.region);
  return;
}
const pixels = toArrayBuffer(event.pixels);
if (this.checkBudget()) {
  this.postBudgetExceeded(event.stage, event.info, pixels, event.format, event.pixelStride, event.region);
  return;
}
```

If zero-length budget payload is unacceptable, then at minimum move the first budget check before `toArrayBuffer()` and document that the last partially-decoded image is intentionally dropped when budget is exhausted before transfer.

Feature angle:

- Better queue/budget behavior helps low-latency AR and recognition flows because stale frames become cheaper to abandon instead of fully copying and posting them after they are already too late to matter.

## Agent 4

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article.

Target file: `[packages/jxl-worker-browser/src/decode-handler.ts](/abs/path/C:/Foo/raw-converter-wasm/packages/jxl-worker-browser/src/decode-handler.ts:362)`

Objective: cut worker ↔ main-thread payload cost and expose richer progressive metadata for downstream automation.

Why:

- The handler currently forwards whole-frame pixel buffers with only minimal stage metadata.
- Recognition, photogrammetry, and AR consumers benefit from stable intermediate metadata: decoded scale, ROI provenance, progressive pass index, and lateness/budget decisions.

Required changes:

- Preserve and forward more metadata already available upstream when present: `sourceScale`, `progressiveRegion`, `regionFallback`, frame timing.
- Add pass ordinal or monotonic progressive sequence numbering at the worker boundary.
- Emit `dropped_due_to_budget`, `dropped_due_to_cancel`, and `copied_bytes` metrics.
- If protocol permits inside this file’s current type surface, prefer transferring exact `ArrayBuffer`s without re-slicing when the incoming view already spans the full buffer.

Suggested local helper:

```ts
function toTransferablePixels(value: ArrayBuffer | Uint8Array): { buffer: ArrayBuffer; copied: boolean } {
  if (value instanceof ArrayBuffer) return { buffer: value, copied: false };
  if (value.byteOffset === 0 && value.byteLength === value.buffer.byteLength) {
    return { buffer: value.buffer, copied: false };
  }
  return { buffer: value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength), copied: true };
}
```

Then post `copied` as a metric. This makes regressions visible.

Feature angle:

- Richer progressive metadata is the hook LLM and CV pipelines need for confidence-weighted early decisions, frame skipping, region re-request, and future saliency-driven partial decode.

## Agent 5

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article.

Target file: `[crates/raw-pipeline/src/jxl_lowlevel.rs](/abs/path/C:/Foo/raw-converter-wasm/crates/raw-pipeline/src/jxl_lowlevel.rs:126)`

Objective: harden the native low-level reference and lower avoidable full-frame copies.

Why:

- `[decode_full()](/abs/path/C:/Foo/raw-converter-wasm/crates/raw-pipeline/src/jxl_lowlevel.rs:48)` and `decode_progressive_frames()` ignore the result of `JxlDecoderSetImageOutBuffer`, which can mask a real bridge/setup failure.
- Progressive path clones the entire RGBA output buffer on every `FrameProgression`.
- This file is the natural place to prepare native parity for ROI decode, texture upload, and future perceptual-constancy render modes.

Required changes:

- Check and handle the return value from both `JxlDecoderSetImageOutBuffer` calls.
- Add a precise error/termination enum instead of collapsing all failure paths to `None`.
- Split the callback API into `on_progress(&[u8], w, h)` and `on_final(Vec<u8>, w, h)` or equivalent so intermediate frames can be borrowed instead of cloned.
- If the borrowed callback is too invasive, at least gate cloning behind an explicit caller option.

Suggested shape:

```rust
pub enum DecodeProgressiveEvent<'a> {
    Progress { width: u32, height: u32, rgba: &'a [u8] },
    Final { width: u32, height: u32, rgba: Vec<u8> },
}
```

Notes:

- Keep `JxlDecoderSetProgressiveDetail(...Passes)` as the reference default unless a caller explicitly requests another detail policy.
- Preserve the current parity goal of first-pixel timing.
- Do not let this reference drift from the WASM-visible progressive semantics.

## Largest gaps still unlit

- The bridge-side allocation contract is still assumed, not proven, from these three files alone. The freed-view bug in `facade.ts` is high confidence, but exact lifetime rules should still be confirmed against the buffer-free implementation when someone is allowed to inspect it.
- Protocol richness is constrained by types imported from `@casabio/jxl-core/protocol` and `types`. These three files reveal missing metadata opportunities, but not the full downstream compatibility cost.
- The actual best Butteraugli acceleration opportunities may sit one layer below this file set, because the dominant win is often smarter candidate selection or earlier perceptual gating before full-resolution compare begins.

## What implementing this achieves

The biggest immediate win is correctness at the most dangerous boundary. Fixing progressive buffer ownership in `facade.ts` removes a silent heap-lifetime bug that can corrupt progressive output, produce timing-sensitive failures, and block future zero-copy work. Once ownership is explicit, the JS ↔ WASM boundary becomes optimizable instead of fragile.

The next win is raw throughput. Auto-downsampling full-frame target requests, reusing resize state, and reducing queue/copy churn cuts the amount of pixel work the browser has to do after libjxl already did the expensive decode. That directly improves time-to-first-pixel, main-thread freshness, and the number of progressive updates that can be shown before the final frame arrives.

These changes also make the pipeline more useful for machine-driven consumers. Richer progressive metadata, clearer budget/drop signals, and faster perceptual comparison form the substrate for ROI ranking, recognition-first decode, photogrammetry prefiltering, and AR frame triage. The pipeline stops being just an image decoder and becomes a decision system that can trade fidelity, latency, and compute intentionally.

Finally, the native low-level Rust reference becomes a stronger parity anchor. Better error surfaces and fewer unnecessary full-frame clones make it suitable not just as a benchmark scaffold, but as the seed for future native progressive paint, native ROI decode, and high-performance perceptual color work in the render loop.
