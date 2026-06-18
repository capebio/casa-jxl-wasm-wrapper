# Task 009-contracts-4
**Finding:** When no manifestTier exists (fallback fetchFull path), job.currentTier is set to job.targetTier rather than the literal tier that was fetched — packages/jxl-progressive/src/progressive-scheduler.ts:663-665
**Status:** done
**Tests before:** fail(pre-existing)
**Tests after:** fail(2 pre-existing TS2412 only)
## Change
Simplified `const achieved = manifestTier !== undefined ? target : job.targetTier` to `const achieved = target`. In the no-manifest path, `target = nextTier(job.currentTier)` (one tier step); setting `achieved = job.targetTier` was incorrect because it skipped intermediate tiers. `onTier` now always fires with the actually-decoded tier.
## Diff
```diff
-        const achieved = manifestTier !== undefined ? target : job.targetTier;
+        const achieved = target;
```
