export function buildRawMeasurementKey(entries) {
  return entries
    .map((entry) => [
      entry.slotId,
      entry.sourceName ?? '',
      Number(entry.byteLength) || 0,
      Number(entry.lastModified) || 0,
    ].join(':'))
    .sort()
    .join('|');
}

export function getCachedResizeVariant(source, sizePx, resizeFn) {
  source.resizeCache ??= new Map();
  if (source.resizeCache.has(sizePx)) return source.resizeCache.get(sizePx);
  const variant = resizeFn();
  source.resizeCache.set(sizePx, variant);
  return variant;
}

export function createBenchmarkRow({
  fileSlot,
  source,
  measuredCapabilities = {},
  ...rest
} = {}) {
  return {
    slotId: fileSlot?.id ?? null,
    sourceName: source?.name ?? null,
    file: fileSlot?.id ?? null,
    firstUsablePreviewMs: null,
    shapeStableMs: null,
    textureStableMs: null,
    roiCandidateMs: null,
    tileReadyMs: null,
    lookRenderMs: null,
    qualityPending: true,
    colorMode: null,
    toneMathLutId: null,
    lookPassCount: null,
    simdPath: null,
    previewColorStableMs: null,
    measuredCapabilities: {
      phase3ValidatedSizes: [],
      ...measuredCapabilities,
    },
    ...rest,
  };
}

export function findRawIsolationMatch(rawIsolationData, row) {
  if (!rawIsolationData || !row?.slotId) return null;
  return rawIsolationData[row.slotId] ?? null;
}

export function escapeCsvCell(value) {
  const str = String(value ?? '');
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function joinCsvRow(values) {
  return values.map((value) => escapeCsvCell(value)).join(',');
}

export function pickScenarioWinner(scoredRows) {
  if (!Array.isArray(scoredRows) || scoredRows.length === 0) return null;
  return scoredRows.reduce((best, entry) => (entry.score > best.score ? entry : best)).row;
}

export function shouldPublishSweepArtifacts(result) {
  return !result?.aborted && Array.isArray(result?.rows) && result.rows.length > 0;
}
