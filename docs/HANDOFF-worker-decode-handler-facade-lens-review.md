# HANDOFF — Lens Review: worker.ts / decode-handler.ts / facade.ts (Round R14)

Scope: `packages/jxl-worker-browser/src/worker.ts`, `packages/jxl-worker-browser/src/decode-handler.ts`, `packages/jxl-wasm/src/facade.ts`.
22-lens pass (strategic, API, pipeline, state, data structures, hot kernels, boundaries, support, owl, reversal, astronomy, ML, gaming, photogrammetry, Butteraugli, AR, color science, mathematics, hacker, re-pass, gaps, birds-eye). Duplicates amalgamated. Items already in `docs/rejected optimizations.md` (buffer pools, drain callbacks, compactQueue thresholds, progress throttling, metrics expansion, generic queue helpers, etc.) were checked and are **not** re-proposed.

Each agent handles exactly one file. Agents may read any file in the repo for context (especially `packages/jxl-worker-browser/src/wasm-loader.ts`, `packages/jxl-wasm/src/bridge.cpp`, `packages/jxl-session/src/decode-session.ts`, `packages/jxl-scheduler/src/scheduler.ts`) but must defer edits to other files until the end and only after requesting approval. Rejections go to `docs/rejected optimizations.md` with the R14 ID.

Priorities: **P1** = correctness bug, **P2** = performance / protocol hygiene, **P3** = cleanup / micro.

---

## Agent 1 — `packages/jxl-worker-browser/src/worker.ts`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

### R14-W1 (P1) — Cold-start queue overflow still creates the session (zombie handler)
`queueDecodeMessage` / `queueEncodeMessage` on overflow delete the queue and the `pending*Starts` entry and post a terminal `QueueOverflow` error — but the in-flight async IIFE in `handleDecodeStart` / `handleEncodeStart` knows nothing of this. After WASM load it creates the handler and registers it in `decodeSessions`/`encodeSessions`. The worker now hosts a live session the main thread already considers dead; it lingers until `release_state` arrives, at which point a spurious `decode_cancelled` is also posted. Fix: track aborted starts.

```ts
const abortedStarts = new Set<string>();

// in queueDecodeMessage overflow branch (and encode twin):
abortedStarts.add(sessionId);
queuedDecodeMessages.delete(sessionId);
pendingDecodeStarts.delete(sessionId);
// ...post QueueOverflow...

// in the IIFE of handleDecodeStart, after getWasm() resolves:
if (abortedStarts.delete(msg.sessionId) || shuttingDown) {
  queuedDecodeMessages.delete(msg.sessionId);
  resolveStartPromise();
  return;
}
```
Also delete from `abortedStarts` in `handleReleaseState` to avoid set growth.

### R14-W2 (P2) — Cold-start queue cap is message-count only, not bytes
`MAX_QUEUED_MESSAGES_PER_SESSION = 256` bounds count; 256 × multi-MB `decode_chunk` transfers can pin hundreds of MB during a slow WASM load. The post-start path has `MAX_QUEUED_BYTES = 128 MiB` (decode-handler); the pre-start path has no byte bound. Add a per-session byte counter alongside the queue (sum `msg.chunk.byteLength` for `decode_chunk`/`encode_pixels` messages), cap at e.g. 128 MiB, and fail with the same `QueueOverflow` path (which now also marks `abortedStarts` per R14-W1).

### R14-W3 (P2) — Add `messageerror` listener
A failed structured-clone deserialization currently vanishes silently; the session whose message died hangs until budget/release. One-liner symmetric to the existing `error`/`unhandledrejection` listeners:

```ts
self.addEventListener("messageerror", () => {
  self.postMessage({ type: "worker_error", code: "MessageDeserializeError",
    message: "Failed to deserialize incoming message" });
});
```

### R14-W4 (P3, verify first) — Suppress `decode_cancelled` for `release_state` cancels
`handleReleaseState` calls `handler.onCancel("release_state")`, which posts `decode_cancelled` to a main thread that has already released the session — one dead structured-clone + dispatch per released session. Before changing: confirm in `scheduler.ts` / `pool.ts` that nothing awaits `decode_cancelled` after sending `release_state`. If confirmed, have worker.ts pass a flag through (or have decode-handler skip the post when `reason === "release_state"` — coordinate with Agent 2; the actual edit lives in decode-handler, so if you both agree, Agent 2 implements and you only verify the call-site reason strings).

