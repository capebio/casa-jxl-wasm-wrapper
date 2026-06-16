import { readFileSync } from "node:fs";
import { basename } from "node:path";

import {
  buildFamilyMetricDefinition,
  deriveFamilyIdFromArtifactName,
  familyLabelFromId,
  familyPrimaryMetricKey,
  isFamilyOverlayMetric,
  normalizeFamilyId,
} from "./benchmark-history-registry.mjs";

export const STANDARD_GRAPH_METRICS = [
  { key: "AvgRawMs", label: "RAW Decode", group: "core", defaultOn: true, color: "#7dd3fc" },
  // Raw sub-stage detail (from targeted + StandardMultifileTest preload)
  { key: "AvgRawDecompressMs", label: "RAW Decompress", group: "raw", defaultOn: false, color: "#bae6fd" },
  { key: "AvgRawDemosaicMs", label: "RAW Demosaic", group: "raw", defaultOn: true, color: "#f97316" },
  { key: "AvgRawTonemapMs", label: "RAW Tonemap", group: "raw", defaultOn: false, color: "#a5b4fc" },
  { key: "AvgProgEncMtMs", label: "Prog Encode MT", group: "encode", defaultOn: true, color: "#34d399" },
  { key: "AvgShotEncMtMs", label: "One-shot Encode MT", group: "encode", defaultOn: true, color: "#f59e0b" },
  // Encode variants (modular/photon from sweep coverage in Standard)
  { key: "AvgModProgEncSimdMs", label: "Modular Prog Enc (SIMD)", group: "encode", defaultOn: false, color: "#fb923c" },
  { key: "AvgPhotonProgEncSimdMs", label: "Photon Prog Enc (SIMD)", group: "encode", defaultOn: false, color: "#f472b6" },
  { key: "AvgProgFirstMtMs", label: "Prog First Paint MT", group: "decode", defaultOn: true, color: "#60a5fa" },
  { key: "AvgProgFinalMtMs", label: "Prog Final MT", group: "decode", defaultOn: true, color: "#f472b6" },
  { key: "AvgShotDecMtMs", label: "One-shot Decode MT", group: "decode", defaultOn: true, color: "#a78bfa" },
  // Progressive decode variants (ds2 first-paint + chunked streaming first from test_1 / progressive-timing)
  { key: "AvgProgDs2FirstSimdMs", label: "Prog DS2 First (SIMD)", group: "decode", defaultOn: false, color: "#67e8f9" },
  { key: "AvgProgChunked4FirstSimdMs", label: "Prog Chunked-4 First (SIMD)", group: "decode", defaultOn: false, color: "#22d3ee" },
  { key: "MultiWorkerParallelWallMs", label: "Parallel Wall", group: "decode", defaultOn: false, color: "#fb7185" },
  { key: "RealJxtcTiledRoi_512_512_Ms", label: "JXTC ROI", group: "core", defaultOn: false, color: "#22c55e" },
  { key: "MonolithicRoi_512_512_Ms", label: "Mono ROI", group: "core", defaultOn: false, color: "#ef4444" },
  { key: "EncCoreCompressMs", label: "JXTC Core Compress", group: "encode", defaultOn: false, color: "#f97316" },
  { key: "AvgPyrEncMtMs", label: "Pyramid Encode MT", group: "encode", defaultOn: false, color: "#94a3b8" },
];

export const GRAPH_METRICS = STANDARD_GRAPH_METRICS;

const TELEMETRY_FIELDS = [
  "CpuActiveLoadPct",
  "CpuClockCurrentGhz",
  "CpuClockMaxGhz",
  "CpuThrottlingPct",
  "SystemMemoryFreeGb",
];

const TIMING_KEY_RE = /(ms|encode|decode|raw|scale|first|final|wall|total|roi|compress|clone|transfer|paint)/i;
const STANDARD_GRAPH_KEYS = new Set(STANDARD_GRAPH_METRICS.map((metric) => metric.key));

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseTextField(text, label) {
  const match = text.match(new RegExp(`^${escapeRegex(label)}:\\s*(.+)$`, "im"));
  return match ? match[1].trim() : null;
}

