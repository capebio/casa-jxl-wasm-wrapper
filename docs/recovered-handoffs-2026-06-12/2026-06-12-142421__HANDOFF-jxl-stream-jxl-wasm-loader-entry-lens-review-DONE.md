# HANDOFF — jxl-stream + jxl-wasm Loader/Entry Lens Review - DONE

Date: 2026-06-12
Scope:
1. `packages/jxl-stream/src/browser.ts`
2. `packages/jxl-stream/src/node.ts`
3. `packages/jxl-stream/src/index.ts`
4. `packages/jxl-wasm/src/loader.ts`
5. `packages/jxl-wasm/src/index.ts`

## Executive map

These five files form thin but critical transport and bootstrap rim around decode/encode core.

```text
Fetch / Blob / HTTP Range / Node Readable
        |
        v
packages/jxl-stream/browser.ts + node.ts
        |
        v
DecodeSession / EncodeSession contracts
        |
        v
worker/session/facade layers
        |
        v
packages/jxl-wasm/loader.ts
        |
        v
compiled WebAssembly.Module cache
        |
        v
packages/jxl-wasm/index.ts -> facade.ts -> bridge.cpp -> libjxl
```

Strategic truth:
- `jxl-stream` owns byte movement, range windows, aborts, cutoffs, resume safety, and stream-to-session backpressure.
- `jxl-wasm/loader.ts` owns module selection, module compile, persistent cache, and hot-start reuse.
- Both `index.ts` files are API chokepoints. Small files, big consequences. They decide what downstream code can depend on without reaching into internals.

What flows between them:
- `Uint8Array` / `ArrayBuffer` chunk payloads.
- `AbortSignal` and string cancel reasons.
- `RangeNegotiation` metadata: requested bytes, delivered bytes, ETag, full size, timing.
- `JxlWasmManifest` identity: `buildId`, `wasmSha`, `wasmUrl`.
- `WebAssembly.Module` compiled artifact, later consumed by facade/worker layers.

## Chapter 1 — Transport layer: browser stream ingress

Files:
- `packages/jxl-stream/src/browser.ts`
- `packages/jxl-stream/src/index.ts` as public export gate

Public API surface:
- `fromReadableStream`
- `toReadableStream`
- `fromResponse`
- `fromBlob`
- `fromBlobRange`
- `fromByteRange`
- `fromRangePrefix`
- `resumeFromByteRange`
- `createByteRangeResumeState`
- types: `DecodeSession`, `EncodeSession`, `PipeOptions`, `RangeNegotiation`, `RangePrefixOptions`, `ByteRangeResumeState`

Pipeline stage fit:
- Decode ingress only.
- No transform, resize, encode, or cache policy execution here.
- It does prepare cutoffs and resumable metadata that later layers can exploit for cache and progressive return-result behavior.

State machinery:
- Session state: delegated to `push`, `close`, `cancel`.
- Cancellation state: `AbortSignal`, `cancelBoth`, early-abort guards, reader lock cleanup.
- Error state: stringified reason propagation, explicit `RangeError` and HTTP failure paths.
- Queue state: implicit one-ahead prefetch via `pending = read()`.

Data structures:
- `Uint8Array` chunk windows.
- `RangeNegotiation` as byte-delivery receipt.
- `ByteRangeResumeState` as resumable manifest.
- `Headers` merge for Range and If-Range.

Hot kernels:
- Chunk pump loops in `fromReadableStream` and `fromByteRange`.
- Skip-and-trim loop for 200 fallback on ignored Range.
- Small but repeated copy points: `subarray` trims, not full concat.

Boundary points:
- Browser Fetch/ReadableStream -> JS chunk loop.
- JS chunk loop -> session push boundary.
- HTTP headers -> typed range metadata.

Implementation layer recommendations:
1. Extract shared pump primitive only if tests first lock current behavior. Shared code attractive, but skip logic and telemetry plumbing differ enough that premature fusion can hide correctness regressions.
2. Promote `RangeNegotiation` to first-class scheduler signal. Delivered bytes, TTFB, and transfer time should inform future ladder selection, not only diagnostics.
3. Add explicit docs around "this layer may intentionally close on truncated byte goal." That behavior is correct for converged prefixes and sidecar windows, but easy for higher layers to misuse.

## Chapter 2 — Transport layer: Node ingress and egress parity

