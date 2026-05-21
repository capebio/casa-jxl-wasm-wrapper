# jxl-worker-node — DECISIONS.md

## D-001 process.exit(0) on shutdown

Spec says "drain, cancel, release, exit." Using `process.exit(0)` after ack since the worker is a dedicated worker_threads thread. Alternative is letting the event loop drain, but codec cleanup may leave handles open. Exit is explicit and matches the browser worker's `self.close()`.

## D-002 No nested thread pool

Per spec Section 7.3: "do not spawn nested libjxl thread pools unless the caller opts in." The handler stubs will not pass thread count to native libjxl. The worker thread itself is the unit of concurrency.

## D-003 Buffer on input and output

Spec Section 15.2: "accept Buffer and Uint8Array interchangeably on input; emit Buffer on output." Implemented in DecodeHandler.onChunk() with Buffer.from conversion. Output from real T-DECODE-NATIVE impl must emit Buffer, not ArrayBuffer, for zero-copy into Node streams.

## D-004 @ts-ignore for not-yet-published packages

The `@casabio/jxl-native` and `@casabio/jxl-wasm` packages don't exist yet. Dynamic imports guarded by `.catch(() => null)` handle runtime absence. The `@ts-ignore` comments are the least invasive escape hatch; they should be replaced with proper type declarations once the packages land.
