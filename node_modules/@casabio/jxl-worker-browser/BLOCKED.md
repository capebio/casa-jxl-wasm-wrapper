# jxl-worker-browser — BLOCKED.md

## B-001 WASM codec facade (T-WASM-BUILD pending)

`src/wasm-loader.ts` now accepts a package-level codec facade and validates `createDecoder/createEncoder`. The real WASM artifact from T-WASM-BUILD still must export that facade before decode and encode sessions can do real codec work.

**Resolution:** Once T-WASM-BUILD lands its `dist/jxl-core.*.wasm` + JS glue, expose `createDecoder/createEncoder` from `@casabio/jxl-wasm`, with compileStreaming + IndexedDB compiled-module cache behind that facade.

## B-002 WASM decoder facade adapter (T-WASM-BUILD pending)

`DecodeHandler.run()` now drives a `JxlModule.createDecoder()` facade and forwards header/progress/final/error/budget events. Real JxlDecoder event subscription, `JxlDecoderFlushImage`, region/downsample handling, and metadata extraction still require the generated `jxl-wasm` adapter from T-WASM-BUILD.

## B-003 WASM encoder facade adapter (T-WASM-BUILD pending)

`EncodeHandler.run()` now drives a `JxlModule.createEncoder()` facade and streams first-byte/chunk/done messages. Real `JxlEncoderFrameSettings`, `JxlEncoderAddImageFrame`, `JxlEncoderAddChunkedFrame`, output processor, and metadata box attachment still require the generated `jxl-wasm` adapter from T-WASM-BUILD.
