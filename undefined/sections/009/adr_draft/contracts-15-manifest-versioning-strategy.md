# ADR: Manifest versioning and client negotiation strategy

**Finding:** contracts-15
**File:** packages/jxl-progressive/src/progressive-manifest.ts

## Status
Proposed

## Context

`migrateManifest` currently throws `ManifestValidationError` for any version > 1. There is no migration path and no version negotiation protocol for clients. As the manifest schema evolves (Phase 8 fields, future channel descriptors, capture geometry), clients that are out of date will throw on valid future manifests instead of gracefully degrading.

## Current behavior

```typescript
if (typeof v === "number" && v > 1) {
  throw new ManifestValidationError(
    `Cannot migrate manifest version ${v} (only version 1 supported)`,
    "version",
  );
}
```

A client running v1 code that receives a v2 manifest from an updated server will throw and produce no frames.

## Decision Options

**Option A — Throw on unknown version (status quo):** Fail loudly. Easy to diagnose but breaks older clients on every schema bump.

**Option B — Tolerate unknown versions, attempt v1 parse:** Treat version > 1 as a forward-compatible superset and try `validateManifest` anyway. Fails if the server removed a required v1 field. Produces no guarantees about correctness.

**Option C — Server-negotiated version via Accept header (recommended for long-term):** The client advertises `X-JXL-Manifest-Version: 1` in manifest fetch requests. The server responds with the highest mutually supported version. `migrateManifest` only receives versions the client understands.

**Option D — Semantic version + downgrade path:** Each manifest version declares which v1 fields it preserves. A v2 manifest embeds a `v1Compat` sub-object for clients that only understand v1. Client checks `v1Compat` presence and falls back.

## Recommendation

Option C for the server/client contract (tracked in a future task on `fetchAndCacheManifest`). Option D for the manifest format itself — it is low cost for the encoder to embed `v1Compat` and allows older clients to degrade gracefully rather than throw. In the short term, `migrateManifest` should emit a warning (via `console.warn`) instead of throwing for unknown versions, and attempt v1 validation on whatever v1-compatible fields are present.

## Short-term code change

Replace the throw with a warn + attempt:

```typescript
if (typeof v === "number" && v > 1) {
  // Forward-compat: attempt to parse known v1 fields; fail gracefully if required fields missing.
  console.warn(`[jxl-progressive] manifest version ${v} is newer than supported (1); attempting v1 parse`);
}
return validateManifest(json);
```

## Consequences

- Older clients no longer hard-break on schema bumps; they degrade to v1 fields.
- `validateManifest` errors on missing required fields remain; only unexpected-version error is softened.
- The server-side version negotiation remains a separate work item.
