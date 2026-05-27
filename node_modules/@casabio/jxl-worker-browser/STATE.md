# jxl-worker-browser — STATE.md

## Status: COMPLETE (handler facade loops in place; real codec adapter blocked on T-WASM-BUILD)

## Tasks complete
- [x] src/worker.ts — message router, session maps, shutdown logic
- [x] src/spawn.ts — WorkerHandle, spawnWorker(), shutdown with timeout
- [x] src/wasm-loader.ts — facade validation and clear capability errors, blocker B-001
- [x] src/decode-handler.ts — facade-driven decode loop, blocker B-002 now in jxl-wasm adapter
- [x] src/encode-handler.ts — facade-driven encode loop, blocker B-003 now in jxl-wasm adapter
- [x] package.json, tsconfig.json
- [x] tsc --noEmit passes clean
- [x] BLOCKED.md, DECISIONS.md, CHANGELOG.md

## Blockers
- B-001: WASM codec facade/artifact (T-WASM-BUILD)
- B-002: WASM decoder facade adapter (T-WASM-BUILD)
- B-003: WASM encoder facade adapter (T-WASM-BUILD)

## Files touched
- packages/jxl-worker-browser/src/worker.ts
- packages/jxl-worker-browser/src/spawn.ts
- packages/jxl-worker-browser/src/wasm-loader.ts
- packages/jxl-worker-browser/src/decode-handler.ts
- packages/jxl-worker-browser/src/encode-handler.ts
- packages/jxl-worker-browser/src/index.ts
- packages/jxl-worker-browser/package.json
- packages/jxl-worker-browser/tsconfig.json

## Next subtask
T-WORKER-NODE
