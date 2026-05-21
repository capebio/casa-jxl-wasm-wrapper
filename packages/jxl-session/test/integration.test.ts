// jxl-session/test/integration.test.ts
// T-TEST integration suite (spec Section 21.3).
//
// BLOCKED — every test here needs a REAL codec end-to-end. The worker codec
// handlers are Codex's T-DECODE-WASM / T-ENCODE-WASM / *-NATIVE work; until a
// real WASM artifact (T-WASM-BUILD) or native binding (T-NATIVE-BIND) exists,
// these cannot run — a stub codec cannot truncate, round-trip ICC, or decode
// 16-bit pixels.
//
// They are scaffolded with `skip` + the exact assertions they must make, so
// flipping them on is mechanical once the codec lands: remove `skip`, point
// the fixture loader at @casabio/jxl-test-corpus, drive a real context via
// createBrowserContext()/createNodeContext().
//
// Tracking: see packages/jxl-session/BLOCKED.md B-002.

import { describe, it } from "node:test";

const NEEDS_CODEC = {
  skip: "Blocked on real codec — T-DECODE/ENCODE-WASM + T-WASM-BUILD (BLOCKED.md B-002)",
};

describe("integration: decode (spec 21.3)", () => {
  it("truncated codestream emits early frames, done() rejects TruncatedStream with partial", NEEDS_CODEC, async () => {
    // TODO when codec lands:
    //  - load a truncated fixture from @casabio/jxl-test-corpus
    //  - ctx.decode(); push the truncated bytes; close()
    //  - assert frames() yields >= 1 frame (DC or pass)
    //  - assert done() rejects with JxlError code "TruncatedStream"
    //  - assert the rejection's .partial is a DecodeFrameEvent with pixels
  });

  it("large raw decode produces a DC frame under the Section 22 latency target", NEEDS_CODEC, async () => {
    // TODO: load the 100 MP raw fixture (fetchLargeFixture); decode with
    //  progressionTarget "dc", downsample 4; assert time-to-first-pixel
    //  metric <= 500 ms p95 per Section 22.
  });

  it("16-bit fixture decodes to rgba16 without precision loss", NEEDS_CODEC, async () => {
    // TODO: load a 16-bit ICC-tagged fixture; decode format "rgba16";
    //  assert the final frame's pixels preserve 16-bit values (no 8-bit
    //  quantization) against known sample points.
  });

  it("bit-depth downcast emits the format_downcast metric", NEEDS_CODEC, async () => {
    // TODO: decode a 16-bit source requesting format "rgba8"; assert an
    //  onMetric callback receives { name: "format_downcast", ... }.
  });

  it("ICC profile round-trips byte-exact through decode", NEEDS_CODEC, async () => {
    // TODO: decode an ICC-tagged fixture (sRGB v4 / Display-P3 / Rec.2020);
    //  assert ImageInfo.iccProfile equals the fixture's known ICC bytes.
  });

  it("EXIF and XMP boxes survive decode", NEEDS_CODEC, async () => {
    // TODO: decode a fixture with EXIF+XMP; assert ImageInfo.exif / .xmp
    //  match the fixture's raw boxes byte-for-byte.
  });
});

describe("integration: encode (spec 21.3)", () => {
  it("emits the first byte before pixel input completes (previewFirst)", NEEDS_CODEC, async () => {
    // TODO: ctx.encode({ previewFirst: true, chunked: true }); push pixels in
    //  several chunks; assert chunks() yields its first ArrayBuffer before
    //  finish() is called.
  });

  it("ICC + EXIF round-trip byte-exact through an encode→decode cycle", NEEDS_CODEC, async () => {
    // TODO: encode RGBA with a known ICC + EXIF; decode the output; assert
    //  the recovered ICC and EXIF equal the originals byte-for-byte.
  });
});

describe("integration: scheduler under load (spec 21.3)", () => {
  it("thumbnail queue stays responsive while a viewer image decodes", NEEDS_CODEC, async () => {
    // TODO: start a long viewer decode at "visible"; enqueue thumbnail
    //  decodes at "near"; assert thumbnails still complete within budget.
  });

  it("a visible decode injected mid-background decode preempts it", NEEDS_CODEC, async () => {
    // NOTE: preemption itself is already covered by jxl-scheduler's unit
    //  tests with fake workers. This test confirms the same with a REAL
    //  codec — cancel propagation reaches libjxl and frees the worker.
  });
});
