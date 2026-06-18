# Task 009-performance-1
**Finding:** tick() spreads entire jobs Map into an array on every RAF frame — packages/jxl-progressive/src/progressive-scheduler.ts:471-478
**Status:** done
**Tests before:** fail(pre-existing)
**Tests after:** fail(2 pre-existing TS2412 only)
## Change
Replaced `[...this.jobs.values()].filter().filter().filter().map().sort().map()` chain (5 intermediate array allocations) with a single for-of loop that builds one `candidates` array. `tierRank` results are computed once per job (fixing performance-2 simultaneously).
## Diff
```diff
-    const candidates = [...this.jobs.values()]
-      .filter((j) => j.visible || j.nearViewport || j.selected)
-      .filter((j) => tierRank(j.currentTier) < tierRank(j.targetTier))
-      .filter((j) => j.decoderAbort === null)
-      .filter((j) => !j.nextRetryAt || now >= j.nextRetryAt)
-      .map((j) => ({ job: j, score: fairnessScore(j, now) }))
-      .sort((a, b) => b.score - a.score)
-      .map((p) => p.job);
+    const candidates: Array<{ job: ProgressiveImageJob; score: number }> = [];
+    for (const j of this.jobs.values()) {
+      if (!j.visible && !j.nearViewport && !j.selected) continue;
+      if (j.decoderAbort !== null) continue;
+      if (j.nextRetryAt && now < j.nextRetryAt) continue;
+      const curRank = tierRank(j.currentTier);
+      const tgtRank = tierRank(j.targetTier);
+      if (curRank >= tgtRank) continue;
+      candidates.push({ job: j, score: fairnessScore(j, now) });
+    }
+    candidates.sort((a, b) => b.score - a.score);
```
