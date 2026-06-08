import { downscaleRgba16, encodeRgba16 } from "@casabio/jxl-wasm";
/** Packed LE RGB u16 (6 bytes/pixel) → RGBA16 interleaved (alpha = 65535). */
export function packedRgb16ToRgba16(packed, width, height) {
    const n = width * height;
    const out = new Uint16Array(n * 4);
    for (let i = 0; i < n; i++) {
        const o = i * 6;
        const o16 = i * 4;
        out[o16] = packed[o] | (packed[o + 1] << 8);
        out[o16 + 1] = packed[o + 2] | (packed[o + 3] << 8);
        out[o16 + 2] = packed[o + 4] | (packed[o + 5] << 8);
        out[o16 + 3] = 65535;
    }
    return out;
}
export function targetDimsForLongEdge(width, height, longEdge) {
    const le = Math.max(width, height);
    if (longEdge >= le)
        return { w: width, h: height };
    if (width >= height) {
        const lw = longEdge;
        return { w: lw, h: Math.max(1, Math.round((height * lw) / width)) };
    }
    const lh = longEdge;
    return { w: Math.max(1, Math.round((width * lh) / height)), h: lh };
}
/**
 * Encode RAW big levels {2048, full} as true 16-bit JXL via WASM downscale + encode.
 */
export async function encodeBigLevelsRgba16(packedRgb16, masterW, masterH, plan) {
    let rgba16 = packedRgb16ToRgba16(packedRgb16, masterW, masterH);
    let curW = masterW;
    let curH = masterH;
    const masterLong = Math.max(masterW, masterH);
    const targets = [];
    for (let i = 0; i < plan.sidecarSizes.length; i++) {
        const size = plan.sidecarSizes[i];
        if (size >= 2048 && size < masterLong) {
            targets.push({ longEdge: size, distance: plan.sidecarDistances[i] });
        }
    }
    targets.push({ longEdge: masterLong, distance: plan.fullDistance });
    const levels = [];
    for (const t of targets) {
        const dst = targetDimsForLongEdge(masterW, masterH, t.longEdge);
        if (dst.w !== curW || dst.h !== curH) {
            rgba16 = await downscaleRgba16(rgba16, curW, curH, dst.w, dst.h);
            curW = dst.w;
            curH = dst.h;
        }
        const enc = await encodeRgba16(rgba16, curW, curH, {
            distance: t.distance,
            effort: plan.effort,
            hasAlpha: false,
        });
        levels.push({
            data: enc.data,
            width: enc.width,
            height: enc.height,
            bitsPerSample: 16,
        });
    }
    return levels;
}
//# sourceMappingURL=rgb16.js.map