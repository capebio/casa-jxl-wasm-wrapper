# jxl-core — STATE.md

## Status: COMPLETE

## Tasks complete
- [x] src/types.ts — full Section 5 API surface
- [x] src/errors.ts — JxlError + JxlErrorCode (Section 18)
- [x] src/protocol.ts — worker message union types (Section 16)
- [x] src/schemas/ — JSON Schemas: decode_start, encode_start, decode_header, worker_ready
- [x] package.json — ESM, exports map, sideEffects: false, TS 5.5.4 pinned
- [x] tsconfig.json — strict, moduleResolution: bundler, ES2022
- [x] tsc — passes with 0 errors
- [x] README.md, DECISIONS.md, CHANGELOG.md written

## Decisions made
See DECISIONS.md. Key: format_downcast + region_fallback_full_frame added to CodecMetric; exactOptionalPropertyTypes enforced; verbatimModuleSyntax on.

## Blockers
None.

## Files touched
- packages/jxl-core/src/types.ts
- packages/jxl-core/src/errors.ts
- packages/jxl-core/src/protocol.ts
- packages/jxl-core/src/index.ts
- packages/jxl-core/src/schemas/decode_start.json
- packages/jxl-core/src/schemas/encode_start.json
- packages/jxl-core/src/schemas/decode_header.json
- packages/jxl-core/src/schemas/worker_ready.json
- packages/jxl-core/package.json
- packages/jxl-core/tsconfig.json
- packages/jxl-core/README.md
- packages/jxl-core/DECISIONS.md
- packages/jxl-core/CHANGELOG.md

## Next subtask
T-WORKER-BROWSER (depends on jxl-core artifacts above)
