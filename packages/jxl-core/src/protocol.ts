// jxl-core/src/protocol.ts
// Worker message protocol: Section 16 of casabio-jxl-wrapper-construction-spec-v2.md
// Keys are snake_case per spec.

import type {
  PixelFormat,
  DecodeStage,
  ImageInfo,
  Region,
  CodecMetric,
} from "./types.js";

// ---------------------------------------------------------------------------
// Main → Worker: Decode
// ---------------------------------------------------------------------------

export interface MsgDecodeStart {
  type: "decode_start";
  sessionId: string;
  format: PixelFormat;
  region: Region | null;
  downsample: 1 | 2 | 4 | 8;
  progressionTarget: "header" | "dc" | "pass" | "final";
  emitEveryPass: boolean;
  progressiveDetail: "dc" | "lastPasses" | "passes" | "dcProgressive" | null;
  preserveIcc: boolean;
  preserveMetadata: boolean;
  priority: "visible" | "near" | "background";
  budgetMs: number | null;
  targetWidth: number | null;
  targetHeight: number | null;
  fitMode: "contain" | "cover" | "stretch" | null;
}

export interface MsgDecodeChunk {
  type: "decode_chunk";
  sessionId: string;
  chunk: ArrayBuffer;           // transferred
}

export interface MsgDecodeClose {
  type: "decode_close";
  sessionId: string;
}

export interface MsgDecodeCancel {
  type: "decode_cancel";
  sessionId: string;
  reason?: string;
}

export interface MsgDecodePause {
  type: "decode_pause";
  sessionId: string;
}

export interface MsgDecodeResume {
  type: "decode_resume";
  sessionId: string;
}

// ---------------------------------------------------------------------------
// Worker → Main: Decode
// ---------------------------------------------------------------------------

export interface MsgDecodeHeader {
  type: "decode_header";
  sessionId: string;
  info: ImageInfo;
}

export interface MsgDecodeProgress {
  type: "decode_progress";
  sessionId: string;
  stage: DecodeStage;
  info: ImageInfo;
  pixels: ArrayBuffer;          // transferred
  format: PixelFormat;
  region?: Region;
  pixelStride: number;
}

export interface MsgDecodeFinal {
  type: "decode_final";
  sessionId: string;
  info: ImageInfo;
  pixels: ArrayBuffer;          // transferred
  format: PixelFormat;
  region?: Region;
  pixelStride: number;
  /** Byte length of the transferred pixel buffer (avoids a separate metric IPC). */
  outputBytes?: number;
  /** Elapsed ms from session start to first pixel (may be set here if no progress event fired). */
  timeToFirstPixelMs?: number;
  /** Elapsed ms from session start to final frame. */
  timeToFinalMs?: number;
}

export interface MsgDecodeError {
  type: "decode_error";
  sessionId: string;
  code: string;
  message: string;
  partialPixels?: ArrayBuffer;       // transferred; present for TruncatedStream
  partialInfo?: ImageInfo;
  partialPixelStride?: number;       // bytes per row of partialPixels; required when partialPixels is present
  partialStage?: DecodeStage;        // stage at which the error occurred; present when partialPixels is present
}

export interface MsgDecodeCancelled {
  type: "decode_cancelled";
  sessionId: string;
}

export interface MsgDecodePaused {
  type: "decode_paused";
  sessionId: string;
}

export interface MsgDecodeBudgetExceeded {
  type: "decode_budget_exceeded";
  sessionId: string;
  stage: DecodeStage;
  pixels: ArrayBuffer;          // transferred; best frame so far
  info: ImageInfo;
  format: PixelFormat;
  region?: Region;              // present for region/tile decodes, matching progress/final
  pixelStride: number;
}

// ---------------------------------------------------------------------------
// Main → Worker: Encode
// ---------------------------------------------------------------------------

