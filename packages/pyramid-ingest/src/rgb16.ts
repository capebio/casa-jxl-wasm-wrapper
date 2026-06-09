import * as JxlWasmNS from "@casabio/jxl-wasm";
const JW: any = JxlWasmNS;
import type { PyramidEncodeOptions, PyramidLevelBytes } from "./backends.js";

/** Packed LE RGB u16 (6 bytes/pixel) → RGBA16 interleaved (alpha = 65535). */
export function packedRgb16ToRgba16(packed: Uint8Array, width: number, height: number): Uint16Array {
  const need = width * height * 6;
  if (packed.length < need) {
    throw new Error(`packedRgb16 too small: ${packed.length} < ${need}`);
  }
  const n = width * height;
  const out = new Uint16Array(n * 4);
  for (let i = 0; i < n; i++) {
    const o = i * 6;
    const o16 = i * 4;
    out[o16] = packed[o]! | (packed[o + 1]! << 8);
    out[o16 + 1] = packed[o + 2]! | (packed[o + 3]! << 8);
    out[o16 + 2] = packed[o + 4]! | (packed[o + 5]! << 8);
    out[o16 + 3] = 65535;
  }
  return out;
}

export function targetDimsForLongEdge(width: number, height: number, longEdge: number): { w: number; h: number } {
  if (longEdge < 1) throw new Error(`longEdge must be >=1, got ${longEdge}`);
  const le = Math.max(width, height);
  if (longEdge >= le) return { w: width, h: height };
  if (width >= height) {
    const lw = longEdge;
    return { w: lw, h: Math.max(1, Math.round((height * lw) / width)) };
  }
  const lh = longEdge;
  return { w: Math.max(1, Math.round((width * lh) / height)), h: lh };
}

/**
 * Encode RAW big levels {2048, full} as true 16-bit JXL via WASM downscale + encode.
 * Master full always from original buffer; 2048+ sidecars downscale from it (desc).
 */
export async function encodeBigLevelsRgba16(
  packedRgb16: Uint8Array,
  masterW: number,
  masterH: number,
  plan: PyramidEncodeOptions,
): Promise<PyramidLevelBytes[]> {
  let rgba16 = packedRgb16ToRgba16(packedRgb16, masterW, masterH);
  let curW = masterW;
  let curH = masterH;
  const masterLong = Math.max(masterW, masterH);

  const targets: { longEdge: number; distance: number }[] = [
    { longEdge: masterLong, distance: plan.fullDistance },
  ];
  const bigSidecars = plan.sidecars
    .filter((sc) => sc.size >= 2048 && sc.size < masterLong)
    .sort((a, b) => b.size - a.size);
  for (const sc of bigSidecars) {
    targets.push({ longEdge: sc.size, distance: sc.distance });
  }

  const levels: PyramidLevelBytes[] = [];
  for (const t of targets) {
    const dst = targetDimsForLongEdge(masterW, masterH, t.longEdge);
    if (dst.w > curW || dst.h > curH) {
      throw new Error(`rgb16 encode order violation: dst ${dst.w}x${dst.h} > cur ${curW}x${curH} (must be <=)`);
    }
    if (dst.w !== curW || dst.h !== curH) {
      rgba16 = await JW.downscaleRgba16(rgba16, curW, curH, dst.w, dst.h);
      curW = dst.w;
      curH = dst.h;
    }
    const enc = await JW.encodeRgba16(rgba16, curW, curH, {
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