# Task 009-logic-7

**Finding:** Dead `v < 0` branch in defaultComposeBurstFrame: Uint8Array elements are always >= 0 — packages/jxl-progressive/src/types.ts:200-203

**Status:** done

**Tests before:** fail (compilation errors due to logic-2 duplication, not related to this fix)

**Tests after:** fail (same, not related to this fix)

## Change

Removed the unreachable `v < 0 ? 0 : v` branch from the clamping expression in `defaultComposeBurstFrame`. Since both operands are `Uint8Array` elements (range [0, 255]), their sum is always in [0, 510], so the branch checking for negative values can never execute. The simplified expression `v > 255 ? 255 : v` correctly clamps to [0, 255].

## Diff

```diff
  for (let i = 0; i < len; i++) {
    const v = b[i]! + r[i]!;
-   out[i] = v > 255 ? 255 : (v < 0 ? 0 : v);
+   out[i] = v > 255 ? 255 : v;
  }
```

**Applied to both occurrences** (lines 202 and 352) via replace_all.
