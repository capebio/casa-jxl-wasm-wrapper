import { describe, test } from "node:test";
import { DecodeHandler } from "../src/decode-handler.js";
import { EncodeHandler } from "../src/encode-handler.js";
import { expect } from "./expect.js";
const baseDecodeStart = {
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
const baseEncodeStart = {
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
        const messages = [];
        const ended = [];
        installWorkerPostMessage(messages);
        const pixels = new Uint8Array([1, 2, 3, 4]).buffer;
        const codec = {
            createDecoder() {
                return {
                    push() { },
                    close() { },
                    cancel() { },
                    dispose() { },
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
        const handler = new DecodeHandler(baseDecodeStart, codec, {
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
        const messages = [];
        const ended = [];
        installWorkerPostMessage(messages);
        const info = {
            width: 1, height: 1, bitsPerSample: 8,
            hasAlpha: true, hasAnimation: false, jpegReconstructionAvailable: false,
        };
        const codec = {
            createDecoder() {
                return {
                    push() { },
                    close() { },
                    cancel() { },
                    dispose() { },
                    async *events() {
                        yield { type: "header", info };
                        yield { type: "final", info, pixels: new Uint8Array([1, 2, 3, 4]).buffer, format: "rgba8", pixelStride: 4 };
                    },
                };
            },
        };
        const handler = new DecodeHandler({ ...baseDecodeStart, sessionId: "budget-pre-progress", budgetMs: 0 }, codec, { onSessionEnd: (sessionId) => ended.push(sessionId) });
        handler.onChunk(new Uint8Array([0xff]).buffer);
        handler.onClose();
        await waitFor(() => ended.length === 1);
        // Session must emit a terminal decode_ message; previously the feed-loop
        // budget check called finishSession("budget_exceeded") with no protocol
        // message and left readDecoderEvents blocked — silent death.
        const terminalMessages = messages.filter((msg) => msg.type === "decode_final" ||
            msg.type === "decode_budget_exceeded" ||
            msg.type === "decode_error" ||
            msg.type === "decode_cancelled");
        expect(terminalMessages.length).toBeGreaterThan(0);
    });
    test("posts time_to_first_pixel_ms for final-only decode (no progress events)", async () => {
        const messages = [];
        const ended = [];
        installWorkerPostMessage(messages);
        const info = {
            width: 1, height: 1, bitsPerSample: 8,
            hasAlpha: true, hasAnimation: false, jpegReconstructionAvailable: false,
        };
        const codec = {
            createDecoder() {
                return {
                    push() { },
                    close() { },
                    cancel() { },
                    dispose() { },
                    async *events() {
                        yield { type: "header", info };
                        yield { type: "final", info, pixels: new Uint8Array([1, 2, 3, 4]).buffer, format: "rgba8", pixelStride: 4 };
                    },
                };
            },
        };
        const handler = new DecodeHandler({ ...baseDecodeStart, sessionId: "final-only-metrics" }, codec, { onSessionEnd: (sessionId) => ended.push(sessionId) });
        handler.onChunk(new Uint8Array([0xff]).buffer);
        handler.onClose();
        await waitFor(() => ended.length === 1);
        const finalMessage = messages.find((msg) => msg.type === "decode_final");
        const metricNames = messages
            .filter((msg) => msg.type === "metric")
            .map((msg) => msg.metric.name);
        expect(metricNames).toContain("time_to_header_ms");
        expect(finalMessage?.timeToFirstPixelMs).toBeDefined();
        expect(finalMessage?.timeToFinalMs).toBeDefined();
    });
    test("encode handler streams codec output chunks and done", async () => {
        const messages = [];
        const ended = [];
        installWorkerPostMessage(messages);
        const codec = {
            createEncoder() {
                return {
                    pushPixels() { },
                    finish() { },
                    cancel() { },
                    dispose() { },
                    async *chunks() {
                        yield new Uint8Array([0, 1, 2]).buffer;
                        yield new Uint8Array([3, 4]).buffer;
                    },
                };
            },
        };
        const handler = new EncodeHandler(baseEncodeStart, codec, {
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
        const messages = [];
        const ended = [];
        installWorkerPostMessage(messages);
        let nowMs = 0;
        const restoreNow = mockPerformanceNow(() => nowMs);
        const codec = {
            createEncoder() {
                return {
                    pushPixels() {
                        nowMs += 0;
                    },
                    finish() { },
                    cancel() { },
                    dispose() { },
                    async *chunks() {
                        yield new Uint8Array([0]).buffer;
                    },
                };
            },
        };
        const handler = new EncodeHandler(baseEncodeStart, codec, {
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
});
function installWorkerPostMessage(messages) {
    Object.defineProperty(globalThis, "self", {
        configurable: true,
        value: {
            postMessage(message) {
                messages.push(message);
            },
        },
    });
}
async function waitFor(predicate) {
    const started = Date.now();
    while (!predicate()) {
        if (Date.now() - started > 500) {
            throw new Error("timed out waiting for handler");
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
}
function mockPerformanceNow(getNow) {
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
//# sourceMappingURL=handlers.test.js.map