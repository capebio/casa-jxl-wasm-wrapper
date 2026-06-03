import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const htmlPath = new URL('./jxl-progressive-byte-benchmark.html', import.meta.url);
const jsPath = new URL('./jxl-progressive-byte-benchmark.js', import.meta.url);

test('progressive byte benchmark page exposes Gobabeb target-size workflow', () => {
  const html = readFileSync(htmlPath, 'utf8');

  expect(html).toContain('Progressive byte benchmark');
  expect(html).toContain('@casabio/jxl-wasm');
  expect(html).toContain('target-long-edge');
  expect(html).toContain('ssimulacra2-target');
  expect(html).toContain('Run Gobabeb benchmark');
  expect(html).toContain('progressive-lightbox');
  expect(html).toContain('./jxl-progressive-byte-benchmark.js');
});

test('progressive byte benchmark script uses best preset, byte metrics, and Gobabeb endpoint', () => {
  const js = readFileSync(jsPath, 'utf8');

  expect(js).toContain("from './jxl-progressive-best-preset.js'");
  expect(js).toContain("from './jxl-progressive-byte-metrics.js'");
  expect(js).toContain("fetch('/api/random-gobabeb'");
  expect(js).toContain('createProgressiveWebPreset');
  expect(js).toContain('createSidecarTargetPlan');
  expect(js).toContain('summarizeByteCutoffResults');
  expect(js).toContain('sidecar');
  expect(js).toContain('targetUsefulEarlyPaint');
  expect(js).toContain('sidecarFirstVisibleBytes');
  expect(js).toContain('usefulEarlyPaint');
  expect(js).toContain('streamDecodeCutoffs');
  expect(js).not.toContain('decodeBytePrefix');
  expect(js).toContain('openLightbox');
});
