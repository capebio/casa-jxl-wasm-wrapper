import type { DecodeSession } from "@casabio/jxl-session";
export type { DecodeSession };
/**
 * Factory function that returns a fresh DecodeSession configured for
 * progressive decode (emitEveryPass: true, progressionTarget: "final").
 * Used by profileJxl and ProgressiveGallery.
 */
export type SessionFactory = () => DecodeSession;
export interface LevelDescriptor {
    width: number;
    height: number;
    byteEnd?: number;
    tier?: string;
}
export interface Roi {
    x: number;
    y: number;
    w: number;
    h: number;
}
export interface ScreenPoint {
    x: number;
    y: number;
}
export interface ImagePoint {
    x: number;
    y: number;
}
/**
 * Standard adapter surface for feeding progressive decodes into classifiers,
 * detectors, embedders without forcing full image materialization.
 */
export interface ModelAdapter {
    onFrame?(frame: {
        stage: string;
        info: unknown;
        pixels?: ArrayBuffer | Uint8Array;
    }): void | Promise<void>;
    /** bmp: pixels for the tile (ArrayBuffer/Uint8Array or ImageBitmap). bbox: image-space. tier: dc|preview|full etc. */
    onTile(bmp: ArrayBuffer | Uint8Array | ImageBitmap, bbox: {
        x: number;
        y: number;
        w: number;
        h: number;
    }, tier: string): void | Promise<void>;
    onEmbedding?(embedding: Float32Array, meta?: Record<string, unknown>): void | Promise<void>;
}
/**
 * Select the pyramid/level whose dimensions best match a model input size (e.g. 224 or 512).
 * Guarantees caller can use the decoded tile at native model res with zero additional resize
 * and without ever decoding higher-res levels than needed.
 */
export declare function pickModelLevel(levels: readonly LevelDescriptor[], inputPx: number): LevelDescriptor | undefined;
/**
 * Map full-res image coords to screen under active level + optional ROI.
 * scaleX/scaleY computed separately to support anamorphic (non-square-pixel) content (B6).
 */
export declare function toScreenCoords(pt: ImagePoint, level: LevelDescriptor, roi?: Roi, screenScale?: {
    scaleX?: number;
    scaleY?: number;
}): ScreenPoint;
/** Inverse: screen -> image (full-res pixels). Separate scales for anamorphic correctness. */
export declare function toImageCoords(pt: ScreenPoint, level: LevelDescriptor, roi?: Roi, screenScale?: {
    scaleX?: number;
    scaleY?: number;
}): ImagePoint;
export type Relation = "Burst" | "Timelapse" | "Panorama" | "Transect" | "Photogrammetry";
export type FrameRole = "key" | "delta";
export interface CameraPose {
    lat: number;
    lon: number;
    alt: number;
    yaw: number;
    pitch: number;
    roll: number;
    timestamp: number;
}
export interface FrameSetMember {
    id: string;
    jxlUrl: string;
    pose?: CameraPose;
    role?: FrameRole;
    /** baseId designates the key member for residual reconstruction (delta only predicts from this base). */
    baseId?: string;
    /** DC tier sha256 override. When identical across burst members, enables single fetch + shared render (BD4/BD6 via Phase 5 cache). */
    dcSha256?: string;
    /** Reserved: pinhole intrinsics (PG2). */
    intrinsics?: {
        fx: number;
        fy: number;
        cx: number;
        cy: number;
        skew?: number;
        dist?: number[];
    };
    /** Reserved: extrinsics / pose matrix components (PG2). */
    extrinsics?: {
        r: number[];
        t: [number, number, number];
    };
    /** Reserved: depth layer descriptor for multi-layer / transect (ST8, PG4). */
    depthLayer?: {
        url?: string;
        sha256?: string;
        units?: "meters" | "normalized" | string;
        scale?: number;
        offset?: number;
    };
    /** Reserved: content-addressed SHA256 for scale-invariant feature sidecar (SIFT etc, PG5). */
    featureSidecar?: string;
}
export interface FrameSet {
    id: string;
    relation: Relation;
    members: FrameSetMember[];
    /** Shared DC tier sha enables burst thumbnail dedupe at manifest.jxl level for lowest tier. */
    sharedDcSha256?: string;
}
export interface BurstGroup {
    readonly baseId: string;
    readonly deltaIds: readonly string[];
    /** Fetch decoded base (ArrayBuffer of pixels) via cache key (manifest sha or jxlUrl of the key member). */
    getBaseBuffer(): Promise<ArrayBuffer | null>;
    /** Reconstruct one delta frame. */
    compose(base: ArrayBuffer, residual: ArrayBuffer): ArrayBuffer;
}
export type ComposeBurstFrame = (base: ArrayBuffer, residual: ArrayBuffer) => ArrayBuffer;
export declare function defaultComposeBurstFrame(base: ArrayBuffer, residual: ArrayBuffer): ArrayBuffer;
export declare function getSharpnessRank(lumaArray: Uint8Array, width: number, height: number): number;
/** argmax(sharpness) helper: returns index of sharpest member (for appointing burst cover). */
export declare function argmaxSharpness<T extends {
    luma?: Uint8Array;
    width?: number;
    height?: number;
    sharpness?: number;
}>(candidates: readonly T[]): number;
export type AssetChannel = "rgb" | "depth" | "normal" | "confidence";
export interface ChannelDescriptor {
    channel: AssetChannel;
    /** Optional per-channel metadata (scale, bias, confidence threshold, normal encoding). */
    meta?: Record<string, unknown>;
}
/**
 * Basic tile sort comparator for saliency-ordered fetching (F35/C2).
 * Use as: [...tiles].sort(saliencyTileComparator(saliencyCenter))
 * Computes squared distance of tile center to manifest saliency center.
 * Actual queue wiring lives in scheduler/stream (skipped here to confine edits to allowed files).
 */
export declare function saliencyTileComparator(saliency?: {
    centerX: number;
    centerY: number;
}): (a: {
    cx: number;
    cy: number;
}, b: {
    cx: number;
    cy: number;
}) => number;
/**
 * detectWhileStreaming: feed progressive tiles to detector/adapter; early exit on high confidence.
 * Consumer usage (example, no core change here):
 *   for await (const t of detectWhileStreaming(tileSource, detector, () => session.cancel())) { ... }
 * The cancel() must be wired to the actual source (DecodeSession / fetch controller) to reject
 * iterator and release decoder slot (B5 contract). Full auto-wiring of iterator reject deferred.
 */
export declare function detectWhileStreaming(tiles: AsyncIterable<{
    bmp: ArrayBuffer | Uint8Array | ImageBitmap;
    bbox: {
        x: number;
        y: number;
        w: number;
        h: number;
    };
    tier: string;
}>, detector: (bmp: any, bbox: any, tier: string) => {
    confidence?: number;
    localized?: boolean;
} | void | Promise<any>, cancel?: () => void | Promise<void>, opts?: {
    confidenceThreshold?: number;
}): Promise<void>;
/**
 * ID-Budget Auto-Stop hook (N1).
 * Extension point: when model confidence crosses threshold during streaming, signal "sharp enough".
 * Callers integrate into their fetch/decode budget loop (e.g. if (autoStop(res)) { stream.end(); }).
 * No change to core termination in this confined edit.
 */
export declare function shouldAutoStopForModel(conf: number, threshold?: number): boolean;
//# sourceMappingURL=types.d.ts.map