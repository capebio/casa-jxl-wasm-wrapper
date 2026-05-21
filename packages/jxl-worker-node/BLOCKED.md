# jxl-worker-node — BLOCKED.md

## B-001 jxl-native not available (T-NATIVE-BIND pending)

`backend-selector.ts` tries `import('@casabio/jxl-native')`. Will return null until T-NATIVE-BIND publishes the package. Runtime will fall through to WASM attempt, then fail.

## B-002 jxl-wasm not available for Node (T-WASM-BUILD pending)

`backend-selector.ts` tries `import('@casabio/jxl-wasm')`. Will return null until T-WASM-BUILD publishes the Node-compatible WASM glue (compile-once path per spec Section 6.8).

## B-003 Decode implementation (T-DECODE-NATIVE pending)

`DecodeHandler.run()` is a stub.

## B-004 Encode implementation (T-ENCODE-NATIVE pending)

`EncodeHandler.run()` is a stub.