---

## Agent 2 — `packages/jxl-worker-browser/src/decode-handler.ts`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

### R14-D1 (P1/P2) — Early progression targets never finish the session worker-side
For `progressionTarget: "dc" | "pass"` with `emitEveryPass: false`, the facade generator returns right after yielding the target `progress` event. `readDecoderEvents` posts `decode_progress` and its loop ends — but `feedDecoder` keeps waiting for input, `Promise.all` never resolves, `finishSession` never runs, and the handler stays in `decodeSessions` until the main thread sends `release_state` (which then emits a spurious `decode_cancelled`). The `header` target already has the correct precedent (`finishSession("final")` inline). Mirror it in the `progress` case:

```ts
case "progress": {
  // ...existing post of decode_progress...
  this.postFirstPixelMetric();
  // Facade returns after the first flush when target != final and emitEveryPass
  // is false — mirror that here so the worker slot frees immediately.
  if (this.opts.progressionTarget !== "final" && !this.opts.emitEveryPass) {
    this.finishSession("final");
    return;
  }
  break;
}
```
**Verify first** in `packages/jxl-session/src/decode-session.ts` that a `decode_progress` at the target stage is treated as session completion main-side (no explicit terminal message exists for early targets). If the session layer instead waits for a terminal message, that is a second, bigger gap — document it in QUESTIONS/handoff rather than inventing a protocol message (protocol churn is a rejected class).

### R14-D2 (P2, verify first) — Honor pause between chunks in the inner feed loop
`feedDecoder`'s inner `while` drains the entire queued backlog even if `decode_pause` arrives mid-burst — the pause ack was already posted by `onPause`, so the scheduler believes the worker yielded while it is still pushing. Whether a pause can interleave at all depends on `BrowserDecoder.push()` in `wasm-loader.ts`: if `push()` ever returns a genuinely pending promise (macrotask boundary), messages interleave and this check is live; if `push()` is synchronous (await = microtask only), macrotasks starve and the check is dead code. Read `wasm-loader.ts` first. If pause can interleave:

```ts
while (!this.ended && this.chunkQueue.length > this.chunkReadIndex) {
  if (this.paused) break;          // re-enters outer loop → waitForResume
  const chunk = this.takeNextChunk();
  // ...
}
```
If push is strictly synchronous, reject with that reasoning (it is adjacent to but distinct from rejected DH6-1, which was about yielding *mid*-push).

### R14-D3 (P1, verify first) — `event.partialPixelStride` / `event.partialStage` may not exist on the error event
`readDecoderEvents`' `error` case reads `event.partialPixelStride` and `event.partialStage`, but the facade's `DecodeEvent` error variant only declares `partialPixels?` and `partialInfo?`. Check the event type actually surfaced by `wasm-loader.ts`'s `BrowserDecoder`. If the facade type flows through unchanged, those two fields are always `undefined`, and `decode_error` partial frames are posted without stride/stage — consumers that assume stride present will misrender 16-bit partials. Resolution is type alignment: either (a) the wasm-loader event type legitimately carries those fields (then no change in this file; note it and close), or (b) they never exist (then drop the dead reads here and confirm `MsgDecodeError` consumers default stride correctly). Do not widen the facade type from this file — that's Agent 3/4's territory and needs approval.

### R14-D4 (P3) — Skip `decode_cancelled` post for `release_state` (pairs with R14-W4)
If Agent 1's verification (scheduler/pool never awaits `decode_cancelled` after `release_state`) holds:

```ts
async onCancel(reason?: string): Promise<void> {
  if (this.ended || this.cancelled) return;
  this.cancelled = true;
  this.paused = false;
  if (reason !== "release_state") {
    self.postMessage({ type: "decode_cancelled", sessionId: this.sessionId });
  }
  // ...
}
```
Reject if verification fails or is inconclusive.

---

## Agent 3 — `packages/jxl-wasm/src/facade.ts` (decoder paths)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

