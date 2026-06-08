import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import initRaw, {
  process_cr2_with_flags,
  process_dng_with_flags,
  process_orf_with_flags,
  type ProcessResult,
} from "../../../web/pkg/raw_converter_wasm.js";
import type { DecodedMaster, RawBackend, RawFormat } from "./backends.js";

const OUT_FULL_RGB8 = 1;
const OUT_FULL_16 = 8;

let initPromise: Promise<unknown> | null = null;

function ensureInit(): Promise<unknown> {
  if (!initPromise) {
    initPromise = (async () => {
      const wasmPath = fileURLToPath(new URL("../../../web/pkg/raw_converter_wasm_bg.wasm", import.meta.url));
      const bytes = await readFile(wasmPath);
      return initRaw({ module_or_path: bytes });
    })();
  }
  return initPromise;
}

type ProcessFn = (
  data: Uint8Array, output_flags: number,
  exposure_ev: number, contrast: number, highlights: number, shadows: number,
  whites: number, blacks: number, saturation: number, vibrance: number,
  temp: number, tint: number, wb_r_override: number, wb_b_override: number,
  texture: number, clarity: number,
) => ProcessResult;

function decodeWith(fn: ProcessFn, bytes: Uint8Array): DecodedMaster {
  const flags = OUT_FULL_RGB8 | OUT_FULL_16;
  const pr = fn(bytes, flags, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NaN, NaN, 0, 0);
  try {
    const rgba = pr.take_rgba();
    const rgb16 = pr.take_rgb16_full();
    const master: DecodedMaster = {
      rgba,
      width: pr.width,
      height: pr.height,
      orientation: "baked",
    };
    if (rgb16.length > 0) master.rgb16 = rgb16;
    return master;
  } finally {
    pr.free();
  }
}

export function createRawBackend(): RawBackend {
  return {
    async decode(bytes: Uint8Array, format: RawFormat): Promise<DecodedMaster> {
      await ensureInit();
      switch (format) {
        case "orf": return decodeWith(process_orf_with_flags, bytes);
        case "dng": return decodeWith(process_dng_with_flags, bytes);
        case "cr2": return decodeWith(process_cr2_with_flags, bytes);
      }
    },
  };
}