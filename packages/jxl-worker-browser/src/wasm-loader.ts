// jxl-worker-browser/src/wasm-loader.ts
// Loads the WASM module. Stub until T-WASM-BUILD lands.
// Real implementation must wire compileStreaming + IndexedDB compiled-module
// cache per spec Section 6.8.

import type { DecodeStage, ImageInfo, PixelFormat, Region } from "@casabio/jxl-core/types";

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
      pixelStride: number;
    }
  | {
      type: "error";
      code: string;
      message: string;
      partialPixels?: ArrayBuffer | Uint8Array;
      partialInfo?: ImageInfo;
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
    preserveIcc: boolean;
    preserveMetadata: boolean;
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
  }): BrowserEncoder;
}

// BLOCKED: actual WASM artifact not yet available (T-WASM-BUILD pending).
// This stub always rejects so that handlers emit CapabilityMissing cleanly.
// Replace with real loader once jxl-wasm is built.
export async function loadWasmModule(wasmUrl: string): Promise<JxlModule> {
  // Real path (spec Section 6.8):
  //
  // 1. compileStreaming(fetch(wasmUrl))
  // 2. Persist compiled WebAssembly.Module in IndexedDB keyed by
  //    `${buildId}:${wasmSha}` from build-manifest.json
  // 3. On cache miss, fall back to step 1 and write result.
  //
  // For now: attempt to fetch the URL and fail with a clear message.
  const resp = await fetch(wasmUrl);
  if (!resp.ok) {
    throw new Error(
      `[jxl-worker-browser] WASM not available at ${wasmUrl} (${resp.status}). ` +
        "T-WASM-BUILD artifact required.",
    );
  }
  // Real instantiation happens here once the artifact exists.
  throw new Error(
    "[jxl-worker-browser] WASM stub: real module instantiation not implemented yet. " +
      "Awaiting T-WASM-BUILD.",
  );
}