### R14-F1 (P2, highest-value perf item in this round) — Fuse buffer take + crop/downsample/resize; kill the full-frame slice
`takeBuffer` → `readBufferView` does `HEAPU8.slice(dataPtr, dataPtr + size)` — a **full-frame copy** — before `applyRegionAndDownsample` / `applyTargetResize` copy *again* into a (usually much smaller) output. In `eventsProgressive` this happens **per flush** (DC + every AC pass). A 46 MP RGBA8 region/thumbnail decode copies ~184 MB per pass just to throw most of it away; rgbaf32 is 4× that. Fix entirely inside this file, no bridge change:

- When any transform will materialize a fresh output (region crop, downsample > 1, or target resize), read the buffer as a **zero-copy subarray** (`HEAPU8.subarray`, the `takeBufferView` field-read logic without the free), run `applyRegionAndDownsample` / `applyTargetResize` directly on the view (all synchronous, no awaits/yields between read and free, so heap growth cannot invalidate it), then `_jxl_wasm_buffer_free(handle)`.
- When no transform applies (passthrough fast path), keep today's `slice` copy — the handle is freed and the data must own its memory before yield.

Sketch for `takeAndWrap` in `eventsProgressive` (same pattern applies in `eventsOneShot`, where `callDecodeFromPtr`'s `readBufferView` slice feeds `applyRegionAndDownsample` + `applyTargetResize`):

```ts
const willTransform =
  (this.options.region != null) || ((this.options.downsample ?? 1) > 1) ||
  (this.options.targetWidth != null && this.options.targetHeight != null);

const buf = willTransform
  ? readBufferFields(module, handle)          // subarray view, caller frees
  : takeBuffer(module, handle, "decode");      // slice + free, as today
try {
  // crop/downsample/resize from the view — every transform path allocates
  // its own output, so nothing retains the heap view
} finally {
  if (willTransform) module._jxl_wasm_buffer_free(handle);
}
```
Edge: `applyRegionAndDownsample`'s "region clamps to full image" secondary fast path returns the input — if that fires with a view and no resize follows, you must slice before yielding. Guard it.

### R14-F2 (P1) — `buildInfo` hardcodes `bitsPerSample: 8` for rgba16/rgbaf32 progressive decode
`eventsProgressive`'s `buildInfo` memoizes `{ bitsPerSample: 8, hasAlpha: true, ... }` regardless of format. A 16-bit progressive decode reports `info.bitsPerSample === 8` to every consumer (the one-shot path correctly uses the buffer's real value). Fix:

```ts
const bits = fmtIndex === 2 ? 32 : fmtIndex === 1 ? 16 : 8;
const buildInfo = (w: number, h: number): ImageInfo => {
  info ??= { width: w, height: h, bitsPerSample: bits as 8 | 16 | 32,
             hasAlpha: true, hasAnimation: false, jpegReconstructionAvailable: false };
  return info;
};
```
(`hasAlpha: true` stays — output is always RGBA and no `dec_has_alpha` bridge exists.)

### R14-F3 (P1, latent) — Multi-format capability check fires on the wrong path in `events()`
`events()` throws `CapabilityMissing` when `format !== "rgba8"` and the **legacy one-shot** fn (`_jxl_wasm_decode_rgba16` / `_jxl_wasm_decode_rgbaf32`) is absent — but if `progressiveDecode` capability is present, `eventsProgressive` handles all formats via `dec_create(fmtIndex, …)` and never touches the legacy fns. A build exporting the progressive bridge but not the legacy multi-format one-shots falsely rejects rgba16/f32. Move the check inside the one-shot branch:

