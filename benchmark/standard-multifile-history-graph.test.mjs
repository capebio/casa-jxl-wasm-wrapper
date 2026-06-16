import test from "node:test";
import assert from "node:assert/strict";

import {
  GRAPH_METRICS,
  buildGraphHistory,
  buildGraphAggregateHtml,
  parseGraphRunText,
} from "./standard-multifile-history-graph.mjs";
import { familyPrimaryMetricKey } from "./benchmark-history-registry.mjs";

const RUN_A = `TestName: StandardMultifileTest - general
RunTimestamp: 2026-06-09T14:34:51.021Z
CpuActiveLoadPct: 44
CpuClockCurrentGhz: 2.20
CpuClockMaxGhz: 2.71
CpuThrottlingPct: 81.0
SystemMemoryFreeGb: 31.2
MonolithicRoi_512_512_Ms: 366
RealJxtcTiledRoi_512_512_Ms: 120
AvgRawMs: 3566
AvgProgEncMtMs: 568
AvgShotEncMtMs: 237
AvgProgFirstMtMs: 110
AvgProgFinalMtMs: 264
AvgShotDecMtMs: 185
AvgPyrEncMtMs: 0
MultiWorkerParallelWallMs: 8494
EncCoreCompressMs: 91.55
`;

const RUN_B = `TestName: StandardMultifileTest - general
RunTimestamp: 2026-06-12T19:39:32.277Z
CpuActiveLoadPct: 14
CpuClockCurrentGhz: 2.71
CpuClockMaxGhz: 2.71
CpuThrottlingPct: 100.0
SystemMemoryFreeGb: 46.5
MonolithicRoi_512_512_Ms: 272
RealJxtcTiledRoi_512_512_Ms: 67
AvgRawMs: 711
AvgProgEncMtMs: 126
AvgShotEncMtMs: 62
AvgProgFirstMtMs: 30
AvgProgFinalMtMs: 79
AvgShotDecMtMs: 55
AvgPyrEncMtMs: 0
MultiWorkerParallelWallMs: 1838
EncCoreCompressMs: N/A
`;

test("parseGraphRunText extracts curated metrics, telemetry, and timestamp", () => {
  const run = parseGraphRunText(RUN_A, "2026-06-09T14-34-51-021Z-StandardMultifileTest-general.toon");
  assert.equal(run.timestampIso, "2026-06-09T14:34:51.021Z");
  assert.equal(run.fileName, "2026-06-09T14-34-51-021Z-StandardMultifileTest-general.toon");
  assert.equal(run.metrics.AvgRawMs, 3566);
  assert.equal(run.metrics.MonolithicRoi_512_512_Ms, 366);
  assert.equal(run.telemetry.CpuActiveLoadPct, 44);
  assert.equal(run.telemetry.CpuThrottlingPct, 81);
  assert.ok(run.heatScore > 0);
});

test("parseGraphRunText handles pipe-separated metric pairs", () => {
  const run = parseGraphRunText(
    `TestName: StandardMultifileTest - general\nRunTimestamp: 2026-06-12T19:39:32.277Z\nAvgProgEncSimdMs: 568 | AvgProgEncMtMs: 126\nAvgShotEncSimdMs: 237 | AvgShotEncMtMs: 62\n`,
    "2026-06-12T19-39-32-277Z-StandardMultifileTest-general.toon",
  );

  assert.equal(run.metrics.AvgProgEncMtMs, 126);
  assert.equal(run.metrics.AvgShotEncMtMs, 62);
});

test("parseGraphRunText ignores non-timing numeric fields", () => {
  const run = parseGraphRunText(
    `TestName: Example\nRunTimestamp: 2026-06-12T19:39:32.277Z\niter: 9 | passes: 3 | Target: 1920\nexample.primaryMs: 42\n`,
    "example.toon",
  );

  assert.equal(run.metrics.iter, undefined);
  assert.equal(run.metrics.passes, undefined);
  assert.equal(run.metrics.Target, undefined);
  assert.equal(run.metrics.example?.primaryMs, undefined);
  assert.equal(run.metrics["example.primaryMs"], 42);
});

test("parseGraphRunText handles legacy totals and table rows", () => {
  const run = parseGraphRunText(
    `TestName: Progressive vs 1-shot\nRunTimestamp: 2026-06-06T02:27:55.064Z\nFamilyId: progressive-vs-oneshot\nFamilyLabel: Progressive vs 1-shot\nTotalEncode: 8201ms\nTotalDecodeFirstPaint: 3497ms\nTotalDecodeFinal: 10269ms\n`,
    "progressive-vs-oneshot.toon",
  );

  assert.equal(run.metrics["progressive-vs-oneshot.totalEncodeMs"], 8201);
  assert.equal(run.metrics["progressive-vs-oneshot.totalDecodeFirstPaintMs"], 3497);
  assert.equal(run.metrics["progressive-vs-oneshot.totalDecodeFinalMs"], 10269);
});

