import type { SessionFactory } from "./types.js";
import { type ProgressiveManifest, type ManifestTier, type ScaleFrontierEntry } from "./progressive-manifest.js";
import { type MetricName, type MetricScorer } from "./progressive-metrics.js";
export type { SessionFactory };
export interface ProfileOptions {
    /** Bytes to feed per push. Default 4096 (4 KiB). */
    chunkSize?: number;
    encoderName?: string;
    libjxlVersion?: string;
    encoderFlags?: string[];
    saliency?: ProgressiveManifest["saliency"];
    /** Called after each chunk push with (byteOffset, totalBytes). */
    onProgress?: (byteOffset: number, total: number) => void;
    signal?: AbortSignal;
    /** When set, each non-final progression event is scored (partial vs final) and tiers
     *  become threshold-driven instead of structural. */
    scorer?: MetricScorer;
    /** Per-tier score thresholds (defaults derived from the scorer's metric). */
    thresholds?: ScoreThresholds;
    /** Longest-edge display sizes to compute a scale frontier for (ascending). */
    displaySizes?: number[];
    /** Downscaler used to build the scale frontier (production: wasm downscale_rgba). */
    downscaler?: Downscaler;
}
/** Options for profileJxlFile, extending ProfileOptions with a filesystem side-effect flag. */
export interface ProfileFileOptions extends ProfileOptions {
    /**
     * When true (default), writes the manifest as `${path}.json` beside the .jxl file.
     * Pass false to skip the write and return the manifest only.
     */
    writeManifest?: boolean;
}
export interface ScoredEvent {
    byteOffset: number;
    progressionIndex: number;
    score: number;
}
export interface ScoreThresholds {
    dc: number;
    preview: number;
}
/** Choose dc/preview byteEnds as the earliest progression event whose score clears the
 *  tier threshold. byteEnd always comes from a real progression event (never a guessed
 *  byte count). Full tier is always the total. */
export declare function selectTiersByScore(events: ScoredEvent[], totalBytes: number, metric: MetricName, thresholds: ScoreThresholds): ManifestTier[];
export type Downscaler = (rgba: Uint8Array, w: number, h: number, dw: number, dh: number) => Uint8Array;
export interface ScoredPass {
    byteOffset: number;
    progressionIndex: number;
    pixels: Uint8Array;
}
export interface BuildFrontierArgs {
    passes: ScoredPass[];
    finalPixels: Uint8Array;
    srcW: number;
    srcH: number;
    tiers: ManifestTier[];
    totalBytes: number;
    metric: MetricName;
    thresholds: ScoreThresholds;
    /** Longest-edge display sizes to compute frontier entries for, ascending. */
    displaySizes: number[];
    downscaler: Downscaler;
    scorerAt?: (cand: Uint8Array, ref: Uint8Array, w: number, h: number) => Promise<number> | number;
}
/** For each display size, find the earliest pass that clears the preview threshold once
 *  both pass and final are downsampled to that size; map it to the smallest covering tier.
 *  A pass insufficient at native res can be sufficient at thumbnail res, so frontier
 *  byteEnds shrink with display size. */
export declare function buildScaleFrontier(args: BuildFrontierArgs): Promise<ScaleFrontierEntry[]>;
/**
 * Drive a throw-away DecodeSession in small byte increments,
 * record progression events, and return a ProgressiveManifest.
 *
 * Works in both Node.js and browser environments — accepts pre-loaded bytes,
 * performs no I/O internally.
 */
export declare function profileJxl(jxlBytes: ArrayBuffer, sessionFactory: SessionFactory, source: {
    width: number;
    height: number;
    hasAlpha: boolean;
    orientation?: number;
}, opts?: ProfileOptions): Promise<ProgressiveManifest>;
/**
 * Node.js helper: read a .jxl file, profile it, and optionally write
 * the manifest as `${path}.json` beside the original file.
 */
export declare function profileJxlFile(path: string, sessionFactory: SessionFactory, source: {
    width: number;
    height: number;
    hasAlpha: boolean;
    orientation?: number;
}, opts?: ProfileFileOptions): Promise<ProgressiveManifest>;
//# sourceMappingURL=progressive-profile.d.ts.map