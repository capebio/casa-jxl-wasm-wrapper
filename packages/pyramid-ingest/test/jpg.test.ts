import { afterEach, expect, test } from "bun:test";
import sharp from "sharp";
import { setJxlModuleFactoryForTesting, transcodeJpegToJxl } from "@casabio/jxl-wasm";
import { buildJpgLadder } from "../src/ladder";
import { createJxlBackend } from "../src/backends";
import { loadScalarModule, scalarFactory } from "./scalar";

afterEach(() => setJxlModuleFactoryForTesting(null));

async function jpegFixture(w: number, h: number): Promise<Uint8Array> {
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      raw[o] = (x * 31 + y * 17) & 0xff;
      raw[o + 1] = (x * 7 + y * 53) & 0xff;
      raw[o + 2] = (x * 13 + y * 29) & 0xff;
    }
  }
  const jpg = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
  return new Uint8Array(jpg);
}

test("buildJpgLadder uses the bit-exact lossless transcode as the full level", { timeout: 120_000 }, async () => {
  const module = await loadScalarModule();
  setJxlModuleFactoryForTesting(scalarFactory(module));
  const jxl = createJxlBackend();

  const jpeg = await jpegFixture(1280, 960);
  const expectedFull = await transcodeJpegToJxl(jpeg);

  const ladder = await buildJpgLadder(jxl, jpeg);
  expect(ladder.orientation).toBe("source");
  expect(ladder.width).toBe(1280);
  expect(ladder.height).toBe(960);

  const widths = ladder.levels.map((l) => l.width);
  expect(widths).toEqual([256, 512, 1024, 1280]);
  for (let i = 1; i < widths.length; i++) expect(widths[i]!).toBeGreaterThan(widths[i - 1]!);

  const full = ladder.levels[ladder.levels.length - 1]!;
  expect(Buffer.from(full.data)).toEqual(Buffer.from(expectedFull));
});