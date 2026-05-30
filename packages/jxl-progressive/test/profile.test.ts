// packages/jxl-progressive/test/profile.test.ts
// Uses a mock DecodeSession that emits fake frames at controlled byte offsets.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { profileJxl, type ProfileOptions } from "../src/progressive-profile.js";
import type { SessionFactory } from "../src/types.js";
import type { DecodeSession, DecodeFrameEvent, ImageInfo } from "@casabio/jxl-session";

// Minimal ImageInfo for frame events
const fakeInfo: ImageInfo = {
  width: 100, height: 100, bitsPerSample: 8, hasAlpha: false,
  hasAnimation: false, jpegReconstructionAvailable: false,
};

// fakePixels: a small ArrayBuffer representing pixel data
function fakePixels(): ArrayBuffer { return new ArrayBuffer(100 * 100 * 4); }

/**
 * MockDecodeSession emits one frame event per N bytes pushed.
 * After close(), it resolves frames() iteration.
 */
function makeMockSession(opts: {
  // emit a frame event after these many bytes have been pushed (cumulative)
  emitAtBytes: number[];
  stages?: string[];
}): { session: DecodeSession; factory: SessionFactory } {
  let bytesPushed = 0;
  let frameIdx = 0;
  const { emitAtBytes, stages = [] } = opts;

  // We use an async generator that yields frames on demand.
  // The session yields a frame whenever bytesPushed crosses the next threshold.
  let resolveNext: (() => void) | null = null;
  const pending: DecodeFrameEvent[] = [];
  let done = false;

  function maybeTrigger() {
    while (
      frameIdx < emitAtBytes.length &&
      bytesPushed >= (emitAtBytes[frameIdx] ?? Infinity)
    ) {
      const stage = stages[frameIdx] ?? "pass";
      pending.push({
        stage: stage as DecodeFrameEvent["stage"],
        info: fakeInfo,
        pixels: fakePixels(),
        format: "rgba8",
        pixelStride: 100 * 4,
      });
      frameIdx++;
    }
    resolveNext?.();
    resolveNext = null;
  }

  const session: DecodeSession = {
    id: "mock-session",
    async push(chunk) {
      bytesPushed += (chunk instanceof ArrayBuffer ? chunk.byteLength : (chunk as Uint8Array).byteLength);
      maybeTrigger();
    },
    async close() {
      done = true;
      maybeTrigger();
    },
    async cancel() {
      done = true;
      resolveNext?.();
    },
    async done() { return fakeInfo; },
    async *frames() {
      while (true) {
        while (pending.length > 0) {
          yield pending.shift()!;
        }
        if (done && pending.length === 0) break;
        await new Promise<void>((r) => { resolveNext = r; });
      }
    },
  };

  const factory: SessionFactory = () => session;
  return { session, factory };
}

describe("profileJxl", () => {
  it("returns a manifest with version 1", async () => {
    const { factory } = makeMockSession({ emitAtBytes: [1024, 4096, 8192] });
    const jxl = new ArrayBuffer(10000);
    const m = await profileJxl(jxl, factory, { width: 100, height: 100, hasAlpha: false });
    assert.equal(m.version, 1);
  });

  it("includes full tier with byteEnd = jxl.byteLength", async () => {
    const { factory } = makeMockSession({ emitAtBytes: [1000, 4000] });
    const jxl = new ArrayBuffer(8000);
    const m = await profileJxl(jxl, factory, { width: 100, height: 100, hasAlpha: false });
    const full = m.tiers.find((t) => t.name === "full");
    assert.ok(full, "full tier must exist");
    assert.equal(full!.byteEnd, 8000);
  });

  it("dc tier byteEnd is less than full file size", async () => {
    const { factory } = makeMockSession({
      emitAtBytes: [500, 3000, 7000],
      stages: ["dc", "pass", "pass"],
    });
    const jxl = new ArrayBuffer(10000);
    const m = await profileJxl(jxl, factory, { width: 100, height: 100, hasAlpha: false });
    const dc = m.tiers.find((t) => t.name === "dc");
    assert.ok(dc, "dc tier must exist");
    assert.ok(dc!.byteEnd < 10000, "dc byteEnd must be < full size");
  });

  it("falls back to single full tier when no progression events occur", async () => {
    const { factory } = makeMockSession({ emitAtBytes: [] });
    const jxl = new ArrayBuffer(5000);
    const m = await profileJxl(jxl, factory, { width: 50, height: 50, hasAlpha: false });
    assert.equal(m.tiers.length, 1);
    assert.equal(m.tiers[0]?.name, "full");
  });

  it("jxl.bytes equals jxlBytes.byteLength", async () => {
    const { factory } = makeMockSession({ emitAtBytes: [1000] });
    const jxl = new ArrayBuffer(9000);
    const m = await profileJxl(jxl, factory, { width: 100, height: 100, hasAlpha: false });
    assert.equal(m.jxl.bytes, 9000);
  });

  it("jxl.sha256 is a 64-char hex string", async () => {
    const { factory } = makeMockSession({ emitAtBytes: [500] });
    const jxl = new ArrayBuffer(2000);
    const m = await profileJxl(jxl, factory, { width: 100, height: 100, hasAlpha: false });
    assert.match(m.jxl.sha256, /^[0-9a-f]{64}$/);
  });

  it("includes saliency metadata when provided", async () => {
    const { factory } = makeMockSession({ emitAtBytes: [500] });
    const jxl = new ArrayBuffer(2000);
    const saliency = { enabled: true, centerX: 0.5, centerY: 0.3, confidence: 0.85, method: "attention" };
    const m = await profileJxl(
      jxl, factory, { width: 100, height: 100, hasAlpha: false },
      { saliency },
    );
    assert.deepEqual(m.saliency, saliency);
  });

  it("calls onProgress with increasing byte offsets", async () => {
    const { factory } = makeMockSession({ emitAtBytes: [500] });
    const jxl = new ArrayBuffer(3000);
    const offsets: number[] = [];
    await profileJxl(jxl, factory, { width: 100, height: 100, hasAlpha: false }, {
      chunkSize: 1000,
      onProgress: (offset) => offsets.push(offset),
    });
    assert.ok(offsets.length > 0);
    // offsets must be non-decreasing
    for (let i = 1; i < offsets.length; i++) {
      assert.ok(offsets[i]! >= offsets[i - 1]!);
    }
    assert.equal(offsets[offsets.length - 1], 3000);
  });

  it("rejects when signal is pre-aborted", async () => {
    const { factory } = makeMockSession({ emitAtBytes: [] });
    const ctrl = new AbortController();
    ctrl.abort();
    const jxl = new ArrayBuffer(1000);
    await assert.rejects(
      profileJxl(jxl, factory, { width: 10, height: 10, hasAlpha: false }, { signal: ctrl.signal }),
    );
  });
});