File:
- `packages/jxl-stream/src/node.ts`

Public API surface:
- `fromNodeReadable`
- `toNodeReadable`
- `BufferedReader`

Pipeline stage fit:
- Decode ingress from filesystem/network streams.
- Encode egress to Node consumers.
- Still no image transform work. This is plumbing around decode/encode sessions.

State machinery:
- Session state mirrors browser path.
- Cancellation state uses `AbortSignal`, `readable.destroy`, and idempotent `session.cancel`.
- Queue state is single outstanding `it.next()` prefetch.
- `BufferedReader` is local buffer state for callers that consume by byte counts rather than chunk boundaries.

Data structures:
- `Readable` async iterator.
- `Buffer` zero-copy views on encode output.
- `BufferedReader` deque: chunk list, `head`, `total`.

Hot kernels:
- `fromNodeReadable` one-ahead chunk loop.
- `BufferedReader.take` spanning-copy path.
- `toNodeReadable` conversion boundary from `ArrayBuffer` to `Buffer`.

Boundary points:
- Node Readable -> JS async iterator.
- JS -> session push / close / cancel.
- Encode session async iterable -> byte-mode Node stream.

Implementation layer recommendations:
1. Keep Node/browser parity as hard rule. Same cutoff semantics, same return type, same abort contract.
2. Treat `BufferedReader` as utility with mutation contract documented explicitly. Current O(1) append shape is right, but retained chunk references mean callers must not mutate appended data.
3. Add dedicated `node.test.ts`. Right now browser range logic is much more exercised conceptually than Node stream lifecycles, yet server-side ingest and tooling depend on them.

Gaming lens:
- Think of `fromNodeReadable` as frame pacing. You want one packet in flight, not burst spam or idle gaps. Smooth pacing beats spikes.

## Chapter 3 — Package gateways and API governance

Files:
- `packages/jxl-stream/src/index.ts`
- `packages/jxl-wasm/src/index.ts`

Public API surface:
- `jxl-stream/index.ts`: re-exports browser and node transport.
- `jxl-wasm/index.ts`: re-exports loader and facade.

Strategic role:
- These files are import ergonomics layer.
- They are also contract-stability layer. Re-export shape defines what downstream packages think is "official".

Findings:
- Strength: both gateways are minimal and low-drift.
- Risk: `jxl-wasm/index.ts` re-exports much wider surface through `facade.ts` than `loader.ts` alone suggests. Consumers can easily bind directly to WASM-facing details instead of stable higher-level abstractions.
- Risk: `jxl-stream/index.ts` merges browser and node APIs into one surface. Good for convenience, but requires discipline in docs and tests so browser-only and node-only functions stay clearly separated.

Implementation layer recommendations:
1. Freeze explicit export policy. Decide which symbols are stable package contract versus internal convenience.
2. Add API inventory tests or generated docs from these two entrypoints. Cheap way to catch accidental export drift.
3. Consider subpath exports for `@casabio/jxl-stream/browser` and `@casabio/jxl-stream/node` if environment separation starts mattering for bundle size or docs clarity.

Astronomy lens:
- These index files are observatory domes. Small doors, huge effect. If doors point telescope wrong way, whole system studies wrong sky.

## Chapter 4 — WASM bootstrap, compile cache, and module identity

File:
- `packages/jxl-wasm/src/loader.ts`

Public API surface:
- `loadJxlModule`
- types: `JxlWasmManifest`, `LoaderOptions`

WASM binding relevance:
- This file does not expose decode/encode calls itself.
- It is still one of main JS ↔ WASM boundaries because it decides which bytes become compiled `WebAssembly.Module`, where they come from, and how often compilation repeats.

State machinery:
- Node cache: `Map<string, Promise<WebAssembly.Module>>`
- Browser cache: in-memory promise memo + IndexedDB persistence
- Error state: missing `wasmUrl`, bad fetch, bad compile, IDB unavailable

Data structures:
- Cache key: `${buildId}:${wasmSha}`
- `LoaderOptions`: `fetchImpl`, `idbFactory`, `nodeFs`, `cacheDbName`, `wasmUrl`
- IDB record: `{ key, module }`

Hot kernels:
- Not pixel hot path.
- Startup hot path: fetch, compileStreaming, compile fallback, IDB open/get/put.
- Memory hot point: avoiding `response.clone()` during compile fallback is smart and should stay.

