import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  buildBenchmarkExport,
  runBenchmarkSession,
  streamDecodeCutoffs,
  TRANSPORT_PROFILES,
} from './jxl-progressive-byte-benchmark-core.js';

test('benchmark html exposes transport profile workflow', () => {
  const html = readFileSync(new URL('./jxl-progressive-byte-benchmark.html', import.meta.url), 'utf8');

  expect(html).toContain('Progressive byte benchmark');
  expect(html).toContain('transport-profile');
  expect(html).toContain('Run Gobabeb benchmark');
  expect(html).toContain('./jxl-progressive-byte-benchmark.js');
});

test('runBenchmarkSession blocks when raw wasm not ready', async () => {
  const statuses = [];
  const result = await runBenchmarkSession({
    state: { rawReady: false, running: false, results: [] },
    onStatus: (text) => statuses.push(text),
  });

  expect(result).toEqual([]);
  expect(statuses.at(-1)).toBe('Waiting for RAW WASM.');
});

test('streamDecodeCutoffs attributes async events to correct cutoff', async () => {
  const decoder = createFakeDecoder([
    { type: 'progress', stage: 'preview', bytes: 1024, delayTurns: 2 },
    { type: 'final', stage: 'final', bytes: 2048, delayTurns: 2 },
  ]);

  const result = await streamDecodeCutoffs({
    decoder,
    jxlBytes: new Uint8Array(2048),
    plan: [{ bytes: 1024 }, { bytes: 2048 }],
    transportProfile: TRANSPORT_PROFILES.lte,
    waitForTurn: async () => {
      await Promise.resolve();
      await Promise.resolve();
    },
    sleep: async () => {},
    now: createClock(),
  });

  expect(result.cutoffs).toHaveLength(2);
  expect(result.cutoffs[0].events.map((event) => event.type)).toEqual(['progress']);
  expect(result.cutoffs[1].events.map((event) => event.type)).toEqual(['final']);
  expect(result.cutoffs[0].frame?.stage).toBe('preview');
  expect(result.cutoffs[1].frame?.stage).toBe('final');
});

test('runBenchmarkSession keeps sidecar before target and records transport metrics', async () => {
  const records = [];
  const state = { rawReady: true, running: false, results: [] };
  const results = await runBenchmarkSession({
    state,
    runCount: 1,
    targetLongEdge: 800,
    quality: 85,
    progressiveDetail: 'passes',
    transportProfile: '3g',
    loadSource: async () => ({ name: 'gobabeb.orf', rawBytes: 1234, width: 1600, height: 1200, rgb: new Uint8Array(16) }),
    createSidecarTargetPlan: () => [300, 800],
    createPreset: ({ targetLongEdge }) => ({
      target: { width: targetLongEdge, height: targetLongEdge === 300 ? 225 : 600 },
      encode: {},
      decode: {},
      byteCutoffs: [1024],
      qualityPolicy: { ssimulacra2: { message: 'none' } },
    }),
    makeTargetRgba: () => new ArrayBuffer(16),
    encodeTarget: async (_rgba, _encode, variantTarget) => new Uint8Array(variantTarget === 300 ? 1500 : 4000),
    buildByteCutoffPlan: (bytes) => [{ bytes: Math.min(1024, bytes) }, { bytes }],
    streamDecodeCutoffs: async (_bytes, plan, _decode, _onStep, context) => ({
      cutoffs: plan.map((entry, index) => ({
        entry,
        bytes: entry.bytes,
        events: index === 0
          ? [{ type: 'progress', stage: 'preview', tMs: context.transportProfile.chunkDelayMs }]
          : [{ type: 'final', stage: 'final', tMs: context.transportProfile.chunkDelayMs * 2 }],
        frame: index === 0
          ? { type: 'progress', stage: 'preview', tMs: context.transportProfile.chunkDelayMs }
          : { type: 'final', stage: 'final', tMs: context.transportProfile.chunkDelayMs * 2 },
        error: null,
      })),
      error: null,
      transportProfile: context.transportProfile.name,
      firstPaintMs: context.transportProfile.chunkDelayMs,
      previewMs: context.transportProfile.chunkDelayMs,
      finalMs: context.transportProfile.chunkDelayMs * 2,
      stallCount: 0,
      avgPaintGapMs: context.transportProfile.chunkDelayMs,
    }),
    classifyByteCutoffFrame: (cutoff) => ({
      bytes: cutoff.bytes,
      painted: true,
      frameCount: cutoff.events.length,
      isFinal: cutoff.events.some((event) => event.type === 'final'),
      stage: cutoff.frame?.stage ?? null,
      error: cutoff.error,
    }),
    summarizeByteCutoffResults: (cutoffs, totalBytes) => ({
      totalBytes,
      firstPaintBytes: cutoffs[0].bytes,
      previewBytes: cutoffs[0].bytes,
      finalBytes: cutoffs.at(-1).bytes,
      usefulEarlyPaint: true,
      paintedCutoffs: cutoffs.length,
      maxFrameCount: 1,
    }),
    onRecord: (record) => records.push(record),
  });

  expect(results).toHaveLength(1);
  expect(records[0].variants.map((variant) => variant.label)).toEqual(['sidecar 300', 'target 800']);
  expect(records[0].variants[0].sidecar).toBe(true);
  expect(records[0].variants[1].sidecar).toBe(false);
  expect(records[0].variants.every((variant) => variant.transportProfile === '3g')).toBe(true);
  expect(records[0].variants[0].firstPaintMs).toBeGreaterThanOrEqual(0);
});

