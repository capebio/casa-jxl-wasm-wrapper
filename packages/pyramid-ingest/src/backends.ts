import * as JxlWasmNS from "@casabio/jxl-wasm";
const JW: any = JxlWasmNS;

export type MasterFormat = "orf" | "dng" | "cr2" | "jpg";
export type RawFormat = "orf" | "dng" | "cr2";
export type Orientation = "baked" | "source";

export interface DecodedMaster {
  rgba: Uint8Array;
  /** M3: packed LE RGB u16 (6 bytes/pixel) from ProcessResult.take_rgb16_full. */
  rgb16?: Uint8Array;
  width: number;
  height: number;
  orientation: Orientation;
}

export interface PyramidLevelBytes {
  data: Uint8Array;
  width: number;
  height: number;
  bitsPerSample?: 8 | 16;
  tiled?: boolean;
}

export interface TileContainerEncodeOptions {
  tileSize: number;
  distance: number;
  effort: number;
}

export interface PyramidEncodeOptions {
  fullDistance: number;
  sidecars: ReadonlyArray<{ size: number; distance: number }>;
  effort: number;
}

export interface RawBackend {
  decode(bytes: Uint8Array, format: RawFormat): Promise<DecodedMaster>;
}

export interface JxlBackend {
  encodePyramid(
    rgba: Uint8Array,
    width: number,
    height: number,
    opts: PyramidEncodeOptions,
  ): Promise<PyramidLevelBytes[]>;
  encodeTileContainer(
    rgba: Uint8Array,
    width: number,
    height: number,
    opts: TileContainerEncodeOptions,
  ): Promise<Uint8Array>;
  /** 16-bit JXTC path (available after JXTC-16 WASM rebuild; v1 tiled top uses 8-bit). */
  encodeTileContainer16?(
    rgba16: Uint8Array,
    width: number,
    height: number,
    opts: TileContainerEncodeOptions,
  ): Promise<Uint8Array>;
  transcodeJpeg(jpeg: Uint8Array): Promise<Uint8Array>;
  decodeToRgba8(jxl: Uint8Array): Promise<{ rgba: Uint8Array; width: number; height: number }>;
}

export interface Telemetry {
  stage(name: string, fields?: Record<string, unknown>): void;
  progress(done: number, total: number, currentItem?: string): void;
}

export interface Clock {
  now(): number;
}

export function createJxlBackend(): JxlBackend {
  return {
    async encodePyramid(rgba, width, height, opts) {
      const sidecarSizes = opts.sidecars.map((s) => s.size);
      const sidecarDistances = opts.sidecars.map((s) => s.distance);
      const enc = JW.encodeRgba8Pyramid;
      const levels = await enc(rgba, width, height, {
        fullDistance: opts.fullDistance,
        sidecarSizes,
        sidecarDistances,
        effort: opts.effort,
        hasAlpha: false,
        resampling: 1,
      });
      return levels.map((l: { data: Uint8Array; width: number; height: number }) => ({ data: l.data, width: l.width, height: l.height }));
    },

    async encodeTileContainer(rgba, width, height, opts) {
      const enc = JW.encodeTileContainerRgba8;
      return enc(rgba, width, height, {
        tileSize: opts.tileSize,
        distance: opts.distance,
        effort: opts.effort,
        hasAlpha: false,
      });
    },

    async encodeTileContainer16(rgba16, width, height, opts) {
      const enc = JW.encodeTileContainerRgba16;
      return enc(rgba16, width, height, {
        tileSize: opts.tileSize,
        distance: opts.distance,
        effort: opts.effort,
        hasAlpha: false,
      });
    },

    async transcodeJpeg(jpeg) {
      const tx = JW.transcodeJpegToJxl;
      return tx(jpeg);
    },

    async decodeToRgba8(jxl) {
      const createDecoder = JW.createDecoder;
      const decoder = createDecoder({
        format: "rgba8",
        progressionTarget: "final",
        emitEveryPass: false,
        preserveIcc: false,
        preserveMetadata: false,
      });
      let result: { rgba: Uint8Array; width: number; height: number } | null = null;
      const drainP = (async () => {
        for await (const ev of decoder.events()) {
          if (ev.type === "final") {
            const px = ev.pixels instanceof Uint8Array ? ev.pixels : new Uint8Array(ev.pixels);
            result = { rgba: px, width: ev.info.width, height: ev.info.height };
          } else if (ev.type === "error") {
            throw new Error(`decode ${ev.code}: ${ev.message}`);
          }
        }
      })();
      try {
        await decoder.push(jxl);
        await decoder.close();
        await drainP;
      } finally {
        await Promise.resolve(decoder.dispose()).catch(() => {});
      }
      if (!result) throw new Error("decode produced no final frame");
      return result;
    },
  };
}