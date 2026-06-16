# Standard Multifile History Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate a self-contained `GraphAggregateResults.html` from historical `StandardMultifileTest-general` `.toon` files whenever `StandardMultifileTest.mjs` runs.

**Architecture:** Extend `StandardMultifileTest.mjs` with a small parsing layer for historical `.toon` files, a normalization layer that filters to curated non-zero metrics, and an HTML generator that emits a custom SVG-based timeline graph with toggles, per-metric colors, and heat overlays. Keep the `.toon` writer intact and append aggregate HTML generation after it.

**Tech Stack:** Node.js ESM, built-in `fs`/`path`, inline HTML/CSS/JavaScript, custom SVG rendering

---

## File Structure

- Modify: `StandardMultifileTest.mjs`
  - add historical `.toon` discovery and parsing
  - add curated metric definitions and filtering
  - add self-contained HTML generator
  - call HTML generation after current `.toon` write
- Create: `docs/outputs/timing tests/GraphAggregateResults.html`
  - generated artifact, not hand-edited

### Task 1: Add historical parsing helpers

**Files:**
- Modify: `StandardMultifileTest.mjs`

- [ ] **Step 1: Add failing mental contract for parser behavior**

Expected parser contract:

```js
// Input: raw .toon text
// Output: normalized run object
{
  timestampIso: '2026-06-12T19:39:32.277Z',
  timestampMs: 1781293172277,
  fileName: '2026-06-12T19-39-32-277Z-StandardMultifileTest-general.toon',
  metrics: { AvgRawMs: 711, AvgProgEncMtMs: 126 },
  telemetry: { CpuActiveLoadPct: 14, CpuThrottlingPct: 100 }
}
```

- [ ] **Step 2: Implement metric regex helpers and `.toon` parser**

Add code near the serialization helpers:

```js
function parseNumericField(text, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`${escaped}:\\s*([\\d.]+|N\\/A)`, "i"));
  if (!match || match[1] === "N/A") return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function parseTextField(text, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`${escaped}:\\s*(.+)`, "i"));
  return match ? match[1].trim() : null;
}
```

- [ ] **Step 3: Build curated metric definitions**

Add a top-level metric catalog:

```js
const GRAPH_METRICS = [
  { key: "AvgRawMs", label: "RAW Decode", group: "core", defaultOn: true, color: "#7dd3fc" },
  { key: "AvgProgEncMtMs", label: "Prog Encode MT", group: "encode", defaultOn: true, color: "#34d399" },
  { key: "AvgShotEncMtMs", label: "One-shot Encode MT", group: "encode", defaultOn: true, color: "#f59e0b" },
  { key: "AvgProgFirstMtMs", label: "Prog First Paint MT", group: "decode", defaultOn: true, color: "#60a5fa" },
  { key: "AvgProgFinalMtMs", label: "Prog Final MT", group: "decode", defaultOn: true, color: "#f472b6" },
  { key: "AvgShotDecMtMs", label: "One-shot Decode MT", group: "decode", defaultOn: true, color: "#a78bfa" },
  { key: "MultiWorkerParallelWallMs", label: "Parallel Wall", group: "decode", defaultOn: false, color: "#fb7185" },
  { key: "RealJxtcTiledRoi_512_512_Ms", label: "JXTC ROI", group: "core", defaultOn: false, color: "#22c55e" },
  { key: "MonolithicRoi_512_512_Ms", label: "Mono ROI", group: "core", defaultOn: false, color: "#ef4444" },
  { key: "EncCoreCompressMs", label: "JXTC Core Compress", group: "encode", defaultOn: false, color: "#f97316" }
];
```

- [ ] **Step 4: Run quick syntax check**

Run: `rtk proxy node --check .\StandardMultifileTest.mjs`
Expected: no syntax errors

### Task 2: Build aggregate history model

**Files:**
- Modify: `StandardMultifileTest.mjs`

- [ ] **Step 1: Discover historical `.toon` files**

Add code:

```js
function collectHistoricalToonRuns(outDir) {
  if (!existsSync(outDir)) return [];
  return readdirSync(outDir)
    .filter((name) => name.endsWith(".toon") && name.includes("StandardMultifileTest-general"))
    .map((name) => join(outDir, name))
    .sort((a, b) => a.localeCompare(b));
}
```

- [ ] **Step 2: Normalize parsed runs and drop empty series**

Add code:

