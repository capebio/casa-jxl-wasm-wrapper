import type { RawBackend, DecodedMaster, RawFormat } from "./backends.js";

// The Rust RAW pipeline WASM is at repo root web/pkg (committed build of raw-pipeline).
// Lazy init so tests that don't need RAW don't pay the load cost.
let rawModPromise: Promise<any> | null = null;

async function loadRawModule() {
  if (!rawModPromise) {
    // Resolve relative to this package in the monorepo checkout.
    // @ts-expect-error - web/pkg has no .d.ts in this tree (prebuilt WASM); runtime provides the shape.
    rawModPromise = import("../../../web/pkg/raw_converter_wasm.js").then((m) => {
      const base = new URL("../../../web/pkg/", import.meta.url);
      return m.default({ locateFile: (p: string) => new URL(p, base).href });
    });
  }
  return rawModPromise;
}

function formatToFnName(format: RawFormat): string {
  if (format === "orf") return "process_orf_with_flags";
  if (format === "dng") return "process_dng_with_flags";
  if (format === "cr2") return "process_cr2_with_flags";
  throw new Error(`unsupported raw format for ingest: ${format}`);
}

export function createRawBackend(): RawBackend {
  return {
    async decode(bytes: Uint8Array, format: RawFormat): Promise<DecodedMaster> {
      const mod = await loadRawModule();
      const fnName = formatToFnName(format);
      const fn = (mod as any)[fnName];
      if (typeof fn !== "function") {
        throw new Error(`raw pipeline missing export ${fnName} (web/pkg not built or flags mismatch)`);
      }
      // M3: request full RGB8 (1) + full RGB16 (8) so pyramid can emit 16-bit for RAW {2048,full} levels.
      // Grid levels continue to use the 8-bit data. JPG path unchanged.
      // Default 0 kept for compatibility in non-M3 callers; M3 ladder will use 9.
      const flags = 1 | 8;
      const handle = fn(bytes, flags);
      if (!handle) throw new Error(`raw decode failed for ${format}`);
      const take = (mod as any).ProcessResult.take_rgba;
      if (typeof take !== "function") {
        throw new Error("ProcessResult.take_rgba missing from raw pipeline");
      }
      const res = take(handle);
      const rgba = res.data instanceof Uint8Array ? res.data : new Uint8Array(res.data);

      // M3: also expose full 16-bit packed if present (for big levels encode + client 16-bit path).
      let rgb16: Uint8Array | null = null;
      const take16 = (mod as any).ProcessResult.take_rgb16_full;
      if (typeof take16 === "function") {
        const r16 = take16(handle);
        if (r16 && r16.length > 0) {
          rgb16 = r16 instanceof Uint8Array ? r16 : new Uint8Array(r16);
        }
      }

      return {
        rgba,
        width: res.width,
        height: res.height,
        orientation: "baked",
        // M3 extension (optional for 8-bit callers)
        rgb16: rgb16 || undefined,
        bitsPerSample: rgb16 ? 16 : 8,
      } as any; // extended for M3; 8-bit path unchanged
    },
  };
}
    },
  };
}
