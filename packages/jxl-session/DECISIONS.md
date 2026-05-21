# jxl-session — DECISIONS.md

## D-001 JxlContext defined in jxl-session, not jxl-core

Spec Section 5 shows `JxlContext` and `createBrowserContext`/`createNodeContext` under a `// jxl-session/src/index.ts` comment. jxl-core is a types-only contract package with no facade. `JxlContext` is a facade interface — defined in `src/context.ts` here. `ContextOptions` stays in jxl-core (it is a plain config shape referenced by the contract).

## D-002 capabilities() is sync; the probe is async

Spec: `capabilities(): Capabilities` (sync) and `createBrowserContext(opts?): JxlContext` (sync). Gemini's `getCapabilities()` is async (WASM instruction probes). Resolution: the context returns a conservative default `Capabilities` immediately and kicks off the async probe; `capabilities()` returns the cached value, which updates once the probe resolves. Callers needing the probed value should call `capabilities()` after a tick, or treat the default as a floor. Recorded as a known race.

## D-003 sourceKey is null — dedupe disabled at the session layer

Scheduler dedupe (Section 12.4) keys on "URL hash or content hash". `DecodeOptions`/`EncodeOptions` carry no source identity, so the session facade passes `sourceKey: null`. Dedupe + fan-out are fully implemented in jxl-scheduler but unreachable from this layer. The T-INT web integration — which holds the source URL/bytes — should pass a real `sourceKey`. This needs either a new `DecodeOptions.sourceKey` field or a separate context method. Noted in BLOCKED.md B-001.

## D-004 Budget breach rejects done(), frames() still yields the partial

On `decode_budget_exceeded`: the partial frame is pushed to `frames()` (so consumers see the best frame), the frame stream ends, and `done()` rejects with `JxlError("BudgetExceeded")` carrying `partial`. Rationale: `done()` is documented to resolve on *final completion*; a budget stop is not final. The error carries the partial so callers have one failure path with the data attached.

## D-005 ICC/EXIF/XMP copied, not transferred, in encode_start

Spec Section 16.2 calls `iccProfile` transferable. But `scheduler.acquireSlot()` sends the start message with no transfer list. ICC/EXIF/XMP are small (KB range); structuredClone copy cost is negligible. Pixel chunks (large) ARE transferred via `scheduler.send(..., [ab])`. If a future need arises, add a transfer list to the scheduler's start-message path.

## D-006 Worker packages loaded via dynamic import()

`createBrowserContext` dynamically imports `@casabio/jxl-worker-browser`; `createNodeContext` imports `@casabio/jxl-worker-node`. Keeps `node:worker_threads` out of browser bundles and `DedicatedWorker` out of node bundles, even before tree-shaking. The scheduler's `WorkerFactory` is already `() => Promise<WorkerHandle>`, so async import fits naturally.

## D-007 Encode defaults: effort 4, distance 1.0

`EncodeOptions.effort` is optional; `encode_start` requires 1-9. Default 4 (viewer-quality midpoint per Section 11.3) when no policy is applied. When the caller supplies neither `distance` nor `quality`, default `distance` to 1.0 (a reasonable libjxl visually-lossless-ish point). If `quality` is given, `distance` is sent as null and the worker maps it via `JxlEncoderDistanceFromQuality`.

## D-008 Pool sizing uses navigator.hardwareConcurrency for both surfaces

Section 12.1: browser `min(4, hardwareConcurrency-1)`, server `cpus().length-1`. Node >= 21 exposes `globalThis.navigator.hardwareConcurrency`, which equals `cpus().length`. Using it for both avoids importing `node:os` into a file that browsers also load. Falls back to 4 if `navigator` is absent.

## D-009 WorkerHandle cast at the factory boundary

The worker packages' `WorkerHandle` and the scheduler's `WorkerHandle` differ only in the `send` transfer-list param type (`Transferable[]` / `unknown[]` vs `ArrayBuffer[]`). Structurally compatible; an `as unknown as` cast at the factory return keeps the boundary explicit without weakening either package's own types.