Boundary points:
- URL / filesystem -> raw wasm bytes.
- Raw bytes -> `WebAssembly.Module`.
- `IndexedDB` structured clone of module.
- Module -> later facade instantiation path.

Implementation layer recommendations:
1. Split compile-path telemetry from decode telemetry. Loader startup latency deserves its own metric family because cold compile and hot reuse dominate perceived app boot.
2. Make cache invalidation intent explicit in docs: `buildId + wasmSha` is content identity, not feature identity. Good design. Protect it.
3. Add fault-injection tests for IndexedDB read/write failure, fetch fallback, and `file://` path resolution. This file is mostly edge handling; edge handling needs direct tests.

Owl lens:
- Near view: promise caches are correct and prevent compile stampede.
- Far view: loader is quiet strategic asset. It determines whether multithreaded/perf wins actually appear in user sessions or die in repeated cold starts.

## Chapter 5 — Pipeline truth: what these files do not do

Requested pipeline stages:
- Decode
- Transform
- Resize
- Encode
- Cache
- Return result

Actual coverage in this scope:
- Decode: yes, transport into decode session.
- Transform: no.
- Resize: no.
- Encode: only egress wrapping for encode session chunks.
- Cache: loader caches compiled wasm module; transport layer emits metadata useful for cache decisions but does not own image cache itself.
- Return result: yes, via streams and session completion.

Important architectural guardrail:
- Do not stuff image math into these files.
- Non-Riemannian perceptual color work, Butteraugli acceleration, photogrammetry math, and AR inference do not belong here directly.
- These files should facilitate them by reducing startup latency, cutting byte waste, exposing timing, and preserving progressive responsiveness.

## Chapter 6 — Product-facing extensions these layers can enable

LLM / machine recognition lens:
- `fromBlobRange` and `fromByteRange` enable cheap prefix and tile fetches for quick embeddings, thumbnail classifiers, and "recognize before full decode" workflows.
- `RangeNegotiation` timing can become training data for adaptive fetch policy selection.
- Resume state can support interrupted field capture sessions where classifier and viewer share same partial asset.

Photogrammetry / digital twin lens:
- Exact byte-window transport is foundation for pyramid and tile workflows.
- Loader cache reduces time-to-first-analysis across repeated specimen views.
- Missing next step: manifest-aware multi-window orchestration above this layer, not inside it.

AR plant recognition lens:
- Fast first paint matters more than full decode. These files help by honoring cutoffs, aborts, and resumable prefixes.
- Needed follow-up above this layer: scheduler should prioritize center-frame / on-screen tile windows and classifier-sized previews first.

Gaming lens:
- Treat byte budget like render budget.
- Prioritize first interactive frame, then stream fidelity upgrades.
- Use `priority: 'high' | 'low' | 'auto'` like asset streaming priority tiers.

Astronomy lens:
- Browser/node stream providers are sensor feeds.
- Loader cache is observatory warm state.
- Range fetch is windowed telescope readout: inspect exact sky patch without downloading whole universe.

## Chapter 7 — Butteraugli and perceptual color implications

Butteraugli lens:
- These files will not make Butteraugli itself faster.
- They can reduce how often Butteraugli-heavy flows block user-visible work by:
- separating startup cost from encode cost,
- enabling earlier preview-side decisions from partial bytes,
- allowing scheduler to stop fetching after converged visual prefix,
- making encode-side sidecars/prefixes cheaper to consume.

Perceptual constancy / non-Riemannian color lens:
- Keep color engine in Rust/WASM render pipeline, not here.
- What these files should expose to help:
- stable progressive paints,
- low-latency module hot reuse,
- predictable abort and resume semantics,
- metrics for first-paint versus final-paint timing.

Concrete facilitation path:
1. Loader publishes cold/hot compile timing.
2. Session layer publishes progressive frame timing.
3. Lightbox can decide when to apply expensive perceptual math versus coarse preview.

## Chapter 8 — Reversal findings: run film backwards

Four findings from reversing failure back to cause:

