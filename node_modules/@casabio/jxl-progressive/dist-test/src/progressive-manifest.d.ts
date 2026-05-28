export type TierName = "dc" | "preview" | "full";
export interface ManifestTier {
    name: TierName;
    byteStart: number;
    byteEnd: number;
    progressionIndex: number | "final";
    intendedUse: string;
}
export interface ProgressiveManifest {
    version: 1;
    source: {
        width: number;
        height: number;
        hasAlpha: boolean;
        orientation: number;
    };
    jxl: {
        bytes: number;
        sha256: string;
    };
    encoder: {
        name: string;
        libjxlVersion: string;
        flags: string[];
    };
    saliency?: {
        enabled: boolean;
        centerX: number;
        centerY: number;
        confidence: number;
        method: string;
    };
    tiers: ManifestTier[];
}
export declare class ManifestValidationError extends Error {
    readonly field: string;
    constructor(message: string, field: string);
}
export declare class ManifestStaleError extends Error {
    constructor(message: string);
}
export declare function validateManifest(json: unknown): ProgressiveManifest;
export declare function lookupTier(manifest: ProgressiveManifest, name: TierName): ManifestTier | undefined;
export declare function checkHash(manifest: ProgressiveManifest, jxlBytes: ArrayBuffer): Promise<boolean>;
export declare function migrateManifest(json: unknown): ProgressiveManifest;
//# sourceMappingURL=progressive-manifest.d.ts.map