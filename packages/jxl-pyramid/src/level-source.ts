import { isJxtcContainer, parseJxtcHeader } from "./tiling.js";
import type { PyramidLevel } from "./manifest.js";

/** Uniform handle for whole-frame JXL or tiled JXTC top levels. */
export type LevelSource =
  | { kind: "whole"; bytes: Uint8Array; width: number; height: number }
  | { kind: "tiled"; bytes: Uint8Array; width: number; height: number; tileSize: number; bitsPerSample: 8 | 16 };

export function createLevelSource(
  entry: Pick<PyramidLevel, "w" | "h" | "tiled">,
  bytes: Uint8Array,
): LevelSource {
  if (entry.tiled) {
    if (!isJxtcContainer(bytes)) {
      throw new Error("manifest level is tiled but bytes are not a JXTC container");
    }
    const header = parseJxtcHeader(bytes);
    return {
      kind: "tiled",
      bytes,
      width: header.imageW,
      height: header.imageH,
      tileSize: header.tileSize,
      bitsPerSample: header.bitsPerSample,
    };
  }
  return { kind: "whole", bytes, width: entry.w, height: entry.h };
}