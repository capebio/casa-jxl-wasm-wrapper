# jxl-worker-node — BLOCKED.md

## B-001 jxl-native not available (T-NATIVE-BIND pending)

`backend-selector.ts` tries `import('@casabio/jxl-native')` and only selects it when the module or loaded binding exposes `createDecoder/createEncoder`. Runtime falls through to WASM when the package exists but lacks the codec facade.

## B-002 jxl-wasm not available for Node (T-WASM-BUILD pending)

`backend-selector.ts` tries `import('@casabio/jxl-wasm')` and only selects it when the module exposes `createDecoder/createEncoder`. Runtime reports `CapabilityMissing` when neither backend has a usable facade.

## B-003 Native decoder facade adapter (T-NATIVE-BIND pending)

`DecodeHandler.run()` now drives a backend `createDecoder()` facade, forwards the shared protocol, and emits Buffer pixels on the Node side. Real libjxl decoder calls still require the `jxl-native` binding to expose that facade.

## B-004 Native encoder facade adapter (T-NATIVE-BIND pending)

`EncodeHandler.run()` now drives a backend `createEncoder()` facade and streams Buffer chunks plus done messages. Real libjxl encoder calls still require the `jxl-native` binding to expose that facade.
