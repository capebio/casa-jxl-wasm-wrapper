import { expect, test } from 'bun:test';
import {
  buildRawMeasurementKey,
  createBenchmarkRow,
  escapeCsvCell,
  findRawIsolationMatch,
  getCachedResizeVariant,
  joinCsvRow,
  pickScenarioWinner,
  shouldPublishSweepArtifacts,
} from './jxl-preset-benchmark-core.js';

test('buildRawMeasurementKey changes when file identity changes inside same slot', () => {
  const a = buildRawMeasurementKey([
    { slotId: 'orf', sourceName: 'one.orf', byteLength: 1000, lastModified: 1 },
  ]);
  const b = buildRawMeasurementKey([
    { slotId: 'orf', sourceName: 'two.orf', byteLength: 1000, lastModified: 1 },
  ]);

  expect(a).not.toBe(b);
});

test('getCachedResizeVariant caches per size', () => {
  let calls = 0;
  const source = {};
  const first = getCachedResizeVariant(source, 512, () => {
    calls += 1;
    return { rgba: new Uint8Array([1]), width: 512, height: 384 };
  });
  const second = getCachedResizeVariant(source, 512, () => {
    calls += 1;
    return { rgba: new Uint8Array([2]), width: 512, height: 384 };
  });
  const third = getCachedResizeVariant(source, 1920, () => {
    calls += 1;
    return { rgba: new Uint8Array([3]), width: 1920, height: 1440 };
  });

  expect(first).toBe(second);
  expect(third).not.toBe(first);
  expect(calls).toBe(2);
});

test('createBenchmarkRow carries stable slot identity and reserved telemetry fields', () => {
  const row = createBenchmarkRow({
    fileSlot: { id: 'orf' },
    source: { name: 'gobabeb.orf' },
    phase: 1,
    sizePx: 512,
    tier: 'high',
  });

  expect(row.slotId).toBe('orf');
  expect(row.sourceName).toBe('gobabeb.orf');
  expect(row.file).toBe('orf');
  expect(row.qualityPending).toBe(true);
  expect(row.firstUsablePreviewMs).toBeNull();
  expect(row.colorMode).toBeNull();
  expect(row.previewColorStableMs).toBeNull();
  expect(row.measuredCapabilities.phase3ValidatedSizes).toEqual([]);
});

test('findRawIsolationMatch uses exact slotId match before filename substring', () => {
  const rawIsolationData = {
    orf: { slotId: 'orf', sourceName: 'a.orf' },
    dng: { slotId: 'dng', sourceName: 'orf-preview.dng' },
  };

  expect(findRawIsolationMatch(rawIsolationData, { slotId: 'orf', sourceName: 'x.orf' })).toBe(rawIsolationData.orf);
});

test('csv helpers quote commas and quotes', () => {
  expect(escapeCsvCell('plain')).toBe('plain');
  expect(escapeCsvCell('a,b')).toBe('"a,b"');
  expect(escapeCsvCell('a"b')).toBe('"a""b"');
  expect(joinCsvRow(['name', 'a,b', 'a"b'])).toBe('name,"a,b","a""b"');
});

test('pickScenarioWinner returns highest scored row not first row', () => {
  const winner = pickScenarioWinner([
    { row: { slotId: 'orf' }, score: 10 },
    { row: { slotId: 'dng' }, score: 25 },
  ]);

  expect(winner.slotId).toBe('dng');
});

test('shouldPublishSweepArtifacts blocks aborted partial runs', () => {
  expect(shouldPublishSweepArtifacts({ aborted: true, rows: [{}] })).toBe(false);
  expect(shouldPublishSweepArtifacts({ aborted: false, rows: [{}] })).toBe(true);
  expect(shouldPublishSweepArtifacts({ aborted: false, rows: [] })).toBe(false);
});
