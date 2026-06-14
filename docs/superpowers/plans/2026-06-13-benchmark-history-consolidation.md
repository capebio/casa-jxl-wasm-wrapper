# Benchmark History Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Normalize every benchmark history artifact into `.toon`, keep legacy files in a backup folder, and extend the history graph to show every benchmark family as a toggleable overlay.

**Architecture:** Add a small benchmark-history conversion layer that discovers legacy timing outputs, converts them into a canonical `.toon` shape, and writes the normalized files into `docs/outputs/timing tests`. Keep the current `StandardMultifileTest` history graph as the primary renderer, but teach it to ingest multiple benchmark families through family adapters and series registries. Preserve the original raw outputs in a backup subfolder so the graph can stay simple while the source data remains available.

**Tech Stack:** Node.js ESM, built-in `fs` / `path`, existing `.toon` parser conventions, inline HTML/CSS/JavaScript, custom SVG rendering

---

## File Structure

- Modify: `benchmark/standard-multifile-history-graph.mjs`
  - add benchmark-family registry
  - add normalized series adapters for other benchmark outputs
  - keep the current single-family metric graph working
  - render family overlays and family toggles
- Modify: `StandardMultifileTest.mjs`
  - generate the primary `.toon`
  - invoke the history consolidation step after each run
- Create: `benchmark/benchmark-history-conversion.mjs`
  - discover legacy benchmark artifacts
  - convert JSON / CSV / Markdown benchmark outputs into `.toon`
  - move original legacy files into `docs/outputs/timing tests/backup`
- Create: `benchmark/benchmark-history-registry.mjs`
  - define benchmark families, adapter metadata, and default colors / labels
- Create: `benchmark/benchmark-history-conversion.test.mjs`
  - regression tests for normalization and backup-path behavior
- Modify: `benchmark/standard-multifile-history-graph.test.mjs`
  - add coverage for multi-family overlays and hidden-by-default families
- Generated: `docs/outputs/timing tests/*.toon`
  - canonical history artifacts only
- Generated: `docs/outputs/timing tests/GraphAggregateResults.html`
  - reads canonical `.toon` history only
- Generated / moved: `docs/outputs/timing tests/backup/*`
  - legacy raw JSON / CSV / Markdown benchmark outputs

### Task 1: Define the benchmark family registry

**Files:**
- Create: `benchmark/benchmark-history-registry.mjs`

- [ ] **Step 1: Define the family registry shape**

```js
export const BENCHMARK_FAMILIES = [
  {
    familyId: "standard-multifile",
    label: "Standard Multifile",
    sourceGlobs: [
      "docs/outputs/timing tests/*StandardMultifileTest-general.toon",
    ],
    defaultVisible: true,
    color: "#7dd3fc",
    series: [
      { seriesId: "AvgRawMs", label: "RAW Decode", key: "AvgRawMs", defaultOn: true },
      { seriesId: "AvgProgEncMtMs", label: "Prog Encode MT", key: "AvgProgEncMtMs", defaultOn: true },
      { seriesId: "AvgShotEncMtMs", label: "One-shot Encode MT", key: "AvgShotEncMtMs", defaultOn: true },
    ],
  },
  {
    familyId: "policy-ab",
    label: "Policy A/B",
    sourceGlobs: [
      "docs/Benchmark results/policy-ab-*.json",
      "docs/Benchmark results/policy-ab-*.csv",
    ],
    defaultVisible: false,
    color: "#f59e0b",
    series: [
      { seriesId: "baseline_ms", label: "Baseline Encode", key: "baseline_ms", defaultOn: false },
      { seriesId: "viewer_ms", label: "Viewer Encode", key: "viewer_ms", defaultOn: false },
    ],
  },
];
```

- [ ] **Step 2: Export helper lookup functions**

```js
export function getFamilyById(familyId) {
  return BENCHMARK_FAMILIES.find((family) => family.familyId === familyId) ?? null;
}

export function getVisibleSeries(family) {
  return family.series.filter((series) => series.defaultOn);
}
```

- [ ] **Step 3: Run a syntax check**

Run: `rtk proxy node --check .\benchmark\benchmark-history-registry.mjs`
Expected: no syntax errors

