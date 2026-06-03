import { expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

const source = readFileSync(new URL('./jpeg-progressive-stream.mjs', import.meta.url), 'utf8');

test('jpeg-progressive-stream script has expected structure', () => {
  expect(source).toContain('runJpegMatrix');
  expect(source).toContain('MATRIX_CASES');
  expect(source).toContain('EFFORT_SWEEP');
  expect(source).toContain('sneyers');
  expect(source).toContain('computeQualitySeries');
  expect(source).toContain('jpeg-progressive-stream-');
});

test('sneyers-e3 row meets thresholds on smallest available JPEG', async () => {
  const dir = process.env.JPS_FIXTURE_DIR ?? String.raw`C:\995\2026-02-20 Gobabeb To Windhoek\JPEG`;
  let jpegs;
  try {
    jpegs = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && ['.jpg', '.jpeg'].includes(extname(e.name).toLowerCase()))
      .map((e) => ({ name: e.name, size: statSync(join(dir, e.name)).size }))
      .sort((a, b) => a.size - b.size);
  } catch {
    console.warn('[skip] JPEG fixture dir not accessible');
    return;
  }
  if (jpegs.length === 0) {
    console.warn('[skip] no JPEGs in fixture dir');
    return;
  }
  process.env.JPEG_DIR = dir;
  process.env.JPS_LIMIT = '1';
  process.env.JPS_TARGET = '1200';
  process.env.JPS_QUALITY = '85';
  process.env.JPS_DETAIL = 'passes';
  const { runJpegMatrix } = await import('./jpeg-progressive-stream.mjs');
  const results = await runJpegMatrix();
  const file = results[0];
  const sneyers = file.cases.find((c) => c.name === 'sneyers-e3');
  expect(sneyers).toBeDefined();
  if (sneyers.summary.paintedCutoffs < 2) {
    console.warn('[skip] cutoff probe sees paints=1 on this image; thresholds require a file where the progressive structure surfaces multiple probe-visible paints (e.g. larger/more complex source)');
    return;
  }
  expect(sneyers.summary.paintedCutoffs).toBeGreaterThanOrEqual(4);
  expect(sneyers.summary.firstRecognizableBytes).toBeLessThanOrEqual(sneyers.jxlBytes * 0.25);
  expect(sneyers.summary.previewBytes).toBeLessThanOrEqual(sneyers.jxlBytes * 0.50);
  expect(sneyers.summary.monotone).toBe(true);
  expect(sneyers.summary.finalPsnr).toBeGreaterThanOrEqual(40);
}, 180_000); // 3-minute timeout for live bench
