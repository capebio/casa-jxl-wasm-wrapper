import type { PyramidManifest, GalleryIndex } from "./manifest.js";
export declare const MANIFEST_SCHEMA_VERSION = 2;
export declare const INDEX_SCHEMA_VERSION = 1;
export declare class ManifestValidationError extends Error {
    readonly path: string;
    constructor(message: string, path: string);
}
/**
 * Accepts schema 1|2 (normalizes 1 → 2 defaults: stub=false, proxy=false).
 * Throws ManifestValidationError on schema > 2 or missing/invalid fields.
 */
export declare function parsePyramidManifest(json: unknown): PyramidManifest;
export declare function parseGalleryIndex(json: unknown): GalleryIndex;
//# sourceMappingURL=manifest-validate.d.ts.map