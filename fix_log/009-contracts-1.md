# Task 009-contracts-1
**Finding:** Entire Phase-8 type block is duplicated verbatim at lines 263-411, causing two identical export declarations in the same file — packages/jxl-progressive/src/types.ts:263-411
**Status:** done
**Tests before:** fail(12 TS duplicate-identifier errors from the block + 1 pre-existing scheduler.test error)
**Tests after:** fail(3 pre-existing progressive-scheduler.ts errors + 1 pre-existing scheduler.test error) — duplication errors eliminated

## Change
Removed the verbatim duplicate of the Phase-8 block (lines 263-411 in the original file): the section header comment through `ChannelDescriptor`, including `Relation`, `FrameRole`, `CameraPose`, `FrameSetMember`, `FrameSet`, `BurstGroup`, `ComposeBurstFrame`, `defaultComposeBurstFrame`, `getSharpnessRank`, `argmaxSharpness`, `AssetChannel`, and `ChannelDescriptor`. The first copy at lines 119-261 is the canonical one and was left intact.

## Diff
```diff
-// --- Phase 8: Bursts, Capture Geometries & 3D Twins (ST1, BD2, PG2, PG5, ST8, BD5, RC2, BD4, BD6, BD7, PG4) ---
-// Schema lives primarily here per handoff (types.ts) + progressive-manifest.ts for ProgressiveManifest reserves.
-// FrameSet generalizes single progressive JXLs into coordinate-transformable multi-frame sets.
-// Heavy CV (SfM, SIFT, MVS) remains in pyramid-ingest. This package owns only progressive schema + decode interfaces.
-
-// Relation between coordinated capture members (bursts use I/P delta coding; transects are pushbroom).
-export type Relation = "Burst" | "Timelapse" | "Panorama" | "Transect" | "Photogrammetry";
-
-// ... (148 lines of verbatim duplicate removed) ...
-
-export interface ChannelDescriptor {
-  channel: AssetChannel;
-  /** Optional per-channel metadata (scale, bias, confidence threshold, normal encoding). */
-  meta?: Record<string, unknown>;
-}
-
 // --- Streaming AI helpers (surface only; full pipeline integration deferred per layer rules) ---
```
