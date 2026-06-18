# ADR: Validation strategy for Phase 8 optional fields in validateManifest

**Finding:** contracts-14
**File:** packages/jxl-progressive/src/progressive-manifest.ts

## Status
Proposed

## Context

`validateManifest` accepts three optional Phase 8 fields — `capture`, `channels`, and `channelDescriptors` — but performs no structural validation on them. The fields carry typed shapes (`CameraPose`, `FrameSetMember` sub-fields, `AssetChannel[]`, `ChannelDescriptor[]`) defined in `types.ts`. Because they are passed through as-is and stored to OPFS, a malformed value will surface as a runtime error only when a consumer first reads the field — far from the validation boundary.

## Decision Options

**Option A — Pass-through (status quo):** Accept and cache any value without validation. Simple but allows corrupt data to propagate into the cache and only fail at the consumer.

**Option B — Structural type guards (recommended):** Add `assertField` checks for the top-level shape of each optional field (object/array type, required sub-keys). Do not deeply validate nested `CameraPose`/`intrinsics` values for now — those are large nested structs and the risk of corrupt pose data is lower than corrupt array/object confusion.

Example guards to add:
- `capture`: must be an object if present; each sub-key (`pose`, `intrinsics`, etc.) must be an object if present.
- `channels`: must be an array if present; each element must be an object with at least a string `id` field.
- `channelDescriptors`: must be an array if present; each element must be an object with a string `id` field.

**Option C — Zod/valibot schema:** Replace hand-rolled validation entirely. Deferred pending security-4 ADR decision.

## Recommendation

Option B. The structural guards are trivial to add (< 20 lines) and catch the most common corruption (array vs object confusion, missing required identity field). Deep validation of `CameraPose` coordinates can be deferred until photogrammetry ingestion is production-ready.

## Consequences

- Malformed Phase 8 data is rejected at the network boundary rather than silently cached.
- `validateManifest` grows by ~20 lines.
- Any existing malformed manifests in OPFS will be rejected on next read (acceptable; they were already broken).
