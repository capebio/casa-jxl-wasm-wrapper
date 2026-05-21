# jxl-worker-browser — BLOCKED.md

## B-001 WASM module (T-WASM-BUILD pending)

`src/wasm-loader.ts` is a stub. The real WASM artifact from T-WASM-BUILD is required before decode and encode sessions can do real codec work. `loadWasmModule()` will throw with a clear message until the artifact is present.

**Resolution:** Once T-WASM-BUILD lands its `dist/jxl-core.*.wasm` + JS glue, implement the real loader per spec Section 6.8 (compileStreaming + IndexedDB compiled-module cache).

## B-002 Decode implementation (T-DECODE-WASM pending)

`DecodeHandler.run()` is a stub that emits one placeholder header then fails. Real decode loop (JxlDecoder event subscription, flush on frame progression, region/downsample support) is provided by T-DECODE-WASM.

## B-003 Encode implementation (T-ENCODE-WASM pending)

`EncodeHandler.run()` is a stub. Real encode loop provided by T-ENCODE-WASM.
