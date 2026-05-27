import type { PixelFormat, DecodeStage, ImageInfo, Region, CodecMetric } from "./types.js";
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
    chunk: ArrayBuffer;
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
    pixels: ArrayBuffer;
    format: PixelFormat;
    region?: Region;
    pixelStride: number;
}
export interface MsgDecodeFinal {
    type: "decode_final";
    sessionId: string;
    info: ImageInfo;
    pixels: ArrayBuffer;
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
    partialPixels?: ArrayBuffer;
    partialInfo?: ImageInfo;
    partialPixelStride?: number;
    partialStage?: DecodeStage;
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
    pixels: ArrayBuffer;
    info: ImageInfo;
    format: PixelFormat;
    region?: Region;
    pixelStride: number;
}
export interface MsgEncodeStart {
    type: "encode_start";
    sessionId: string;
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
    progressiveFlavor?: "dc" | "ac";
    previewFirst: boolean;
    chunked: boolean;
    sidecarSizes?: readonly number[];
    priority: "visible" | "near" | "background";
}
export interface MsgEncodePixels {
    type: "encode_pixels";
    sessionId: string;
    chunk: ArrayBuffer;
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
export interface MsgEncodeChunk {
    type: "encode_chunk";
    sessionId: string;
    chunk: ArrayBuffer;
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
export interface MsgWorkerReady {
    type: "worker_ready";
    backend: "wasm" | "native";
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
export interface MsgWorkerDrain {
    type: "worker_drain";
    sessionId: string;
    latencyMs?: number;
    queueDepth?: number;
    queuedBytes?: number;
    adaptiveHwm?: number;
}
export interface MsgMetric {
    type: "metric";
    sessionId: string;
    metric: CodecMetric;
}
export interface MsgReleaseState {
    type: "release_state";
    sessionId: string;
}
export type MainToWorkerMessage = MsgDecodeStart | MsgDecodeChunk | MsgDecodeClose | MsgDecodeCancel | MsgDecodePause | MsgDecodeResume | MsgEncodeStart | MsgEncodePixels | MsgEncodeFinish | MsgEncodeCancel | MsgWorkerShutdown | MsgReleaseState;
export type WorkerToMainMessage = MsgDecodeHeader | MsgDecodeProgress | MsgDecodeFinal | MsgDecodeError | MsgDecodeCancelled | MsgDecodePaused | MsgDecodeBudgetExceeded | MsgEncodeChunk | MsgEncodeFirstByteReady | MsgEncodeDone | MsgEncodeError | MsgEncodeCancelled | MsgWorkerReady | MsgWorkerShutdownAck | MsgWorkerError | MsgWorkerDrain | MsgMetric;
//# sourceMappingURL=protocol.d.ts.map