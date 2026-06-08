import type { DecodedMaster, JxlBackend, Orientation, PyramidLevelBytes } from "./backends.js";
export interface LadderResult {
    levels: PyramidLevelBytes[];
    orientation: Orientation;
    width: number;
    height: number;
}
export declare function buildRawLadder(jxl: JxlBackend, decoded: DecodedMaster): Promise<LadderResult>;
export declare function buildJpgLadder(jxl: JxlBackend, jpeg: Uint8Array): Promise<LadderResult>;
export declare function buildProxyLadder(jxl: JxlBackend, rgba: Uint8Array, width: number, height: number, size: number, orientation: Orientation): Promise<LadderResult>;
//# sourceMappingURL=ladder.d.ts.map