### Task 2: Convert legacy benchmark artifacts into canonical `.toon`

**Files:**
- Create: `benchmark/benchmark-history-conversion.mjs`
- Create: `benchmark/benchmark-history-conversion.test.mjs`

- [ ] **Step 1: Write one converter example for policy A/B JSON**

```js
export function convertPolicyAbJsonToToon(jsonText, fileName) {
  const data = JSON.parse(jsonText);
  const lines = [];
  lines.push(`TestName: policy-ab`);
  lines.push(`RunTimestamp: ${data.exportedAt}`);
  lines.push(`SourceFile: ${fileName}`);
  lines.push(``);
  lines.push(`---`);
  lines.push(`rows[${data.rows.length}]{file|baseline_ms|viewer_ms|baseline_bytes|viewer_bytes}:`);
  for (const row of data.rows) {
    lines.push(`  ${row.file},${row.baseline_ms},${row.viewer_ms},${row.baseline_bytes},${row.viewer_bytes}`);
  }
  lines.push(``);
  lines.push(`# Aggregates`);
  lines.push(`mean_ms_delta_pct: ${data.mean_ms_delta_pct}`);
  lines.push(`mean_size_delta_pct: ${data.mean_size_delta_pct}`);
  return lines.join("\n") + "\n";
}
```

- [ ] **Step 2: Add a legacy-file discovery function**

```js
export function discoverLegacyBenchmarkFiles(rootDir) {
  return [
    ...discoverJsonFiles(rootDir),
    ...discoverCsvFiles(rootDir),
    ...discoverMarkdownFiles(rootDir),
  ];
}
```

- [ ] **Step 3: Add a backup-move helper**

```js
export function backupLegacyBenchmarkFile(filePath, backupDir) {
  const target = join(backupDir, basename(filePath));
  mkdirSync(backupDir, { recursive: true });
  renameSync(filePath, target);
  return target;
}
```

- [ ] **Step 4: Add focused tests**

```js
import assert from "node:assert/strict";
import { convertPolicyAbJsonToToon } from "./benchmark-history-conversion.mjs";

assert.match(
  convertPolicyAbJsonToToon(
    JSON.stringify({ exportedAt: "2026-06-02T02:22:18.000Z", rows: [] }),
    "policy-ab-2026-06-02T02-22-18.json",
  ),
  /TestName:\s*policy-ab/,
);
```

- [ ] **Step 5: Run the new tests**

Run:

```powershell
rtk proxy bun test benchmark/benchmark-history-conversion.test.mjs
```

Expected: pass

### Task 3: Expand the graph normalizer for family overlays

**Files:**
- Modify: `benchmark/standard-multifile-history-graph.mjs`
- Modify: `benchmark/standard-multifile-history-graph.test.mjs`

- [ ] **Step 1: Add a normalized series shape**

```js
{
  familyId: "policy-ab",
  familyLabel: "Policy A/B",
  seriesId: "viewer_ms",
  seriesLabel: "Viewer Encode",
  timestampMs: 1781293172277,
  timestampIso: "2026-06-13T04:58:10.079Z",
  valueMs: 123,
  color: "#f59e0b",
  visibleByDefault: false,
}
```

- [ ] **Step 2: Add adapters for at least these families**

```js
const adapters = [
  adaptStandardMultifileToSeries,
  adaptPolicyAbToSeries,
  adaptProgressiveTimingToSeries,
  adaptP3FeaturesToSeries,
  adaptSessionWorkerTimingsToSeries,
  adaptTargetedWasmTimingsToSeries,
];
```

- [ ] **Step 3: Keep unknown or zero-only series out of the graph**

```js
function shouldKeepSeries(series, runs) {
  return runs.some((run) => Number.isFinite(run.valueMs) && run.valueMs !== 0);
}
```

- [ ] **Step 4: Add tests for hidden-by-default overlays**

```js
import assert from "node:assert/strict";
import { buildGraphHistory } from "./standard-multifile-history-graph.mjs";

