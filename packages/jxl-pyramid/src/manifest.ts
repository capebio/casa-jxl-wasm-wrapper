// manifest.ts
// Interfaces for the Pyramid Gallery manifest and index schemas (M0-M4).
// Conforms strictly to the 2026-06-07-pyramid-gallery-design.md specification.

/** Supported master image file formats. */
export type MasterFormat = "orf" | "dng" | "cr2" | "jpg";

/** Image orientation handling strategy. */
export type Orientation = "baked" | "source";

/** Target size for a pyramid level, either a long-edge target size (number) or the string "full". */
export type LevelSize = number | "full";

/** Supported bit depths per sample in the JXL stream. */
export type BitsPerSample = 8 | 16;

/** Metadata of the original master image. */
export interface MasterMetadata {
  name: string;
  format: MasterFormat;
  mtimeMs: number;
}

/** One encode-time quality measurement for a progressive pass of a level.
 *  Produced once at ingest (pyramid-ingest --profile-convergence); clients read these
 *  instead of computing ssim/butteraugli at download time. */
export interface QualityCurvePoint {
  /** Compressed byte offset at which this progressive pass became decodable. */
  bytes: number;
  /** SSIM vs the level's own final pixels (1 = identical). */
  ssim?: number;
  /** Butteraugli distance vs the level's own final pixels (0 = identical, ~1.0 imperceptible). */
  butteraugli?: number;
}

/** Information about a single pyramid level. */
export interface PyramidLevel {
  size: LevelSize;
  w: number;
  h: number;
  bytes: number;
  bitsPerSample: BitsPerSample;
  contenthash: string;
  tiled: boolean;
  /** First byte offset where the level is visually saturated (legacy single cutoff). */
  convergedByteEnd?: number;
  /** Full encode-time quality curve, ascending by bytes (additive; absent on older manifests). */
  qualityCurve?: QualityCurvePoint[];
}

/** The schema definition of `manifest.json` per image. (V3 minimal compat) */
export interface PyramidManifest {
  schema: 1 | 2;
  imageId: string;
  master: MasterMetadata;
  orientation: Orientation;
  width: number;
  height: number;
  aspect: number;
  levels: PyramidLevel[];
  proxy?: boolean;
  // V2+ additive (from pyramid-ingest Phase2 V3/M)
  producedBy?: any;
  stub?: boolean;
  metadata?: Record<string, unknown>;
  convergedByteEnd?: number; // on levels too in some
}

/** Quality target for pickByteEndForQuality. Provide at least one threshold. */
export interface QualityTarget {
  /** Accept the first pass whose butteraugli distance is <= this (e.g. 2.0 for "good enough", 1.1 for visually saturated). */
  maxButteraugli?: number;
  /** Accept the first pass whose ssim is >= this (e.g. 0.999). */
  minSsim?: number;
}

/**
 * Pick a download cutoff (bytes) for a level from its encode-time quality curve.
 * Feed the result to the stream layer's maxBytes (same mechanism as convergedByteEnd).
 *
 * - With thresholds: returns the first curve point meeting EVERY provided threshold
 *   (points missing a thresholded metric do not qualify), or undefined if none does
 *   (caller downloads the full level).
 * - With an empty target ({}): falls back to the level's convergedByteEnd.
 * - No curve and no convergedByteEnd: undefined.
 */
export function pickByteEndForQuality(
  level: Pick<PyramidLevel, "qualityCurve" | "convergedByteEnd" | "bytes">,
  target: QualityTarget = {},
): number | undefined {
  const { maxButteraugli, minSsim } = target;
  const hasThreshold = maxButteraugli !== undefined || minSsim !== undefined;
  const curve = level.qualityCurve;
  if (hasThreshold && curve && curve.length > 0) {
    for (const pt of curve) {
      if (maxButteraugli !== undefined && !(pt.butteraugli !== undefined && pt.butteraugli <= maxButteraugli)) continue;
      if (minSsim !== undefined && !(pt.ssim !== undefined && pt.ssim >= minSsim)) continue;
      // only useful when it actually truncates the download
      if (pt.bytes > 0 && pt.bytes < level.bytes) return pt.bytes;
      return undefined;
    }
    return undefined;
  }
  if (!hasThreshold && level.convergedByteEnd != null && level.convergedByteEnd > 0 && level.convergedByteEnd < level.bytes) {
    return level.convergedByteEnd;
  }
  return undefined;
}

/** Information about the smallest level (L0 seed) inlined in the gallery index. */
export interface LevelZeroSeed {
  contenthash: string;
  w: number;
  h: number;
}

/** A single image entry within `index.json`. */
export interface GalleryIndexEntry {
  imageId: string;
  aspect: number;
  l0: LevelZeroSeed;
}

/** The schema definition of `index.json` per gallery. */
export interface GalleryIndex {
  schema: 1;
  images: GalleryIndexEntry[];
}
