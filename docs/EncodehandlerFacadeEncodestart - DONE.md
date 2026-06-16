# Progressive Saliency Implementation Plan
## 19-Lens Review: encode-handler.ts / facade.ts / encode_start.json

**Date:** 2026-06-11
**Files in scope (one per agent — do not touch anything else without asking):**

1. `packages/jxl-worker-browser/src/encode-handler.ts` (378 lines)
2. `packages/jxl-wasm/src/facade.ts` (2652 lines)
3. `packages/jxl-core/src/schemas/encode_start.json` (31 lines)

---

## Strategic Overview (Lens 1)

The three files form the **encode arm** of the pipeline:

```
scheduler ── MsgEncodeStart ──► encode-handler.ts (worker)
                                   │  validates against encode_start.json (contract)
                                   │  owns pixel queue, drain backpressure, session FSM
                                   ▼
                                facade.ts  LibjxlEncoder
                                   │  streaming-input fast path (pixels → WASM heap direct)
                                   │  buffered fallback (sidecars / metadata)
                                   ▼
                                bridge.cpp / libjxl ──► JXL chunks ──► postMessage (transfer)
```

Data crossing boundaries: transferred `ArrayBuffer` pixel chunks (main→worker), zero-copy
`HEAPU8` writes (JS→WASM), borrowed `subarray` views on chunk drain (WASM→JS, same-tick
contract), transferred JXL chunks (worker→main). The schema is the *third rail*: it is the
formal contract for the first hop, and it is currently **out of sync with what the handler
actually reads** — the same failure class as the decode_start P0 found in the jxl-core lens
review.

**Cross-file root finding:** `encode-handler.ts` reads 12 fields from `MsgEncodeStart`
(`progressiveFlavor`, `progressiveDc`, `progressiveAc`, `qProgressiveAc`, `groupOrder`,
`sidecarSizes`, `orientation`, `centerX`, `centerY`, `intrinsicSize`,
`disablePerceptualHeuristics`, `codestreamLevel`) that `encode_start.json` declares illegal
via `"additionalProperties": false`. Any validator wired to this schema rejects every real
encode_start message the pipeline currently produces.

**Guardrails for all agents** (from CLAUDE.md — violations get rejected on sight):
- No pixel buffer pools (transferred ArrayBuffers detach).
- No drain callbacks / backpressure inside the facade — backpressure is the
  scheduler/worker boundary only.
- No batching logic in the facade.
- No per-stage budget resets.
- Adaptive/heuristic *behaviour* changes require benchmark data. Instrumentation
  (measuring and reporting) is fine.
- Check `docs/rejected optimizations.md` before implementing anything that smells familiar.

---

## Agent 1 — `packages/jxl-core/src/schemas/encode_start.json`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

You may **read** `packages/jxl-core/src/protocol.ts` to cross-check exact field names and
types of `MsgEncodeStart`, but only edit the schema file.

### S1 (P0) — Schema rejects every current encode_start message

