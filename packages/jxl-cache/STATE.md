# State - jxl-cache

## Tasks Complete
- [x] Package initialization (package.json, tsconfig.json)
- [x] Implement LRU base class with eviction and `getOldestKey`
- [x] Implement Browser persistent layer (OPFS)
- [x] Implement Node persistent layer (fs/promises)
- [x] Implement unified `createJxlCache` factory
- [x] Add README.md

## Current Subtask
- None

## Next Subtask
- None (T-CACHE Complete)

## Decisions Made
- `LRUCache` uses a `Map` to track insertion order for O(1) LRU management.
- Browser persistent layer (OPFS) maintains an internal `LRUCache<null>` to track item sizes and access order, as OPFS doesn't natively provide easy LRU metadata.
- Node persistent layer does not implement default eviction per spec, but respects the memory limit for the hot layer.

## Blockers Encountered
- None.

## Files Touched
- `packages/jxl-cache/package.json`
- `packages/jxl-cache/tsconfig.json`
- `packages/jxl-cache/src/lru.ts`
- `packages/jxl-cache/src/browser.ts`
- `packages/jxl-cache/src/node.ts`
- `packages/jxl-cache/src/index.ts`
- `packages/jxl-cache/README.md`
- `packages/jxl-cache/STATE.md`
- `packages/jxl-cache/DECISIONS.md`
