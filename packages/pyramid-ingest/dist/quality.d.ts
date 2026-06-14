import type { PyramidEncodeOptions } from "./backends.js";
/** libjxl quality->distance: distance = 0.1 + (100 - q) * 0.09, with q=100 lossless (0). */
export declare function qualityToDistance(quality: number): number;
export declare const EFFORT = 3;
export declare const GRID_QUALITY = 85;
export declare const BIG_QUALITY = 95;
export declare const PROXY_QUALITY = 85;
export declare const LEVEL_SIZES: readonly [256, 512, 1024, 2048];
export declare function planLadder(): PyramidEncodeOptions;
export declare function planProxy(size: number): PyramidEncodeOptions;
//# sourceMappingURL=quality.d.ts.map