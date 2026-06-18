# Task 016-contracts-7

**Finding:** wasm.createDecoder is called with progressiveDetail conditionally spread, but the JxlModule interface always includes the field as optional - the conditional spread is unnecessary and confusing — packages/jxl-worker-browser/src/decode-handler.ts:244-250

**Status:** deferred

**Tests before:** pass (29/29)

**Tests after:** N/A

## Deferral Reason

The conditional spread `...(this.opts.progressiveDetail !== null ? { progressiveDetail: this.opts.progressiveDetail } : {})` is actually **necessary** because the type signature forbids passing `undefined` for an optional field when `exactOptionalPropertyTypes: true` is enabled in tsconfig. The TypeScript error "is not assignable to type ... undefined" occurs when passing `progressiveDetail: undefined` explicitly. The conditional spread omits the field entirely when the value is null, which is the correct pattern for this TypeScript strictness mode. The finding misidentifies this as "unnecessary"—it is in fact the only correct approach.
