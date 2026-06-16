import type { DecodeOptions, EncodeOptions } from "@casabio/jxl-core";
type Priority = NonNullable<DecodeOptions["priority"]>;
type Downsample = NonNullable<DecodeOptions["downsample"]>;
export interface DecodePolicy {
    progressionTarget: NonNullable<DecodeOptions["progressionTarget"]>;
    emitEveryPass: boolean;
    priority: Priority;
    downsample?: Downsample;
}
export interface EncodePolicy {
    effort: NonNullable<EncodeOptions["effort"]>;
    progressive: boolean;
    previewFirst: boolean;
    priority: Priority;
    groupOrder?: NonNullable<EncodeOptions["groupOrder"]>;
}
export type DecodePolicyName = "thumbnail" | "gallery" | "viewer" | "export" | "prefetch" | "mlInference";
export declare const decodePolicies: Readonly<{
    readonly thumbnail: {
        readonly progressionTarget: "dc";
        readonly emitEveryPass: false;
        readonly priority: "near";
        readonly downsample: 8;
    };
    readonly gallery: {
        readonly progressionTarget: "dc";
        readonly emitEveryPass: false;
        readonly priority: "near";
        readonly downsample: 4;
    };
    readonly viewer: {
        readonly progressionTarget: "final";
        readonly emitEveryPass: true;
        readonly priority: "visible";
    };
    readonly export: {
        readonly progressionTarget: "final";
        readonly emitEveryPass: false;
        readonly priority: "visible";
    };
    readonly prefetch: {
        readonly progressionTarget: "dc";
        readonly emitEveryPass: false;
        readonly priority: "background";
        readonly downsample: 4;
    };
    readonly mlInference: {
        readonly progressionTarget: "final";
        readonly emitEveryPass: false;
        readonly priority: "background";
        readonly downsample: 4;
    };
}>;
export declare function isDecodePolicyName(s: string): s is DecodePolicyName;
export declare function applyDecodePolicy(name: DecodePolicyName, base: DecodeOptions): DecodeOptions;
export type EncodePolicyName = "thumbnail" | "viewer" | "archival";
export declare const encodePolicies: Readonly<{
    readonly thumbnail: {
        readonly effort: 2;
        readonly progressive: false;
        readonly previewFirst: false;
        readonly priority: "near";
    };
    readonly viewer: {
        readonly effort: 3;
        readonly progressive: true;
        readonly previewFirst: true;
        readonly priority: "visible";
        readonly groupOrder: 1;
    };
    readonly archival: {
        readonly effort: 7;
        readonly progressive: true;
        readonly previewFirst: false;
        readonly priority: "background";
    };
}>;
export declare function isEncodePolicyName(s: string): s is EncodePolicyName;
export declare function applyEncodePolicy(name: EncodePolicyName, base: EncodeOptions): EncodeOptions;
/**
 * Largest power-of-two downsample (1|2|4|8) whose result still covers
 * containerW×containerH (CSS px × devicePixelRatio if you want crisp output).
 * Section 9.2: thumbnail downsample "4 or 8 depending on container size".
 */
export declare function downsampleForContainer(imageW: number, imageH: number, containerW: number, containerH: number): Downsample;
export {};
//# sourceMappingURL=index.d.ts.map