const model = buildGraphHistory([
  { path: "docs/outputs/timing tests/one.toon", text: "TestName: StandardMultifileTest\nRunTimestamp: 2026-06-13T04:58:10.079Z\nAvgRawMs: 10\n" },
  { path: "docs/Benchmark results/policy-ab-2026-06-02T02-22-18.json", text: "{\"exportedAt\":\"2026-06-02T02:22:18.000Z\",\"rows\":[]}" },
]);

assert.ok(model.series.some((series) => series.familyId === "standard-multifile"));
```

- [ ] **Step 5: Run graph tests**

Run:

```powershell
rtk proxy bun test benchmark/standard-multifile-history-graph.test.mjs
```

Expected: pass

### Task 4: Wire the consolidation step into `StandardMultifileTest.mjs`

**Files:**
- Modify: `StandardMultifileTest.mjs`

- [ ] **Step 1: Add the consolidation import**

```js
import { consolidateBenchmarkHistory } from "./benchmark/benchmark-history-conversion.mjs";
```

- [ ] **Step 2: Invoke consolidation after the benchmark writes its `.toon`**

```js
await consolidateBenchmarkHistory({
  timingDir: String.raw`C:\Foo\raw-converter-wasm\docs\outputs\timing tests`,
  legacyDirs: [String.raw`C:\Foo\raw-converter-wasm\docs\Benchmark results`],
  backupDirName: "backup",
});
```

- [ ] **Step 3: Keep the auto-open graph behavior unchanged**

```js
if (process.env.STANDARD_MULTIFILE_OPEN_GRAPH !== "0") {
  await openGraphHtml(graphHtmlPath);
}
```

- [ ] **Step 4: Syntax check the benchmark entrypoint**

Run: `rtk proxy node --check .\StandardMultifileTest.mjs`
Expected: no syntax errors

### Task 5: Rebuild the aggregate history graph against canonical `.toon` only

**Files:**
- Modify: `benchmark/standard-multifile-history-graph.mjs`
- Modify: `StandardMultifileTest.mjs`

- [ ] **Step 1: Make the renderer read only normalized `.toon` history**

```js
const sources = collectToonHistoryFiles(timingDir);
const model = buildGraphHistory(sources);
```

- [ ] **Step 2: Keep family toggles and colors in the sidebar**

```js
const defaultGroups = model.families.map((family) => ({
  familyId: family.familyId,
  label: family.label,
  visible: family.defaultVisible,
}));
```

- [ ] **Step 3: Render family overlays and preserve heat coloring**

```js
drawFamilyOverlay(series, { dashed: !series.visibleByDefault });
drawMetricHeatBands(runs);
```

- [ ] **Step 4: Rebuild the generated HTML and verify it opens**

Run:

```powershell
node .\StandardMultifileTest.mjs
```

Expected:
- benchmark completes
- legacy files moved into `docs/outputs/timing tests/backup`
- `GraphAggregateResults.html` is regenerated
- graph opens manually via browser file association if shell launch is disabled

### Task 6: Add migration regression coverage

**Files:**
- Create: `benchmark/benchmark-history-conversion.test.mjs`
- Modify: `benchmark/standard-multifile-history-graph.test.mjs`

- [ ] **Step 1: Assert that old files move into backup, not deletion**

```js
assert.equal(existsSync(join(backupDir, basename(originalPath))), true);
assert.equal(existsSync(originalPath), false);
```

- [ ] **Step 2: Assert that canonical `.toon` files still parse**

```js
assert.ok(model.runs.length > 0);
assert.ok(model.families.length > 0);
```

- [ ] **Step 3: Run the full benchmark-history test suite**

Run:

```powershell
rtk proxy bun test benchmark/benchmark-history-conversion.test.mjs benchmark/standard-multifile-history-graph.test.mjs
```

Expected: both suites pass

## Self-Review

- Coverage: registry, legacy conversion, backup migration, graph overlay support, and benchmark wiring are all covered.
- Placeholder scan: no `TBD` / `TODO` / vague implementation steps remain.
- Type consistency: `familyId`, `seriesId`, `valueMs`, `timestampMs`, and `defaultVisible` are used consistently across tasks.
- Scope check: this is one migration plus one graph expansion, still small enough for a single implementation plan.

