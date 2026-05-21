# State - jxl-capabilities

## Tasks Complete
- [x] Package initialization (package.json, tsconfig.json)
- [x] Implement capability detection in `src/index.ts`
- [x] Implement Relaxed SIMD runtime probe
- [x] Add README.md with capability descriptions

## Current Subtask
- None

## Next Subtask
- None (T-CAPS Complete)

## Decisions Made
- Using inlined WASM probes for SIMD, Threads, and Relaxed SIMD to ensure the probe works even if `wasm-feature-detect` is not yet available or configured.
- `selectedWasmBuild` logic follows Section 6.1 preference order.

## Blockers Encountered
- None.

## Files Touched
- `packages/jxl-capabilities/package.json`
- `packages/jxl-capabilities/tsconfig.json`
- `packages/jxl-capabilities/src/index.ts`
- `packages/jxl-capabilities/README.md`
- `packages/jxl-capabilities/STATE.md`
- `packages/jxl-capabilities/DECISIONS.md`
