# ADR: Cross-tier ordering invariant for validateManifest

**Finding:** logic-9
**File:** packages/jxl-progressive/src/progressive-manifest.ts

## Status
Proposed

## Context

`validateManifest` checks each tier individually but not cross-tier invariants. Two classes of corruption pass validation today:
1. Duplicate tier names (two `"dc"` entries): `lookupTier` silently returns the first, ignoring the second.
2. Inverted `byteEnd` ordering: a manifest with `dc.byteEnd > preview.byteEnd` passes validation and will confuse the scheduler's progressive ordering assumptions.

The scheduler expects `dc.byteEnd < preview.byteEnd < full.byteEnd` because it uses tier byte ranges to issue progressive HTTP Range requests in order. Inverted ordering would cause the scheduler to re-request bytes it already has or issue a Range request that covers a regression.

## Decision Options

**Option A — No cross-tier checks (status quo):** Accept duplicate names and inverted ordering. Low code complexity but silently allows corrupt manifests to enter the scheduler.

**Option B — Uniqueness check only:** After the per-tier loop, assert that all tier names are unique. Inexpensive and closes the duplicate-name bug. Does not enforce ordering.

**Option C — Uniqueness + ordering check (recommended):** After the per-tier loop:
1. Assert that no two tiers share the same `name`.
2. Assert that if both `dc` and `preview` are present, `dc.byteEnd <= preview.byteEnd`.
3. Assert that if both `preview` and `full` are present, `preview.byteEnd <= full.byteEnd`.

Do not require all three tiers to be present (a minimal manifest with only `full` is valid).

**Option D — Strict canonical order:** Require tiers to appear in `dc → preview → full` order in the array. More prescriptive; breaks any ingestor that emits tiers in a different order.

## Recommendation

Option C. The invariant matches the scheduler's actual runtime assumptions. Checking after the loop is O(n) with n ≤ 3. Strict positional ordering (Option D) is unnecessarily brittle.

## Implementation sketch

```typescript
const seen = new Set<string>();
for (const tier of tiersArr) {
  const name = (tier as Record<string, unknown>)["name"] as string;
  assertField(!seen.has(name), "tiers", `duplicate tier name "${name}"`);
  seen.add(name);
}
const byByteEnd = (n: TierName) => {
  const t = (tiersArr as ManifestTier[]).find(x => x.name === n);
  return t?.byteEnd ?? -1;
};
if (byByteEnd("dc") >= 0 && byByteEnd("preview") >= 0) {
  assertField(byByteEnd("dc") <= byByteEnd("preview"), "tiers", "dc.byteEnd must be <= preview.byteEnd");
}
if (byByteEnd("preview") >= 0 && byByteEnd("full") >= 0) {
  assertField(byByteEnd("preview") <= byByteEnd("full"), "tiers", "preview.byteEnd must be <= full.byteEnd");
}
```

## Consequences

- Corrupt manifests with duplicate tier names or inverted ordering are rejected at parse time.
- Legitimate manifests (validated by logic-3/security-2 tier range checks already applied) are unaffected.
- Adds ~15 lines to `validateManifest`.
