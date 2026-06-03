import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./progressive-byte-benchmark.mjs', import.meta.url), 'utf8');

test('non-client progressive byte benchmark uses Gobabeb corpus and shared preset metrics', () => {
  expect(source).toContain('GOBABEB_DIR');
  expect(source).toContain('createProgressiveWebPreset');
  expect(source).toContain('createSidecarTargetPlan');
  expect(source).toContain('summarizeByteCutoffResults');
  expect(source).toContain('sidecar');
  expect(source).toContain('streamDecodeCutoffs');
  expect(source).toContain('progressive-byte-benchmark-');
});
