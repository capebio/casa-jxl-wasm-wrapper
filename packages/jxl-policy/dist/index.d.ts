import type { DecodeOptions, EncodeOptions } from "@casabio/jxl-core";
export type DecodePolicyName = "thumbnail" | "gallery" | "viewer" | "export" | "prefetch";
export interface DecodePolicy {
    progressionTarget: "header" | "dc" | "pass" | "final";
    emitEveryPass: boolean;
    priority: "visible" | "near" | "background";
    downsample?: 1 | 2 | 4 | 8;
}
export declare const decodePolicies: Record<DecodePolicyName, DecodePolicy>;
export declare function applyDecodePolicy(name: DecodePolicyName, base: DecodeOptions): DecodeOptions;
export type EncodePolicyName = "thumbnail" | "viewer" | "archival";
export interface EncodePolicy {
    effort: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
    progressive: boolean;
    previewFirst: boolean;
    priority: "visible" | "near" | "background";
    modular?: -1 | 0 | 1;
    brotliEffort?: number;
}
export declare const encodePolicies: Record<EncodePolicyName, EncodePolicy>;
export declare function applyEncodePolicy(name: EncodePolicyName, base: EncodeOptions): EncodeOptions;
//# sourceMappingURL=index.d.ts.map