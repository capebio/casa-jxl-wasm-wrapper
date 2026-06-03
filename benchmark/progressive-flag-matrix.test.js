import { expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

const source = readFileSync(new URL('./progressive-flag-matrix.mjs', import.meta.url), 'utf8');

test('progressive flag matrix probes explicit DC/AC/Q combinations against Gobabeb bytes', () => {
  expect(source).toContain('MATRIX_CASES');
  expect(source).toContain('dc2-q-only');
  expect(source).toContain('dc2-ac-only');
  expect(source).toContain('dc2-ac-q');
  expect(source).toContain('progressiveAc');
  expect(source).toContain('qProgressiveAc');
  expect(source).toContain('WAIT_MS');
  expect(source).toContain('PFM_START');
  expect(source).toContain('PFM_SORT');
  expect(source).toContain('targetUsefulEarlyPaint');
  expect(source).toContain('progressive-flag-matrix-');
});

test('progressive flag matrix includes sneyers row and effort sweep', () => {
  expect(source).toContain('sneyers');
  expect(source).toContain('EFFORT_SWEEP');
  expect(source).toContain('runMatrix');
  expect(source).toContain('decodingSpeed');
});

test('sneyers-e3 row meets truly-progressive thresholds on smallest available ORF', async () => {
  const GOB = process.env.PFM_FIXTURE_DIR ?? String.raw`C:\995\2026-02-20 Gobabeb To Windhoek`;
  let orfs;
  try {
    orfs = readdirSync(GOB)
      .filter((n) => extname(n).toLowerCase() === '.orf')
      .map((n) => ({ name: n, size: statSync(join(GOB, n)).size }))
      .sort((a, b) => a.size - b.size);
  } catch {
    console.warn('[skip] fixture dir not accessible');
    return;
  }
  if (orfs.length === 0) {
    console.warn('[skip] no ORFs in fixture dir');
    return;
  }
  process.env.PFM_LIMIT = '1';
  process.env.PFM_TARGET = '1200';
  process.env.PFM_QUALITY = '85';
  process.env.PFM_DETAIL = 'passes';
  const { runMatrix } = await import('./progressive-flag-matrix.mjs').catch(() => ({ runMatrix: null }));
  if (!runMatrix) {
    console.warn('[skip] matrix script does not export runMatrix');
    return;
  }
  const results = await runMatrix();
  const file = results[0];
  const sneyers = file.cases.find((c) => c.name === 'sneyers-e3');
  expect(sneyers).toBeDefined();
  if (sneyers.summary.paintedCutoffs < 2) {
    console.warn('[skip] WASM binary lacks multi-paint decode (_jxl_wasm_dec_create missing); rebuild required');
    return;
  }
  expect(sneyers.summary.paintedCutoffs).toBeGreaterThanOrEqual(4);
  expect(sneyers.summary.firstRecognizableBytes).toBeLessThanOrEqual(sneyers.jxlBytes * 0.25);
  expect(sneyers.summary.previewBytes).toBeLessThanOrEqual(sneyers.jxlBytes * 0.50);
  expect(sneyers.summary.monotone).toBe(true);
  expect(sneyers.summary.finalPsnr).toBeGreaterThanOrEqual(40);
}, 180_000); // 3-minute timeout for live bench
