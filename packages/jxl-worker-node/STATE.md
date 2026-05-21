# jxl-worker-node — STATE.md

## Status: COMPLETE (stubs; blocked on T-NATIVE-BIND, T-WASM-BUILD, T-DECODE-NATIVE, T-ENCODE-NATIVE)

## Tasks complete
- [x] src/worker.ts — message router, session maps, shutdown
- [x] src/spawn.ts — WorkerHandle, spawnWorker()
- [x] src/backend-selector.ts — native/WASM selection with JXL_FORCE_WASM env var
- [x] src/decode-handler.ts — state machine shell (stub)
- [x] src/encode-handler.ts — state machine shell (stub)
- [x] package.json, tsconfig.json
- [x] tsc --noEmit passes clean

## Blockers
- B-001: @casabio/jxl-native (T-NATIVE-BIND)
- B-002: @casabio/jxl-wasm for Node (T-WASM-BUILD)
- B-003: Decode impl (T-DECODE-NATIVE)
- B-004: Encode impl (T-ENCODE-NATIVE)

## Next subtask
T-SCHEDULER