```ts
if (getCapabilities(module).progressiveDecode) {
  yield* this.eventsProgressive(module);
} else {
  if (this.options.format !== "rgba8") { /* existing CapabilityMissing check */ }
  yield* this.eventsOneShot(module);
}
```
(The encoder has the same disease — that one is Agent 4's R14-F6.)

### R14-F4 (P3) — `push()` after `events()` completes leaks queued chunks
`LibjxlDecoder.events()`'s `finally` clears the queue once, but `push()` only guards on `cancelled || closed`. A caller that keeps pushing after the generator finished (early progression target, no `close()` sent) re-grows `chunkQueue`/`queuedBytes` forever with no consumer. Set a done flag in the `finally` and drop pushes:

```ts
private done = false;
// events() finally: this.done = true; ...existing clears...
push(chunk) { if (this.cancelled || this.closed || this.done) return; ... }
```

### R14-F5 (P3) — Dedupe the 7-field struct read
`readBufferView` and `takeBufferView` duplicate the HEAPU32-fast-path / FFI-fallback field read verbatim. Extract `readBufferFields(module, handle): {dataPtr, size, width, height, bitsVal, alphaVal, errorCode}` and have both (and R14-F1's view path) call it. Pure dedupe, no behavior change.

---

## Agent 4 — `packages/jxl-wasm/src/facade.ts` (encoder + module-level utilities)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Coordinate with Agents 3/5 — same file. Suggested order: 3 → 4 → 5, each rebasing on the previous agent's edits.

### R14-F6 (P1, latent) — `chunks()` checks legacy multi-format encode fns even on the streaming-input path
Lines ~1765–1770: for rgba16/f32, `chunks()` throws `CapabilityMissing` if `_jxl_wasm_encode_rgba16`/`_jxl_wasm_encode_rgbaf32` are absent — *before* branching on `streamingInputActive`, which encodes those formats via `fmtIndex` in `enc_create_image*` and never calls the legacy fns. Builds with streaming input but without legacy multi-format encoders falsely fail. Move the check into the buffered (non-streaming) branch only.

### R14-F7 (P2) — Butteraugli comparator with a resident reference (Lens 15)
Every `computeButteraugli` call mallocs + uploads **both** full RGBA buffers. The dominant real-world pattern (quality sweeps, convergedByteEnd-style saturation probes) compares many candidates against one reference, re-uploading the reference each time. Pure facade addition — the bridge fns are stateless, so JS can simply hold the reference pointer across calls:

```ts
export class ButteraugliComparator {
  private refPtr = 0;
  private constructor(private module: LibjxlWasmModule,
                      private width: number, private height: number) {}
  static async create(reference: ArrayBuffer | Uint8Array, width: number, height: number) {
    const module = await loadLibjxlModule();
    if (!module._jxl_wasm_butteraugli_compare) throw new CapabilityMissing("…");
    const c = new ButteraugliComparator(module, width, height);
    const size = width * height * 4;
    c.refPtr = module._malloc(size);
    if (c.refPtr === 0) throw new Error("WASM malloc failed for Butteraugli reference");
    module.HEAPU8.set(copyOrBorrowInput(reference, false).subarray(0, size), c.refPtr);
    return c;
  }
  compare(candidate: ArrayBuffer | Uint8Array): number {
    const size = this.width * this.height * 4;
    const ptr = this.module._malloc(size);
    try {
      this.module.HEAPU8.set(copyOrBorrowInput(candidate, false).subarray(0, size), ptr);
      const bits = this.module._jxl_wasm_butteraugli_compare!(this.refPtr, ptr, this.width, this.height);
      if (bits < 0) throw new Error("Butteraugli WASM compare failed");
      const f = new ArrayBuffer(4); new Int32Array(f)[0] = bits;
      return new Float32Array(f)[0]!;
    } finally { this.module._free(ptr); }
  }
  dispose(): void {
    if (this.refPtr !== 0) { this.module._free(this.refPtr); this.refPtr = 0; }
  }
}
```
Halves upload bandwidth and mallocs per comparison in sweeps. Keep the existing one-shot functions; refactor them to share helpers only if it stays small. Caution: `refPtr` survives across calls, which is exactly the pattern rejected as R3-7 *for concurrent decode sessions* — here the comparator is single-owner with an explicit `dispose()`, so the lifecycle objection does not apply; say so in the commit message.

### R14-F8 (P1-adjacent) — `extractJpegReconstructionFromJxl` SOI/EOI scan will false-positive on entropy-coded data
The heuristic scans the whole container body for `FF D8 … FF D9`. Compressed tile payloads are high-entropy; on multi-MB containers the probability of a stray `FFD8` (and a later `FFD9`) is effectively 1, returning garbage "JPEG" bytes. Also the return value **aliases the input buffer** (subarray view) — undocumented. Harden:
1. Read the JXTC layout in `bridge.cpp` (`encode_tile_container_*`) and parse the index instead of scanning blind — restrict the search to regions outside tile payload ranges. If the format genuinely has no jbrd region, this function should return `null` for pure-JXTC files rather than scan.
2. If scanning must remain, validate structure after SOI: next two bytes must be `FF` + a valid marker (`E0`–`EF`, `DB`, `C0`–`CF` …), and the segment length fields must chain consistently for at least 2–3 segments before accepting.
3. Either `.slice()` the result or document the aliasing in the JSDoc.

### R14-F9 (P3) — Dedupe advanced-settings allocation; allocate only when actually consumed
`initModule` inlines a copy of `prepareAdvancedSettings` and allocates `advIdsPtr`/`advValuesPtr` even when `needsY`/`needsX`/plain `enc_create_image` is chosen — pointers are never passed to WASM in those branches and survive until dispose. Call `prepareAdvancedSettings` and only when the `enc_create_image_adv` branch will actually be taken. Also replace `(this as any)._advIdsPtr` / `_advValuesPtr` with typed private fields. **Verify in bridge.cpp** whether `enc_create_image_adv` copies the arrays during create (then free immediately after the call) or retains the pointers until finish (then keep dispose-time free).

### R14-F10 (P3) — `computeButteraugliDownsampled` cleanups
Unused `pw/ph/pixelSize` locals (dead since the "allocate full original" decision). The fallback `fn = …compare_ds || …compare` silently calls the 4-arg full-res fn with a 5th ignored arg — full-res score returned while the caller asked for downsampled. The doc string half-covers this; make it explicit: prefer throwing `CapabilityMissing` when `_ds` is absent (consistent with every other capability gate in this file), or at minimum document that the fallback is full-res. Delete the dead locals either way.

### R14-F11 (P3) — Hoist `new TextEncoder()` out of `serializeExtraChannelsForWasm`'s loop
One allocation per channel → one module-level `const TEXT_ENCODER = new TextEncoder();`.

---

## Agent 5 — `packages/jxl-wasm/src/facade.ts` (resize/math kernels)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Same-file coordination: run after Agents 3 and 4.

### R14-F12 (P2) — Fuse cover-mode resize + crop: never resize pixels that get cropped away
`applyTargetResize` cover path bilinear-resizes the **whole** source to `scaledW × scaledH`, then center-crops to target — for aspect-mismatched covers up to ~2× wasted kernel work and an extra full-size intermediate buffer. Extend the axis builder with a source window so the resize maps target pixels directly to the cropped source span:

```ts
function buildResizeAxis(srcSize: number, dstSize: number,
                         srcStart = 0, srcSpan = srcSize) {
  const scale = srcSpan / dstSize;
  for (let d = 0; d < dstSize; d++) {
    const f = srcStart + (d + 0.5) * scale - 0.5;
    const base = Math.max(0, Math.floor(f));
    i0[d] = base; i1[d] = Math.min(srcSize - 1, base + 1); t[d] = f - base;
  }
  ...
}
```
Cover becomes: compute `scale`, derive the source crop window `(cropX', cropY', spanW, spanH)` in *source* coordinates (`spanW = targetW / scale`, centered), then a single `bilinearResize(src, srcW, srcH, targetW, targetH, stride)` using windowed axes. Output identical up to sub-pixel rounding (window center math must match the old `Math.floor((scaledW - targetW)/2)` centering — derive, don't guess; add a parity test against the old path on odd dimensions). Removes the intermediate buffer and the `applyRegionAndDownsample` crop pass entirely.

### R14-F13 (P2, benchmark-gated) — Fixed-point integer bilinear for rgba8
The rgba8 inner loop does 4 float multiplies + `Math.round` per channel (16 fmuls + 4 rounds per pixel). 8.8 fixed-point eliminates float↔int traffic:

```ts
const xtI = (xt * 256) | 0, ytI = (yt * 256) | 0;        // per dx / per dy
const w11 = (xtI * ytI) >> 8, w10 = ytI - w11,
      w01 = xtI - w11,        w00 = 256 - xtI - ytI + w11; // sums to 256
dst[dstOff + c] = (tl * w00 + tr * w01 + bl * w10 + br * w11 + 128) >> 8;
```
CLAUDE.md requires benchmark evidence for tunables/heuristics; this is deterministic arithmetic, but still: write a micro-benchmark (e.g., 4000×3000 → 1200×900) and only land if ≥ ~20% faster on the rgba8 path with max per-channel delta ≤ 1 vs the float kernel. Reject with numbers otherwise. Do **not** touch the u16/f32 paths (f32 must stay float; u16 headroom 16+8 bits = 24 bits, fits int32 — optional follow-up only if the rgba8 result is compelling).

### R14-F14 (P3, flag — do not implement without user sign-off) — `distanceFromQuality` diverges from libjxl's mapping
Current: linear `(100 − q) × 0.15` → q=90 ⇒ d=1.5. libjxl's `JxlEncoderDistanceFromQuality`: q ≥ 30 ⇒ `0.1 + (100 − q) × 0.09` (q=90 ⇒ d=1.0); below 30 a quadratic. Files encoded "quality 90" here are visibly more compressed than the same setting in cjxl/other tools. This is a **behavior change** that shifts all quality-specified encodes; it intersects the project's tuned baselines. Write it up (one paragraph, both formulas, example deltas) in the handoff/QUESTIONS for the user to decide; implement only on explicit approval.

### R14-F15 (P3) — Drop the vestigial `IS_LITTLE_ENDIAN` guards in `bilinearResize`
A5 removed the big-endian branches but left `if (IS_LITTLE_ENDIAN)` wrappers; on a hypothetical BE host the u16/f32 paths would now silently return an all-zero image (worse than the dead code they replaced). Since the platform is contractually LE (per the A5 comments), delete the guards and the `IS_LITTLE_ENDIAN` const, or replace with a one-time throw. Either is better than silent black frames.

---

## Unilluminated rooms (Lens 21 — for future rounds, no action now)

1. **`wasm-loader.ts` / `BrowserDecoder`** — the actual push/pump semantics that R14-D2 and R14-D3 depend on have never been reviewed; it is the load-bearing wall between decode-handler and facade.
2. **`bridge.cpp` buffer lifecycle** — `MakeBufferBorrowed` invalidation rules and whether `enc_create_image_adv` copies or retains its arrays (R14-F9) are undocumented on the TS side.
3. **`encode-handler.ts`** — decode-handler has had ~7 review rounds; its encode twin has had none. Symmetric bugs (early-finish, pause semantics, queue caps) are likely.

---

## Overview — what implementing this round achieves

The two structural wins are memory-bandwidth and lifecycle truthfulness. R14-F1 removes a full-frame copy from every progressive flush and every one-shot decode that crops, downsamples, or resizes — on the platform's real workloads (region decode for the pyramid viewer, thumbnail targets, rgbaf32 high-precision passes feeding the future perceptual-color LookRenderer) this is hundreds of megabytes of avoided traffic per image, the kind of saving that directly shortens time-to-first-pixel and lowers GC pressure in long gallery sessions. R14-F12 and R14-F13 compound this in the resize kernel, and R14-F7 turns Butteraugli sweeps — the pipeline's acknowledged slow path — from "upload both images every call" into "upload the candidate only," roughly halving the FFI cost of quality-convergence probing.

The correctness cluster (R14-W1, R14-D1, R14-F2, R14-F3/F6, R14-F8) closes lifecycle gaps that today only stay invisible because the scheduler's release/budget machinery sweeps up after them: zombie sessions born after their own death notice, early-target decodes that hold worker slots until externally released, 16-bit progressive frames mislabeled as 8-bit, capability gates that test the wrong bridge generation, and a JPEG-extraction heuristic that will eventually hand a viewer garbage bytes. Fixing these makes worker slots return promptly under preemption pressure and removes a class of "works until the build composition changes" latent failures.

Net effect: the worker boundary gets honest (every session that ends, ends once, with the right message and no stragglers), the WASM boundary gets cheaper (one materializing copy per frame, exactly where the output is born), and the measurement tooling that steers encode quality gets fast enough to run routinely rather than exceptionally — groundwork that the pyramid gallery, AR identification latency budgets, and the perceptual color engine all draw on.
