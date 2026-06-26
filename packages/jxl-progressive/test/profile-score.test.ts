// packages/jxl-progressive/test/profile-score.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { profileJxl } from "../src/progressive-profile.js";
import { psnrVsRef, type MetricScorer } from "../src/progressive-metrics.js";
import type { SessionFactory } from "../src/types.js";
import type { DecodeSession, DecodeFrameEvent, ImageInfo } from "@casabio/jxl-session";

const W = 4, H = 4;
function solid(v: number): Uint8Array {
  const p = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) { p[i * 4] = v; p[i * 4 + 1] = v; p[i * 4 + 2] = v; p[i * 4 + 3] = 255; }
  return p;
}
const fakeInfo: ImageInfo = {
  width: W, height: H, bitsPerSample: 8, hasAlpha: false,
  hasAnimation: false, jpegReconstructionAvailable: false,
};

// Mock that emits a frame (with given stage + pixels) once `atBytes` cumulative bytes
// are pushed. Uses the resolveNext wake pattern (see profile.test.ts) so byteOffsets
// are deterministic, not race-prone.
function makeScoringMock(frames: { atBytes: number; stage: string; pixels: Uint8Array }[]): SessionFactory {
  return () => {
    let bytesPushed = 0, idx = 0, done = false;
    let resolveNext: (() => void) | null = null;
    const pending: DecodeFrameEvent[] = [];
    function maybeTrigger() {
      while (idx < frames.length && bytesPushed >= (frames[idx]?.atBytes ?? Infinity)) {
        const f = frames[idx]!;
        pending.push({
          stage: f.stage as DecodeFrameEvent["stage"],
          info: fakeInfo,
          pixels: f.pixels.buffer.slice(f.pixels.byteOffset, f.pixels.byteOffset + f.pixels.byteLength),
          format: "rgba8",
          pixelStride: W * 4,
        });
        idx++;
      }
      resolveNext?.();
      resolveNext = null;
    }
    const session: DecodeSession = {
      id: "scoring-mock",
      async push(chunk) {
        bytesPushed += (chunk instanceof ArrayBuffer ? chunk.byteLength : (chunk as Uint8Array).byteLength);
        maybeTrigger();
      },
      async close() { done = true; maybeTrigger(); },
      async cancel() { done = true; resolveNext?.(); },
      async done() { return fakeInfo; },
      async *frames() {
        while (true) {
          while (pending.length > 0) yield pending.shift()!;
          if (done && pending.length === 0) break;
          await new Promise<void>((r) => { resolveNext = r; });
        }
      },
    };
    return session;
  };
}

describe("profileJxl scoring", () => {
  it("attaches a perceptual score to the dc tier when a scorer is given", async () => {
    const factory = makeScoringMock([
      { atBytes: 200, stage: "dc", pixels: solid(40) },    // far from final → low psnr
      { atBytes: 600, stage: "pass", pixels: solid(120) }, // near final → high psnr
      { atBytes: 1000, stage: "final", pixels: solid(128) },
    ]);
    const scorer: MetricScorer = { metric: "psnr", score: async (cand, ref) => psnrVsRef(cand, ref) };
    const m = await profileJxl(new ArrayBuffer(1000), factory, { width: W, height: H, hasAlpha: false }, { scorer, chunkSize: 100 });
    const dc = m.tiers.find((t) => t.name === "dc");
    assert.ok(dc, "expected a dc tier");
    assert.equal(dc!.score?.metric, "psnr");
    assert.equal(dc!.score?.reference, "final");
    assert.ok(Number.isFinite(dc!.score!.value));
  });

  it("omits scores when no scorer is provided (backward compat)", async () => {
    const factory = makeScoringMock([
      { atBytes: 200, stage: "dc", pixels: solid(40) },
      { atBytes: 600, stage: "pass", pixels: solid(120) },
      { atBytes: 1000, stage: "final", pixels: solid(128) },
    ]);
    const m = await profileJxl(new ArrayBuffer(1000), factory, { width: W, height: H, hasAlpha: false }, { chunkSize: 100 });
    assert.ok(m.tiers.every((t) => t.score === undefined));
  });
});
