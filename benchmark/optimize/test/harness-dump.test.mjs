import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDump } from '../harness-dump.mjs';

test('buildDump merges loadedFiles raw substages with results metrics', () => {
  const loadedFiles = [{ file: 'a.dng', rawDecompress: 10, rawDemosaic: 20, rawTonemap: 70, rawOrient: 1 }];
  const simdResults = [{ file: 'a.dng', prog_enc_ms: 100, shot_dec_ms: 50, photon_prog_enc_ms: 300, mod_prog_enc_ms: 280 }];
  const telemetry = { cpuModel: 'X', cpuThrottlingPct: '100.0' };
  const dump = buildDump({ loadedFiles, simdResults, mtResults: [], telemetry });
  assert.equal(dump.schema, 'optimize-baseline/v1');
  assert.equal(dump.files[0].file, 'a.dng');
  assert.equal(dump.files[0].raw.tonemap_ms, 70);
  assert.equal(dump.files[0].metrics.photon_prog_enc_ms, 300);
  assert.equal(dump.telemetry.cpuThrottlingPct, '100.0');
});

test('buildDump tolerates missing arrays', () => {
  const dump = buildDump({ loadedFiles: [], simdResults: [], mtResults: [], telemetry: {} });
  assert.deepEqual(dump.files, []);
});
