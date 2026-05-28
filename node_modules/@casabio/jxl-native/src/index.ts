import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

export interface NativeBinding {
  version(): string;
  probe(): {
    loaded: boolean;
    path: string;
  };
  createDecoder?: (options: DecoderOptions) => NativeDecoder;
  createEncoder?: (options: EncoderOptions) => NativeEncoder;
}

export interface NativeLoaderOptions {
  prebuiltPath?: string;
  sourcePath?: string;
}

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
  | { type: "progress"; stage: DecodeStage; info: ImageInfo; pixels: ArrayBuffer | Uint8Array; format: PixelFormat; region?: Region; pixelStride: number }
  | { type: "final"; info: ImageInfo; pixels: ArrayBuffer | Uint8Array; format: PixelFormat; region?: Region; pixelStride: number }
  | { type: "budget_exceeded"; stage: DecodeStage; info: ImageInfo; pixels: ArrayBuffer | Uint8Array; format: PixelFormat; pixelStride: number }
  | { type: "error"; code: string; message: string };

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
  /** Brotli effort for aux data (metadata, ICC, EXIF, extra channels). -1 = libjxl default, 0-11 explicit. */
  brotliEffort?: number;
  /** Target ISO for libjxl synthetic photon noise. 0 or omitted disables it. */
  photonNoiseIso?: number;
  /** Encoder-native downsampling factor before JXL transform/coding. */
  resampling?: 1 | 2 | 4 | 8;
  progressive: boolean;
  previewFirst: boolean;
  chunked: boolean;
}

export interface NativeDecoder {
  push(chunk: ArrayBuffer | Uint8Array): void | Promise<void>;
  close(): void | Promise<void>;
  events(): AsyncIterable<DecodeEvent>;
  cancel(reason?: string): void | Promise<void>;
  dispose(): void | Promise<void>;
}

export interface NativeEncoder {
  pushPixels(chunk: ArrayBuffer | Uint8Array, region?: Region): void | Promise<void>;
  finish(): void | Promise<void>;
  chunks(): AsyncIterable<ArrayBuffer | Uint8Array>;
  cancel(reason?: string): void | Promise<void>;
  dispose(): void | Promise<void>;
}

export interface NativeCodecFacade {
  createDecoder(options: DecoderOptions): NativeDecoder;
  createEncoder(options: EncoderOptions): NativeEncoder;
}

const require = createRequire(String(import.meta.url));
const packageRoot = dirname(fileURLToPath(String(import.meta.url)));

export function loadNativeBinding(options: NativeLoaderOptions = {}): NativeBinding {
  const candidates = [
    options.prebuiltPath ?? resolvePrebuiltBinary(),
    options.sourcePath ?? resolveSourceBinary()
  ];

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const binding = require(candidate) as NativeBinding;
      ensureBindingLoaded(binding, candidate);
      return binding;
    } catch (error) {
      lastError = error;
    }
  }

  throw new CapabilityMissing("jxl-native addon unavailable; falling back to WASM is required", lastError);
}

export function createNativeCodecFacade(binding: NativeBinding): NativeCodecFacade {
  if (typeof binding.createDecoder !== "function" || typeof binding.createEncoder !== "function") {
    throw new CapabilityMissing("jxl-native addon does not expose createDecoder/createEncoder");
  }
  ensureBindingLoaded(binding, "native binding");
  return {
    createDecoder(options) {
      return binding.createDecoder!(options);
    },
    createEncoder(options) {
      return binding.createEncoder!(options);
    },
  };
}

export function createDecoder(options: DecoderOptions): NativeDecoder {
  return createNativeCodecFacade(loadNativeBinding()).createDecoder(options);
}

export function createEncoder(options: EncoderOptions): NativeEncoder {
  return createNativeCodecFacade(loadNativeBinding()).createEncoder(options);
}

function resolvePrebuiltBinary(): string {
  const platform = process?.platform ?? "unknown";
  const arch = process?.arch ?? "unknown";
  const base = join(packageRoot, "..", "prebuilds");
  const candidate = resolve(base, `${platform}-${arch}`, "jxl-native.node");
  return candidate;
}

function resolveSourceBinary(): string {
  const release = resolve(packageRoot, "..", "build", "Release", "jxl_native.node");
  const debug = resolve(packageRoot, "..", "build", "Debug", "jxl_native.node");
  return fileExists(release) ? release : fileExists(debug) ? debug : release;
}

function fileExists(path: string): boolean {
  try {
    require("node:fs").accessSync(path);
    return true;
  } catch {
    return false;
  }
}

function ensureBindingLoaded(binding: NativeBinding, label: string): void {
  if (typeof binding.version === "function" && binding.version().includes("scaffold")) {
    throw new CapabilityMissing(`jxl-native addon at ${label} is still the scaffold stub`);
  }
  if (typeof binding.probe !== "function") return;
  const probe = binding.probe();
  if (typeof probe.path === "string" && probe.path.toLowerCase().includes("stub")) {
    throw new CapabilityMissing(`jxl-native addon at ${label} is still the scaffold stub`, probe);
  }
  if (probe.loaded !== true) {
    throw new CapabilityMissing(`jxl-native addon at ${label} is present but not loaded`, probe);
  }
}
