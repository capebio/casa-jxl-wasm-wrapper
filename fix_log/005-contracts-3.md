# Task 005-contracts-3
**Finding:** recommendedEffort() return type declares 1-9 but only 4, 6, or 7 are reachable — packages/jxl-capabilities/src/index.ts:118-124
**Status:** done
**Tests before:** pass (9)
**Tests after:** pass (10)

## Change
Narrowed return type from `1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9` to `4 | 6 | 7`. This was done together with the 005-logic-1 fix (same line). TypeScript continues to accept all return sites.

## Diff
```diff
-export function recommendedEffort(hwConcurrency?: number): 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 {
+export function recommendedEffort(hwConcurrency?: number): 4 | 6 | 7 {
```
