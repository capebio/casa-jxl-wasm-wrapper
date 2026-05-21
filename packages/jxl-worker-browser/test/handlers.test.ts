import { describe, expect, test } from "bun:test";
import type { MsgDecodeStart, MsgEncodeStart, WorkerToMainMessage } from "@casabio/jxl-core/protocol";
import { DecodeHandler } from "../src/decode-handler";
import { EncodeHandler } from "../src/encode-handler";

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
    expect(messages.findLast((msg) => msg.type.startsWith("encode_"))).toEqual({ type: "encode_done", sessionId: "encode-1", totalBytes: 5 });
  });
});

function installWorkerPostMessage(messages: WorkerToMainMessage[]): void {
  Object.defineProperty(globalThis, "self", {
    configurable: true,
    value: {
      postMessage(message: WorkerToMainMessage) {
        messages.push(message);
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
