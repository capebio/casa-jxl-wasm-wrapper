export const DEFAULT_BYTE_CUTOFFS = Object.freeze([
  1024,
  2048,
  5 * 1024,
  10 * 1024,
  25 * 1024,
  50 * 1024,
  100 * 1024,
  150 * 1024,
]);

export const DEFAULT_PERCENT_CUTOFFS = Object.freeze([
  1,
  2,
  5,
  10,
  20,
  35,
  50,
  70,
  90,
]);

export function buildByteCutoffPlan(totalBytes, cutoffs = DEFAULT_BYTE_CUTOFFS, percentCutoffs = DEFAULT_PERCENT_CUTOFFS) {
  const total = Math.max(0, Math.floor(Number(totalBytes) || 0));
  if (total <= 0) return [];

  const seen = new Set();
  const plan = [];
  const add = (raw, kind) => {
    const bytes = Math.floor(Number(raw) || 0);
    if (bytes <= 0 || bytes >= total || seen.has(bytes)) return;
    seen.add(bytes);
    plan.push({
      bytes,
      kind,
      percent: (bytes / total) * 100,
    });
  };

  for (const raw of cutoffs) {
    add(raw, 'fixed');
  }
  if (total >= 128 * 1024) {
    for (const rawPercent of percentCutoffs) {
      const percent = Number(rawPercent);
      if (!Number.isFinite(percent) || percent <= 0 || percent >= 100) continue;
      add(Math.round((total * percent) / 100), 'percent');
    }
  }

  plan.sort((a, b) => a.bytes - b.bytes);

  if (!seen.has(total)) {
    plan.push({ bytes: total, kind: 'final', percent: 100 });
  }
  return plan;
}

export function formatByteCutoffLabel(entry) {
  const kb = formatKb(entry.bytes);
  if (entry.kind === 'final') return `Final - ${kb}`;
  return `${kb} - ${entry.percent.toFixed(1)}%`;
}

function formatKb(bytes) {
  const kb = bytes / 1024;
  return `${Number.isInteger(kb) ? kb : kb.toFixed(1)} KB`;
}
