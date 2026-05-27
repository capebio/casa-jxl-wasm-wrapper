# jxl-worker-node — STATE.md

## Status: COMPLETE (handler facade loops in place; real codec adapter blocked on T-NATIVE-BIND/T-WASM-BUILD)

## Tasks complete
- [x] src/worker.ts — message router, session maps, shutdown
- [x] src/spawn.ts — WorkerHandle, spawnWorker()
- [x] src/backend-selector.ts — native/WASM selection with JXL_FORCE_WASM env var and facade validation
- [x] src/decode-handler.ts — backend facade decode loop
- [x] src/encode-handler.ts — backend facade encode loop
- [x] package.json, tsconfig.json
- [x] tsc --noEmit passes clean

## Blockers
- B-001: @casabio/jxl-native (T-NATIVE-BIND)
- B-002: @casabio/jxl-wasm for Node (T-WASM-BUILD)
- B-003: Native decoder facade adapter (T-NATIVE-BIND)
- B-004: Native encoder facade adapter (T-NATIVE-BIND)

## Next subtask
T-SCHEDULER