`"additionalProperties": false` + missing properties = hard reject of all messages carrying
the progressive/saliency fields the handler reads. Add the missing optional properties
(verify each exists on `MsgEncodeStart` in protocol.ts first; omit any that don't):

```json
"progressiveFlavor": { "enum": ["dc", "ac"] },
"progressiveDc": { "enum": [0, 1, 2] },
"progressiveAc": { "enum": [0, 1, 2] },
"qProgressiveAc": { "enum": [0, 1, 2] },
"groupOrder": { "enum": [0, 1] },
"sidecarSizes": {
  "type": "array",
  "items": { "type": "integer", "minimum": 1 },
  "description": "Max dimensions (px) of sidecar thumbnails, ascending"
},
"orientation": { "type": "integer", "minimum": 1, "maximum": 8 },
"centerX": { "type": "integer", "minimum": 0 },
"centerY": { "type": "integer", "minimum": 0 },
"disablePerceptualHeuristics": { "type": "boolean" },
"codestreamLevel": { "enum": [-1, 5, 10] }
```

`intrinsicSize`: shape unknown from the handler alone — copy its exact type from
protocol.ts (likely `{width, height}` object or integer; encode accordingly).

### S2 (P1) — `oneOf` for binary fields fails on `null`

```json
"iccProfile": { "oneOf": [{ "type": "null" }, { "description": "ArrayBuffer — transferred" }] }
```

`{ "description": ... }` is an *unconstrained* schema — it matches **everything, including
null**. So for `iccProfile: null` **both** branches match and `oneOf` (exactly-one) fails.
Every message with a null ICC/EXIF/XMP is rejected. Fix for all three fields:

```json
"iccProfile": {
  "anyOf": [{ "type": "null" }, { "not": { "type": "null" } }],
  "description": "ArrayBuffer or null — transferred, not JSON-representable"
}
```

(or simply drop the `oneOf` and keep a bare descriptive schema — decide one style and
apply to `iccProfile`, `exif`, `xmp` consistently).

### S3 (P2) — Bounds hardening

- `width`/`height`: add `"maximum": 1048576` (1M px per side; facade enforces 1 GiB pixel
  bytes — a per-side cap catches garbage early and cheaply).
- `distance`: add `"maximum": 25` (libjxl's max).
- Add `"description"` strings to the saliency fields (`centerX`/`centerY` = group-order
  center for center-out progressive paint) so the schema doubles as protocol docs.

### S4 (P3) — Format enum forward-compat note

facade.ts has a working `rgb8` (3-channel, fmt index 3) encode path; the schema enum is
`["rgba8","rgba16","rgbaf32"]`. Do **not** add `rgb8` unless protocol.ts's
`MsgEncodeStart["format"]` already includes it — just leave a `$comment` noting the bridge
supports fmt=3 so the next protocol rev can expose it deliberately.

---

## Agent 2 — `packages/jxl-worker-browser/src/encode-handler.ts`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

### E1 (P1) — `finish()` timeout timer never cleared

`feedEncoder` (line ~286): the 30 s `setTimeout` inside `Promise.race` is never cancelled
when `encoder.finish()` wins the race. In Node workers this pins the event loop for 30 s
after every successful encode; in browsers it's a spurious wake. Note the facade's
`finish()` is synchronous (flag set + resolve) — the real work happens in `chunks()` —
so today the race *always* leaks the timer.

```ts
this.state = "finalising";
let finishTimer: ReturnType<typeof setTimeout> | undefined;
try {
  await Promise.race([
    encoder.finish(),
    new Promise<never>((_, reject) => {
      finishTimer = setTimeout(
        () => reject(new Error("encoder.finish() timed out after 30 s")),
        FINISH_TIMEOUT_MS,
      );
    }),
  ]);
} finally {
  clearTimeout(finishTimer);
}
```

### E2 (P1) — All failures collapse to code `"Internal"`

`run()`'s catch and the constructor catch map every error — including
`CapabilityMissing` (e.g. region encode requested, multi-format bridge absent) — to
`code: "Internal"`. Upstream can't distinguish "rebuild the WASM" from "bug". Map the code:

```ts
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown })?.code === "CapabilityMissing"
    ? "CapabilityMissing" : "Internal";
  this.failSession(code, message);
}
```

Apply in both `run()`'s catch and the constructor's `.catch`.

### E3 (P2) — `_drainMsg.latencyMs` is always 0

The drain message carries `latencyMs: 0` forever — dead telemetry that the scheduler's
adaptive-HWM logic (decode side has a real EMA) cannot use. Populate it with the measured
`pushPixels` await duration. This is instrumentation only — no behaviour change, no
tunable, so it does not trip the "adaptive changes need benchmarks" rule; it *enables*
that future benchmark.

```ts
// feedEncoder inner loop:
const t0 = performance.now();
await encoder.pushPixels(entry.chunk, entry.region);
this.lastPushLatencyMs = performance.now() - t0;
// maybePostDrain:
this._drainMsg.latencyMs = this.lastPushLatencyMs;
```

(add `private lastPushLatencyMs = 0;`)

### E4 (P2) — Surface `EncodeStats` on `encode_done`

The facade populates `getStats()` (originalBytes/compressedBytes/ratio) after `chunks()`
completes; the handler throws it away. Compression ratio per image is exactly the signal
the saliency/quality ladder upstream needs (and what `convergedByteEnd` manifests want
alongside `sidecarOffsets`). In `readEncoderChunks` after the loop:

```ts
const stats = encoder.getStats();
const doneMsg: MsgEncodeDone = {
  type: "encode_done",
  sessionId: this.sessionId,
  totalBytes,
  ...(sidecarOffsets.length > 0 ? { sidecarOffsets } : {}),
  ...(stats !== null ? { stats } : {}),
};
```

This needs one optional field on `MsgEncodeDone` in `packages/jxl-core/src/protocol.ts`
(`stats?: { originalBytes: number; compressedBytes: number; ratio: number }`). That is a
minimal closely-related edit permitted by the scope rule — document it in your commit.
If you judge the protocol edit out of bounds, reject this item with that reason rather
than shipping a cast.

### E5 (P3) — `sidecarOffsets` are *end* offsets and assume 1 chunk = 1 sidecar

`sidecarOffsets.push(totalBytes)` records the cumulative byte position *after* the chunk
— i.e. sidecar *i* spans `[offsets[i-1] ?? 0, offsets[i])`. Correct today (the buffered
sidecar bridge yields exactly one buffer per sidecar), but undocumented and silently wrong
if the bridge ever splits a sidecar. Tighten the comment to state both invariants
(end-exclusive offsets; one-chunk-per-sidecar contract with the `_jxl_wasm_buffer_next`
chain). Comment-only change.

### E6 (P3) — Pixels arriving after `onFinish` vanish silently

`onPixels` after `finished` returns without trace — a scheduler bug feeding late chunks
would be invisible. One-time `console.warn` (not an error: protocol races between
fire-and-forget messages are legitimate):

```ts
if (this.finished) {
  if (!this.lateWarned) {
    this.lateWarned = true;
    console.warn(`[jxl-worker] encode ${this.sessionId}: pixels after finish — dropped`);
  }
  return;
}
```

### E7 (P3) — Micro: `this.state = "streaming"` reassigned per chunk

`readEncoderChunks` sets state on every chunk. Set once when `firstByteEmitted` flips.
Trivial; do it only while touching the function for E4.

### E8 — Cleanup note (conditional, no code if precondition unmet)

The `(this.opts as MsgEncodeStart).progressiveDc`-style self-casts exist only because the
installed `node_modules` copy of jxl-core is stale (the comment at line ~149 says so). If
a current jxl-core build is present in your session, delete the no-op casts and the
`progressiveFlavor` `unknown` dance and let the real type flow. If node_modules is still
stale, leave them — do not "fix" types by widening.

### E-Test — Add under `packages/jxl-worker-browser/test/` (mirrors decode-handler gap list)

- cancel while `feedEncoder` awaits `pushPixels` → encoder disposed once, `encode_cancelled` posted once
- `MAX_QUEUED_BYTES` overflow → `QueueOverflow` posted, queue cleared
- finish-timeout path → `Internal` error, no unhandled rejection, timer cleared (E1)
- `encode_done` carries stats when facade provides them (E4)

---

## Agent 3 — `packages/jxl-wasm/src/facade.ts` — memory safety & correctness

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

### F1 (P0) — Unchecked `_malloc` → silent heap corruption at address 0

Four call sites take the raw `_malloc` result and immediately `HEAPU8.set(...)`. On OOM,
`_malloc` returns 0 and the write lands at the bottom of the WASM heap — silent corruption
of libjxl's globals, not an error. `mallocOrThrow` already exists in this file; use it:

| Site | Line (approx) | Context |
|---|---|---|
| `transcodeJpegToJxl` | 619 | `const ptr = module._malloc(view.byteLength);` |
| `eventsOneShot` | 1462 | `const inputPtr = module._malloc(totalSize);` |
| `LibjxlEncoder.chunks()` buffered path | 1786 | `const ptr = module._malloc(this.pixelByteTotal);` |
| sidecar dims | 1806 | `const dimsPtr = module._malloc(sortedSizes.length * 4);` |

In `eventsOneShot` also guard `totalSize === 0` *before* malloc (zero-byte input should
produce a clean `"error"` event "empty JXL input", not whatever `malloc(0)` does).

### F2 (P0) — Sidecar encode path ignores pixel format

`chunks()` buffered path: `if (this.sortedSidecarSizes.length > 0 && caps.sidecars)` calls
`_jxl_wasm_encode_rgba8_with_sidecars` **unconditionally**. With `format: "rgba16"` or
`"rgbaf32"`, the WASM heap holds `w*h*8` (or `*16`) bytes but the bridge reads `w*h*4` as
RGBA8 → garbled half/quarter image encoded with no error. Guard:

```ts
const sidecarsUsable = this.sortedSidecarSizes.length > 0 && caps.sidecars
  && this.options.format === "rgba8";
if (this.sortedSidecarSizes.length > 0 && !sidecarsUsable) {
  console.warn("[jxl-wasm] sidecarSizes require rgba8 — encoding without sidecars");
}
if (sidecarsUsable) { ... }
```

Mirror the same `format === "rgba8"` condition into `initModule`'s `wantSidecars` so the
streaming-input fast path correctly re-activates for non-rgba8 + sidecar requests.

### F3 (P1) — Sidecar path silently drops ICC/EXIF/XMP

`initModule` carefully avoids the streaming path when metadata is present (to route through
`encode_rgba8_with_metadata`), but the buffered **sidecar** branch wins over the metadata
branch and the bridge fn has no metadata params — colour profile silently stripped exactly
on the gallery-ingest path that produces pyramid sidecars (worst possible place for an
ecologist's colour-managed specimen photos). Minimum fix: one-time `console.warn` when
`sidecarsUsable && hasMetadataOpts`. Better (verify bridge first): yield sidecars via the
sidecar fn, then re-encode the *main* image via `encode_rgba8_with_metadata` — only do
this if you can confirm the chunk-order contract (sidecars first, main last) is preserved;
otherwise ship the warn and file the bridge gap in the doc comment.

### F4 (P1) — `buildInfo` memoizes wrong `hasAlpha`/`bitsPerSample` forever

`eventsProgressive`: the header event fires `buildInfo(w, h)` with default
`hasAlpha = true` before any pixel buffer exists; `info ??=` memoizes that. When the first
real flushed buffer arrives with `buf.hasAlpha === false`, the memo wins — every
progress/final event reports `hasAlpha: true` for alpha-less images (most camera output!).
Same for `bitsPerSample`. Fix: refresh the memo when real buffer metadata diverges:

```ts
const buildInfo = (w: number, h: number, bitsPerSample: 8 | 16 | 32 = normalizeBitsPerSample(bpc * 8), hasAlpha?: boolean): ImageInfo => {
  if (info === undefined) {
    info = { width: w, height: h, bitsPerSample, hasAlpha: hasAlpha ?? true, hasAnimation: false, jpegReconstructionAvailable: false };
  } else if (hasAlpha !== undefined && (info.hasAlpha !== hasAlpha || info.bitsPerSample !== bitsPerSample)) {
    info = { ...info, hasAlpha, bitsPerSample };
  }
  return info;
};
```

(`takeAndWrap` already passes `buf.hasAlpha`/`buf.bitsPerSample`; the header-path call
passes neither, so the default no longer poisons the memo.)

### F5 (P2) — Cancel race leaves pending push hitting a freed encoder state

`LibjxlEncoder.cancel()` frees `wasmEncState` between microtasks; a queued `pushTask` then
calls `_jxl_wasm_enc_pixels_ptr(0, …)` → error thrown → spurious "push failed (0)" surfaces
on an already-cancelled session. Guard inside the pushTask, after `ensureModule`:

```ts
if (this.cancelled || (this.streamingInputActive && this.wasmEncState === 0)) return;
```

### F6 (P2) — First-flush stage mislabelled "dc" when no DC pass exists

`flushCount === 1 → "dc"` is wrong for `progressiveDetail: "lastPasses"` (detail 2 — the
first flush libjxl surfaces is a late AC pass). Consumers keying UX on `stage === "dc"`
(paint-DC-blurred, then sharpen) get a full-detail frame labelled dc:

```ts
const stage: DecodeStage = (flushCount === 1 && progressiveDetail !== 2) ? "dc" : "pass";
```

### F7 (P3) — Document the `takeBufferView` same-tick contract at its *call sites*

`takeAndWrap` (progressive decode) and both enc chunk drains yield WASM-heap `subarray`
views. Two latent hazards for future editors: (a) any `await` inserted between take and
copy/post invalidates the view after the next heap growth; (b) `postMessage` of a subarray
without `.slice()` structured-clones the **entire WASM heap ArrayBuffer**. The contract is
documented on `takeBufferView` itself but not where the temptation lives. Add a one-line
`// SAME-TICK VIEW — copy before any await/postMessage (see takeBufferView)` at the three
call sites. Comments only; no code change.

### F8 (P3) — `_a6Checked` survives test module swaps

`setJxlModuleFactoryForTesting` resets `modulePromise` but not the module-level
`_a6Checked`, so a second fake module never gets the pointer-size assert. Reset it inside
`setJxlModuleFactoryForTesting` and `setForcedTier`.

---

## Agent 4 — `packages/jxl-wasm/src/facade.ts` — performance

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

### P1 (P1) — `decodeRegionLod` defeats its own downsampling

It hardcodes `downsample: 1`, which short-circuits `normalizeDecoderOptions`'s
`options.downsample ?? pickDownsample(options)`. Result: a 512 px LOD request over an
8000 px region decodes **all 64 Mpx at full resolution**, then bilinear-shrinks in JS —
this is the telescope pointed at the whole sky to look at one star. Delete the
`downsample: 1` line and let `pickDownsample` choose 8/4/2 (it has region + target dims —
exactly its designed input). One-line change, order-of-magnitude win on the
region-LOD path the pyramid viewer uses. Verify with the existing tiled-region benchmark.

### P2 (P1) — `pickDownsample` is blind without a region

`if (region === null …) return 1;` means a plain "decode this 50 Mpx JXL to a 256 px
thumbnail" (`decodeViewport` with target dims, no region) runs full-res. The facade can't
know source dims pre-decode — but callers (manifest, sidecar index, cache) usually do.
Add an opt-in hint, then use it:

```ts
// DecoderOptions:
/** Known source dimensions, e.g. from a manifest. Enables coarse-downsample
 *  selection when no region is given. No effect if absent. */
sourceSizeHint?: { width: number; height: number };

// pickDownsample:
const longEdge = region !== null
  ? Math.max(region.w, region.h)
  : options.sourceSizeHint
    ? Math.max(options.sourceSizeHint.width, options.sourceSizeHint.height)
    : 0;
if (longEdge === 0 || targetWidth == null || targetHeight == null || targetWidth <= 0 || targetHeight <= 0) return 1;
```

(thread `sourceSizeHint` through `pickDownsample`'s options parameter type and
`decodeViewport`). Pure opt-in; absent hint = today's behaviour, so no benchmark gate.

### P3 (P1) — Butteraugli: stop re-mallocing the candidate every compare (Lens 15)

`ButteraugliComparator.compare()` mallocs + frees `pixelSize` per call. The convergence
loop (compare every progressive pass against final) is exactly the repeated-compare
workload — per-call malloc/free churns and fragments the WASM heap. Candidate size is
fixed at construction; allocate once:

```ts
private candPtr = 0;        // lazily allocated, freed in dispose()
compare(candidate: ArrayBuffer | Uint8Array): number {
  if (this.refPtr === 0) throw new Error("ButteraugliComparator has been disposed");
  const pixelSize = butteraugliPixelSize(candidate, this.width, this.height, "ButteraugliComparator.compare");
  if (this.candPtr === 0) this.candPtr = mallocOrThrow(this.module, pixelSize, "Butteraugli candidate");
  const view = copyOrBorrowInput(candidate, false);
  this.module.HEAPU8.set(view.subarray(0, pixelSize), this.candPtr);
  const bits = this.module._jxl_wasm_butteraugli_compare!(this.refPtr, this.candPtr, this.width, this.height);
  if (bits < 0) throw new Error("Butteraugli WASM compare failed");
  return floatFromI32Bits(bits);
}
dispose(): void {
  if (this.candPtr !== 0) { this.module._free(this.candPtr); this.candPtr = 0; }
  if (this.refPtr !== 0)  { this.module._free(this.refPtr);  this.refPtr  = 0; }
}
```

Also in one-shot `computeButteraugli`: one `mallocOrThrow(pixelSize * 2)` instead of two
mallocs (ptr2 = ptr1 + pixelSize) — halves allocator traffic, single free.

### P4 (P2) — `distanceFromQuality` diverges from libjxl's official mapping

Current linear `(100−q)·15/100` gives q90 → d1.5; libjxl/cjxl's
`JxlEncoderDistanceFromQuality` gives q90 → d1.0. Users calibrated against cjxl get
visibly lower quality at the same number. Adopt the official piecewise curve:

```ts
function distanceFromQuality(quality: number | null): number {
  if (quality === null) return 1;
  if (!Number.isFinite(quality)) throw new Error(`Invalid JXL quality: ${quality}`);
  const q = Math.max(0, Math.min(100, quality));
  if (q >= 100) return 0;
  if (q >= 30) return 0.1 + (100 - q) * 0.09;
  return (53 / 3000) * q * q - (23 / 20) * q + 25;
}
```

Behavioural change to output filesize/quality at a given `quality` — note it in the commit
message. (Distance-specified callers are unaffected; the gallery sweeps use effort+distance.)

### P5 (P2) — rgba16 bilinear inner loop: drop the impossible clamp

Bilinear is a convex combination — output of in-range u16 inputs cannot leave
[0, 65535]. `Math.max(0, Math.min(65535, Math.round(...)))` per channel is three calls of
pure overhead in the hottest 16-bit resize loop (the format the RAW pipeline feeds):

```ts
dstView[dstOff + c] = (tl * w00 + tr * w01 + bl * w10 + br * w11 + 0.5) | 0;
```

(`| 0` is exact here: value < 2^31. The rgba8 path already uses fixed-point; this brings
16-bit to parity.)

### P6 (P3) — Nearest-neighbour downsample aliases; offer opt-in box filter

`applyRegionAndDownsample` point-samples (`Math.min(…, x*downsample)`), which shimmers on
foliage/feather detail — precisely the high-frequency content in biodiversity imagery —
and progressive passes re-sample differently, causing visible crawl between paints.
Add `downsampleFilter?: "nearest" | "box"` to `DecoderOptions`, **default `"nearest"`**
(zero behaviour change without opt-in; respects the no-untested-tunables rule). Box path
for the `stride === 4, downsample === 2` case first (sum 4 texels, `>> 2`); fall back to
nearest for other combos. Reject this item rather than make box the default.

### P7 (P3) — `console.log` in `decodeTiledRegionRgba8` / `decodeTileContainerRegion` hot paths

Both log a formatted line per region decode — that's per-tile, per-pan-frame in the viewer,
and string formatting costs more than some of the metrics it reports. The `onMetric`
callback already carries every number in the message. Gate the logs behind a module-level
`let verboseTiming = false` + `export function setVerboseTiming(v: boolean)` (or delete
them — onMetric is the supported channel).

---

## Agent 5 — `packages/jxl-wasm/src/facade.ts` — progressive-saliency features

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Run **after Agent 3/4** land (same file; this agent builds on the Butteraugli comparator
changes).

### X1 (P1) — `ProgressiveConvergenceMeter`: the measurement half of `convergedByteEnd`

The ratified `convergedByteEnd` design (see memory/docs): an offline pass measures where
progressive paints stop being visually distinguishable; the manifest stores the byte
offset; the *stream layer* aborts the download (~50% net savings). The facade's role is
**measurement only** — never aborting, never caching (layer invariants). Build the meter
from existing parts:

```ts
/**
 * Measures visual convergence of successive progressive frames.
 * Feed each "progress"/"final" frame (RGBA8, same dims); returns the
 * Butteraugli distance from the previous frame, or null for the first.
 * Convergence = delta below threshold (e.g. 0.5) for K consecutive passes.
 * Measurement only — abort decisions belong to the stream layer.
 */
export class ProgressiveConvergenceMeter {
  private prevPtr = 0;
  private havePrev = false;
  private constructor(private readonly module: LibjxlWasmModule,
                      private readonly width: number,
                      private readonly height: number) {}

  static async create(width: number, height: number): Promise<ProgressiveConvergenceMeter> {
    const module = await loadLibjxlModule();
    if (!module._jxl_wasm_butteraugli_compare) {
      throw new CapabilityMissing("Convergence meter requires a rebuilt WASM with butteraugli bridge");
    }
    return new ProgressiveConvergenceMeter(module, width, height);
  }

  /** Returns Butteraugli distance to the previous pass, or null on the first pass. */
  pushPass(pixels: ArrayBuffer | Uint8Array): number | null {
    const pixelSize = butteraugliPixelSize(pixels, this.width, this.height, "ProgressiveConvergenceMeter.pushPass");
    if (this.prevPtr === 0) this.prevPtr = mallocOrThrow(this.module, pixelSize * 2, "convergence frames");
    const curPtr = this.prevPtr + pixelSize;
    const view = copyOrBorrowInput(pixels, false);
    this.module.HEAPU8.set(view.subarray(0, pixelSize), curPtr);
    let delta: number | null = null;
    if (this.havePrev) {
      const bits = this.module._jxl_wasm_butteraugli_compare!(this.prevPtr, curPtr, this.width, this.height);
      if (bits < 0) throw new Error("Butteraugli WASM compare failed");
      delta = floatFromI32Bits(bits);
    }
    // current becomes previous: copy within heap (no JS round-trip)
    this.module.HEAPU8.copyWithin(this.prevPtr, curPtr, curPtr + pixelSize);
    this.havePrev = true;
    return delta;
  }

  dispose(): void {
    if (this.prevPtr !== 0) { this.module._free(this.prevPtr); this.prevPtr = 0; }
    this.havePrev = false;
  }
}
```

Recommend callers feed **downsampled** frames (e.g. the existing `applyRegionAndDownsample`
at ds=2): 4× faster Butteraugli with near-identical convergence ordering — Butteraugli is
the slowest op in the pipeline (Lens 15) and this is the single biggest lever on it.
Export from the package index. No wiring into decode events inside the facade — consumers
(offline ingest tool) drive it.

### X2 (P2) — Encoder `onMetric` instrumentation (the dark room, Lens 18)

Decode has `onMetric`; encode has nothing — encode timing (module init, pixel copy,
`enc_finish`, chunk drain) is invisible, yet encode is the ingest cost-center for pyramid
builds. Add `onMetric?: (name: string, value: number) => void` to `EncoderOptions` and emit
from `LibjxlEncoder.chunks()`:

- `encode_finish_ms` — wall time of `_jxl_wasm_enc_finish` (streaming) or the encode FFI call (buffered)
- `encode_chunk_drain_ms` — cumulative drain loop time
- `encode_compressed_bytes` — final compressedBytes (pairs with Agent 2's stats-on-done)

Names follow the existing decode metric style. Pure observability; no behaviour change.

### X3 (P2) — Type the rgb8 encode path honestly

`LibjxlEncoder` compares `this.options.format === "rgb8"` in three places and
`expectedPixelBytes` handles 3 channels — but `PixelFormat` doesn't contain `"rgb8"`, so
either tsc is flagging TS2367 today or a suppression hides a real working feature. Do NOT
add `rgb8` to `PixelFormat` (the decode paths assume 4-channel stride and would lie).
Instead:

```ts
export type EncodePixelFormat = PixelFormat | "rgb8";
// EncoderOptions.format: EncodePixelFormat;
// expectedPixelBytes(width, height, format: EncodePixelFormat, ...)
```

This legalises the existing encode-only code paths without touching decode typing.
Check `tsc` output before/after; if protocol types reference `EncoderOptions["format"]`,
confirm no downstream break (read-only check of dependents is fine).

### X4 (P3) — Deduplicate the thrice-repeated resize+emit block

`eventsProgressive` carries the identical "apply targetResize → rebuild outInfo → build
event → attach regionFallback/region" block three times (flush, synthetic-progress, final),
and `eventsOneShot` a fourth variant. Extract one helper:

```ts
private finalizeFrame(
  rawPixels: { data: Uint8Array; width: number; height: number; region?: Region },
  evInfo: ImageInfo, bpc: 1 | 2 | 4, hasRegion: boolean,
): { outPixels: typeof rawPixels; outInfo: ImageInfo } { ... }
```

~60 lines deleted, one place to maintain the target-resize semantics. Behaviour-preserving
refactor — verify with the existing decode tests before and after.

### X5 (P3) — Future-bridge stub: `colorSpace` decode option (non-Riemannian engine prep)

The colour-constancy engine (LookRenderer, flat log-space model) wants linear or XYB input
rather than display-referred sRGB8. The bridge can't deliver it yet. Following the file's
established pattern for not-yet-bridged options (`preserveIcc`, `preserveMetadata` — typed,
documented as "WASM no-op"), add:

```ts
/**
 * Requested output colour space. @note **WASM no-op** — the current bridge
 * always emits display-referred RGBA. Reserved for the perceptual-constancy
 * pipeline; honoured once the bridge exposes linear/XYB output.
 */
colorSpace?: "srgb" | "linear";
```

Type + doc only. Rejecting is reasonable if you consider speculative option plumbing noise;
the counter-argument is that this file deliberately declares forward contracts this way.

---

## Lens Residue — examined, intentionally NOT proposed (do not implement)

- **Output pixel/chunk buffer pool** — transferred buffers detach (standing rejection R1-2/R2-2/DH-2).
- **Drain/backpressure hooks on JxlEncoder** — wrong layer (R1-1/R2-3).
- **Adaptive HWM on encode drain** — needs benchmark evidence first; E3's latencyMs creates that evidence.
- **Worker-side `createImageBitmap` for sidecar previews** — standing rejection R4-2.
- **Magic-byte validation of pixel chunks in handler** — format validation belongs to libjxl.
- **Caching encoder state across sessions** — workers are stateless between sessions by contract.
- **`compactQueue` threshold tuning** — standing rejection DH-4.
- **Soft-yield mid-encode** — `enc_finish` is synchronous WASM; cannot be interrupted (encode-side budget remains a known, accepted gap — bridge work, out of scope for these files).

---

## What Implementing This Achieves

The correctness tier closes four silent-corruption holes and one contract rupture: the
encode_start schema stops rejecting every real message the pipeline emits (the same P0
class already found on the decode side), null metadata fields validate again, four
unchecked WASM mallocs stop writing to address zero under memory pressure, and the sidecar
path stops encoding 16-bit specimen scans as garbled 8-bit data while silently stripping
their ICC profiles. Alongside these, alpha/bit-depth metadata on progressive events becomes
trustworthy, cancelled encodes stop surfacing phantom errors, and every failure finally
carries a code that distinguishes "rebuild the WASM" from "real bug" — the difference
between a support ticket and a five-second diagnosis.

The performance tier attacks the two places the viewer actually waits. `decodeRegionLod`
currently decodes full-resolution pixels it immediately throws away; one deleted line lets
the existing downsample machinery cut that work by up to 64×, and the `sourceSizeHint`
extension gives thumbnail decodes the same escape. On the measurement side, Butteraugli —
the pipeline's slowest operation — loses its per-call allocation churn and gains a
half-resolution recommendation, while quality→distance mapping aligns with cjxl so tuned
quality numbers mean what photographers expect.

The feature tier turns the encode arm from a black box into the instrument the
progressive-saliency programme needs: encode metrics and compression stats flow up through
`encode_done` into manifests, and the `ProgressiveConvergenceMeter` packages Butteraugli
into the exact offline measurement that `convergedByteEnd` requires — find the byte where
paints stop changing visibly, record it, and let the stream layer cut every subsequent
download in half. Combined with the already-wired center-out group order (`centerX`/
`centerY`, now schema-legal), the pipeline can encode what matters first, prove when
nothing more is worth fetching, and hand LLM/AR recognisers small, early, colour-faithful
frames — the foveated, evidence-driven delivery model the platform's field-identification
and digital-twin ambitions sit on.
