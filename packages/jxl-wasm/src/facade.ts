export type PixelFormat = "rgba8" | "rgba16" | "rgbaf32";
export type DecodeStage = "header" | "dc" | "pass" | "final";
export type Region = { x: number; y: number; w: number; h: number };

export interface ImageInfo {
  width: number;
  height: number;
  bitsPerSample: 8 | 16 | 32;
  hasAlpha: boolean;
  hasAnimation: boolean;
  jpegReconstructionAvailable: boolean;
}

export type DecodeEvent =
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

export interface DecoderOptions {
  format: PixelFormat;
  region: Region | null;
  downsample: 1 | 2 | 4 | 8;
  progressionTarget: "header" | "dc" | "pass" | "final";
  emitEveryPass: boolean;
  preserveIcc: boolean;
  preserveMetadata: boolean;
}

export interface EncoderOptions {
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
}

export interface JxlDecoder {
  push(chunk: ArrayBuffer): void | Promise<void>;
  close(): void | Promise<void>;
  events(): AsyncIterable<DecodeEvent>;
  cancel(reason?: string): void | Promise<void>;
  dispose(): void | Promise<void>;
}

export interface JxlEncoder {
  pushPixels(chunk: ArrayBuffer, region?: Region): void | Promise<void>;
  finish(): void | Promise<void>;
  chunks(): AsyncIterable<ArrayBuffer | Uint8Array>;
  cancel(reason?: string): void | Promise<void>;
  dispose(): void | Promise<void>;
}

export class CapabilityMissing extends Error {
  readonly code = "CapabilityMissing";
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "CapabilityMissing";
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

export function createDecoder(_options: DecoderOptions): JxlDecoder {
  return new UnavailableDecoder();
}

export function createEncoder(_options: EncoderOptions): JxlEncoder {
  return new UnavailableEncoder();
}

function missingCodec(): CapabilityMissing {
  return new CapabilityMissing(
    "jxl-wasm codec facade is present, but generated libjxl WASM glue is not installed",
  );
}

class UnavailableDecoder implements JxlDecoder {
  private cancelled = false;

  push(_chunk: ArrayBuffer): void {}

  close(): void {}

  async *events(): AsyncIterable<DecodeEvent> {
    if (this.cancelled) return;
    const error = missingCodec();
    yield {
      type: "error",
      code: error.code,
      message: error.message,
    };
  }

  cancel(_reason?: string): void {
    this.cancelled = true;
  }

  dispose(): void {}
}

class UnavailableEncoder implements JxlEncoder {
  pushPixels(_chunk: ArrayBuffer, _region?: Region): void {}

  finish(): void {}

  async *chunks(): AsyncIterable<ArrayBuffer | Uint8Array> {
    throw missingCodec();
  }

  cancel(_reason?: string): void {}

  dispose(): void {}
}
