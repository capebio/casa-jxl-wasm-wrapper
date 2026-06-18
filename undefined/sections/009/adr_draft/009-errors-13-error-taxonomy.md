# ADR: Structured Error Taxonomy for ProgressiveGallery

**Task:** 009-errors-13
**Status:** proposed

## Context

The `onError` callback receives a generic `Error` for all failure modes: network errors, `ManifestValidationError`, hash verification failures, and `HttpError`. Callers must parse `e.message` strings to distinguish permanent from transient errors and cannot programmatically gate retry logic or UI messaging.

## Decision

Introduce a `ProgressiveLoadError` base class with a `kind` discriminant:

```typescript
export type ProgressiveErrorKind =
  | "network"       // transient HTTP / TCP failure
  | "manifest"      // ManifestValidationError or JSON parse failure
  | "hash"          // SHA-256 mismatch
  | "abort"         // operation cancelled
  | "timeout"       // manifest/fetch timeout
  | "unknown";

export class ProgressiveLoadError extends Error {
  constructor(
    public readonly kind: ProgressiveErrorKind,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ProgressiveLoadError";
  }
}
```

Wrap errors at the boundary in `startDecode` catch block before passing to `onError`.

## Consequences

- Breaking change to `onError` signature only if callers `instanceof`-check against `Error` subclasses — mitigation: keep `ProgressiveLoadError extends Error`.
- `HttpError` (already a typed subclass) is wrapped into `kind: "network"` with `cause` preserving the original.
- `ManifestValidationError` maps to `kind: "manifest"`.
- Callers can now gate `kind === "manifest"` as permanent (no retry) vs `kind === "network"` as transient.
- Deferred: requires audit of all `onError` callers before shipping.