test("parseGraphRunText parses table rows into timing metrics", () => {
  const run = parseGraphRunText(
    `TestName: Policy Matrix Sweep (Test_6)\nRunTimestamp: 2026-06-06T04:50:31.920Z\nFamilyId: policy-matrix\nFamilyLabel: Policy Matrix\nruns[1]{t|file|raw_ms|rgba_ms|encode_ms|size}:\n  50:24.175 | _MG_1744.CR2 | 3480.855 | 205.148 | 408.112 | 102363B\n`,
    "policy-matrix.toon",
  );

  assert.equal(run.metrics["policy-matrix.rawMs"], 3480.855);
  assert.equal(run.metrics["policy-matrix.rgbaMs"], 205.148);
  assert.equal(run.metrics["policy-matrix.encodeMs"], 408.112);
});

test("buildGraphHistory sorts runs and drops metrics that are zero or absent across history", () => {
  const model = buildGraphHistory([
    { path: "b.toon", text: RUN_B },
    { path: "a.toon", text: RUN_A },
  ]);
  assert.deepEqual(
    model.runs.map((run) => run.timestampIso),
    ["2026-06-09T14:34:51.021Z", "2026-06-12T19:39:32.277Z"],
  );
  assert.ok(model.activeMetrics.some((metric) => metric.key === "AvgShotEncMtMs"));
  assert.ok(!model.activeMetrics.some((metric) => metric.key === "AvgPyrEncMtMs"));
  assert.equal(model.summary.latest.fileName, "b.toon");
});

test("buildGraphAggregateHtml emits embedded data and control labels", () => {
  const model = buildGraphHistory([
    { path: "a.toon", text: RUN_A },
    { path: "b.toon", text: RUN_B },
  ]);
  const html = buildGraphAggregateHtml(model, { launchBadge: "Launch 1 - Direct browser spawn" });
  assert.match(html, /JXL Wrapper Benchmark/);
  assert.match(html, /id="graph-data"/);
  assert.match(html, /RAW Decode/);
  assert.match(html, /history-chart/);
  assert.match(html, /CpuActiveLoadPct/);
  assert.match(html, /mixColors/);
  assert.match(html, /bandHeatColor/);
  assert.match(html, /Launch 1/);
});

test("GRAPH_METRICS keeps the curated defaults user asked for", () => {
  const keys = GRAPH_METRICS.map((metric) => metric.key);
  assert.ok(keys.includes("AvgProgEncMtMs"));
  assert.ok(keys.includes("AvgShotEncMtMs"));
  assert.ok(keys.includes("EncCoreCompressMs"));
});

test("parseGraphRunText aliases family primary timing fields", () => {
  const run = parseGraphRunText(
    `TestName: Policy A/B\nRunTimestamp: 2026-06-02T02:22:18.000Z\nFamilyId: policy-ab\nFamilyLabel: Policy A/B\nviewer_ms: 123.5\nbaseline_ms: 150.0\n`,
    "policy-ab-2026-06-02T02-22-18.json.toon",
  );

  assert.equal(run.familyId, "policy-ab");
  assert.equal(run.familyLabel, "Policy A/B");
  assert.equal(run.metrics[familyPrimaryMetricKey("policy-ab")], 123.5);
});

test("buildGraphHistory adds family overlay metrics for non-standard runs", () => {
  const model = buildGraphHistory([
    { path: "a.toon", text: RUN_A },
    { path: "policy-ab-2026-06-13T02-22-18.json.toon", text: `TestName: Policy A/B\nRunTimestamp: 2026-06-13T02:22:18.000Z\nFamilyId: policy-ab\nFamilyLabel: Policy A/B\npolicy-ab.viewer_ms: 123.5\npolicy-ab.baseline_ms: 150.0\n` },
  ]);

  assert.ok(model.activeMetrics.some((metric) => metric.key === familyPrimaryMetricKey("policy-ab")));
  assert.ok(model.activeMetrics.some((metric) => metric.key === "policy-ab.viewerMs"));
  assert.ok(model.activeMetrics.some((metric) => metric.key === "policy-ab.baselineMs"));
  const overlayMetric = model.activeMetrics.find((metric) => metric.key === "policy-ab.viewerMs");
  assert.match(overlayMetric.color, /^#[0-9a-f]{6}$/i);
  assert.equal(model.summary.latest.familyId, "policy-ab");
});