function parseNumericField(text, label) {
  const raw =
    parseTextField(text, label) ??
    text.match(new RegExp(`(?:^|\\|)\\s*${escapeRegex(label)}:\\s*([^\\n|]+)`, "im"))?.[1]?.trim() ??
    null;
  if (!raw || raw === "N/A") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function parseNumericLikeValue(raw) {
  const match = String(raw ?? "").trim().match(/^-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function normalizeTimingMetricKey(key, familyId = "") {
  const raw = String(key ?? "").trim();
  if (!raw) return null;
  const dotted = raw.lastIndexOf(".");
  if (dotted > 0) {
    const prefixText = raw.slice(0, dotted + 1);
    const suffixText = raw.slice(dotted + 1);
    const normalizedSuffix = normalizeTimingMetricKey(suffixText, familyId);
    return normalizedSuffix ? `${prefixText}${normalizedSuffix}` : null;
  }
  if (/^[A-Za-z0-9_]+Ms$/.test(raw) && !raw.includes("-") && !raw.includes(" ") && !raw.includes(".")) {
    return raw;
  }
  const normalizedFamily = normalizeFamilyId(familyId);
  const prefix = normalizedFamily && raw.startsWith(`${normalizedFamily}.`) ? `${normalizedFamily}.` : "";
  const suffix = prefix ? raw.slice(prefix.length) : raw;
  const compact = suffix.replace(/[^a-zA-Z0-9_]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  if (!compact) return null;
  if (/^(iter|passes?|file|target|quality|effort|modular|resamp|reps|size|t)$/i.test(compact)) return null;
  if (!TIMING_KEY_RE.test(compact)) return null;
  const snake = compact.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  const camel = snake
    .split("_")
    .filter(Boolean)
    .map((part, index) => index === 0 ? part.toLowerCase() : part[0].toUpperCase() + part.slice(1).toLowerCase())
    .join("");
  const normalized = camel.endsWith("Ms") ? camel : `${camel}Ms`;
  return prefix ? `${prefix}${normalized}` : normalized;
}

function namespaceFamilyMetrics(metrics, familyId) {
  const normalizedFamily = normalizeFamilyId(familyId);
  const namespaced = {};
  for (const [key, value] of Object.entries(metrics)) {
    if (value == null) continue;
    if (String(key).startsWith(`${normalizedFamily}.`)) {
      namespaced[key] = value;
      continue;
    }
    const normalizedKey = normalizeTimingMetricKey(key, normalizedFamily);
    if (!normalizedKey) continue;
    const finalKey = normalizedKey.startsWith(`${normalizedFamily}.`)
      ? normalizedKey
      : `${normalizedFamily}.${normalizedKey}`;
    namespaced[finalKey] = value;
  }
  return namespaced;
}

function parseAllNumericFields(text) {
  const fields = {};
  let tableColumns = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      tableColumns = null;
      continue;
    }
    const headerMatch = line.match(/^\s*(?:runs|rows)\[\d+\]\{([^}]*)\}:\s*$/i);
    if (headerMatch) {
      tableColumns = headerMatch[1].split("|").map((value) => value.trim()).filter(Boolean);
      continue;
    }

    if (tableColumns && /^\s+/.test(line) && line.includes("|")) {
      const rowValues = line.split("|").map((value) => value.trim());
      const usableColumns = tableColumns.slice(0, rowValues.length);
      usableColumns.forEach((column, index) => {
        const metricKey = normalizeTimingMetricKey(column);
        if (!metricKey) return;
        const numeric = parseNumericLikeValue(rowValues[index]);
        if (!Number.isFinite(numeric)) return;
        fields[metricKey] = numeric;
      });
      continue;
    }

    const chunks = line.split("|");
    for (const chunk of chunks) {
      const match = chunk.match(/^\s*([^:#]+):\s*([^|#]+)\s*$/);
      if (!match) continue;
      const key = normalizeTimingMetricKey(match[1].trim());
      if (!key) continue;
      const value = parseNumericLikeValue(match[2].trim());
      if (!Number.isFinite(value)) continue;
      fields[key] = value;
    }
  }
  return fields;
}

function selectFamilyPrimaryField(fields, familyId) {
  const keys = Object.keys(fields);
  const familyKey = familyPrimaryMetricKey(familyId);
  if (familyKey in fields) return familyKey;
  const hinted = {
    "policy-ab": ["viewer_ms", "baseline_ms"],
    "effort-sweep": ["encodeMs", "encode_ms"],
    "effort-sweep-benchmark": ["encodeMs", "encode_ms"],
    "p3-features": ["fullFinalMs", "full_final_ms", "encodeMs"],
    "p3-features-benchmark": ["fullFinalMs", "full_final_ms", "encodeMs"],
    "progressive-byte": ["encodeMs", "encode_ms"],
    "progressive-byte-benchmark": ["encodeMs", "encode_ms"],
    "progressive-flag-matrix": ["encodeMs", "encode_ms"],
    "progressive-timing": ["avg_final_ms", "avg_first_ms", "shotFinalMs", "encode_ms"],
    "session-worker-timings": ["totalMs", "TotalWallMs", "encodeMs"],
    "streaming-ssim": ["referenceDecodeMs", "reference_decode_ms", "encodeMs"],
    "targeted-wasm-timings": ["totalMs", "TotalWallMs", "encodeMs"],
    "raw-format-sweep": ["totalMs", "TotalWallMs", "encodeMs"],
    "single-progressive": ["TotalWallMs", "TotalEncodeMs", "encodeMs"],
  }[normalizeFamilyId(familyId)] ?? [];
  for (const key of hinted) {
    const exact = keys.find((candidate) => candidate.toLowerCase() === key.toLowerCase());
    if (exact) return exact;
    const suffix = keys.find((candidate) => candidate.toLowerCase().endsWith(`.${key.toLowerCase()}`));
    if (suffix) return suffix;
  }
  const preferred = keys.find((key) => /primaryms$/i.test(key));
  if (preferred) return preferred;
  const total = keys.find((key) => /total.*ms/i.test(key));
  if (total) return total;
  const final = keys.find((key) => /final.*ms/i.test(key));
  if (final) return final;
  const encode = keys.find((key) => /encode.*ms/i.test(key));
  if (encode) return encode;
  const decode = keys.find((key) => /decode.*ms/i.test(key));
  if (decode) return decode;
  const avg = keys.find((key) => /avg.*ms/i.test(key));
  if (avg) return avg;
  return keys.find((key) => /ms/i.test(key)) ?? null;
}

function looksLikeTimingMetricKey(key) {
  return TIMING_KEY_RE.test(String(key ?? ""));
}

function seriesLabelFromKey(familyLabel, familyId, metricKey) {
  const normalizedFamily = normalizeFamilyId(familyId);
  const prefix = `${normalizedFamily}.`;
  const suffix = String(metricKey).startsWith(prefix) ? String(metricKey).slice(prefix.length) : String(metricKey);
  if (suffix === "primaryMs") return familyLabel;
  const trimmed = suffix.replace(/(?:[_-]?ms)$/i, "");
  const pretty = trimmed
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  return `${familyLabel} · ${pretty}`;
}

function seriesColorFromKey(familyId, metricKey) {
  const seed = `${normalizeFamilyId(familyId)}:${String(metricKey)}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  const hue = hash % 360;
  const saturation = 62 + (hash % 14);
  const lightness = 54 + (hash % 10);
  const c = (1 - Math.abs(2 * (lightness / 100) - 1)) * (saturation / 100);
  const x = c * (1 - Math.abs((hue / 60) % 2 - 1));
  const m = (lightness / 100) - (c / 2);
  let rgb;
  if (hue < 60) rgb = [c, x, 0];
  else if (hue < 120) rgb = [x, c, 0];
  else if (hue < 180) rgb = [0, c, x];
  else if (hue < 240) rgb = [0, x, c];
  else if (hue < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  const toHex = (value) => Math.round((value + m) * 255).toString(16).padStart(2, "0");
  return `#${toHex(rgb[0])}${toHex(rgb[1])}${toHex(rgb[2])}`;
}

function timestampFromFilename(fileName) {
  const match = fileName.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/);
  if (!match) return null;
  const [, date, hh, mm, ss, ms] = match;
  return `${date}T${hh}:${mm}:${ss}.${ms}Z`;
}

export function computeHeatScore(run) {
  const load = run.telemetry.CpuActiveLoadPct ?? 0;
  const throttlePenalty = Math.max(0, 100 - (run.telemetry.CpuThrottlingPct ?? 100));
  const clockCurrent = run.telemetry.CpuClockCurrentGhz ?? null;
  const clockMax = run.telemetry.CpuClockMaxGhz ?? null;
  const clockPenalty = clockCurrent && clockMax && clockMax > 0
    ? Math.max(0, (1 - (clockCurrent / clockMax)) * 100)
    : 0;
  return Math.max(0, Math.min(100, load * 0.55 + throttlePenalty * 0.35 + clockPenalty * 0.1));
}

export function parseGraphRunText(text, fileName = "unknown.toon") {
  const timestampIso = parseTextField(text, "RunTimestamp") || timestampFromFilename(fileName);
  const timestampMs = timestampIso ? Date.parse(timestampIso) : Number.NaN;
  const telemetry = Object.fromEntries(
    TELEMETRY_FIELDS.map((field) => [field, parseNumericField(text, field)]),
  );
  const familyId = normalizeFamilyId(
    parseTextField(text, "FamilyId") ||
    deriveFamilyIdFromArtifactName(fileName, parseTextField(text, "TestName") || ""),
  );
  const familyLabel = parseTextField(text, "FamilyLabel") || familyLabelFromId(familyId);
  const rawMetrics = parseAllNumericFields(text);
  const metrics = familyId === "standard-multifile"
    ? rawMetrics
    : namespaceFamilyMetrics(rawMetrics, familyId);
  if (familyId !== "standard-multifile") {
    const primarySource = selectFamilyPrimaryField(metrics, familyId);
    const familyKey = familyPrimaryMetricKey(familyId);
    if (primarySource && metrics[primarySource] != null && metrics[familyKey] == null) {
      metrics[familyKey] = metrics[primarySource];
    }
  }
  const run = {
    fileName,
    testName: parseTextField(text, "TestName") || "StandardMultifileTest",
    familyId,
    familyLabel,
    timestampIso,
    timestampMs,
    metrics,
    telemetry,
  };
  return { ...run, heatScore: computeHeatScore(run) };
}

function readGraphRunFromEntry(entry) {
  if (typeof entry === "string") {
    const text = readFileSync(entry, "utf8");
    return parseGraphRunText(text, basename(entry));
  }
  if (entry && typeof entry === "object" && typeof entry.text === "string") {
    return parseGraphRunText(entry.text, entry.path ? basename(entry.path) : "inline.toon");
  }
  return null;
}

function formatDelta(metric, latest, previous) {
  const current = latest.metrics[metric.key];
  const before = previous.metrics[metric.key];
  if (current == null || before == null) return null;
  const delta = current - before;
  const direction = delta < 0 ? "faster" : delta > 0 ? "slower" : "flat";
  return { key: metric.key, label: metric.label, current, before, delta, direction, absDelta: Math.abs(delta) };
}

function buildSummary(runs, activeMetrics) {
  // Prefer the two most recent "standard-multifile" runs for the "latest vs previous" delta summary.
  // This avoids the "Need at least two runs" message when the absolute latest files in the dir
  // are sweep/policy tests that don't share the core Avg* metric keys with each other.
  // Falls back to the overall last two only if there aren't two usable standard runs.
  let latest = null;
  let previous = null;

  const standardRuns = runs.filter(r => r.familyId === "standard-multifile");
  if (standardRuns.length >= 2) {
    latest = standardRuns.at(-1);
    previous = standardRuns.at(-2);
  } else {
    latest = runs.at(-1) || null;
    previous = runs.length > 1 ? runs.at(-2) : null;
  }

  const deltas = latest && previous
    ? activeMetrics.map((metric) => formatDelta(metric, latest, previous)).filter(Boolean).sort((a, b) => b.absDelta - a.absDelta)
    : [];
  return {
    latest,
    previous,
    topChanges: deltas.slice(0, 3),
  };
}

export function buildGraphHistory(entries) {
  const runs = entries
    .map(readGraphRunFromEntry)
    .filter((run) => run && Number.isFinite(run.timestampMs))
    .sort((a, b) => a.timestampMs - b.timestampMs);

  const familyMetrics = [];
  const seenFamilyMetricKeys = new Set(STANDARD_GRAPH_KEYS);
  for (const run of runs) {
    if (!run.familyId || run.familyId === "standard-multifile") continue;
    const familyLabel = run.familyLabel || familyLabelFromId(run.familyId);
    for (const [key, value] of Object.entries(run.metrics)) {
      if (value == null || value === 0) continue;
      if (!looksLikeTimingMetricKey(key)) continue;
      if (!String(key).startsWith(`${run.familyId}.`)) continue;
      if (seenFamilyMetricKeys.has(key)) continue;
      familyMetrics.push(buildFamilyMetricDefinition(run.familyId, {
        key,
        label: seriesLabelFromKey(familyLabel, run.familyId, key),
        color: seriesColorFromKey(run.familyId, key),
        defaultOn: false,
      }));
      seenFamilyMetricKeys.add(key);
    }
  }

  const activeMetrics = [...STANDARD_GRAPH_METRICS, ...familyMetrics].filter((metric) =>
    runs.some((run) => {
      const value = run.metrics[metric.key];
      return value != null && value !== 0;
    }),
  );

  return {
    runs,
    activeMetrics,
    summary: buildSummary(runs, activeMetrics),
  };
}

function formatMetricValue(value) {
  return value == null ? "n/a" : `${Math.round(value)} ms`;
}

function formatDeltaHtml(change) {
  const sign = change.delta > 0 ? "+" : "";
  const cls = change.delta < 0 ? "good" : change.delta > 0 ? "bad" : "flat";
  return `<div class="delta-pill ${cls}"><strong>${change.label}</strong><span>${sign}${Math.round(change.delta)} ms</span></div>`;
}

function safeJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function buildGraphAggregateHtml(model, { launchBadge = null } = {}) {
  const payload = safeJson({
    runs: model.runs,
    metrics: model.activeMetrics,
    summary: model.summary,
    generatedAt: new Date().toISOString(),
  });
  const latest = model.summary.latest;
  const previous = model.summary.previous;
  const latestTime = latest?.timestampIso ?? "n/a";
  const previousTime = previous?.timestampIso ?? "n/a";
  const launchText = launchBadge ? ` - ${launchBadge}` : "";
  const deltaHtml = model.summary.topChanges.length
    ? model.summary.topChanges.map(formatDeltaHtml).join("")
    : `<div class="delta-pill flat"><strong>History</strong><span>Need at least two runs</span></div>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>JXL Wrapper Benchmark${launchText}</title>
  <style>
    :root {
      --bg0: #06131a;
      --bg1: #0b1d27;
      --panel: rgba(9, 20, 28, 0.88);
      --line: rgba(255,255,255,0.08);
      --text: #e6f0f5;
      --muted: #92a9b5;
      --accent: #8de3ff;
      --good: #67e8a0;
      --bad: #ff8f8f;
      --flat: #d9c28b;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: "Segoe UI", "Aptos", system-ui, sans-serif;
      color: var(--text);
      background:
        radial-gradient(circle at top left, rgba(44, 122, 152, 0.28), transparent 28%),
        radial-gradient(circle at top right, rgba(201, 88, 88, 0.22), transparent 22%),
        linear-gradient(180deg, var(--bg1), var(--bg0));
    }
    .shell {
      display: grid;
      grid-template-columns: 360px 1fr;
      min-height: 100vh;
    }
    .sidebar, .main { padding: 24px; }
    .sidebar {
      border-right: 1px solid var(--line);
      background: linear-gradient(180deg, rgba(6,15,20,0.96), rgba(8,18,24,0.78));
      backdrop-filter: blur(20px);
      overflow-y: auto;
      max-height: 100vh;
      position: sticky;
      top: 0;
      align-self: start;
    }
    @media (max-width: 900px) {
      .shell { grid-template-columns: 1fr; }
      .sidebar { border-right: none; border-bottom: 1px solid var(--line); max-height: none; position: static; }
    }
    .main { display: grid; gap: 18px; }
    .eyebrow { color: var(--accent); text-transform: uppercase; letter-spacing: 0.14em; font-size: 11px; }
    .launch-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      border-radius: 999px;
      background: rgba(141, 227, 255, 0.12);
      border: 1px solid rgba(141, 227, 255, 0.24);
      color: #d7f5ff;
      font-size: 10px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      cursor: default;
    }
    .title-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin: 4px 0 2px;
    }
    .title-row h1 {
      margin: 0;
      font-size: 20px;
      line-height: 1.1;
    }
    .badges {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }
    .console-btn {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 4px;
      border: 1px solid rgba(141,227,255,0.3);
      background: rgba(141,227,255,0.08);
      color: #d7f5ff;
      cursor: pointer;
    }
    .console-btn:hover { background: rgba(141,227,255,0.2); }
    h1 { margin: 6px 0 8px; font-size: 24px; line-height: 1.05; }
    .copy { color: var(--muted); font-size: 14px; line-height: 1.45; }
    .control-group, .hero, .chart-shell {
      border: 1px solid var(--line);
      border-radius: 18px;
      background: var(--panel);
      box-shadow: 0 18px 42px rgba(0, 0, 0, 0.28);
    }
    .control-group { padding: 16px; margin-top: 16px; }
    .hero { padding: 18px 20px; }
    .hero-grid { display: grid; grid-template-columns: 1.2fr 1fr; gap: 14px; }
    .summary-meta { display: flex; gap: 12px; flex-wrap: wrap; color: var(--muted); font-size: 13px; }
    .delta-row { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 14px; }
    .delta-pill {
      padding: 10px 12px;
      border-radius: 12px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.06);
      min-width: 150px;
    }
    .delta-pill strong, .metric-label strong { display: block; font-size: 12px; margin-bottom: 4px; }
    .delta-pill span { font-size: 14px; }
    .delta-pill.good span { color: var(--good); }
    .delta-pill.bad span { color: var(--bad); }
    .delta-pill.flat span { color: var(--flat); }
    .metric-list { display: grid; gap: 10px; margin-top: 12px; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
    .metric-row {
      display: grid;
      grid-template-columns: 18px 1fr auto;
      gap: 10px;
      align-items: center;
      padding: 8px 10px;
      border-radius: 12px;
      background: rgba(255,255,255,0.03);
    }
    .metric-row input[type="checkbox"] { width: 16px; height: 16px; }
    .metric-row input[type="color"] {
      width: 34px;
      height: 24px;
      border: 0;
      background: transparent;
      padding: 0;
    }
    .metric-label { min-width: 0; }
    .metric-label span { color: var(--muted); font-size: 12px; }
    .preset-row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
    .metric-row.hidden-metric { display: none; }
    .graph-toolbar {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
      margin-top: 12px;
    }
    button {
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.04);
      color: var(--text);
      border-radius: 999px;
      padding: 8px 12px;
      cursor: pointer;
    }
    button:hover { background: rgba(255,255,255,0.08); }
    .chart-shell { position: relative; padding: 16px; min-height: 720px; overflow: hidden; }
    #history-chart { width: 100%; height: 680px; display: block; cursor: grab; touch-action: none; }
    .tooltip {
      position: absolute;
      min-width: 240px;
      max-width: 360px;
      pointer-events: none;
      padding: 12px 14px;
      border-radius: 14px;
      background: rgba(6, 14, 18, 0.94);
      border: 1px solid rgba(141, 227, 255, 0.24);
      box-shadow: 0 14px 34px rgba(0,0,0,0.32);
      color: var(--text);
      transform: translate(14px, -50%);
    }
    .tooltip.hidden { display: none; }
    .tooltip .stamp { color: var(--accent); font-size: 12px; margin-bottom: 8px; }
    .tooltip .tip-row {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 12px;
      font-size: 12px;
      margin-top: 4px;
    }
    .tooltip.frozen {
      pointer-events: auto;
      border-color: var(--accent);
      box-shadow: 0 18px 40px rgba(0,0,0,0.4), 0 0 0 2px rgba(141, 227, 255, 0.35);
    }
    .tooltip .copy-instruction {
      margin-top: 10px;
      padding-top: 6px;
      border-top: 1px solid rgba(141, 227, 255, 0.2);
      font-size: 11px;
      color: var(--accent);
      text-align: center;
      letter-spacing: 0.02em;
    }
    .footnote { color: var(--muted); font-size: 12px; margin-top: 12px; }
    @media (max-width: 1180px) {
      .hero-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside class="sidebar">
      <div class="eyebrow">Historical Benchmarks</div>
      <div class="title-row">
        <h1>JXL Wrapper Benchmark</h1>
        <div class="badges">
          ${launchBadge ? `<span class="launch-badge" title="Click to log launch info">${launchBadge}</span>` : ""}
          <button class="console-btn" onclick="try { const dataEl = document.getElementById('graph-data'); const d = dataEl ? JSON.parse(dataEl.textContent) : null; const std = (d?.runs||[]).filter(r => r.familyId === 'standard-multifile'); const summary = 'GRAPH_DATA: ' + (d?.runs?.length||0) + ' runs total, ' + std.length + ' standard-multifile. Recent std timestamps: ' + std.slice(-3).map(r => r.timestampIso).join(', '); alert(summary + '\n\nFull object + state dumped to console (F12).'); console.log('GRAPH_DATA runs:', d?.runs?.length, 'metrics:', d?.metrics); console.log('Full GRAPH_DATA:', d); if (typeof window.__graphState !== 'undefined') console.log('__graphState:', window.__graphState); else if (typeof state !== 'undefined') console.log('state (legacy):', state); const svg = document.getElementById('history-chart'); if (svg && svg.innerHTML.indexOf('Benchmark History Chart') > -1 && typeof window.renderChart === 'function') { console.log('Console btn also forcing render...'); window.renderChart(); } } catch(e){ alert('Console dump error: ' + e); console.error('console dump failed', e); }">console</button>
        </div>
      </div>
      <div class="copy">True timestamp spacing. Smooth metric splines. CPU heat overlay behind the data so timing jumps can be explained instead of guessed. <em style="font-size:10px;opacity:0.7">(Timings use consistent 1920px long-edge target scale for comparability; native ~20MP RAWs are scaled to this in the test harness.)</em></div>
      <div class="control-group">
        <div class="eyebrow">Visible Metrics</div>
        <div class="preset-row">
          <button data-preset="core" onclick="(window.setPreset||function(n){console.log('setPreset not ready for',n)})(this.getAttribute('data-preset'))">Core</button>
          <button data-preset="raw" onclick="(window.setPreset||function(n){console.log('setPreset not ready for',n)})(this.getAttribute('data-preset'))">Raw</button>
          <button data-preset="encode" onclick="(window.setPreset||function(n){console.log('setPreset not ready for',n)})(this.getAttribute('data-preset'))">Encode</button>
          <button data-preset="decode" onclick="(window.setPreset||function(n){console.log('setPreset not ready for',n)})(this.getAttribute('data-preset'))">Decode</button>
          <button data-preset="standard" onclick="(window.setPreset||function(n){console.log('setPreset not ready for',n)})(this.getAttribute('data-preset'))">Standard</button>
          <button data-preset="all" onclick="(window.setPreset||function(n){console.log('setPreset not ready for',n)})(this.getAttribute('data-preset'))">All</button>
          <button data-action="toggle-hidden">Show Hidden</button>
          <button data-action="reset-colors">Reset Colors</button>
        </div>
        <div id="metric-list" class="metric-list"></div>
      </div>
    </aside>
    <main class="main">
      <section class="hero">
        <div class="eyebrow">Latest vs Previous</div>
        <div class="hero-grid">
          <div>
            <h2 style="margin:8px 0 10px;font-size:22px;">Benchmark history from first recorded run</h2>
            <div class="summary-meta">
              <span>Latest: ${latestTime}</span>
              <span>Previous: ${previousTime}</span>
              <span>Runs: ${model.runs.length}</span>
            </div>
            <div class="delta-row">${deltaHtml}</div>
          </div>
          <div class="copy">
            The blue-to-red background strips encode run heat from telemetry. Blue means cool and clean. Red means higher load or worse throttling. Each metric line keeps its own stable color so trend identity stays intact.
          </div>
        </div>
      </section>
      <section class="chart-shell">
        <div class="graph-toolbar">
          <button data-action="zoom-in">Zoom In</button>
          <button data-action="zoom-out">Zoom Out</button>
          <button data-action="fit-view">Fit</button>
          <button data-action="reset-view">Reset View</button>
          <span class="copy">Wheel to zoom. Drag to pan.</span>
        </div>
        <svg id="history-chart" viewBox="0 0 1600 900" preserveAspectRatio="none">
          <!-- fallback visible frame (overwritten by JS if successful) -->
          <rect x="98" y="38" width="1460" height="830" fill="#0a1a22" stroke="#8de3ff" stroke-width="2" rx="16" />
          <text x="800" y="300" fill="#8de3ff" font-size="28" text-anchor="middle" font-family="Segoe UI, system-ui">Benchmark History Chart</text>
          <text x="800" y="360" fill="#a8c5d3" font-size="18" text-anchor="middle">Click presets (Core/Standard etc) • Zoom/Fit • Console btn now alerts + dumps to F12 console</text>
          <line x1="98" y1="868" x2="1558" y2="868" stroke="#8de3ff" stroke-opacity="0.4" />
          <text x="100" y="900" fill="#6b8a9e" font-size="14">Time →</text>
        </svg>
        <div id="tooltip" class="tooltip hidden"></div>
        <div class="footnote">Timestamp spacing is continuous, not bucketed by day or ordinal run number. Closely spaced runs stay closely spaced.</div>
      </section>
    </main>
  </div>
  <script id="graph-data" type="application/json">${payload}</script>
  <script>
    (function bootstrapGraph() {
      function reportFatal(error) {
        const root = document.querySelector('.chart-shell');
        if (root) {
          const box = document.createElement('pre');
          box.style.cssText = 'white-space:pre-wrap;word-break:break-word;padding:16px;border-radius:12px;background:#220b0f;border:1px solid #ff8f8f;color:#ffd7d7;max-width:100%;';
          box.textContent = 'Graph render failed:\\n' + (error && error.stack ? error.stack : String(error));
          root.prepend(box);
        }
        console.error(error);
      }

      window.addEventListener('error', (event) => {
        event.preventDefault();
        reportFatal(event.error || event.message || 'Unknown graph error');
      });
      window.addEventListener('unhandledrejection', (event) => {
        event.preventDefault();
        reportFatal(event.reason || 'Unhandled promise rejection');
      });

      try {
        const GRAPH_DATA = JSON.parse(document.getElementById("graph-data").textContent);
        const metricListEl = document.getElementById("metric-list");
        const svg = document.getElementById("history-chart");
        const tooltip = document.getElementById("tooltip");
        const pad = { left: 98, right: 42, top: 38, bottom: 72 };
        const size = { width: 1600, height: 900 };
        const fullDomain = {
          min: GRAPH_DATA.runs[0]?.timestampMs ?? 0,
          max: GRAPH_DATA.runs.at(-1)?.timestampMs ?? 1,
        };
        const state = {
          runs: GRAPH_DATA.runs,
          metrics: GRAPH_DATA.metrics.map((metric) => ({
            ...metric,
            defaultColor: metric.color,
            enabled: metric.defaultOn,
            color: metric.color,
            hidden: Boolean(metric.isFamilyOverlay),
          })),
          showHidden: false,
          view: { min: fullDomain.min, max: fullDomain.max },
        };

        // Bias view to recent *standard-multifile* runs (the ones carrying Avg* RAW/tonemap/prog timings)
        // so the chart lines are visible even if other test .toons have newer timestamps.
        try {
          const std = state.runs.filter(r => r.familyId === "standard-multifile");
          if (std.length > 0) {
            const n = Math.min(50, std.length);
            const win = std.slice(-n);
            state.view.min = win[0].timestampMs;
            state.view.max = win[win.length - 1].timestampMs;
          }
        } catch (e) { /* non-fatal */ }

        // Force-enable the metrics that matter for StandardMultifile (RAW, photon, mono ROI etc.)
        // so the SVG actually draws lines on load.
        try {
          const isStdMetric = (m) => m.group === "core" || m.group === "raw" ||
            (m.key || "").startsWith("Avg") || (m.key || "").includes("Photon") ||
            (m.key || "").includes("Mono") || (m.key || "").includes("Roi");
          state.metrics.forEach(m => { if (isStdMetric(m)) m.enabled = true; });
        } catch (e) {}

        let frozenPoint = null;

        const presets = {
          core: (metric) => metric.group === "core",
          raw: (metric) => metric.group === "raw",
          encode: (metric) => metric.group === "encode",
          decode: (metric) => metric.group === "decode",
          standard: (metric) => (metric.group === "core" || metric.group === "raw" || (metric.key || "").startsWith("Avg") || (metric.key || "").includes("Photon") || (metric.key || "").includes("Mono") || (metric.key || "").includes("Roi")),
          all: () => true,
        };

        function fmtMs(value) { return value == null ? "n/a" : Math.round(value) + " ms"; }
        function fmtNum(value, suffix = "") { return value == null ? "n/a" : value + suffix; }
        function fmtStamp(value) { return value ? new Date(value).toLocaleString() : "n/a"; }
        function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
        function lerp(a, b, t) { return a + (b - a) * t; }

        function hexToRgb(hex) {
          const clean = String(hex).replace("#", "");
          const value = clean.length === 3
            ? clean.split("").map((c) => c + c).join("")
            : clean;
          const int = Number.parseInt(value, 16);
          return {
            r: (int >> 16) & 255,
            g: (int >> 8) & 255,
            b: int & 255,
          };
        }

        function rgbToCss({ r, g, b }) {
          return "rgb(" + Math.round(r) + "," + Math.round(g) + "," + Math.round(b) + ")";
        }

        function mixColors(fromHex, toHex, t) {
          const from = hexToRgb(fromHex);
          const to = hexToRgb(toHex);
          return rgbToCss({
            r: lerp(from.r, to.r, t),
            g: lerp(from.g, to.g, t),
            b: lerp(from.b, to.b, t),
          });
        }

        function heatColor(score) {
          const t = clamp(score / 100, 0, 1);
          const stops = [
            [0.0, [67, 191, 255]],
            [0.4, [80, 214, 176]],
            [0.7, [255, 183, 77]],
            [1.0, [255, 93, 93]],
          ];
          for (let i = 1; i < stops.length; i++) {
            if (t <= stops[i][0]) {
              const [t0, c0] = stops[i - 1];
              const [t1, c1] = stops[i];
              const local = (t - t0) / (t1 - t0);
              const rgb = c0.map((v, idx) => Math.round(lerp(v, c1[idx], local)));
              return 'rgb(' + rgb.join(',') + ')';
            }
          }
          return 'rgb(255,93,93)';
        }

        function bandHeatColor(score) {
          return mixColors("#43bfff", "#ff5d5d", clamp(score / 100, 0, 1));
        }

        function setPreset(name) {
          const pick = presets[name];
          state.metrics.forEach((metric) => { metric.enabled = pick(metric); });
          renderControls();
          renderChart();
        }

        function resetColors() {
          state.metrics.forEach((metric) => { metric.color = metric.defaultColor || metric.color; });
          renderControls();
          renderChart();
        }

        function setHiddenVisibility(showHidden) {
          state.showHidden = showHidden;
          renderControls();
        }

        function fitView() {
          state.view.min = fullDomain.min;
          state.view.max = fullDomain.max;
          renderChart();
        }

        function zoomBy(factor, anchorRatio = 0.5) {
          const span = Math.max(1, state.view.max - state.view.min);
          const targetSpan = clamp(span * factor, 60_000, Math.max(60_000, fullDomain.max - fullDomain.min));
          const anchorTs = state.view.min + span * clamp(anchorRatio, 0, 1);
          let min = anchorTs - targetSpan * clamp(anchorRatio, 0, 1);
          let max = min + targetSpan;
          if (min < fullDomain.min) {
            max += fullDomain.min - min;
            min = fullDomain.min;
          }
          if (max > fullDomain.max) {
            min -= max - fullDomain.max;
            max = fullDomain.max;
          }
          state.view.min = Math.max(fullDomain.min, min);
          state.view.max = Math.min(fullDomain.max, max);
          renderChart();
        }

        function panBy(deltaRatio) {
          const span = Math.max(1, state.view.max - state.view.min);
          const shift = span * deltaRatio;
          let min = state.view.min + shift;
          let max = state.view.max + shift;
          if (min < fullDomain.min) {
            max += fullDomain.min - min;
            min = fullDomain.min;
          }
          if (max > fullDomain.max) {
            min -= max - fullDomain.max;
            max = fullDomain.max;
          }
          state.view.min = Math.max(fullDomain.min, min);
          state.view.max = Math.min(fullDomain.max, max);
          renderChart();
        }

        function renderControls() {
          metricListEl.innerHTML = "";
          state.metrics.forEach((metric, index) => {
            const row = document.createElement("label");
            row.className = "metric-row";
            if (metric.hidden && !state.showHidden) row.classList.add("hidden-metric");
            row.innerHTML = \`
              <input type="checkbox" \${metric.enabled ? "checked" : ""} data-index="\${index}" data-kind="toggle" />
              <div class="metric-label">
                <strong>\${metric.label}</strong>
                <span>\${metric.key}</span>
              </div>
              <input type="color" value="\${metric.color}" data-index="\${index}" data-kind="color" />
            \`;
            metricListEl.appendChild(row);
          });
          const hiddenButton = document.querySelector('[data-action="toggle-hidden"]');
          if (hiddenButton) hiddenButton.textContent = state.showHidden ? "Hide Hidden" : "Show Hidden";
        }

        function linePath(points) {
      if (points.length === 0) return "";
      if (points.length === 1) return \`M \${points[0].x} \${points[0].y}\`;
      let d = \`M \${points[0].x} \${points[0].y}\`;
      for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[i - 1] || points[i];
        const p1 = points[i];
        const p2 = points[i + 1];
        const p3 = points[i + 2] || p2;
        const cp1x = p1.x + (p2.x - p0.x) / 6;
        const cp1y = p1.y + (p2.y - p0.y) / 6;
        const cp2x = p2.x - (p3.x - p1.x) / 6;
        const cp2y = p2.y - (p3.y - p1.y) / 6;
        d += \` C \${cp1x} \${cp1y}, \${cp2x} \${cp2y}, \${p2.x} \${p2.y}\`;
      }
      return d;
    }

        function straightPath(points) {
          if (points.length === 0) return "";
          return points.map((point, index) => \`\${index === 0 ? "M" : "L"} \${point.x} \${point.y}\`).join(" ");
        }

        function shouldSmooth(points) {
          if (points.length < 4) return false;
          const gaps = [];
          for (let i = 0; i < points.length - 1; i++) {
            gaps.push(Math.abs(points[i + 1].x - points[i].x));
          }
          gaps.sort((a, b) => a - b);
          const median = gaps[Math.floor(gaps.length / 2)] || 0;
          const maxGap = gaps[gaps.length - 1] || 0;
          return median > 0 && maxGap <= median * 6;
        }

        function enabledMetrics() {
          return state.metrics.filter((metric) => metric.enabled);
        }

        function visibleRuns() {
          return state.runs.filter((run) => run.timestampMs >= state.view.min && run.timestampMs <= state.view.max);
        }

        function renderChart() {
          const runs = state.runs;
          const activeRuns = visibleRuns();
          const visibleMetrics = enabledMetrics();
          const x0 = pad.left;
          const x1 = size.width - pad.right;
          const y0 = pad.top;
          const y1 = size.height - pad.bottom;
          const minTs = state.view.min;
          const maxTs = Math.max(minTs + 1, state.view.max);
          const values = visibleMetrics.flatMap((metric) =>
            activeRuns.map((run) => run.metrics[metric.key]).filter((value) => value != null),
          );
          const minY = 0;
          const maxY = Math.max(1, ...values, 1);
          const toX = (ts) => x0 + ((ts - minTs) / Math.max(1, maxTs - minTs)) * (x1 - x0);
          const toY = (val) => y1 - ((val - minY) / Math.max(1, maxY - minY)) * (y1 - y0);
          const hitPoints = [];

          const heatBands = runs.map((run, index) => {
            const center = toX(run.timestampMs);
            const prev = index === 0 ? x0 : (center + toX(runs[index - 1].timestampMs)) / 2;
            const next = index === runs.length - 1 ? x1 : (center + toX(runs[index + 1].timestampMs)) / 2;
            return \`<rect x="\${prev}" y="\${y0}" width="\${Math.max(1, next - prev)}" height="\${y1 - y0}" fill="\${bandHeatColor(run.heatScore)}" opacity="\${0.24 + (run.heatScore / 100) * 0.32}" pointer-events="none" />\`;
          }).join("");

          const grid = Array.from({ length: 6 }, (_, idx) => {
            const value = (maxY / 5) * idx;
            const y = toY(value);
              return \`
                <line x1="\${x0}" y1="\${y}" x2="\${x1}" y2="\${y}" stroke="rgba(141,227,255,0.35)" stroke-width="1" pointer-events="none" />
                <text x="\${x0 - 16}" y="\${y + 5}" fill="#8fa8b6" font-size="20" text-anchor="end">\${Math.round(value)} ms</text>
              \`;
          }).join("");

          const xTicks = activeRuns.map((run, idx) => {
            if (idx !== 0 && idx !== activeRuns.length - 1 && idx % Math.ceil(Math.max(1, activeRuns.length / 8)) !== 0) return "";
            const x = toX(run.timestampMs);
            const stamp = new Date(run.timestampIso);
            const label = (stamp && !isNaN(stamp.getTime())) ? stamp.toISOString().slice(5, 16).replace("T", " ") : "?";
            return \`
              <line x1="\${x}" y1="\${y1}" x2="\${x}" y2="\${y1 + 8}" stroke="rgba(255,255,255,0.16)" />
              <text x="\${x}" y="\${y1 + 30}" fill="#8fa8b6" font-size="18" text-anchor="middle">\${label}</text>
            \`;
          }).join("");

          const lines = visibleMetrics.map((metric) => {
            const points = runs
              .filter((run) => run.metrics[metric.key] != null)
              .map((run) => ({ x: toX(run.timestampMs), y: toY(run.metrics[metric.key]), run }));
            points.forEach((point) => hitPoints.push({ ...point, metric }));
            const path = shouldSmooth(points) && !metric.isFamilyOverlay ? linePath(points) : "";
            const segments = points.slice(0, -1).map((point, index) => {
              const next = points[index + 1];
              const heat = clamp(((point.run.heatScore + next.run.heatScore) / 2) / 100, 0, 1);
              const stroke = mixColors(metric.color, "#ff5d5d", heat);
              return \`
                <line data-hit="1" data-metric-key="\${metric.key}" x1="\${point.x}" y1="\${point.y}" x2="\${next.x}" y2="\${next.y}"
                  stroke="rgba(255,255,255,0.001)" stroke-width="\${16 + heat * 8}" stroke-linecap="round" fill="none" pointer-events="stroke" opacity="0.01" />
                <line data-hit="0" data-metric-key="\${metric.key}" x1="\${point.x}" y1="\${point.y}" x2="\${next.x}" y2="\${next.y}"
                  stroke="\${stroke}" stroke-width="\${4 + heat * 1.9}" stroke-linecap="round"
                  opacity="\${0.72 + heat * 0.28}" pointer-events="none" />
              \`;
            }).join("");
            const circles = points.map((point) => \`
              <circle data-hit="1" data-metric-key="\${metric.key}" cx="\${point.x}" cy="\${point.y}" r="12" fill="rgba(255,255,255,0.001)" stroke="none" pointer-events="all" />
              <circle data-hit="1" data-metric-key="\${metric.key}" cx="\${point.x}" cy="\${point.y}" r="6" fill="\${metric.color}" stroke="rgba(6,14,18,0.9)" stroke-width="2" />
              <circle data-hit="0" cx="\${point.x}" cy="\${point.y}" r="\${9 + (point.run.heatScore / 18)}" fill="\${heatColor(point.run.heatScore)}" opacity="\${0.12 + (point.run.heatScore / 100) * 0.08}" pointer-events="none" />
              \`).join("");
            return \`
              \${path ? '<path d="' + path + '" fill="none" stroke="' + metric.color + '" stroke-width="2" opacity="' + (points.length >= 4 ? 0.12 : 0.0) + '" stroke-linecap="round" stroke-linejoin="round" pointer-events="none" />' : ""}
              \${segments}
              \${circles}
            \`;
          }).join("");
          state.hitPoints = hitPoints;

          svg.innerHTML = \`
            <defs>
              <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="rgba(255,255,255,0.02)" />
                <stop offset="100%" stop-color="rgba(255,255,255,0.00)" />
              </linearGradient>
              <clipPath id="chart-clip">
                <rect x="\${x0}" y="\${y0}" width="\${x1 - x0}" height="\${y1 - y0}" rx="20" />
              </clipPath>
            </defs>
            <rect x="0" y="0" width="\${size.width}" height="\${size.height}" fill="url(#bg)" rx="24" />
            <rect x="\${x0}" y="\${y0}" width="\${x1 - x0}" height="\${y1 - y0}" rx="20" fill="rgba(2,8,11,0.65)" stroke="#8de3ff" stroke-width="1.5" />
            <g clip-path="url(#chart-clip)">
              \${heatBands}
              \${grid}
              \${lines}
            </g>
            <line x1="\${x0}" y1="\${y1}" x2="\${x1}" y2="\${y1}" stroke="rgba(255,255,255,0.24)" />
            <line x1="\${x0}" y1="\${y0}" x2="\${x0}" y2="\${y1}" stroke="rgba(255,255,255,0.24)" />
            \${xTicks}
          \`;
        }

        function nearestPoint(clientX, clientY, rect, metricKey = null) {
          const relX = clamp((clientX - rect.left) / rect.width, 0, 1);
          const relY = clamp((clientY - rect.top) / rect.height, 0, 1);
          const targetX = relX * rect.width;
          const targetY = relY * rect.height;
          let best = null;
          let bestDist = Infinity;
          const candidates = metricKey ? (state.hitPoints || []).filter((point) => point.metric?.key === metricKey) : (state.hitPoints || []);
          for (const point of candidates) {
            const dx = point.x - targetX;
            const dy = point.y - targetY;
            const dist = dx * dx + dy * dy;
            if (dist < bestDist) {
              bestDist = dist;
              best = point;
            }
          }
          return best ? { ...best, dist: Math.sqrt(bestDist) } : null;
        }

        function nearestRun(clientX, rect) {
          const relative = clamp((clientX - rect.left) / rect.width, 0, 1);
          const targetTs = state.view.min + relative * (state.view.max - state.view.min);
          return state.runs.reduce((best, run) => (
            Math.abs(run.timestampMs - targetTs) < Math.abs(best.timestampMs - targetTs) ? run : best
          ), state.runs[0]);
        }

        function showTooltip(event, target = null) {
          const rect = svg.getBoundingClientRect();
          let point;
          const metricKey = target instanceof Element ? target.getAttribute("data-metric-key") : null;
          if (frozenPoint) {
            point = frozenPoint;
          } else {
            point = nearestPoint(event.clientX, event.clientY, rect, metricKey || null);
            if (!point || (!metricKey && point.dist > 28)) {
              tooltip.classList.add("hidden");
              return;
            }
          }
          const run = point.run;
          const focusRow = "<div class=\\"tip-row\\"><span>Point</span><strong style=\\"color:" + point.metric.color + "\\">" + point.metric.label + ": " + fmtMs(run.metrics[point.metric.key]) + "</strong></div>";
          const rows = enabledMetrics().map(function(metric) {
            const value = run.metrics[metric.key];
            return value == null ? "" : "<div class=\\"tip-row\\"><span>" + metric.label + "</span><strong style=\\"color:" + metric.color + "\\">" + fmtMs(value) + "</strong></div>";
          }).join("");
          let content = "<div class=\\"stamp\\">" + fmtStamp(run.timestampIso) + "</div>" +
            "<div class=\\"tip-row\\"><span>Family</span><strong>" + (run.familyLabel ?? run.testName) + "</strong></div>" +
            focusRow +
            rows +
            "<div class=\\"tip-row\\"><span>CpuActiveLoadPct</span><strong>" + fmtNum(run.telemetry.CpuActiveLoadPct, "%") + "</strong></div>" +
            "<div class=\\"tip-row\\"><span>CpuThrottlingPct</span><strong>" + fmtNum(run.telemetry.CpuThrottlingPct, "%") + "</strong></div>" +
            "<div class=\\"tip-row\\"><span>CpuClockCurrentGhz</span><strong>" + fmtNum(run.telemetry.CpuClockCurrentGhz, " GHz") + "</strong></div>" +
            "<div class=\\"tip-row\\"><span>SystemMemoryFreeGb</span><strong>" + fmtNum(run.telemetry.SystemMemoryFreeGb, " GB") + "</strong></div>";
          if (frozenPoint) {
            content += "<div class=\\"copy-instruction\\">ctrl+c to copy to clipboard</div>";
          }
          tooltip.innerHTML = content;
          tooltip.classList.remove("hidden");
          if (!frozenPoint) {
            const left = clamp(event.clientX - rect.left + 14, 12, rect.width - 280);
            tooltip.style.left = left + "px";
            tooltip.style.top = (event.clientY - rect.top) + "px";
          }
        }

        renderControls();
        renderChart();

        // Force the standard preset and re-render so the chart lines (not just the hero deltas)
        // actually appear for the StandardMultifile data.
        try {
          if (typeof setPreset === 'function') setPreset('standard');
          renderChart();
        } catch (e) { console && console.warn && console.warn('force standard preset failed', e); }

        // Expose globals so preset buttons (even static ones) and console button can call them
        // and to allow forcing render from outside if needed.
        window.setPreset = setPreset;
        window.renderChart = renderChart;
        window.renderControls = renderControls;
        window.__graphState = state;

        metricListEl.addEventListener("input", (event) => {
          const el = event.target;
          const index = Number(el.dataset.index);
          if (!Number.isInteger(index)) return;
          if (el.dataset.kind === "toggle") state.metrics[index].enabled = el.checked;
          if (el.dataset.kind === "color") state.metrics[index].color = el.value;
          renderChart();
        });

        document.querySelectorAll("[data-preset]").forEach((button) => {
          button.addEventListener("click", () => setPreset(button.dataset.preset));
        });
        document.querySelector('[data-action="reset-colors"]').addEventListener("click", () => {
          state.metrics.forEach((metric) => { metric.color = metric.defaultColor || metric.color; });
          renderControls();
          renderChart();
        });
        document.querySelector('[data-action="toggle-hidden"]').addEventListener("click", () => {
          setHiddenVisibility(!state.showHidden);
        });
        document.querySelector('[data-action="zoom-in"]').addEventListener("click", () => zoomBy(0.8));
        document.querySelector('[data-action="zoom-out"]').addEventListener("click", () => zoomBy(1.25));
        document.querySelector('[data-action="fit-view"]').addEventListener("click", fitView);
        document.querySelector('[data-action="reset-view"]').addEventListener("click", fitView);

        // Freeze support: ctrl+c (or cmd+c) copies the frozen infobox
        document.addEventListener("keydown", (e) => {
          if (frozenPoint && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
            e.preventDefault();
            const text = tooltip.innerText || tooltip.textContent || "";
            if (text) {
              navigator.clipboard.writeText(text.trim()).catch(() => {});
            }
          }
        });

        let dragState = null;
        svg.addEventListener("wheel", (event) => {
          event.preventDefault();
          const rect = svg.getBoundingClientRect();
          const anchor = clamp((event.clientX - rect.left) / rect.width, 0, 1);
          if (event.shiftKey) {
            panBy(event.deltaY > 0 ? 0.08 : -0.08);
            return;
          }
          zoomBy(event.deltaY > 0 ? 1.12 : 0.89, anchor);
        }, { passive: false });
        svg.addEventListener("pointerdown", (event) => {
          const target = event.target instanceof Element ? event.target.closest("[data-hit='1']") : null;
          if (target) {
            // Freeze infobox on click on a dot or line segment
            const rect = svg.getBoundingClientRect();
            const metricKey = target.getAttribute("data-metric-key");
            const point = nearestPoint(event.clientX, event.clientY, rect, metricKey || null);
            if (point) {
              frozenPoint = point;
              showTooltip(event, target);
              const left = clamp(event.clientX - rect.left + 14, 12, rect.width - 280);
              tooltip.style.left = left + "px";
              tooltip.style.top = (event.clientY - rect.top) + "px";
              tooltip.classList.remove("hidden");
              tooltip.classList.add("frozen");
            }
            return; // prevent starting drag
          }
          // Clicked elsewhere: unfreeze
          if (frozenPoint) {
            frozenPoint = null;
            tooltip.classList.remove("frozen");
            tooltip.classList.add("hidden");
          }
          dragState = { x: event.clientX, y: event.clientY };
          svg.style.cursor = "grabbing";
          svg.setPointerCapture(event.pointerId);
        });
        svg.addEventListener("pointermove", (event) => {
          const target = event.target instanceof Element ? event.target.closest("[data-hit='1']") : null;
          if (dragState) {
            svg.style.cursor = "grabbing";
            const rect = svg.getBoundingClientRect();
            const deltaRatio = -(event.clientX - dragState.x) / rect.width;
            dragState = { x: event.clientX, y: event.clientY };
            panBy(deltaRatio);
            if (!frozenPoint) {
              tooltip.classList.add("hidden");
            }
            return;
          }
          svg.style.cursor = target ? "pointer" : "grab";
          if (frozenPoint) {
            return;
          }
          if (!target) {
            tooltip.classList.add("hidden");
            return;
          }
          showTooltip(event, target);
        });
        svg.addEventListener("pointerup", () => {
          dragState = null;
          svg.style.cursor = "grab";
        });
        svg.addEventListener("pointerleave", () => {
          dragState = null;
          if (!frozenPoint) {
            tooltip.classList.add("hidden");
          }
          svg.style.cursor = "grab";
        });
        svg.addEventListener("dblclick", fitView);
      } catch (error) {
        reportFatal(error);
      }
    })();
  </script>
<script>
  // Safety net: force the chart to render and overwrite any placeholder/fallback text
  // in the SVG viewport. This ensures the real history lines appear even if timing
  // or partial execution left the static fallback visible.
  setTimeout(function() {
    try {
      if (typeof window.renderChart === 'function') {
        console.log('[graph] Forcing renderChart to overwrite placeholder...');
        window.renderChart();
        if (typeof window.renderControls === 'function') window.renderControls();
      } else {
        console.log('[graph] renderChart not exposed yet');
      }
    } catch(e) {
      console.error('[graph] Force render failed', e);
      const svg = document.getElementById('history-chart');
      if (svg) {
        svg.innerHTML = '<rect x="98" y="38" width="1460" height="830" fill="#0a1a22" stroke="#8de3ff" stroke-width="2" rx="16" />\\n' +
          '<text x="800" y="400" fill="#8de3ff" font-size="24" text-anchor="middle">Render error - see console.</text>\\n' +
          '<text x="800" y="440" fill="#a8c5d3" font-size="16" text-anchor="middle">Click console button for details + data dump.</text>';
      }
    }
    // Final safety: if still showing placeholder text, force a visible frame
    setTimeout(function() {
      const svg = document.getElementById('history-chart');
      if (svg && svg.innerHTML.indexOf('Benchmark History Chart') > -1) {
        console.log('[graph] Still placeholder after force, setting basic visible content');
        svg.innerHTML = '<rect x="98" y="38" width="1460" height="830" fill="#0a1a22" stroke="#8de3ff" stroke-width="2" rx="16" />\\n' +
          '<text x="800" y="400" fill="#8de3ff" font-size="24" text-anchor="middle">Chart data present but render had issue.</text>\\n' +
          '<text x="800" y="440" fill="#a8c5d3" font-size="16" text-anchor="middle">Click presets or console button. Check DevTools console for errors.</text>\\n' +
          '<line x1="98" y1="868" x2="1558" y2="868" stroke="#8de3ff" stroke-opacity="0.4" />';
      }
    }, 300);
  }, 120);
</script>
</body>
</html>`;
}
