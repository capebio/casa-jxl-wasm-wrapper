import { describe, test } from "node:test";
import type { MsgDecodeStart, MsgEncodeStart, WorkerToMainMessage } from "@casabio/jxl-core/protocol";
import { DecodeHandler } from "../src/decode-handler.js";
import { EncodeHandler } from "../src/encode-handler.js";
import { expect } from "./expect.js";

const baseDecodeStart: MsgDecodeStart = {
  type: "decode_start",
  sessionId: "decode-1",
  format: "rgba8",
  region: null,
  downsample: 1,
  progressionTarget: "final",
  emitEveryPass: true,
  preserveIcc: true,
  preserveMetadata: true,
  priority: "visible",
  budgetMs: null,
  progressiveDetail: null,
  targetWidth: null,
  targetHeight: null,
  fitMode: null,
};

const baseEncodeStart: MsgEncodeStart = {
  type: "encode_start",
  sessionId: "encode-1",
  format: "rgba8",
  width: 1,
  height: 1,
  hasAlpha: true,
  iccProfile: null,
  exif: null,
  xmp: null,
  distance: null,
  quality: 90,
  effort: 7,
  progressive: true,
  previewFirst: true,
  chunked: false,
  priority: "visible",
};

describe("browser codec handlers", () => {
  test("decode handler forwards codec header, progress, and final messages", async () => {
    const messages: WorkerToMainMessage[] = [];
    const ended: string[] = [];
    installWorkerPostMessage(messages);

    const pixels = new Uint8Array([1, 2, 3, 4]).buffer;
    const codec = {
      createDecoder() {
        return {
          push() {},
          close() {},
          cancel() {},
          dispose() {},
          async *events() {
            yield {
              type: "header",
              info: {
                width: 1,
                height: 1,
                bitsPerSample: 8,
                hasAlpha: true,
                hasAnimation: false,
                jpegReconstructionAvailable: false,
              },
            };
            yield {
              type: "progress",
              stage: "dc",
              info: {
                width: 1,
                height: 1,
                bitsPerSample: 8,
                hasAlpha: true,
                hasAnimation: false,
                jpegReconstructionAvailable: false,
              },
              pixels,
              format: "rgba8",
              pixelStride: 4,
            };
            yield {
              type: "final",
              info: {
                width: 1,
                height: 1,
                bitsPerSample: 8,
                hasAlpha: true,
                hasAnimation: false,
                jpegReconstructionAvailable: false,
              },
              pixels,
              format: "rgba8",
              pixelStride: 4,
            };
          },
        };
      },
    };

    const handler = new DecodeHandler(baseDecodeStart, codec as never, {
      onSessionEnd: (sessionId) => ended.push(sessionId),
    });
    handler.onChunk(new Uint8Array([0xff]).buffer);
    handler.onClose();

    await waitFor(() => ended.length === 1);

    expect(messages.filter((msg) => msg.type.startsWith("decode_")).map((msg) => msg.type)).toEqual([
      "decode_header",
      "decode_progress",
      "decode_final",
    ]);
    expect(ended).toEqual(["decode-1"]);
  });

  test("budget_exceeded before first progress emits terminal message, not silent death", async () => {
    const messages: WorkerToMainMessage[] = [];
    const ended: string[] = [];
    installWorkerPostMessage(messages);

    const info = {
      width: 1, height: 1, bitsPerSample: 8,
      hasAlpha: true, hasAnimation: false, jpegReconstructionAvailable: false,
    };
    const codec = {
      createDecoder() {
        return {
          push() {},
          close() {},
          cancel() {},
          dispose() {},
          async *events() {
            yield { type: "header", info };
            yield { type: "final", info, pixels: new Uint8Array([1, 2, 3, 4]).buffer, format: "rgba8", pixelStride: 4 };
          },
        };
      },
    };

    const handler = new DecodeHandler(
      { ...baseDecodeStart, sessionId: "budget-pre-progress", budgetMs: 0 },
      codec as never,
      { onSessionEnd: (sessionId) => ended.push(sessionId) },
    );
    handler.onChunk(new Uint8Array([0xff]).buffer);
    handler.onClose();

    await waitFor(() => ended.length === 1);

    // Session must emit a terminal decode_ message; previously the feed-loop
    // budget check called finishSession("budget_exceeded") with no protocol
    // message and left readDecoderEvents blocked — silent death.
    const terminalMessages = messages.filter((msg) =>
      msg.type === "decode_final" ||
      msg.type === "decode_budget_exceeded" ||
      msg.type === "decode_error" ||
      msg.type === "decode_cancelled",
    );
    expect(terminalMessages.length).toBeGreaterThan(0);
  });

  test("decode handler stops draining queued chunks when pause lands during async push", async () => {
    const messages: WorkerToMainMessage[] = [];
    const ended: string[] = [];
    installWorkerPostMessage(messages);

    let resolveFirstPush!: () => void;
    const pushed: number[] = [];
    const codec = {
      createDecoder() {
        return {
          async push(chunk: ArrayBuffer) {
            pushed.push(new Uint8Array(chunk)[0] ?? -1);
            if (pushed.length === 1) {
              await new Promise<void>((resolve) => { resolveFirstPush = resolve; });
            }
          },
          close() {},
          cancel() {},
          dispose() {},
          async *events() {
            await new Promise(() => undefined);
          },
        };
      },
    };

    const handler = new DecodeHandler(
      { ...baseDecodeStart, sessionId: "pause-mid-burst" },
      codec as never,
      { onSessionEnd: (sessionId) => ended.push(sessionId) },
    );
    handler.onChunk(new Uint8Array([1]).buffer);
    handler.onChunk(new Uint8Array([2]).buffer);

    await waitFor(() => pushed.length === 1);
    handler.onPause();
    resolveFirstPush();
    await tick();

    expect(pushed).toEqual([1]);
    expect(messages.some((msg) => msg.type === "decode_paused")).toBe(true);

    handler.onResume();
    await waitFor(() => pushed.length === 2);
    await handler.onCancel("test cleanup");
    await waitFor(() => ended.length === 1);
  });

  test("posts time_to_first_pixel_ms for final-only decode (no progress events)", async () => {
    const messages: WorkerToMainMessage[] = [];
    const ended: string[] = [];
    installWorkerPostMessage(messages);

    const info = {
      width: 1, height: 1, bitsPerSample: 8,
      hasAlpha: true, hasAnimation: false, jpegReconstructionAvailable: false,
    };
    const codec = {
      createDecoder() {
        return {
          push() {},
          close() {},
          cancel() {},
          dispose() {},
          async *events() {
            yield { type: "header", info };
            yield { type: "final", info, pixels: new Uint8Array([1, 2, 3, 4]).buffer, format: "rgba8", pixelStride: 4 };
          },
        };
      },
    };

    const handler = new DecodeHandler(
      { ...baseDecodeStart, sessionId: "final-only-metrics" },
      codec as never,
      { onSessionEnd: (sessionId) => ended.push(sessionId) },
    );
    handler.onChunk(new Uint8Array([0xff]).buffer);
    handler.onClose();

    await waitFor(() => ended.length === 1);

    const finalMessage = messages.find((msg) => msg.type === "decode_final") as
      | { type: "decode_final"; timeToFirstPixelMs?: number; timeToFinalMs?: number }
      | undefined;
    const metricNames = messages
      .filter((msg) => msg.type === "metric")
      .map((msg) => (msg as { type: "metric"; metric: { name: string } }).metric.name);

    expect(metricNames).toContain("time_to_header_ms");
    expect(finalMessage?.timeToFirstPixelMs).toBeDefined();
    expect(finalMessage?.timeToFinalMs).toBeDefined();
  });

  test("decode handler finishes worker session after early progression target progress without waiting for close", async () => {
    const messages: WorkerToMainMessage[] = [];
    const ended: string[] = [];
    installWorkerPostMessage(messages);

    const info = {
      width: 1, height: 1, bitsPerSample: 8,
      hasAlpha: true, hasAnimation: false, jpegReconstructionAvailable: false,
    };
    const codec = {
      createDecoder() {
        return {
          push() {},
          close() {},
          cancel() {},
          dispose() {},
          async *events() {
            yield { type: "header", info };
            yield {
              type: "progress",
              stage: "dc" as const,
              info,
              pixels: new Uint8Array([1, 2, 3, 4]).buffer,
              format: "rgba8" as const,
              pixelStride: 4,
            };
          },
        };
      },
    };

    const handler = new DecodeHandler(
      { ...baseDecodeStart, sessionId: "early-progress-target", progressionTarget: "dc", emitEveryPass: false },
      codec as never,
      { onSessionEnd: (sessionId) => ended.push(sessionId) },
    );
    handler.onChunk(new Uint8Array([0xff]).buffer);

    await waitFor(() => ended.length === 1);

    expect(messages.filter((msg) => msg.type.startsWith("decode_")).map((msg) => msg.type)).toEqual([
      "decode_header",
      "decode_progress",
    ]);
    expect(ended).toEqual(["early-progress-target"]);
  });

  test("decode handler checks budget before touching progress pixels", async () => {
    const messages: WorkerToMainMessage[] = [];
    const ended: string[] = [];
    installWorkerPostMessage(messages);

    let nowMs = 0;
    const restoreNow = mockPerformanceNow(() => nowMs);
    const info = {
      width: 1, height: 1, bitsPerSample: 8,
      hasAlpha: true, hasAnimation: false, jpegReconstructionAvailable: false,
    };
    const codec = {
      createDecoder() {
        return {
          push() {},
          close() {},
          cancel() {},
          dispose() {},
          async *events() {
            yield { type: "header", info };
            nowMs = 5;
            const progress: Record<string, unknown> = {
              type: "progress",
              stage: "dc",
              info,
              format: "rgba8",
              pixelStride: 4,
            };
            Object.defineProperty(progress, "pixels", {
              get() {
                throw new Error("pixels getter should not run after budget expires");
              },
            });
            yield progress as any;
          },
        };
      },
    };

    const handler = new DecodeHandler(
      { ...baseDecodeStart, sessionId: "budget-before-copy", budgetMs: 0 },
      codec as never,
      { onSessionEnd: (sessionId) => ended.push(sessionId) },
    );
    handler.onChunk(new Uint8Array([0xff]).buffer);
    handler.onClose();

    await waitFor(() => ended.length === 1);
    restoreNow();

    const budget = messages.find((msg) => msg.type === "decode_budget_exceeded") as
      | { type: "decode_budget_exceeded"; pixels: ArrayBuffer }
      | undefined;
    expect(budget?.pixels.byteLength).toBe(0);
  });

  test("decode handler forwards progressive metadata and transfer-copy metrics", async () => {
    const messages: WorkerToMainMessage[] = [];
    const ended: string[] = [];
    installWorkerPostMessage(messages);

    const info = {
      width: 1, height: 1, bitsPerSample: 8,
      hasAlpha: true, hasAnimation: false, jpegReconstructionAvailable: false,
    };
    const backing = new Uint8Array([0, 1, 2, 3, 4, 5]).buffer;
    const codec = {
      createDecoder() {
        return {
          push() {},
          close() {},
          cancel() {},
          dispose() {},
          async *events() {
            yield { type: "header", info };
            yield {
              type: "progress",
              stage: "dc" as const,
              info,
              pixels: new Uint8Array(backing, 1, 4),
              format: "rgba8" as const,
              pixelStride: 4,
              region: { x: 1, y: 2, w: 3, h: 4 },
              sourceScale: 4,
              progressiveRegion: false,
              regionFallback: "full-frame-then-crop" as const,
              frameDuration: 7,
              progressiveSequence: 1,
              passOrdinal: 0,
            };
            yield {
              type: "final",
              info,
              pixels: new Uint8Array([1, 2, 3, 4]).buffer,
              format: "rgba8" as const,
              pixelStride: 4,
            };
          },
        };
      },
    };

    const handler = new DecodeHandler(
      { ...baseDecodeStart, sessionId: "progress-metadata" },
      codec as never,
      { onSessionEnd: (sessionId) => ended.push(sessionId) },
    );
    handler.onChunk(new Uint8Array([0xff]).buffer);
    handler.onClose();

    await waitFor(() => ended.length === 1);

    const progress = messages.find((msg) => msg.type === "decode_progress") as
      | {
          type: "decode_progress";
          sourceScale?: number;
          progressiveRegion?: boolean;
          regionFallback?: string;
          frameDuration?: number;
          progressiveSequence?: number;
          passOrdinal?: number;
          region?: { x: number; y: number; w: number; h: number };
          copyMs?: number;
          copiedBytes?: number;
        }
      | undefined;

    expect(progress?.sourceScale).toBe(4);
    expect(progress?.progressiveRegion).toBe(false);
    expect(progress?.regionFallback).toBe("full-frame-then-crop");
    expect(progress?.frameDuration).toBe(7);
    expect(progress?.progressiveSequence).toBe(1);
    expect(progress?.passOrdinal).toBe(0);
    expect(progress?.region).toEqual({ x: 1, y: 2, w: 3, h: 4 });
    // Copy metrics are now folded onto the frame (sub-view pixels → copied), not posted
    // as separate metric messages. The session re-emits them via onMetric.
    expect(progress?.copyMs).toBeDefined();
    expect(progress?.copiedBytes).toBe(4);
  });

  test("decode handler does not post decode_cancelled for release_state", async () => {
    const messages: WorkerToMainMessage[] = [];
    const ended: string[] = [];
    installWorkerPostMessage(messages);

    const codec = {
      createDecoder() {
        return {
          push() {},
          close() {},
          cancel() {},
          dispose() {},
          async *events() {
            await new Promise(() => undefined);
          },
        };
      },
    };

    const handler = new DecodeHandler(
      { ...baseDecodeStart, sessionId: "release-state" },
      codec as never,
      { onSessionEnd: (sessionId) => ended.push(sessionId) },
    );
    await handler.onCancel("release_state");

    expect(messages.some((msg) => msg.type === "decode_cancelled")).toBe(false);
    expect(ended).toEqual(["release-state"]);
  });

  test("decode handler supplies partial stride when codec error omits it", async () => {
    const messages: WorkerToMainMessage[] = [];
    const ended: string[] = [];
    installWorkerPostMessage(messages);

    const partialInfo = {
      width: 1, height: 1, bitsPerSample: 16 as const,
      hasAlpha: true, hasAnimation: false, jpegReconstructionAvailable: false,
    };
    const codec = {
      createDecoder() {
        return {
          push() {},
          close() {},
          cancel() {},
          dispose() {},
          async *events() {
            yield {
              type: "error",
              code: "TruncatedStream",
              message: "cut short",
              partialPixels: new Uint8Array(8),
              partialInfo,
            };
          },
        };
      },
    };

    const handler = new DecodeHandler(
      { ...baseDecodeStart, sessionId: "partial-stride", format: "rgba16" },
      codec as never,
      { onSessionEnd: (sessionId) => ended.push(sessionId) },
    );
    handler.onChunk(new Uint8Array([0xff]).buffer);

    await waitFor(() => ended.length === 1);

    const error = messages.find((msg) => msg.type === "decode_error") as
      | { type: "decode_error"; partialPixelStride?: number; partialStage?: string }
      | undefined;
    expect(error?.partialPixelStride).toBe(8);
    expect(error?.partialStage).toBe(undefined);
  });

  test("encode handler streams codec output chunks and done", async () => {
    const messages: WorkerToMainMessage[] = [];
    const ended: string[] = [];
    installWorkerPostMessage(messages);

    const codec = {
      createEncoder() {
        return {
          pushPixels() {},
          finish() {},
          cancel() {},
          dispose() {},
          async *chunks() {
            yield new Uint8Array([0, 1, 2]).buffer;
            yield new Uint8Array([3, 4]).buffer;
          },
        };
      },
    };

    const handler = new EncodeHandler(baseEncodeStart, codec as never, {
      onSessionEnd: (sessionId) => ended.push(sessionId),
    });
    handler.onPixels(new Uint8Array([255, 0, 0, 255]).buffer);
    handler.onFinish();

    await waitFor(() => ended.length === 1);

    expect(messages.filter((msg) => msg.type.startsWith("encode_")).map((msg) => msg.type)).toEqual([
      "encode_first_byte_ready",
      "encode_chunk",
      "encode_chunk",
      "encode_done",
    ]);
    expect(messages.filter((msg) => msg.type.startsWith("encode_")).at(-1)).toEqual({ type: "encode_done", sessionId: "encode-1", totalBytes: 5 });
  });

  test("encode handler coalesces worker_drain while queue stays below HWM", async () => {
    const messages: WorkerToMainMessage[] = [];
    const ended: string[] = [];
    installWorkerPostMessage(messages);

    let nowMs = 0;
    const restoreNow = mockPerformanceNow(() => nowMs);

    const codec = {
      createEncoder() {
        return {
          pushPixels() {
            nowMs += 0;
          },
          finish() {},
          cancel() {},
          dispose() {},
          async *chunks() {
            yield new Uint8Array([0]).buffer;
          },
        };
      },
    };

    const handler = new EncodeHandler(baseEncodeStart, codec as never, {
      onSessionEnd: (sessionId) => ended.push(sessionId),
    });
    handler.onPixels(new Uint8Array([1, 0, 0, 255]).buffer);
    handler.onPixels(new Uint8Array([2, 0, 0, 255]).buffer);
    handler.onPixels(new Uint8Array([3, 0, 0, 255]).buffer);
    handler.onFinish();

    await waitFor(() => ended.length === 1);
    restoreNow();

    expect(messages.filter((msg) => msg.type === "worker_drain")).toHaveLength(1);
  });

  test("encode handler treats finish as closed input", async () => {
    const messages: WorkerToMainMessage[] = [];
    const ended: string[] = [];
    installWorkerPostMessage(messages);

    const pushed: number[] = [];
    const codec = {
      createEncoder() {
        return {
          pushPixels(chunk: ArrayBuffer) {
            pushed.push(new Uint8Array(chunk)[0] ?? -1);
          },
          finish() {},
          cancel() {},
          dispose() {},
          async *chunks() {},
        };
      },
    };

    const handler = new EncodeHandler(baseEncodeStart, codec as never, {
      onSessionEnd: (sessionId) => ended.push(sessionId),
    });
    handler.onFinish();
    handler.onPixels(new Uint8Array([7, 0, 0, 255]).buffer);

    await waitFor(() => ended.length === 1);

    expect(pushed).toEqual([]);
  });

  test("encode handler cancel disposes blocked encoder and suppresses release_state message", async () => {
    const messages: WorkerToMainMessage[] = [];
    const ended: string[] = [];
    installWorkerPostMessage(messages);

    let dispose!: () => void;
    const codec = {
      createEncoder() {
        return {
          pushPixels() {},
          finish() {},
          cancel() {},
          dispose() {
            dispose();
          },
          async *chunks() {
            await new Promise<void>((resolve) => { dispose = resolve; });
          },
        };
      },
    };

    const handler = new EncodeHandler(
      { ...baseEncodeStart, sessionId: "encode-release-state" },
      codec as never,
      { onSessionEnd: (sessionId) => ended.push(sessionId) },
    );

    await waitFor(() => dispose !== undefined);
    await handler.onCancel("release_state");
    await waitFor(() => ended.length === 1);

    expect(messages.some((msg) => msg.type === "encode_cancelled")).toBe(false);
    expect(ended).toEqual(["encode-release-state"]);
  });

  test("decode handler emits frames transparently with deferredRelease=true", async () => {
    const messages: WorkerToMainMessage[] = [];
    const ended: string[] = [];
    installWorkerPostMessage(messages);

    const info = {
      width: 2, height: 2, bitsPerSample: 8,
      hasAlpha: true, hasAnimation: false, jpegReconstructionAvailable: false,
    };
    // deferredRelease=true means the decoder reuses the same buffer across frames.
    // The handler must transparently forward pixels without detachment issues.
    const sharedBuffer = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]).buffer;
    const codec = {
      createDecoder() {
        return {
          push() {},
          close() {},
          cancel() {},
          dispose() {},
          async *events() {
            yield { type: "header", info };
            // First progress: emit view into shared buffer
            yield {
              type: "progress",
              stage: "dc" as const,
              info,
              pixels: new Uint8Array(sharedBuffer, 0, 4),
              format: "rgba8" as const,
              pixelStride: 4,
            };
            // Final: reuse buffer (simulating deferredRelease behavior)
            yield {
              type: "final",
              info,
              pixels: new Uint8Array(sharedBuffer, 0, 16),
              format: "rgba8" as const,
              pixelStride: 4,
            };
          },
        };
      },
    };

    const handler = new DecodeHandler(
      { ...baseDecodeStart, sessionId: "deferred-release-test" },
      codec as never,
      { onSessionEnd: (sessionId) => ended.push(sessionId) },
    );
    handler.onChunk(new Uint8Array([0xff]).buffer);
    handler.onClose();

    await waitFor(() => ended.length === 1);

    // Verify handler forwarded header, progress, and final
    const decodeMsgs = messages.filter((msg) => msg.type.startsWith("decode_")).map((msg) => msg.type);
    expect(decodeMsgs).toEqual(["decode_header", "decode_progress", "decode_final"]);

    // Verify pixels are present in both frames
    const progress = messages.find((msg) => msg.type === "decode_progress") as
      | { type: "decode_progress"; pixels: ArrayBuffer }
      | undefined;
    const final = messages.find((msg) => msg.type === "decode_final") as
      | { type: "decode_final"; pixels: ArrayBuffer }
      | undefined;

    expect(progress?.pixels).toBeDefined();
    expect(final?.pixels).toBeDefined();
    expect(progress!.pixels.byteLength).toBeGreaterThan(0);
    expect(final!.pixels.byteLength).toBeGreaterThan(0);

    expect(ended).toEqual(["deferred-release-test"]);
  });
});

function installWorkerPostMessage(messages: WorkerToMainMessage[]): void {
  Object.defineProperty(globalThis, "self", {
    configurable: true,
    value: {
      postMessage(message: WorkerToMainMessage) {
        // structuredClone to simulate real postMessage (which clones).
        // Required because DecodeHandler reuses prealloc _metricMsg/_metricInner;
        // without clone, later metric posts mutate earlier entries in the captured array.
        messages.push(structuredClone(message));
      },
    },
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 500) {
      throw new Error("timed out waiting for handler");
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function mockPerformanceNow(getNow: () => number): () => void {
  const original = performance.now.bind(performance);
  Object.defineProperty(performance, "now", {
    configurable: true,
    value: getNow,
  });
  return () => {
    Object.defineProperty(performance, "now", {
      configurable: true,
      value: original,
    });
  };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
