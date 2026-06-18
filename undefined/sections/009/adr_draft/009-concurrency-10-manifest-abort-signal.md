# ADR: fetchAndCacheManifest AbortSignal parameter

**Task:** 009-concurrency-10
**Status:** proposed

## Context

`fetchAndCacheManifest` previously accepted no `AbortSignal`. Manifest fetches could not be cancelled when the gallery was destroyed or a job was unobserved, leaking in-flight network requests.

## Decision

Added an optional `signal?: AbortSignal` parameter to `fetchAndCacheManifest`. Callers (`startDecode`) now thread the job's `AbortController.signal` through. A 10 s internal timeout controller is always created; the caller signal is linked to it via `addEventListener("abort", ...)` so either abort source cancels the fetch.

## Consequences

- Manifest fetches are now cancellable on destroy/unobserve.
- `inFlightManifestFetches` is still decremented in `finally` on abort, so the counter stays accurate.
- `prefetchManifest` does not yet thread a signal (it fires void; abort is implicit via job removal from `jobs`). A follow-up could pass the abort signal there too.
- Abort errors return `null` (non-fatal); only non-abort errors are rethrown so callers can distinguish transient from permanent failures.
