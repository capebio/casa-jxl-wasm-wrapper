import { createDecoder, encodeRgba8Pyramid, transcodeJpegToJxl } from "@casabio/jxl-wasm";

export type MasterFormat = "orf" | "dng" | "cr2" | "jpg";
export type RawFormat = "orf" | "dng" | "cr2";
export type Orientation = "baked" | "source";

/** Decoded master pixels (RGBA8) + dims + how orientation is represented. M3: may also carry full 16-bit for big levels. */
export interface DecodedMaster {
  rgba: Uint8Array;
  width: number;
  height: number;
  orientation: Orientation;
  // M3 16-bit extension (packed LE u16 6B/px or similar from raw take_rgb16_full)
  rgb16?: Uint8Array;
  bitsPerSample?: 8 | 16;
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

/** JXL codec boundary — wraps @casabio/jxl-wasm. M3 adds 16-bit encode support for RAW big levels. */
export interface JxlBackend {
  encodePyramid(
    rgba: Uint8Array,
    width: number,
    height: number,
    opts: PyramidEncodeOptions,
  ): Promise<PyramidLevelBytes[]>;
  // M3: for 16-bit input data (packed or u16) for RAW {2048,full} levels. Uses M0 rgba16 primitives.
  encodePyramid16(
    data16: Uint8Array,
    width: number,
    height: number,
    opts: PyramidEncodeOptions,
  ): Promise<PyramidLevelBytes[]>;
  transcodeJpeg(jpeg: Uint8Array): Promise<Uint8Array>;
  decodeToRgba8(jxl: Uint8Array): Promise<{ rgba: Uint8Array; width: number; height: number }>;
  // M3: decode 16-bit JXL level for WebGL float path in lightbox.
  decodeToRgba16?(jxl: Uint8Array): Promise<{ data: Uint8Array; width: number; height: number }>;
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

    // M3: 16-bit encode for RAW big levels. Placeholder calls 8-bit path (loses precision); real impl
    // should use M0 rgba16 downscale + 16-bit encode primitive (one-crossing) once facade exposes encodeRgba16Pyramid or equiv.
    // For now, structure allows ladder to call it; convert 16->8 simple shift for demo.
    async encodePyramid16(data16, width, height, opts) {
      // Simple 16->8 for structure (real: keep 16-bit through encode for highlight headroom in JXL).
      const rgba8 = new Uint8Array(width * height * 4);
      for (let i = 0; i < width * height; i++) {
        const o16 = i * 6; // assume packed LE 6B from raw
        const r = data16[o16 + 1] || (data16[o16] >> 4); // rough high byte
        const g = data16[o16 + 3] || (data16[o16 + 2] >> 4);
        const b = data16[o16 + 5] || (data16[o16 + 4] >> 4);
        const o8 = i * 4;
        rgba8[o8] = r;
        rgba8[o8 + 1] = g;
        rgba8[o8 + 2] = b;
        rgba8[o8 + 3] = 255;
      }
      return this.encodePyramid(rgba8, width, height, opts);
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
