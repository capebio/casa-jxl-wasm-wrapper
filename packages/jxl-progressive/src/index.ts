// packages/jxl-progressive/src/index.ts

// Manifest
export {
  validateManifest,
  lookupTier,
  checkHash,
  migrateManifest,
  ManifestValidationError,
  ManifestStaleError,
} from "./progressive-manifest.js";
export type {
  TierName,
  ManifestTier,
  ProgressiveManifest,
} from "./progressive-manifest.js";

// Saliency policy
export {
  shouldUseSaliency,
  normaliseCenter,
  selectBestCenter,
} from "./saliency-policy.js";
export type { ImageType, ShouldUseSaliencyOpts } from "./saliency-policy.js";

// Profiler
export {
  profileJxl,
  profileJxlFile,
} from "./progressive-profile.js";
export type { ProfileOptions } from "./progressive-profile.js";

// Stream
export {
  fetchTier,
  fetchFull,
  streamTierFrames,
} from "./progressive-stream.js";
export type { TierFetchOptions } from "./progressive-stream.js";

// Cache
export { ProgressiveCache } from "./progressive-cache.js";
export type { ProgressiveCacheOptions } from "./progressive-cache.js";

// Scheduler
export {
  ProgressiveGallery,
  tierRank,
  fairnessScore,
} from "./progressive-scheduler.js";
export type {
  Tier,
  ProgressiveImageJob,
  GalleryOptions,
} from "./progressive-scheduler.js";

// Shared types
export type { SessionFactory } from "./types.js";
