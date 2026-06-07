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
      // Use default flags (0) for orientation bake etc. Matches existing callers in repo.
      const handle = fn(bytes, 0);
      if (!handle) throw new Error(`raw decode failed for ${format}`);
      // take_rgba returns the owned buffer + info.
      const take = (mod as any).ProcessResult.take_rgba;
      if (typeof take !== "function") {
        throw new Error("ProcessResult.take_rgba missing from raw pipeline");
      }
      const res = take(handle);
      // res: { data: Uint8Array | Uint8ClampedArray, width, height, ... }
      const rgba = res.data instanceof Uint8Array ? res.data : new Uint8Array(res.data);
      return {
        rgba,
        width: res.width,
        height: res.height,
        orientation: "baked", // Rust pipeline always bakes for RAW
      };
    },
  };
}
