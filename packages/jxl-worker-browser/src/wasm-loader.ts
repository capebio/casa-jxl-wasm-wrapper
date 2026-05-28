// jxl-worker-browser/src/wasm-loader.ts
// Loads the WASM codec facade. T-WASM-BUILD supplies the generated libjxl
// adapter behind this facade.

import type { DecodeStage, ImageInfo, PixelFormat, Region } from "@casabio/jxl-core/types";

export { detectTier, type Tier } from "@casabio/jxl-capabilities";

export type BrowserDecodeEvent =
  | { type: "header"; info: ImageInfo }
  | {
      type: "progress";
      stage: DecodeStage;
      info: ImageInfo;
      pixels: ArrayBuffer | Uint8Array;
      format: PixelFormat;
      region?: Region;
      pixelStride: number;
    }
  | {
      type: "final";
      info: ImageInfo;
      pixels: ArrayBuffer | Uint8Array;
      format: PixelFormat;
      region?: Region;
      pixelStride: number;
    }
  | {
      type: "budget_exceeded";
      stage: DecodeStage;
      info: ImageInfo;
      pixels: ArrayBuffer | Uint8Array;
      format: PixelFormat;
      region?: Region;
      pixelStride: number;
    }
  | {
      type: "error";
      code: string;
      message: string;
      partialPixels?: ArrayBuffer | Uint8Array;
      partialInfo?: ImageInfo;
      partialPixelStride?: number;
      partialStage?: DecodeStage;
    };

export interface BrowserDecoder {
  push(chunk: ArrayBuffer): void | Promise<void>;
  close(): void | Promise<void>;
  events(): AsyncIterable<BrowserDecodeEvent>;
  cancel(reason?: string): void | Promise<void>;
  dispose(): void | Promise<void>;
}

export interface BrowserEncoder {
  pushPixels(chunk: ArrayBuffer, region?: Region): void | Promise<void>;
  finish(): void | Promise<void>;
  chunks(): AsyncIterable<ArrayBuffer | Uint8Array>;
  cancel(reason?: string): void | Promise<void>;
  dispose(): void | Promise<void>;
}

// Stable facade consumed by worker handlers. T-WASM-BUILD adapts generated libjxl
// exports into this shape.
export interface JxlModule {
  createDecoder(options: {
    format: PixelFormat;
    region: Region | null;
    downsample: 1 | 2 | 4 | 8;
    progressionTarget: "header" | "dc" | "pass" | "final";
    emitEveryPass: boolean;
    progressiveDetail?: "dc" | "lastPasses" | "passes" | "dcProgressive";
    preserveIcc: boolean;
    preserveMetadata: boolean;
    targetWidth?: number | null;
    targetHeight?: number | null;
    fitMode?: "contain" | "cover" | "stretch" | null;
    onMetric?: (name: string, value: number) => void;
  }): BrowserDecoder;
  createEncoder(options: {
    format: PixelFormat;
    width: number;
    height: number;
    hasAlpha: boolean;
    iccProfile: ArrayBuffer | null;
    exif: ArrayBuffer | null;
    xmp: ArrayBuffer | null;
    distance: number | null;
    quality: number | null;
    effort: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
    progressive: boolean;
    previewFirst: boolean;
    chunked: boolean;
    sidecarSizes?: readonly number[];
  }): BrowserEncoder;
}

export interface WasmLoaderOptions {
  fetchImpl?: typeof fetch;
  importWasm?: () => Promise<unknown>;
}

export async function loadWasmModule(wasmUrl: string, options: WasmLoaderOptions = {}): Promise<JxlModule> {
  const imported = await (options.importWasm ?? defaultImportWasm)();
  const facade = resolveJxlModule(imported);
  if (facade !== null) return facade;

  // The dynamic import returned null or a module without the expected exports.
  // Probe the WASM URL to give a more actionable diagnostic (missing build
  // artifact vs. module that loaded but lacks createDecoder/createEncoder).
  // Only attempt the probe when a custom fetchImpl is provided or fetch is
  // available in this context; the result is used for the error message only.
  let probeStatus: number | null = null;
  try {
    const fetchImpl = options.fetchImpl ?? (typeof fetch !== "undefined" ? fetch : null);
    if (fetchImpl !== null) {
      const resp = await fetchImpl(wasmUrl);
      probeStatus = resp.status;
      // Drain the body to avoid keeping a connection open.
      await resp.body?.cancel();
    }
  } catch {
    // Probe failure is non-fatal; we still throw the primary error below.
  }

  if (probeStatus !== null && probeStatus !== 200) {
    throw new Error(
      `[jxl-worker-browser] WASM not available at ${wasmUrl} (${probeStatus}). ` +
        "T-WASM-BUILD artifact required.",
    );
  }

  throw new Error(
    "[jxl-worker-browser] @casabio/jxl-wasm does not expose a codec facade. " +
      "T-WASM-BUILD must export createDecoder/createEncoder.",
  );
}

async function defaultImportWasm(): Promise<unknown> {
  // Resolve the published package shape so packed installs behave the same as
  // the workspace checkout.
  return await import("@casabio/jxl-wasm");
}

function resolveJxlModule(value: unknown): JxlModule | null {
  if (isJxlModule(value)) return value;
  if (isRecord(value) && isJxlModule(value["default"])) return value["default"];
  return null;
}

function isJxlModule(value: unknown): value is JxlModule {
  return isRecord(value) && typeof value["createDecoder"] === "function" && typeof value["createEncoder"] === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
