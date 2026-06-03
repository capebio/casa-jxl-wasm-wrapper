export function classifyByteCutoffFrame({ bytes, events = [], error = null }) {
  const frames = events.filter((event) => event && (event.type === 'progress' || event.type === 'final'));
  return {
    bytes,
    painted: frames.length > 0,
    frameCount: frames.length,
    isFinal: frames.some((event) => event.type === 'final'),
    stage: frames.at(-1)?.stage ?? (frames.at(-1)?.type ?? null),
    error,
  };
}

export function summarizeByteCutoffResults(results, totalBytes) {
  const sorted = [...results].sort((a, b) => a.bytes - b.bytes);
  const painted = sorted.filter((result) => result.painted);
  const firstPaint = painted[0] ?? null;
  const preview = pickPreviewCutoff(painted, totalBytes);
  const final = sorted.find((result) => result.isFinal) ?? sorted.at(-1) ?? null;
  const maxFrameCount = sorted.reduce((max, result) => Math.max(max, result.frameCount ?? 0), 0);

  return {
    totalBytes,
    firstPaintBytes: firstPaint?.bytes ?? null,
    firstPaintPercent: percent(firstPaint?.bytes, totalBytes),
    previewBytes: preview?.bytes ?? null,
    previewPercent: percent(preview?.bytes, totalBytes),
    finalBytes: final?.bytes ?? null,
    finalPercent: percent(final?.bytes, totalBytes),
    paintedCutoffs: painted.length,
    maxFrameCount,
    usefulEarlyPaint: !!firstPaint && firstPaint.bytes < totalBytes,
  };
}

function pickPreviewCutoff(painted, totalBytes) {
  if (painted.length === 0) return null;
  const nonFinal = painted.filter((result) => !result.isFinal && result.bytes < totalBytes);
  if (nonFinal.length === 0) return painted[0] ?? null;
  const threshold = Math.min(50 * 1024, Math.max(1, totalBytes * 0.7));
  return nonFinal.find((result) => result.bytes >= threshold) ?? nonFinal.at(-1) ?? null;
}

function percent(bytes, totalBytes) {
  if (bytes == null || !Number.isFinite(totalBytes) || totalBytes <= 0) return null;
  return Number(((bytes / totalBytes) * 100).toFixed(1));
}

