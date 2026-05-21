# State - jxl-test-corpus

## Tasks Complete
- [x] Package initialization (package.json, tsconfig.json)
- [x] Define manifest types and scaffold `loader.ts`
- [x] Add sample manifest and PGO manifest
- [x] Implement platform-agnostic loader (Node/Browser)
- [x] Add README.md

## Current Subtask
- None

## Next Subtask
- None (T-CORPUS Complete)

## Decisions Made
- Used `import.meta.url` in `loader.ts` to derive relative paths to fixtures, supporting both ESM Node and modern browsers.
- SHA-256 verification included in `fetchLargeFixture`.

## Blockers Encountered
- Real JXL fixtures are not yet present in the repo; they need to be vendored into `packages/jxl-test-corpus/src/fixtures/` before tests can pass.

## Files Touched
- `packages/jxl-test-corpus/package.json`
- `packages/jxl-test-corpus/tsconfig.json`
- `packages/jxl-test-corpus/src/types.ts`
- `packages/jxl-test-corpus/src/manifest.ts`
- `packages/jxl-test-corpus/src/loader.ts`
- `packages/jxl-test-corpus/src/index.ts`
- `packages/jxl-test-corpus/pgo-manifest.json`
- `packages/jxl-test-corpus/README.md`
- `packages/jxl-test-corpus/STATE.md`
- `packages/jxl-test-corpus/DECISIONS.md`
