import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  consolidateBenchmarkHistory,
  convertLegacyBenchmarkArtifactToToon,
} from "./benchmark-history-conversion.mjs";
import { familyPrimaryMetricKey } from "./benchmark-history-registry.mjs";

test("convertLegacyBenchmarkArtifactToToon converts policy-ab JSON into canonical toon", () => {
  const dir = join(tmpdir(), `bench-history-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const source = join(dir, "policy-ab-2026-06-02T02-22-18.json");
  writeFileSync(source, JSON.stringify({
    exportedAt: "2026-06-02T02:22:18.000Z",
    rows: [
      { file: "a", baseline_ms: 10, viewer_ms: 8 },
      { file: "b", baseline_ms: 14, viewer_ms: 12 },
    ],
  }, null, 2), "utf8");

  const artifact = convertLegacyBenchmarkArtifactToToon(source);
  assert.ok(artifact);
  assert.equal(artifact.familyId, "policy-ab");
  assert.equal(artifact.primaryKey, familyPrimaryMetricKey("policy-ab"));
  assert.match(artifact.toonText, /FamilyId:\s*policy-ab/);
  assert.match(artifact.toonText, /policy-ab\.primaryMs:\s*10/);
  assert.match(artifact.toonText, /policy-ab\.baseline_ms:\s*12/);
  rmSync(dir, { recursive: true, force: true });
});

test("convertLegacyBenchmarkArtifactToToon uses file mtime for legacy csv without embedded timestamp", () => {
  const dir = join(tmpdir(), `bench-history-mtime-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const source = join(dir, "policy-matrix.csv");
  writeFileSync(source, `effort,quality,lossless,progressive,modular,resampling,encodeMs,bytes,status\n3,85,0,0,0,1,123.4,456,ok\n`, "utf8");
  const stamp = new Date("2026-06-02T06:01:28.000Z");
  utimesSync(source, stamp, stamp);

  const artifact = convertLegacyBenchmarkArtifactToToon(source);
  assert.ok(artifact);
  assert.match(artifact.toonText, /RunTimestamp:\s*2026-06-02T06:01:28\.000Z/);

  rmSync(dir, { recursive: true, force: true });
});

test("convertLegacyBenchmarkArtifactToToon parses policy matrix filename timestamps without millis", () => {
  const dir = join(tmpdir(), `bench-history-filename-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const source = join(dir, "policy-matrix-2026-06-02T06-01-28.csv");
  writeFileSync(source, `effort,quality,lossless,progressive,modular,resampling,encodeMs,bytes,status\n3,85,0,0,0,1,123.4,456,ok\n`, "utf8");

  const artifact = convertLegacyBenchmarkArtifactToToon(source);
  assert.ok(artifact);
  assert.match(artifact.toonText, /RunTimestamp:\s*2026-06-02T06:01:28\.000Z/);

  rmSync(dir, { recursive: true, force: true });
});

test("convertLegacyBenchmarkArtifactToToon converts structured benchmark logs into canonical toon", () => {
  const dir = join(tmpdir(), `bench-history-log-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const source = join(dir, "after-saliency-p7-ai.log");
  writeFileSync(source, `=========================================
RUNNING STANDARDIZED SPEEDTEST
   Batch Name: saliency-p7-ai
   Timestamp:  2026-06-08T20:13:27.860Z
=========================================

=========================================
TOON RESULTS
=========================================
TestName: StandardMultifileTest - saliency-p7-ai
RunTimestamp: 2026-06-08T20:13:27.860Z
AvgRawMs: 1998
AvgProgEncSimdMs: 580 | AvgProgEncMtMs: 299
MultiWorkerParallelWallMs: 6042
`, "utf8");

  const artifact = convertLegacyBenchmarkArtifactToToon(source);
  assert.ok(artifact);
  assert.equal(artifact.familyId, "standard-multifile");
  assert.match(artifact.toonText, /RunTimestamp:\s*2026-06-08T20:13:27.860Z/);
  assert.match(artifact.toonText, /AvgProgEncMtMs:\s*299/);
  assert.match(artifact.toonText, /MultiWorkerParallelWallMs:\s*6042/);
  rmSync(dir, { recursive: true, force: true });
});

test("consolidateBenchmarkHistory writes toon and backs up raw legacy artifacts", () => {
  const root = join(tmpdir(), `bench-history-consolidate-${Date.now()}`);
  const legacyDir = join(root, "legacy");
  const timingDir = join(root, "timing");
  mkdirSync(legacyDir, { recursive: true });
  mkdirSync(timingDir, { recursive: true });

  const source = join(legacyDir, "policy-ab-2026-06-02T02-22-18.json");
  writeFileSync(source, JSON.stringify({
    exportedAt: "2026-06-02T02:22:18.000Z",
    rows: [
      { file: "a", baseline_ms: 10, viewer_ms: 8 },
      { file: "b", baseline_ms: 14, viewer_ms: 12 },
    ],
  }, null, 2), "utf8");

  const result = consolidateBenchmarkHistory({
    timingDir,
    legacyRoots: [legacyDir],
    backupDirName: "backup",
  });

  const toonPath = join(timingDir, "policy-ab-2026-06-02T02-22-18.toon");
  const backupPath = join(timingDir, "backup", "policy-ab-2026-06-02T02-22-18.json");
  assert.ok(existsSync(toonPath));
  assert.ok(existsSync(backupPath));
  assert.equal(existsSync(source), false);
  assert.ok(result.toonFiles.some((file) => file === toonPath));
  assert.match(readFileSync(toonPath, "utf8"), /policy-ab\.primaryMs/);

  rmSync(root, { recursive: true, force: true });
});

test("consolidateBenchmarkHistory imports structured benchmark logs", () => {
  const root = join(tmpdir(), `bench-history-log-consolidate-${Date.now()}`);
  const legacyDir = join(root, "legacy");
  const timingDir = join(root, "timing");
  mkdirSync(legacyDir, { recursive: true });
  mkdirSync(timingDir, { recursive: true });

  const source = join(legacyDir, "after-saliency-p7-ai.log");
  writeFileSync(source, `=========================================
RUNNING STANDARDIZED SPEEDTEST
   Batch Name: saliency-p7-ai
   Timestamp:  2026-06-08T20:13:27.860Z
=========================================

=========================================
TOON RESULTS
=========================================
TestName: StandardMultifileTest - saliency-p7-ai
RunTimestamp: 2026-06-08T20:13:27.860Z
AvgRawMs: 1998
AvgProgEncSimdMs: 580 | AvgProgEncMtMs: 299
MultiWorkerParallelWallMs: 6042
`, "utf8");

  const result = consolidateBenchmarkHistory({
    timingDir,
    legacyRoots: [legacyDir],
    backupDirName: "backup",
  });

  const toonPath = join(timingDir, "after-saliency-p7-ai.toon");
  const backupPath = join(timingDir, "backup", "after-saliency-p7-ai.log");
  assert.ok(existsSync(toonPath));
  assert.ok(existsSync(backupPath));
  assert.equal(existsSync(source), false);
  assert.ok(result.toonFiles.some((file) => file === toonPath));
  assert.match(readFileSync(toonPath, "utf8"), /AvgProgEncMtMs:\s*299/);

  rmSync(root, { recursive: true, force: true });
});

test("consolidateBenchmarkHistory can copy structured benchmark logs without unlinking source", () => {
  const root = join(tmpdir(), `bench-history-log-copy-${Date.now()}`);
  const timingDir = join(root, "timing");
  const sourceDir = join(root, "sources");
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(timingDir, { recursive: true });

  const source = join(sourceDir, "after-saliency-p7-ai.log");
  writeFileSync(source, `=========================================
RUNNING STANDARDIZED SPEEDTEST
   Batch Name: saliency-p7-ai
   Timestamp:  2026-06-08T20:13:27.860Z
=========================================

=========================================
TOON RESULTS
=========================================
TestName: StandardMultifileTest - saliency-p7-ai
RunTimestamp: 2026-06-08T20:13:27.860Z
AvgRawMs: 1998
AvgProgEncSimdMs: 580 | AvgProgEncMtMs: 299
MultiWorkerParallelWallMs: 6042
`, "utf8");

  const result = consolidateBenchmarkHistory({
    timingDir,
    legacyRoots: [],
    legacyCopies: [source],
    backupDirName: "backup",
  });

  const toonPath = join(timingDir, "after-saliency-p7-ai.toon");
  const backupPath = join(timingDir, "backup", "after-saliency-p7-ai.log");
  assert.ok(existsSync(toonPath));
  assert.ok(existsSync(backupPath));
  assert.ok(existsSync(source));
  assert.ok(result.toonFiles.some((file) => file === toonPath));

  rmSync(root, { recursive: true, force: true });
});