1. If user sees "progressive paint feels random", trace backward: likely not color math first. More likely byte-window policy, abort timing, or range-ignore fallback causing wasted early bytes.
2. If multithreaded WASM seems to "exist but not matter", trace backward: usually loader identity, startup cold path, or worker-tier routing above this file set, not libjxl core throughput.
3. If offline/field workflow feels brittle, trace backward: resume metadata and cache boundaries matter before classifier quality matters.
4. If future AR recognition loop misses real-time target, trace backward: first bottleneck likely transport prioritization and warm module reuse, not final decode fidelity.

## Chapter 9 — Gaps left unilluminated

Three biggest dark rooms outside this review:

1. `packages/jxl-wasm/src/facade.ts` and `packages/jxl-wasm/src/bridge.cpp`
Why: real JS ↔ WASM call frequency, copy behavior, progressive event cadence, and decode/encode option honoring live there.

2. Worker/session orchestration above transport
Why: queue state, session lifetime, cancellation races, pool admission, and progress fan-out are mostly in scheduler/worker packages, not in these five files.

3. `crates/raw-pipeline/src/pipeline.rs` and hot per-pixel loops
Why: all non-Riemannian color, perceptual constancy, SIMDed LUT plans, and photogrammetry-grade transform performance live there, not in stream/loader gateways.

## Chapter 10 — Support code, observability, and tests

Support code present:
- validation: numeric range checks, finite checks, URL/path checks
- logging: minimal
- progress: `RangeNegotiation`, session close/cancel semantics
- tests: implied by surrounding repo, but these files still deserve stronger direct coverage

Recommended test matrix:
1. Browser range happy path, ignore-range fallback, ETag mismatch, zero-length chunks, exact-boundary trim.
2. Node readable abort, string-chunk misuse, max-bytes trim, consumer destroy on `toNodeReadable`.
3. Loader cold compile, hot memo hit, IDB hit, IDB miss, compileStreaming fallback, `file://` resolution.
4. Entry-point export snapshot tests for both `index.ts` files.

Logging/metrics recommendations:
- Add cold/hot loader counters.
- Distinguish abort reason classes: user abort, maxBytes satisfied, network failure, protocol mismatch.
- Record bytes skipped on 200 fallback Range-ignored flows.

## Deferred and rejected ideas for this layer

Keep deferred unless benchmarked and test-locked:
- shared pump-loop abstraction across all browser paths
- per-origin Range-capability memo
- multi-range coalescing helper in transport layer
- bundle more logic into package entrypoints

Reject for this layer:
- pushing Butteraugli compute into stream/loader code
- placing perceptual color transforms in transport loops
- mixing cache manifests or tile schedulers into `loader.ts`
- adding speculative chunk concat in JS without benchmark proof

Reason:
- These changes would violate separation of concerns and likely worsen first-paint latency or maintenance cost.

## Bird's-eye close

Connectivity pattern stands out: these files are not deep logic centers, but they are leverage centers. They decide byte pacing, compile reuse, and package contract shape. Small mistakes here amplify across every decode session.

What feels strongest:
- explicit contracts
- low ceremony
- cautious memory behavior
- good use of subarray/view semantics

What stands out as next improvement:
- tighter observability
- harder contract tests
- clearer public API boundaries
- better formal link from transport metrics to scheduler policy

## What implementing these suggestions achieves

Implementing this handoff would make stream ingress and WASM bootstrap much more predictable under real workload pressure. Browser and Node paths would behave like one coherent transport subsystem, range and resume semantics would become reliable foundations for progressive and offline workflows, and compiled-module reuse would turn cold-start cost into an explicitly managed resource instead of a hidden tax. That directly improves first paint, restart recovery, and repeated-view responsiveness without contaminating these layers with image math that belongs elsewhere.

It would also give higher layers better raw material for smart behavior. A scheduler or lightbox above these files could make evidence-based decisions about byte cutoffs, tile prioritization, and preview-versus-final timing because the transport and loader layers would expose clean timing, delivery, and module-identity signals. That is what enables better LLM-assisted recognition, pyramid-driven photogrammetry, and AR-first plant identification: not by forcing those features into these files, but by making these files trustworthy, measurable infrastructure.

Finally, this organization reduces implementation risk. Each chapter maps to a clear worker skill set: transport correctness, Node parity, API governance, loader/cache resilience, product-enabling telemetry, and cross-layer defer/reject rules. A skilled worker can pick up one chapter, implement it without guessing at adjacent responsibilities, and leave the system more cohesive instead of more entangled.
