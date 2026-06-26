import type { ProgressiveManifest, TierName } from "./progressive-manifest.js";
export interface TierSelection {
    tier: TierName;
    byteEnd: number;
}
/** Pick the frontier entry whose maxDisplayPx covers `displayPx` (longest edge).
 *  Returns undefined when the manifest has no frontier. */
export declare function selectFrontierTier(manifest: ProgressiveManifest, displayPx: number): {
    tier: TierName;
    byteEnd: number;
    maxDisplayPx: number;
} | undefined;
/** Choose a tier for an on-screen element. Uses the scale frontier when present;
 *  otherwise a structural heuristic over tiers (longest-edge thresholds). */
export declare function selectTierForDisplay(manifest: ProgressiveManifest, elementWidth: number, elementHeight: number, dpr: number): TierSelection;
//# sourceMappingURL=progressive-scale.d.ts.map