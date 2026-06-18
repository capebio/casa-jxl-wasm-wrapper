# ADR: Hand-Rolled Validator vs. Schema Library for Manifest Validation

**Status:** Proposed  
**Date:** 2026-06-18  
**Finding:** security-9 — `packages/jxl-pyramid/src/manifest-validate.ts`

## Context

`manifest-validate.ts` (~255 lines) is an entirely hand-rolled runtime validator for
`PyramidManifest` and `GalleryIndex`. Security findings security-1 through security-5 each
document a different class of missing constraint (depth cap, key-count cap, numeric range, hex
format, path-traversal characters) that schema libraries enforce systematically. The fixes for
security-1 and security-2 added a `sanitizeOpaqueObject` helper; security-3 adds dimension
upper-bound checks; security-4/5 add hex and path-character guards. Each fix is a one-off.

## Decision Drivers

1. **Zero new dependencies.** The package already has no runtime deps beyond `@casabio/jxl-wasm`.
   Adding Zod or Valibot adds ~12 KB (Valibot) to ~57 KB (Zod) to the bundle, which matters for
   WASM-adjacent packages loaded in the browser.
2. **Type inference.** A schema library would infer TypeScript types from the schema definition,
   eliminating the parallel `manifest.ts` type declarations. With the hand-rolled approach both
   must be kept in sync manually.
3. **Exhaustive numeric ranges.** Zod `.min()/.max()`, Valibot `minValue/maxValue` enforce ranges
   declaratively. The hand-rolled approach requires explicit checks that reviewers routinely miss
   (as evidenced by security-3 and logic-10).
4. **Bundle/tree-shaking.** Valibot is modular and tree-shakes to ~1-3 KB for a simple schema;
   Zod 3 does not tree-shake well. Both add a dependency audit surface.

## Options

### Option A: Keep hand-rolled, add systematic numeric-range contracts

Extend `requireNumber` to accept optional `{ min?, max?, integer? }` options. Add range args at
every call site. Add a `requireHex` helper. Document the convention so future fields pick up
validation automatically via code review checklist.

**Pros:** Zero new deps. Surgical. Already on the right path after security-1/-2 fixes.  
**Cons:** Still requires per-call discipline. Type inference is still manual.

### Option B: Migrate to Valibot

Replace the hand-rolled validator with Valibot schemas that derive TypeScript types directly.
Move `manifest.ts` types to be inferred from schemas.

**Pros:** Exhaustive by construction. Type inference eliminates drift. ~1-3 KB bundle impact
(tree-shaken).  
**Cons:** New runtime dependency. Non-trivial migration (~255 lines + type file). Valibot API has
changed between v0 and v1; locks to a specific major.

### Option C: Migrate to Zod

As Option B but with Zod.

**Pros:** Wider ecosystem familiarity. `.safeParse()` ergonomics.  
**Cons:** Zod 3 is ~57 KB unminified and does not tree-shake; Zod 4 improves this but is newer.
Larger bundle risk for a browser-loaded package.

## Recommendation

**Option A in the short term; Option B when manifest complexity next grows.**

The immediate security gaps are closed by the targeted fixes (security-1/-2/-3/-4/-5). The
remaining systemic risk is that future fields added to `PyramidManifest` will repeat the same
omissions. The lightweight mitigation is to extend `requireNumber` with a range-options overload
and add a `requireHex` helper, then enforce their use at code review.

If the manifest schema gains 3+ new optional fields in a single sprint, that is the trigger to
evaluate Valibot migration, as the migration cost amortizes across more surface area.

## Numeric-Range Contracts Still Missing (as of 2026-06-18)

After security-1/-2 fixes, the following fields still lack explicit numeric upper-bound checks
(security-3 covers some; the rest are opportunities):

| Field | Path | Missing constraint |
|---|---|---|
| `w`, `h` (level) | `manifest.levels[i].w/h` | upper bound MAX_DIMENSION (security-3) |
| `bytes` (level) | `manifest.levels[i].bytes` | upper bound MAX_BYTES (security-3) |
| `tileSize`, `cols`, `rows` | `manifest.levels[i].tiling.*` | already bounded (MAX_TILE_SIZE / MAX_DIMENSION) |
| `mtimeMs` | `manifest.master.mtimeMs` | no range (could be negative or far-future) |
| `sizeBytes` | `manifest.master.sizeBytes` | no range |
| `convergedByteEnd` | level | must be `< bytes` (logic-3 fix changes `>` to `>=`) |
| `aspect` | manifest | must be positive |
| qualityCurve `bytes`, `ssim`, `butteraugli` | | no range checks |
