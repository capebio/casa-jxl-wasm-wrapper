# @casabio/jxl-core

Pure TypeScript contract package for the Casabio JXL wrapper. No runtime code — types, error classes, worker protocol types, and JSON Schemas only.

## Contents

| File | Purpose |
|---|---|
| `src/types.ts` | All public-facing TypeScript types (Section 5 of spec) |
| `src/errors.ts` | `JxlError` class and `JxlErrorCode` enum |
| `src/protocol.ts` | Worker message union types (Section 16 of spec) |
| `src/schemas/*.json` | JSON Schema drafts for key protocol messages |

## Design Decisions

Recorded in `DECISIONS.md`. Key choices:

- **`format_downcast` and `region_fallback_full_frame` added to `CodecMetric`.**
  The spec mentions these metrics in Sections 8 and 9 but does not list them in the `CodecMetric` union in Section 5. The more restrictive option is to include them so implementations have a typed surface. Noted here for review.

- **`ContextOptions` and `CacheOptions` included in `types.ts`.**
  Section 5 mentions `ContextOptions` by name in the `createBrowserContext` / `createNodeContext` signatures without defining its shape beyond prose in Sections 12 and 14. Shape derived from spec prose; prefer the restrictive set of fields.

- **`MsgReleaseState` included in protocol.**
  Present in the existing `jxl-worker.js` codebase (`release_state` handler). Carried forward as it is part of the live protocol.

- **`verbatimModuleSyntax: true` in tsconfig.**
  Forces explicit `import type` for type-only imports. Prevents accidental value imports from a types-only package. Strict choice aligned with spec intent.

- **`exactOptionalPropertyTypes: true`.**
  All optional fields on interfaces are either absent or a defined value; they cannot be explicitly set to `undefined`. This is stricter than the TypeScript default. Noted in case downstream implementations hit edge cases.

## Usage

```ts
import type { DecodeOptions, ImageInfo } from "@casabio/jxl-core";
import type { MsgDecodeStart } from "@casabio/jxl-core/protocol";
import { JxlError } from "@casabio/jxl-core/errors";
```

This package has no runtime exports beyond `JxlError`. All other exports are types.

## Not in scope

- WASM loading, worker spawning, session management — those live in `jxl-worker-browser`, `jxl-worker-node`, `jxl-session`, `jxl-scheduler`.
- Any dependency on `@jsquash/jxl` (prohibited by spec Section 3).
