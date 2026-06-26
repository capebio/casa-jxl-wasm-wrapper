/** Outputs (when selected) populate ProgressiveManifest.saliency — the encode-side field that reaches clients. */
export type ImageType = "portrait" | "product" | "macro" | "landscape" | "habitat" | "map" | "plate" | "herbarium" | "microscopy" | "diagnostic";
export interface ShouldUseSaliencyOpts {
    imageType: ImageType;
    /** Attention-centre confidence from 0 to 1. */
    confidence: number;
    /** Number of detected attention centres. */
    centerCount: number;
    /** Minimum confidence to enable saliency. Default 0.6. */
    confidenceThreshold?: number;
}
/** Returns true if attention-centre saliency encoding is appropriate. */
export declare function shouldUseSaliency(opts: ShouldUseSaliencyOpts): boolean;
/** Normalise pixel coordinates to the 0–1 range. */
export declare function normaliseCenter(cx: number, cy: number, imageWidth: number, imageHeight: number): {
    x: number;
    y: number;
};
/**
 * From multiple attention centres, pick the single best.
 * Returns null if no centre meets the confidence threshold.
 */
export declare function selectBestCenter(centers: Array<{
    x: number;
    y: number;
    confidence: number;
}>, opts?: {
    threshold?: number;
}): {
    x: number;
    y: number;
    confidence: number;
} | null;
export interface Saliency {
    centerX: number;
    centerY: number;
    enabled: boolean;
    method: string;
    confidence: number;
}
/** Map pixel centre to manifest {centerX, centerY}. */
export declare function normaliseCenterToManifest(cx: number, cy: number, imageWidth: number, imageHeight: number): {
    centerX: number;
    centerY: number;
};
/** Select best attention centre; return in manifest {centerX,centerY,confidence} form. */
export declare function selectBestCenterForManifest(centers: Array<{
    x: number;
    y: number;
    confidence: number;
}>, opts?: {
    threshold?: number;
}): {
    centerX: number;
    centerY: number;
    confidence: number;
} | null;
/**
 * Compose a ProgressiveManifest-compatible saliency record from a centre (legacy or normalized).
 * Used by writers / profile callers to eliminate {x,y} vs {centerX,centerY} drift.
 * Callers: profileJxl(..., { saliency: toSaliency(bestCenter) })
 */
export declare function toSaliency(center: {
    x: number;
    y: number;
} | {
    centerX: number;
    centerY: number;
} | null, method?: string, opts?: {
    enabled?: boolean;
    confidence?: number;
}): Saliency | undefined;
//# sourceMappingURL=saliency-policy.d.ts.map