export interface MsgEncodeStart {
  type: "encode_start";
  sessionId: string;
  format: PixelFormat;
  width: number;
  height: number;
  hasAlpha: boolean;
  iccProfile: ArrayBuffer | null;   // transferred when present
  exif: ArrayBuffer | null;
  xmp: ArrayBuffer | null;
  distance: number | null;
  quality: number | null;
  effort: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  progressive: boolean;
  progressiveFlavor?: "dc" | "ac";
  previewFirst: boolean;
  chunked: boolean;
  sidecarSizes?: readonly number[];
  priority: "visible" | "near" | "background";
}

export interface MsgEncodePixels {
  type: "encode_pixels";
  sessionId: string;
  chunk: ArrayBuffer;           // transferred
  region?: Region;
}

export interface MsgEncodeFinish {
  type: "encode_finish";
  sessionId: string;
}

export interface MsgEncodeCancel {
  type: "encode_cancel";
  sessionId: string;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Worker → Main: Encode
// ---------------------------------------------------------------------------

export interface MsgEncodeChunk {
  type: "encode_chunk";
  sessionId: string;
  chunk: ArrayBuffer;           // transferred
}

export interface MsgEncodeFirstByteReady {
  type: "encode_first_byte_ready";
  sessionId: string;
}

export interface MsgEncodeDone {
  type: "encode_done";
  sessionId: string;
  totalBytes: number;
  /**
   * Cumulative byte offsets at sidecar boundaries. Length === sidecarSizes.length
   * when sidecars were emitted; omitted otherwise. See EncodeStats.sidecarOffsets.
   */
  sidecarOffsets?: readonly number[];
}

export interface MsgEncodeError {
  type: "encode_error";
  sessionId: string;
  code: string;
  message: string;
}

export interface MsgEncodeCancelled {
  type: "encode_cancelled";
  sessionId: string;
}

// ---------------------------------------------------------------------------
// Worker lifecycle
// ---------------------------------------------------------------------------

export interface MsgWorkerReady {
  type: "worker_ready";
  backend: "wasm" | "native";  // node worker reports which backend it selected
  wasmBuild?: "relaxed-simd-mt" | "simd-mt" | "simd" | "scalar";
}

export interface MsgWorkerShutdown {
  type: "worker_shutdown";
}

export interface MsgWorkerShutdownAck {
  type: "worker_shutdown_ack";
}

export interface MsgWorkerError {
  type: "worker_error";
  code: string;
  message: string;
}

// Backpressure: worker tells main that its queue is below high-water mark
export interface MsgWorkerDrain {
  type: "worker_drain";
  sessionId: string;
  latencyMs?: number;   // EMA of decoder.push() duration; drives scheduler pushHwm tuning
  queueDepth?: number;  // unprocessed chunk count at drain time
  queuedBytes?: number; // unprocessed byte count at drain time
  adaptiveHwm?: number; // computed HWM that triggered drain
}

// Metric passthrough
export interface MsgMetric {
  type: "metric";
  sessionId: string;
  metric: CodecMetric;
}

// ---------------------------------------------------------------------------
// Release state (from existing worker for re-submitted tasks)
// ---------------------------------------------------------------------------

export interface MsgReleaseState {
  type: "release_state";
  sessionId: string;
}

// ---------------------------------------------------------------------------
// Union types
// ---------------------------------------------------------------------------

export type MainToWorkerMessage =
  | MsgDecodeStart
  | MsgDecodeChunk
  | MsgDecodeClose
  | MsgDecodeCancel
  | MsgDecodePause
  | MsgDecodeResume
  | MsgEncodeStart
  | MsgEncodePixels
  | MsgEncodeFinish
  | MsgEncodeCancel
  | MsgWorkerShutdown
  | MsgReleaseState;

export type WorkerToMainMessage =
  | MsgDecodeHeader
  | MsgDecodeProgress
  | MsgDecodeFinal
  | MsgDecodeError
  | MsgDecodeCancelled
  | MsgDecodePaused
  | MsgDecodeBudgetExceeded
  | MsgEncodeChunk
  | MsgEncodeFirstByteReady
  | MsgEncodeDone
  | MsgEncodeError
  | MsgEncodeCancelled
  | MsgWorkerReady
  | MsgWorkerShutdownAck
  | MsgWorkerError
  | MsgWorkerDrain
  | MsgMetric;
