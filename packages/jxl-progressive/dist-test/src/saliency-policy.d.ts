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
//# sourceMappingURL=saliency-policy.d.ts.map