import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBaseline } from '../baseline-parse.mjs';

const dump = {
  schema: 'optimize-baseline/v1',
  telemetry: { cpuThrottlingPct: '100.0' },
  files: [{
    file: 'a.dng',
    raw: { decompress_ms: 10, demosaic_ms: 20, tonemap_ms: 70, orient_ms: 1 },
    metrics: { prog_enc_ms: 100, shot_dec_ms: 50, photon_prog_enc_ms: 300, mod_prog_enc_ms: 280, mt_prog_enc_ms: 90, mt_shot_dec_ms: 48 },
  }],
};

test('raw decode dominant substage is tonemap', () => {
  const b = parseBaseline(dump);
  const raw = b.find(x => x.file === 'a.dng' && x.metric === 'raw_decode');
  assert.equal(raw.dominant_substage, 'tonemap');
  assert.equal(raw.bound_class, 'pipeline'); // raw decode is Rust pipeline, never codec-kernel
});

test('photon/modular metrics marked codec-kernel (encode dominated by libjxl)', () => {
  const b = parseBaseline(dump);
  const ph = b.find(x => x.metric === 'photon_prog_enc');
  assert.equal(ph.median_ms, 300);
  assert.equal(ph.bound_class, 'codec-kernel');
});

test('throttled telemetry flags low trust on the baseline', () => {
  const b = parseBaseline({ ...dump, telemetry: { cpuThrottlingPct: '82.0' } });
  assert.equal(b[0].trust, 'low');
});
