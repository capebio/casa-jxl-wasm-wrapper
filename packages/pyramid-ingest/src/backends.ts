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
  /** populated by profileConvergence when --profile-convergence and saturation met on a pass */
  convergedByteEnd?: number;
  /** unlocked instrumentation (via O/runlog from WU-6+phase2): pixel bytes of the level buffer passed to encoder (downscale output size = JS/WASM materialization + staging copy size per level for current batch JXTC path). */
  stagedBytes?: number;
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
  /** Downscale helpers for per-level tiled encoding (Phase 3 all-levels JXTC). */
  downscaleRgba8(
    rgba: Uint8Array,
    srcW: number,
    srcH: number,
    dstW: number,
    dstH: number,
  ): Promise<Uint8Array>;
  downscaleRgba16?(
    rgba16: Uint16Array | Uint8Array,
    srcW: number,
    srcH: number,
    dstW: number,
    dstH: number,
  ): Promise<Uint16Array | Uint8Array>;
  transcodeJpeg(jpeg: Uint8Array): Promise<Uint8Array>;
  decodeToRgba8(jxl: Uint8Array): Promise<{ rgba: Uint8Array; width: number; height: number }>;
  /** incremental progressive decode + SSIM (or butter) to find first visual saturation byte offset for the level's own final. returns undef if single-pass or below threshold or small level. */
  profileConvergence?(jxl: Uint8Array, w?: number, h?: number): Promise<number | undefined>;
}

export interface Telemetry {
  stage(name: string, fields?: Record<string, unknown>): void;
  progress(done: number, total: number, currentItem?: string): void;
  // unlocked: per-image events (image-start / image-end / image-failed) for json/runlog + O/M/I/K/C/T
  event?(type: string, data?: Record<string, unknown>): void;
}

export interface Clock {
  now(): number;
}

export function createJxlBackend(telemetry?: Telemetry): JxlBackend {
  const tel = telemetry;
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
      const t0 = Date.now();
      const enc = JW.encodeTileContainerRgba8;
      const data = await enc(rgba, width, height, {
        tileSize: opts.tileSize,
        distance: opts.distance,
        effort: opts.effort,
        hasAlpha: false,
      });
      const ms = Date.now() - t0;
      tel?.stage?.("encode-tile-container", { w: width, h: height, inputBytes: (rgba as any).byteLength, ms });
      return data;
    },

    async encodeTileContainer16(rgba16, width, height, opts) {
      const t0 = Date.now();
      const enc = JW.encodeTileContainerRgba16;
      const data = await enc(rgba16, width, height, {
        tileSize: opts.tileSize,
        distance: opts.distance,
        effort: opts.effort,
        hasAlpha: false,
      });
      const ms = Date.now() - t0;
      tel?.stage?.("encode-tile-container-16", { w: width, h: height, inputBytes: (rgba16 as any).byteLength, ms });
      return data;
    },

    async downscaleRgba8(rgba, srcW, srcH, dstW, dstH) {
      const t0 = Date.now();
      const ds = JW.downscaleRgba8;
      if (typeof ds !== "function") throw new Error("downscaleRgba8 missing on jxl-wasm module");
      const out = await ds(rgba, srcW, srcH, dstW, dstH);
      const ms = Date.now() - t0;
      tel?.stage?.("downscale-rgba8", { srcW, srcH, dstW, dstH, outputBytes: (out as any).byteLength, ms });
      return out;
    },

    async downscaleRgba16(rgba16, srcW, srcH, dstW, dstH) {
      const t0 = Date.now();
      const ds = JW.downscaleRgba16;
      if (typeof ds !== "function") throw new Error("downscaleRgba16 missing on jxl-wasm module");
      const out = await ds(rgba16, srcW, srcH, dstW, dstH);
      const ms = Date.now() - t0;
      tel?.stage?.("downscale-rgba16", { srcW, srcH, dstW, dstH, outputBytes: (out as any).byteLength, ms });
      return out;
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

    async profileConvergence(jxl, w, h) {
      if (!jxl || jxl.length === 0) return undefined;
      if (w != null && h != null && Math.max(w, h) < 1024) return undefined;
      const createDecoder = JW.createDecoder;
      if (typeof createDecoder !== "function") return undefined;
      const decoder = createDecoder({
        format: "rgba8",
        progressionTarget: "final",
        emitEveryPass: true,
        preserveIcc: false,
        preserveMetadata: false,
      });
      const passes: Array<{ bytes: number; pixels: Uint8Array }> = [];
      let finalPixels: Uint8Array | null = null;
      let infoW = w ?? 0, infoH = h ?? 0;
      let bytesPushed = 0;
      const drainP = (async () => {
        for await (const ev of decoder.events()) {
          if (ev.type === "header") {
            infoW = ev.info?.width ?? infoW;
            infoH = ev.info?.height ?? infoH;
          } else if (ev.type === "progress") {
            const raw = ev.pixels;
            const px = raw instanceof Uint8Array ? new Uint8Array(raw) : new Uint8Array(raw as ArrayBuffer);
            passes.push({ bytes: bytesPushed, pixels: px });
          } else if (ev.type === "final") {
            const raw = ev.pixels;
            finalPixels = raw instanceof Uint8Array ? new Uint8Array(raw) : new Uint8Array(raw as ArrayBuffer);
            infoW = ev.info?.width ?? infoW;
            infoH = ev.info?.height ?? infoH;
          } else if (ev.type === "error") {
            throw new Error(`profile decode ${ev.code}: ${ev.message}`);
          }
        }
      })();
      try {
        const CHUNK = 32768;
        for (let off = 0; off < jxl.length; off += CHUNK) {
          const end = Math.min(off + CHUNK, jxl.length);
          const chunk = jxl.subarray(off, end);
          bytesPushed += chunk.length;
          await Promise.resolve(decoder.push(chunk));
        }
        await Promise.resolve(decoder.close());
        await drainP;
      } catch {
        await Promise.resolve((decoder as any).dispose?.()).catch(() => {});
        return undefined;
      } finally {
        await Promise.resolve((decoder as any).dispose?.()).catch(() => {});
      }
      if (!finalPixels || passes.length === 0) return undefined;
      const useW = infoW || w || 0;
      const useH = infoH || h || 0;
      if (useW <= 0 || useH <= 0) return undefined;
      if (Math.max(useW, useH) < 1024) return undefined;
      try {
        const ssimMod: any = await import("ssim.js").catch(() => null);
        if (!ssimMod) return undefined;
        const ssimFn = (ssimMod.default || ssimMod).ssim;
        if (typeof ssimFn !== "function") return undefined;
        const useButter = typeof JW.computeButteraugli === "function";
        for (const p of passes) {
          if (p.pixels.length !== finalPixels.length) continue;
          const img1 = { data: Uint8ClampedArray.from(p.pixels), width: useW, height: useH };
          const img2 = { data: Uint8ClampedArray.from(finalPixels), width: useW, height: useH };
          const res = ssimFn(img1, img2);
          const ssimVal = typeof res === "number" ? res : res && res.mssim;
          let meets = typeof ssimVal === "number" && ssimVal >= 0.9995;
          if (!meets && useButter) {
            try {
              const ba = await JW.computeButteraugli(p.pixels.buffer ?? p.pixels, finalPixels.buffer ?? finalPixels, useW, useH);
              if (typeof ba === "number" && ba <= 1.1) meets = true;
            } catch {}
          }
          if (meets) {
            if (p.bytes > 0 && p.bytes < jxl.length) return p.bytes;
            break;
          }
        }
      } catch {
        return undefined;
      }
      return undefined;
    },
  };
}