```js
function buildGraphHistory(paths) {
  const runs = paths
    .map(readGraphRunFromToon)
    .filter(Boolean)
    .sort((a, b) => a.timestampMs - b.timestampMs);

  const activeMetrics = GRAPH_METRICS.filter((metric) =>
    runs.some((run) => {
      const value = run.metrics[metric.key];
      return value !== null && value !== 0;
    })
  );

  return { runs, activeMetrics };
}
```

- [ ] **Step 3: Compute heat score and latest-vs-previous deltas**

Add code:

```js
function computeHeatScore(run) {
  const load = run.telemetry.CpuActiveLoadPct ?? 0;
  const throttlePenalty = Math.max(0, 100 - (run.telemetry.CpuThrottlingPct ?? 100));
  const clockCurrent = run.telemetry.CpuClockCurrentGhz ?? null;
  const clockMax = run.telemetry.CpuClockMaxGhz ?? null;
  const clockPenalty = clockCurrent && clockMax && clockMax > 0
    ? Math.max(0, (1 - (clockCurrent / clockMax)) * 100)
    : 0;
  return Math.max(0, Math.min(100, load * 0.55 + throttlePenalty * 0.35 + clockPenalty * 0.10));
}
```

- [ ] **Step 4: Run quick syntax check**

Run: `rtk proxy node --check .\StandardMultifileTest.mjs`
Expected: no syntax errors

### Task 3: Generate self-contained HTML graph

**Files:**
- Modify: `StandardMultifileTest.mjs`

- [ ] **Step 1: Add HTML generator shell**

Add function:

```js
function buildGraphAggregateHtml({ runs, activeMetrics }) {
  const payload = JSON.stringify({ runs, metrics: activeMetrics }, null, 2);
  return `<!doctype html>
<html lang="en">
<head>...</head>
<body>
  <script id="graph-data" type="application/json">${payload}</script>
  <script>
    // render app
  </script>
</body>
</html>`;
}
```

- [ ] **Step 2: Implement left rail, summary strip, and SVG renderer**

Include:

```js
const layout = `
  <aside class="sidebar">...</aside>
  <main class="main">
    <section class="hero">...</section>
    <section class="chart-shell">
      <svg id="history-chart" viewBox="0 0 1600 900" preserveAspectRatio="none"></svg>
      <div id="tooltip" class="tooltip hidden"></div>
    </section>
  </main>
`;
```

- [ ] **Step 3: Implement interaction logic**

Include:

```js
function renderChart(state) {
  // compute scales from true timestampMs and metric values
  // draw heat bands first
  // draw axes
  // draw spline paths
  // draw exact point markers
}

function bindControls(state) {
  // toggles, color pickers, presets, reset
}
```

- [ ] **Step 4: Write output file after `.toon` generation**

Append near the current write block:

```js
const graphPaths = collectHistoricalToonRuns(OUT_DIR);
const graphModel = buildGraphHistory(graphPaths);
const graphHtml = buildGraphAggregateHtml(graphModel);
writeFileSync(join(OUT_DIR, "GraphAggregateResults.html"), graphHtml);
```

- [ ] **Step 5: Run quick syntax check**

Run: `rtk proxy node --check .\StandardMultifileTest.mjs`
Expected: no syntax errors

### Task 4: Regenerate artifact and verify behavior

**Files:**
- Modify: `StandardMultifileTest.mjs`
- Test: `docs/outputs/timing tests/GraphAggregateResults.html`

- [ ] **Step 1: Run benchmark generator**

Run: `rtk proxy node .\StandardMultifileTest.mjs general`
Expected: benchmark completes, writes current `.toon`, writes `GraphAggregateResults.html`

- [ ] **Step 2: Verify output file exists**

Run: `rtk proxy powershell -NoProfile -Command "Get-Item '.\docs\outputs\timing tests\GraphAggregateResults.html' | Select-Object FullName,Length,LastWriteTime"`
Expected: file exists with fresh timestamp

- [ ] **Step 3: Spot-check generated HTML content**

Run: `rtk rg -n "graph-data|history-chart|tooltip|CpuActiveLoadPct|AvgShotEncMtMs|MonolithicRoi_512_512_Ms" ".\docs\outputs\timing tests\GraphAggregateResults.html"`
Expected: embedded data and renderer markers present

- [ ] **Step 4: Commit**

```bash
git add StandardMultifileTest.mjs "docs/outputs/timing tests/GraphAggregateResults.html" docs/superpowers/specs/2026-06-13-standard-multifile-history-graph-design.md docs/superpowers/plans/2026-06-13-standard-multifile-history-graph.md
git commit -m "feat: add standard multifile history graph"
```
