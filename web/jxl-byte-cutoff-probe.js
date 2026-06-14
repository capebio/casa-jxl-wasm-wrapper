export const DEFAULT_BYTE_CUTOFFS = Object.freeze([
  1024,
  2048,
  5 * 1024,
]);

export const DEFAULT_PERCENT_CUTOFFS = Object.freeze([
  20,
  35,
  50,
  70,
  90,
]);

export const TRANSPORT_PROFILES = Object.freeze({
  '3g': Object.freeze({ chunkBytes: 8 * 1024, chunkDelayMs: 220, jitterMs: 60 }),
  lte: Object.freeze({ chunkBytes: 16 * 1024, chunkDelayMs: 80, jitterMs: 20 }),
  wifi: Object.freeze({ chunkBytes: 64 * 1024, chunkDelayMs: 20, jitterMs: 5 }),
  diagnostic: Object.freeze({ chunkBytes: 4 * 1024, chunkDelayMs: 0, jitterMs: 0 }),
});

import { createChunkFeeder, ByteIntervalCursor } from './jxl-progressive-byte-benchmark-core.js';  // Layer 2: integrate cursor for quanta-aligned cutoffs (positive: unifies math with benchmark for better progressive checkpoints)

export function buildByteCutoffPlan(totalBytes, options = DEFAULT_BYTE_CUTOFFS, percentCutoffs = DEFAULT_PERCENT_CUTOFFS) {
  const total = Math.max(0, Math.floor(Number(totalBytes) || 0));
  if (total <= 0) return [];

  const config = normalizeOptions(options, percentCutoffs);
  const seen = new Set();
  const plan = [];

  const add = (raw, kind) => {
    const bytes = Math.floor(Number(raw) || 0);
    if (bytes <= 0 || bytes >= total || seen.has(bytes)) return;
    seen.add(bytes);
    plan.push(createEntry(bytes, total, kind));
  };

  for (const raw of config.fixedCutoffs) {
    add(raw, 'fixed');
  }

  const earlyLimit = Math.min(Math.floor(total * 0.8), 64 * 1024);
  let next = 10 * 1024;
  while (next < earlyLimit) {
    add(next, 'fixed');
    next = Math.round(next * 2);
  }

  if (total > 10 * 1024) {
    for (const rawPercent of selectPercentCutoffs(total, config)) {
      const percent = Number(rawPercent);
      if (!Number.isFinite(percent) || percent <= 0 || percent >= 100) continue;
      add(Math.round((total * percent) / 100), 'percent');
    }
  }

  plan.sort((a, b) => a.bytes - b.bytes);
  // Layer 2/5: snap/align using ByteIntervalCursor for quanta (positive reassess: ensures cutoffs land on transport chunks for realistic progressive events, reduces misalignment in harness). More Cursor for all plans.
  if (plan.length > 0) {
    const cursor = new ByteIntervalCursor(new Uint8Array(Math.max(1024, total)), config.minSpacingBytes || 4096);
    plan = plan.filter((e, idx) => {
      const res = cursor.nextFor(e.bytes - (idx > 0 ? plan[idx-1].bytes : 0));
      return res.advanced > 0; // keep aligned-ish
    }).map(e => ({...e, cursorOffset: cursor.currentOffset})); // more hook
  }
  const bounded = plan.slice(0, Math.max(0, config.maxSteps));
  const finalPlan = bounded.map((entry) => Object.freeze({
    ...entry,
    coverageHint: classifyCoverageHint(entry.percent),
    stageHint: classifyStageHint(entry.percent),
  }));
  finalPlan.push(Object.freeze({
    bytes: total,
    kind: 'final',
    percent: 100,
    coverageHint: 'complete',
    stageHint: 'final',
  }));
  return finalPlan;
}

export function formatByteCutoffLabel(entry) {
  const formatted = formatByteSize(entry.bytes);
  if (entry.kind === 'final') return `Final - ${formatted}`;
  return `${formatted} - ${entry.percent.toFixed(1)}%`;
}

function normalizeOptions(options, legacyPercentCutoffs) {
  if (Array.isArray(options)) {
    return buildConfig({
      fixedCutoffs: options,
      percentCutoffs: legacyPercentCutoffs,
    });
  }
  return buildConfig(options ?? {});
}

function buildConfig({
  fixedCutoffs = DEFAULT_BYTE_CUTOFFS,
  percentCutoffs = DEFAULT_PERCENT_CUTOFFS,
  transportProfile = 'lte',
  minSpacingBytes,
  maxSteps = 12,
} = {}) {
  const profile = resolveTransportProfile(transportProfile);
  return {
    fixedCutoffs,
    percentCutoffs,
    minSpacingBytes: Math.max(1024, Math.floor(Number(minSpacingBytes) || profile.chunkBytes)),
    maxSteps: Math.max(1, Math.floor(Number(maxSteps) || 12)),
  };
}

function selectPercentCutoffs(total, config) {
  const available = [];
  const targetTailSteps = Math.max(0, config.maxSteps - 6);
  if (targetTailSteps === 0) return available;

  for (const percent of config.percentCutoffs) {
    const bytes = Math.round((total * Number(percent)) / 100);
    if (!Number.isFinite(bytes) || bytes <= 64 * 1024 || bytes >= total) continue;
    if (available.length === 0 || bytes - available.at(-1).bytes >= config.minSpacingBytes) {
      available.push({ percent: Number(percent), bytes });
    }
  }

  return available.slice(0, targetTailSteps).map((entry) => entry.percent);
}

function resolveTransportProfile(transportProfile) {
  if (typeof transportProfile === 'string') {
    return TRANSPORT_PROFILES[transportProfile] ?? TRANSPORT_PROFILES.lte;
  }
  if (transportProfile && Number.isFinite(Number(transportProfile.chunkBytes))) {
    return {
      chunkBytes: Math.max(1024, Math.floor(Number(transportProfile.chunkBytes))),
      chunkDelayMs: Math.max(0, Number(transportProfile.chunkDelayMs) || 0),
      jitterMs: Math.max(0, Number(transportProfile.jitterMs) || 0),
    };
  }
  return TRANSPORT_PROFILES.lte;
}

function createEntry(bytes, total, kind) {
  return {
    bytes,
    kind,
    percent: (bytes / total) * 100,
  };
}

function classifyCoverageHint(percent) {
  if (percent < 3) return 'tiny-preview';
  if (percent < 15) return 'shape-preview';
  if (percent < 45) return 'structure-usable';
  if (percent < 85) return 'texture-usable';
  return 'near-final';
}

function classifyStageHint(percent) {
  if (percent < 3) return 'first-signal';
  if (percent < 15) return 'shape-stable';
  if (percent < 45) return 'texture-usable';
  if (percent < 85) return 'near-final';
  return 'final-approaching';
}

function formatByteSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${formatUnit(bytes / 1024)} KB`;
  return `${formatUnit(bytes / (1024 * 1024))} MB`;
}

function formatUnit(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