test('buildBenchmarkExport returns stable json payload shape', () => {
  const payload = buildBenchmarkExport([
    {
      source: 'gobabeb.orf',
      transportProfile: 'lte',
      variants: [{ label: 'target 800' }],
      summary: { firstPaintBytes: 1024 },
    },
  ], '2026-06-12T00:00:00.000Z');

  expect(payload).toEqual({
    exportedAt: '2026-06-12T00:00:00.000Z',
    results: [
      {
        source: 'gobabeb.orf',
        transportProfile: 'lte',
        variants: [{ label: 'target 800' }],
        summary: { firstPaintBytes: 1024 },
      },
    ],
  });
});

// Layer 6 cross: test explicit Cursor + driveRealSession wiring (positive for flip-flop support).
test('ByteIntervalCursor and driveRealSession are wired for custom/flip-flop strategies', async () => {
  const { ByteIntervalCursor, createChunkFeeder } = await import('./jxl-progressive-byte-benchmark-core.js');
  const cursor = new ByteIntervalCursor(new Uint8Array(4096), 1024);
  const res = cursor.nextFor(2048);
  expect(res.advanced).toBeGreaterThan(0);
  expect(res.buffer).toBeTruthy();

  // driveReal in session DI (uses 0-delay + cursor internally)
  const result = await runBenchmarkSession({
    state: { rawReady: true, running: false, results: [] },
    runCount: 1,
    loadSource: async () => ({ name: 't', width: 4, height: 4, rawBytes: 100, rgb: new Uint8Array(48), rgba: new Uint8Array(64) }),
    makeTargetRgba: (s, w, h) => s.rgba,
    encodeTarget: async () => new Uint8Array(100),
    buildByteCutoffPlan: () => [{ bytes: 50 }, { bytes: 100 }],
    streamDecodeCutoffs: streamDecodeCutoffs, // default uses cursor
    driveRealSession: true,
    classifyByteCutoffFrame: (c) => ({ painted: !!c.frame, bytes: c.bytes }),
    summarizeByteCutoffResults: (cs, t) => ({ firstPaintBytes: cs[0]?.bytes, finalBytes: t }),
  });
  expect(result.length).toBe(1);
  expect(result[0].driveRealSession).toBe(true);
  // L6 prod wiring: Cursor now ready for real session chunking in progressive paths.
});

function createClock() {
  let tick = 0;
  return () => {
    tick += 5;
    return tick;
  };
}

function createFakeDecoder(events) {
  const queue = [];
  let closed = false;
  let pendingResolve = null;
  let eventIndex = 0;

  const pump = () => {
    if (pendingResolve && queue.length > 0) {
      const resolve = pendingResolve;
      pendingResolve = null;
      resolve(queue.shift());
    } else if (pendingResolve && closed) {
      const resolve = pendingResolve;
      pendingResolve = null;
      resolve(null);
    }
  };

  return {
    async push() {
      const nextEvent = events[eventIndex++];
      if (!nextEvent) return;
      let turns = nextEvent.delayTurns ?? 0;
      while (turns-- > 0) {
        await Promise.resolve();
      }
      queue.push(nextEvent);
      pump();
    },
    async close() {
      closed = true;
      pump();
    },
    async dispose() {},
    async *events() {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift();
          continue;
        }
        if (closed) return;
        const value = await new Promise((resolve) => {
          pendingResolve = resolve;
        });
        if (value == null) return;
        yield value;
      }
    },
  };
}
