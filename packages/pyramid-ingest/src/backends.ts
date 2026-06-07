import { createDecoder, encodeRgba8Pyramid, transcodeJpegToJxl } from "@casabio/jxl-wasm";

export type MasterFormat = "orf" | "dng" | "cr2" | "jpg";
export type RawFormat = "orf" | "dng" | "cr2";
export type Orientation = "baked" | "source";

/** Decoded master pixels (RGBA8) + dims + how orientation is represented. */
export interface DecodedMaster {
  rgba: Uint8Array;
  width: number;
  height: number;
  orientation: Orientation;
}

/** Raw bytes of one encoded pyramid level. */
export interface PyramidLevelBytes {
  data: Uint8Array;
  width: number;
  height: number;
}

export interface PyramidEncodeOptions {
  fullDistance: number;
  sidecarSizes: readonly number[];
  sidecarDistances: readonly number[];
  effort: number;
}

/** RAW decode boundary — implemented by raw-backend.ts (real) and fakes in tests. */
export interface RawBackend {
  decode(bytes: Uint8Array, format: RawFormat): Promise<DecodedMaster>;
}

/** JXL codec boundary — wraps @casabio/jxl-wasm. */
export interface JxlBackend {
  encodePyramid(
    rgba: Uint8Array,
    width: number,
    height: number,
    opts: PyramidEncodeOptions,
  ): Promise<PyramidLevelBytes[]>;
  transcodeJpeg(jpeg: Uint8Array): Promise<Uint8Array>;
  decodeToRgba8(jxl: Uint8Array): Promise<{ rgba: Uint8Array; width: number; height: number }>;
}

export function createJxlBackend(): JxlBackend {
  return {
    async encodePyramid(rgba, width, height, opts) {
      const levels = await encodeRgba8Pyramid(rgba, width, height, {
        fullDistance: opts.fullDistance,
        sidecarSizes: opts.sidecarSizes,
        sidecarDistances: opts.sidecarDistances,
        effort: opts.effort,
        hasAlpha: false, // masters are opaque; drop the full-level alpha plane
        resampling: 1,
      });
      return levels.map((l) => ({ data: l.data, width: l.width, height: l.height }));
    },

    async transcodeJpeg(jpeg) {
      return transcodeJpegToJxl(jpeg);
    },

    async decodeToRgba8(jxl) {
      const decoder = createDecoder({
        format: "rgba8",
        progressionTarget: "final",
        emitEveryPass: false,
        preserveIcc: false,
        preserveMetadata: false,
      });
      let result: { rgba: Uint8Array; width: number; height: number } | null = null;
      const drain = (async () => {
        for await (const ev of decoder.events()) {
          if (ev.type === "final") {
            const px = ev.pixels instanceof Uint8Array ? ev.pixels : new Uint8Array(ev.pixels);
            result = { rgba: px, width: ev.info.width, height: ev.info.height };
          } else if (ev.type === "error") {
            throw new Error(`decode ${ev.code}: ${ev.message}`);
          }
        }
      })();
      await decoder.push(jxl);
      await decoder.close();
      await drain;
      await decoder.dispose();
      if (!result) throw new Error("decode produced no final frame");
      return result;
    },
  };
}
