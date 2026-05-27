// jxl-session/test/encode-session.test.ts
// Unit tests for EncodeSessionImpl — lifecycle, chunk emission, cancel,
// error normalization, quality/distance defaulting.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EncodeSessionImpl } from "../src/encode-session.js";
import { JxlError } from "@casabio/jxl-core/errors";
import { makeScheduler, waitForWorker, tick } from "./helpers.js";

const baseOpts = { format: "rgba8" as const, width: 64, height: 48, hasAlpha: false };

describe("EncodeSessionImpl lifecycle", () => {
  it("sends encode_start with options mapped from EncodeOptions", async () => {
    const { scheduler, workers } = makeScheduler();
    const session = new EncodeSessionImpl(scheduler, {
      ...baseOpts, effort: 7, progressive: true, previewFirst: true, chunked: true, priority: "background",
    });
    const worker = await waitForWorker(workers);
    const start = worker.messages[0]!;
    assert.equal(start.type, "encode_start");
    if (start.type === "encode_start") {
      assert.equal(start.effort, 7);
      assert.equal(start.progressive, true);
      assert.equal(start.previewFirst, true);
      assert.equal(start.chunked, true);
      assert.equal(start.priority, "background");
    }
    await session.cancel();
    await scheduler.shutdown();
  });

  it("defaults effort to 4 and distance to 1.0 when none supplied", async () => {
    const { scheduler, workers } = makeScheduler();
    const session = new EncodeSessionImpl(scheduler, { ...baseOpts });
    const worker = await waitForWorker(workers);
    const start = worker.messages[0]!;
    if (start.type === "encode_start") {
      assert.equal(start.effort, 4);
      assert.equal(start.distance, 1.0);
      assert.equal(start.quality, null);
    }
    await session.cancel();
    await scheduler.shutdown();
  });

  it("passes quality through and leaves distance null when quality is given", async () => {
    const { scheduler, workers } = makeScheduler();
    const session = new EncodeSessionImpl(scheduler, { ...baseOpts, quality: 90 });
    const worker = await waitForWorker(workers);
    const start = worker.messages[0]!;
    if (start.type === "encode_start") {
      assert.equal(start.quality, 90);
      assert.equal(start.distance, null);
    }
    await session.cancel();
    await scheduler.shutdown();
  });

  it("done() resolves with total bytes on encode_done", async () => {
    const { scheduler, workers } = makeScheduler();
    const session = new EncodeSessionImpl(scheduler, { ...baseOpts });
    const worker = await waitForWorker(workers);
    worker.emit({ type: "encode_done", sessionId: session.id, totalBytes: 4096 });
    assert.equal(await session.done(), 4096);
    await scheduler.shutdown();
  });

  it("chunks() yields encode_chunk buffers in order", async () => {
    const { scheduler, workers } = makeScheduler();
    const session = new EncodeSessionImpl(scheduler, { ...baseOpts });
    const worker = await waitForWorker(workers);
    worker.emit({ type: "encode_chunk", sessionId: session.id, chunk: new ArrayBuffer(10) });
    worker.emit({ type: "encode_chunk", sessionId: session.id, chunk: new ArrayBuffer(20) });
    worker.emit({ type: "encode_done", sessionId: session.id, totalBytes: 30 });
    const sizes: number[] = [];
    for await (const c of session.chunks()) sizes.push(c.byteLength);
    assert.deepEqual(sizes, [10, 20]);
    await scheduler.shutdown();
  });

  it("pushPixels() forwards encode_pixels messages", async () => {
    const { scheduler, workers } = makeScheduler();
    const session = new EncodeSessionImpl(scheduler, { ...baseOpts, chunked: true });
    const worker = await waitForWorker(workers);
    await session.pushPixels(new ArrayBuffer(64));
    await session.finish();
    assert.ok(worker.messages.some((m) => m.type === "encode_pixels"));
    assert.ok(worker.messages.some((m) => m.type === "encode_finish"));
    await session.cancel();
    await scheduler.shutdown();
  });
});

describe("EncodeSessionImpl cancel and errors", () => {
  it("cancel() rejects done() with Cancelled", async () => {
    const { scheduler, workers } = makeScheduler();
    const session = new EncodeSessionImpl(scheduler, { ...baseOpts });
    await waitForWorker(workers);
    await session.cancel();
    await assert.rejects(session.done(), (err: unknown) => {
      assert.ok(err instanceof JxlError);
      assert.equal(err.code, "Cancelled");
      return true;
    });
    await scheduler.shutdown();
  });

  it("encode_error normalizes the code", async () => {
    const { scheduler, workers } = makeScheduler();
    const session = new EncodeSessionImpl(scheduler, { ...baseOpts });
    const worker = await waitForWorker(workers);
    worker.emit({ type: "encode_error", sessionId: session.id, code: "OutOfMemory", message: "oom" });
    await assert.rejects(session.done(), (err: unknown) => {
      assert.ok(err instanceof JxlError);
      assert.equal(err.code, "OutOfMemory");
      return true;
    });
    await scheduler.shutdown();
  });

  it("pushPixels() after finish throws ConfigError", async () => {
    const { scheduler, workers } = makeScheduler();
    const session = new EncodeSessionImpl(scheduler, { ...baseOpts });
    await waitForWorker(workers);
    await session.finish();
    await assert.rejects(session.pushPixels(new ArrayBuffer(8)), (err: unknown) => {
      assert.ok(err instanceof JxlError);
      assert.equal(err.code, "ConfigError");
      return true;
    });
    await session.cancel();
    await scheduler.shutdown();
  });

  it("forwards metric messages to onMetric", async () => {
    const seen: Array<{ name: string; value: number }> = [];
    const { scheduler, workers } = makeScheduler();
    const session = new EncodeSessionImpl(scheduler, { ...baseOpts, onMetric: (m) => seen.push(m) });
    const worker = await waitForWorker(workers);
    worker.emit({ type: "metric", sessionId: session.id, metric: { name: "output_bytes", value: 2048 } });
    await tick();
    assert.equal(seen[0]?.name, "output_bytes");
    await session.cancel();
    await scheduler.shutdown();
  });
});
