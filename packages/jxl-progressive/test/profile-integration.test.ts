// packages/jxl-progressive/test/profile-integration.test.ts
// End-to-end: drive the real profiler with a pure-JS scorer + downscaler and assert the
// emitted manifest is valid, has scored tiers, and a well-formed scale frontier.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { profileJxl, type Downscaler } from "../src/progressive-profile.js";
import { validateManifest, type ScaleFrontierEntry } from "../src/progressive-manifest.js";
import { psnrVsRef, type MetricScorer } from "../src/progressive-metrics.js";
import type { SessionFactory } from "../src/types.js";
import type { DecodeSession, DecodeFrameEvent, ImageInfo } from "@casabio/jxl-session";

const W = 16, H = 16;
function solid(v: number): Uint8Array {
  const p = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) { p[i * 4] = v; p[i * 4 + 1] = v; p[i * 4 + 2] = v; p[i * 4 + 3] = 255; }
  return p;
}
function checker(): Uint8Array {
  const p = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = ((x + y) & 1) ? 255 : 0; const i = (y * W + x) * 4;
    p[i] = v; p[i + 1] = v; p[i + 2] = v; p[i + 3] = 255;
  }
  return p;
}
function boxAvg(rgba: Uint8Array, w: number, h: number, dw: number, dh: number): Uint8Array {
  const out = new Uint8Array(dw * dh * 4);
  const xs = w / dw, ys = h / dh;
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
    const x0 = Math.floor(x * xs), x1 = Math.max(x0 + 1, Math.floor((x + 1) * xs));
    const y0 = Math.floor(y * ys), y1 = Math.max(y0 + 1, Math.floor((y + 1) * ys));
    let r = 0, g = 0, b = 0, a = 0, cnt = 0;
    for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) {
      const si = (sy * w + sx) * 4; r += rgba[si]!; g += rgba[si + 1]!; b += rgba[si + 2]!; a += rgba[si + 3]!; cnt++;
    }
    const di = (y * dw + x) * 4; out[di] = r / cnt; out[di + 1] = g / cnt; out[di + 2] = b / cnt; out[di + 3] = a / cnt;
  }
  return out;
}
const fakeInfo: ImageInfo = { width: W, height: H, bitsPerSample: 8, hasAlpha: false, hasAnimation: false, jpegReconstructionAvailable: false };

function mock(frames: { atBytes: number; stage: string; pixels: Uint8Array }[]): SessionFactory {
  return () => {
    let bytesPushed = 0, idx = 0, done = false;
    let resolveNext: (() => void) | null = null;
    const pending: DecodeFrameEvent[] = [];
    function trig() {
      while (idx < frames.length && bytesPushed >= (frames[idx]?.atBytes ?? Infinity)) {
        const f = frames[idx]!;
        pending.push({ stage: f.stage as DecodeFrameEvent["stage"], info: fakeInfo, pixels: f.pixels.buffer.slice(0), format: "rgba8", pixelStride: W * 4 });
        idx++;
      }
      resolveNext?.(); resolveNext = null;
    }
    const s: DecodeSession = {
      id: "int-mock",
      async push(c) { bytesPushed += (c instanceof ArrayBuffer ? c.byteLength : (c as Uint8Array).byteLength); trig(); },
      async close() { done = true; trig(); },
      async cancel() { done = true; resolveNext?.(); },
      async done() { return fakeInfo; },
      async *frames() { while (true) { while (pending.length) yield pending.shift()!; if (done && !pending.length) break; await new Promise<void>((r) => { resolveNext = r; }); } },
    };
    return s;
  };
}

describe("profile end-to-end (perceptual tiers + scale frontier)", () => {
  it("produces a valid manifest with scored tiers and a well-formed scale frontier", async () => {
    const factory = mock([
      { atBytes: 1000, stage: "dc", pixels: solid(128) },
      { atBytes: 5000, stage: "pass", pixels: checker() },
      { atBytes: 8000, stage: "final", pixels: checker() },
    ]);
    const scorer: MetricScorer = { metric: "psnr", score: async (c, r) => psnrVsRef(c, r) };
    const downscaler: Downscaler = boxAvg;
    const displaySizes = [2, 8, 16];

    const m = await profileJxl(
      new ArrayBuffer(8000), factory, { width: W, height: H, hasAlpha: false },
      { scorer, downscaler, displaySizes, chunkSize: 1000, encoderName: "test" },
    );

    // 1. Schema-valid (round-trips through the validator the consumer/edge uses).
    assert.doesNotThrow(() => validateManifest(m));

    // 2. Non-final tiers carry a perceptual score.
    for (const t of m.tiers) {
      if (t.name !== "full") {
        assert.equal(t.score?.metric, "psnr");
        assert.equal(t.score?.reference, "final");
      }
    }

    // 3. Scale frontier: one entry per display size, byteEnds non-decreasing & within file.
    assert.ok(m.scaleFrontier, "expected a scaleFrontier");
    assert.equal(m.scaleFrontier!.length, displaySizes.length);
    for (let i = 0; i < m.scaleFrontier!.length; i++) {
      const e: ScaleFrontierEntry = m.scaleFrontier![i]!;
      assert.equal(e.maxDisplayPx, displaySizes[i]);
      assert.ok(e.byteEnd > 0 && e.byteEnd <= m.jxl.bytes);
      if (i > 0) assert.ok(e.byteEnd >= m.scaleFrontier![i - 1]!.byteEnd);
    }
  });
});
