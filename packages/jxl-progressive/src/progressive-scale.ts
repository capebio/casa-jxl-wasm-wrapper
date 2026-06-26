// packages/jxl-progressive/src/progressive-scale.ts
import type { ProgressiveManifest, TierName, ManifestTier } from "./progressive-manifest.js";

export interface TierSelection { tier: TierName; byteEnd: number; }

/** Pick the frontier entry whose maxDisplayPx covers `displayPx` (longest edge).
 *  Returns undefined when the manifest has no frontier. */
export function selectFrontierTier(
  manifest: ProgressiveManifest,
  displayPx: number,
): { tier: TierName; byteEnd: number; maxDisplayPx: number } | undefined {
  const fr = manifest.scaleFrontier;
  if (fr === undefined || fr.length === 0) return undefined;
  for (const e of fr) if (displayPx <= e.maxDisplayPx) return e;
  return fr[fr.length - 1]!;
}

/** Choose a tier for an on-screen element. Uses the scale frontier when present;
 *  otherwise a structural heuristic over tiers (longest-edge thresholds). */
export function selectTierForDisplay(
  manifest: ProgressiveManifest,
  elementWidth: number,
  elementHeight: number,
  dpr: number,
): TierSelection {
  const longestEdge = Math.max(elementWidth, elementHeight) * (dpr > 0 ? dpr : 1);
  const frontier = selectFrontierTier(manifest, longestEdge);
  if (frontier !== undefined) return { tier: frontier.tier, byteEnd: frontier.byteEnd };

  // Fallback: no frontier → pick by longest-edge buckets against available tiers.
  const byName = (n: TierName): ManifestTier | undefined => manifest.tiers.find((t) => t.name === n);
  if (longestEdge <= 384 && byName("dc")) { const t = byName("dc")!; return { tier: "dc", byteEnd: t.byteEnd }; }
  if (longestEdge <= 1280 && byName("preview")) { const t = byName("preview")!; return { tier: "preview", byteEnd: t.byteEnd }; }
  const full = byName("full") ?? manifest.tiers[manifest.tiers.length - 1]!;
  return { tier: full.name, byteEnd: full.byteEnd };
}
