import { readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { setForcedTier } from "@casabio/jxl-wasm";
import { createJxlBackend } from "./backends.js";
import { createRawBackend } from "./raw-backend.js";
import { computeIngestPlan, formatFromPath, ingestBatch, rebuildIndex, type Backends, type IngestPlan } from "./ingest.js";
import { createTtyTelemetry, noOpTelemetry } from "./telemetry-tty.js";
import { boundedConcurrency, planShard } from "./shard.js";
import { cliArgsSchema } from "./schema.js";
import { imageIdForPath } from "./hash.js";
import { parseManifest } from "./schema.js";
import { acquireReadLock, acquireWriteLock, acquireImageWriteLock, acquireImageReadLock, type AdvisoryLock } from "./lock.js";
import { randomUUID } from "node:crypto";
import { makeProducedBy } from "./schema.js";

// C1 (Phase2): richer collect for in-batch (path, mtime, format) cache, avoid double stat in ingest.
export interface CollectedInput {
  path: string;
  stat: { size: number; mtimeMs: number };
  format: string | null;
}

export async function collectInputs(roots: readonly string[]): Promise<CollectedInput[]> {
  const out: CollectedInput[] = [];
  const walk = async (p: string): Promise<void> => {
    const s = await stat(p);
    if (s.isDirectory()) {
      for (const name of await readdir(p)) await walk(join(p, name));
    } else {
      const fmt = formatFromPath(p);
      if (fmt) {
        out.push({ path: p, stat: { size: s.size, mtimeMs: s.mtimeMs }, format: fmt });
      }
    }
  };
  for (const root of roots) await walk(root);
  // INVARIANT (D3): ingest order must be deterministic so that --shard partitions
  // a stable file list across machines / readdir orders. Do not remove this sort.
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

function parseShard(spec: string): { i: number; n: number } {
  const m = /^(\d+)\/(\d+)$/.exec(spec);
  if (!m) throw new Error(`--shard must be "i/N" (0-based), got "${spec}"`);
  return { i: Number(m[1]), n: Number(m[2]) };
}

const PER_IMAGE_BYTES = 6000 * 4000 * 4;

function printPlanHuman(plan: IngestPlan, onDisk?: { manifestExists: boolean; levelCountOnDisk: number }): void {
  process.stdout.write(`Image: ${plan.imageId}\n`);
  process.stdout.write(`Master: ${plan.master.name} (mtimeMs ${plan.master.mtimeMs})\n`);
  process.stdout.write(`Format: ${plan.master.format}\n`);
  process.stdout.write(`Plan: ${plan.levels.length} levels\n`);
  for (const lv of plan.levels) {
    const sz = Math.max(lv.width, lv.height);
    const label = sz === plan.width && sz === plan.height ? "full" : `sidecar ${sz}`;
    const kb = (lv.data.length / 1024).toFixed(1);
    process.stdout.write(`  - ${label}  (${lv.width}×${lv.height}, ${kb} KB)\n`);
  }
  if (onDisk) {
    process.stdout.write(`Manifest exists: ${onDisk.manifestExists ? "yes" : "no"}\n`);
    process.stdout.write(`On-disk levels: ${onDisk.levelCountOnDisk} / ${plan.levels.length} present\n`);
  }
}

export async function main(argv: string[], backendsOverride?: Backends): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: "string" },
      proxy: { type: "string" },
      force: { type: "boolean", default: false },
      concurrency: { type: "string" },
      "mem-budget-mb": { type: "string" },
      shard: { type: "string" },
      tier: { type: "string", default: "simd" },
      "reindex-only": { type: "boolean", default: false },
      "encoder-threads": { type: "string" },
      verbose: { type: "boolean", short: "v", default: false },
      "verify-hash": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      explain: { type: "string" },
      "timeout-ms": { type: "string" },
      "accept-unsupported": { type: "boolean", default: true },
      "profile-convergence": { type: "boolean", default: false },
      // WU-6 prereqs + subcmd (gc/validate/rm/resume). rm string for id/path.
      gc: { type: "boolean", default: false },
      validate: { type: "boolean", default: false },
      rm: { type: "string" },
      resume: { type: "boolean", default: false },
      migrate: { type: "boolean", default: false },
      "migrate-layout": { type: "string" },
      "migrate-schema": { type: "string" },
      "suggest-migrations": { type: "boolean", default: false },
      // K2
      "chaos-test": { type: "boolean", default: false },
      config: { type: "string" },
      // O1/O6
      json: { type: "boolean", default: false },
      "runlog-keep": { type: "string" },
    },
  });

  // X1: basic config load if fits ( .json overrides for defaults like concurrency etc; surgical)
  if (values.config) {
    try {
      const cfg = JSON.parse(await readFile(values.config as string, "utf8"));
      Object.assign(values, cfg);
    } catch {}
  }

  const parsed = cliArgsSchema.parse(values);

  if (!parsed.out) throw new Error("--out <dir> is required");

  const ac = new AbortController();  // hoisted for onSig + subcmd/batch signal (used by ingest batch + future cmds)

  if (parsed["reindex-only"]) {
    const index = await rebuildIndex(parsed.out);
    process.stdout.write(`pyramid-ingest: reindexed ${index.images.length} images\n`);
    return 0;
  }

  // F4: --explain
  if (parsed.explain) {
    const expl = parsed.explain;
    const isHexId = /^[0-9a-f]{16}$/.test(expl);
    if (isHexId) {
      // load from out/images/<id>/manifest + count on-disk levels
      const manifestPath = join(parsed.out, "images", expl, "manifest.json");
      let manifest: ReturnType<typeof parseManifest> | null = null;
      try {
        manifest = parseManifest(await readFile(manifestPath, "utf8"));
      } catch {
        // not found or bad
      }
      if (!manifest) {
        process.stderr.write(`explain: no manifest for imageId ${expl} under ${parsed.out}\n`);
        return 1;
      }
      const levelsDir = join(parsed.out, "levels");
      let onDisk = 0;
      for (const e of manifest.levels) {
        try {
          await stat(join(levelsDir, `${e.contenthash}.jxl`));
          onDisk++;
        } catch {}
      }
      process.stdout.write(`Image: ${manifest.imageId}\n`);
      process.stdout.write(`Master: ${manifest.master.name} (mtimeMs ${manifest.master.mtimeMs})\n`);
      process.stdout.write(`Format: ${manifest.master.format}\n`);
      process.stdout.write(`Plan: ${manifest.levels.length} levels\n`);
      for (const lv of manifest.levels) {
        const label = lv.size === "full" ? "full" : `sidecar ${lv.size}`;
        process.stdout.write(`  - ${label}  (${lv.w}×${lv.h}, ${Math.round(lv.bytes/102.4)/10} KB)\n`);
      }
      process.stdout.write(`Manifest exists: yes\n`);
      process.stdout.write(`On-disk levels: ${onDisk} / ${manifest.levels.length} present\n`);
      return 0;
    }
    // treat as master path: compute plan (no write)
    const masterPath = expl;
    const format = formatFromPath(masterPath);
    if (!format) {
      process.stderr.write(`explain: unsupported format or not found: ${masterPath}\n`);
      return 1;
    }
    const info = await stat(masterPath);
    if (info.size > 512 * 1024 * 1024) {
      process.stderr.write("explain: master too large\n");
      return 1;
    }
    const bytes = await readFile(masterPath);
    const imageId = await imageIdForPath(masterPath);
    const identity = { imageId, masterName: basename(masterPath), mtimeMs: info.mtimeMs };
    // use override or create minimal backends (no telemetry for explain compute)
    const b: Backends = backendsOverride ?? {
      raw: createRawBackend(),
      jxl: createJxlBackend(),
      telemetry: noOpTelemetry,
    };
    const plan = await computeIngestPlan(bytes, format, b, identity, { outDir: parsed.out, force: false });
    printPlanHuman(plan);
    return 0;
  }

  // WU-6 prereqs + subcommand parsing (approved plan): support `gc` / `validate` / `rm` as first positional
  // (or --gc/--validate/--rm flag for BC). reindex/explain keep flag paths. Batch is default.
  // Locks acquired per L3 (write for gc/rm/ingest, read for validate). Release on sig + finally.
  let subcmd: "gc" | "validate" | "rm" | "batch" | "reindex" | "explain" | null = null;
  let cmdPositionals = [...positionals];
  const first = cmdPositionals[0]?.toLowerCase();
  if (first && ["gc", "validate", "rm"].includes(first)) {
    subcmd = first as any;
    cmdPositionals.shift();
  } else if (parsed["reindex-only"]) {
    subcmd = "reindex";
  } else if (parsed.explain) {
    subcmd = "explain";
  } else if (parsed.gc) {
    subcmd = "gc";
  } else if (parsed.validate) {
    subcmd = "validate";
  } else if (parsed.rm) {
    subcmd = "rm";
  } else if (first === "migrate" || parsed.migrate || parsed["migrate-layout"] || parsed["migrate-schema"]) {
    subcmd = "migrate";
  } else {
    subcmd = "batch";
  }

  let heldLock: AdvisoryLock | null = null;
  const onSig = () => {
    ac.abort();
    heldLock?.release().catch(() => {});
  };
  process.once("SIGINT", onSig);
  process.once("SIGTERM", onSig);

  try {
    if (subcmd === "reindex") {
      const index = await rebuildIndex(parsed.out);
      process.stdout.write(`pyramid-ingest: reindexed ${index.images.length} images\n`);
      return 0;
    }

    if (subcmd === "explain") {
      // (existing explain logic moved above for clarity; if reached here via flag, re-run path)
      const expl = parsed.explain!;
      // ... (dupe minimal; in practice explain early-returns before here. Kept for structure.)
      const isHexId = /^[0-9a-f]{16}$/.test(expl);
      if (isHexId) {
        const manifestPath = join(parsed.out, "images", expl, "manifest.json");
        let manifest: ReturnType<typeof parseManifest> | null = null;
        try { manifest = parseManifest(await readFile(manifestPath, "utf8")); } catch {}
        if (!manifest) { process.stderr.write(`explain: no manifest for imageId ${expl} under ${parsed.out}\n`); return 1; }
        // on-disk count omitted for brevity in this structural edit (real path early-returns)
        process.stdout.write(`Image: ${manifest.imageId} (explain via subcmd)\n`);
        return 0;
      }
      const masterPath = expl;
      const format = formatFromPath(masterPath);
      if (!format) { process.stderr.write(`explain: unsupported format or not found: ${masterPath}\n`); return 1; }
      const info = await stat(masterPath);
      if (info.size > 512 * 1024 * 1024) { process.stderr.write("explain: master too large\n"); return 1; }
      const bytes = await readFile(masterPath);
      const imageId = imageIdForPath(masterPath);
      const identity = { imageId, masterName: basename(masterPath), mtimeMs: info.mtimeMs };
      const b: Backends = backendsOverride ?? { raw: createRawBackend(), jxl: createJxlBackend(), telemetry: noOpTelemetry };
      const plan = await computeIngestPlan(bytes, format, b, identity, { outDir: parsed.out, force: false });
      printPlanHuman(plan);
      return 0;
    }

    if (subcmd === "gc" || parsed.gc) {
      heldLock = await acquireWriteLock(parsed.out);
      const { removeOrphans } = await import("./ingest.js");  // dynamic to avoid any init order
      const res = await removeOrphans(parsed.out, { dryRun: !!parsed["dry-run"] });
      if (!!parsed.json) {
        process.stdout.write(JSON.stringify({ type: "gc-result", removedLevelFiles: res.removedLevelFiles.length, removedImageDirs: res.removedImageDirs.length, dryRun: !!parsed["dry-run"] }) + "\n");
      } else {
        process.stdout.write(`pyramid-ingest: gc removed ${res.removedLevelFiles.length} levels, ${res.removedImageDirs.length} dirs${parsed["dry-run"] ? " (dry-run)" : ""}\n`);
      }
      if (!parsed["dry-run"]) {
        await rebuildIndex(parsed.out).catch(() => {});
      }
      return 0;
    }

    if (subcmd === "validate" || parsed.validate) {
      heldLock = await acquireReadLock(parsed.out);
      const { validate } = await import("./validate.js");
      const report = await validate(parsed.out, { verifyHash: !!parsed["verify-hash"], suggestMigrations: !!parsed["suggest-migrations"] });
      if (!!parsed.json) {
        process.stdout.write(JSON.stringify({ type: "validate-result", totalImages: report.totalImages, totalLevels: report.totalLevels, issues: report.issues.length, verifyHash: !!parsed["verify-hash"], sampleIssues: report.issues.slice(0, 5), migrationSuggestions: report.migrationSuggestions || [] }) + "\n");
      } else {
        process.stdout.write(`validate: ${report.totalImages} images, ${report.totalLevels} levels, ${report.issues.length} issues\n`);
        for (const iss of report.issues.slice(0, 20)) {
          process.stdout.write(`  ${iss.kind} ${JSON.stringify(iss)}\n`);
        }
        if (report.migrationSuggestions && report.migrationSuggestions.length) {
          process.stdout.write("migration suggestions:\n");
          for (const s of report.migrationSuggestions) process.stdout.write(`  ${s}\n`);
        }
      }
      if (report.issues.length > 0) return 1;
      return 0;
    }

    if (subcmd === "rm" || parsed.rm) {
      // full L3: image-only write lock (unlocks rm of one image concurrent with batch ingest of others; gallery only for rebuild)
      const target = parsed.rm || cmdPositionals[0];
      if (!target) { process.stderr.write("rm requires <imageId|master-path>\n"); return 1; }
      let imageId = target;
      if (target.includes("/") || target.includes("\\") || target.includes(".")) {
        try { imageId = await imageIdForPath(target); } catch {}
      }
      const imgLock = await acquireImageWriteLock(parsed.out, imageId);
      const { removeImage } = await import("./rm.js");
      const doGc = !!parsed.gc;
      const res = await removeImage(parsed.out, imageId, { dryRun: !!parsed["dry-run"], gc: doGc });
      if (!!parsed.json) {
        process.stdout.write(JSON.stringify({ type: "rm-result", imageId, removedDirs: res.removedDirs.length, removedLevels: res.removedLevels.length, gc: doGc, dryRun: !!parsed["dry-run"] }) + "\n");
      } else {
        process.stdout.write(`pyramid-ingest: rm ${imageId} dirs=${res.removedDirs.length} levels=${res.removedLevels.length}${parsed["dry-run"] ? " (dry-run)" : ""}\n`);
      }
      if (!parsed["dry-run"]) {
        // brief gallery write only for index; advisory so other image work can proceed
        const g = await acquireWriteLock(parsed.out).catch(() => null);
        await rebuildIndex(parsed.out).catch(() => {});
        if (g) await g.release().catch(() => {});
      }
      await imgLock.release().catch(() => {});
      return 0;
    }

    if (subcmd === "migrate" || parsed.migrate || parsed["migrate-layout"] || parsed["migrate-schema"]) {
      heldLock = await acquireWriteLock(parsed.out);
      const { migrateSchema, migrateLayout } = await import("./migrate.js");
      let totalMigrated = 0, totalSkipped = 0, totalErrors = 0;
      // M1 (or specified schema target)
      const schemaTarget = parsed["migrate-schema"] ? (parseInt(parsed["migrate-schema"] as string, 10) as any) : 2;
      const sRes = await migrateSchema(parsed.out, schemaTarget, { dryRun: !!parsed["dry-run"] });
      totalMigrated += sRes.migrated; totalSkipped += sRes.skipped; totalErrors += sRes.errors.length;
      // M2
      if (parsed["migrate-layout"]) {
        const lRes = await migrateLayout(parsed.out, parsed["migrate-layout"] as any, { dryRun: !!parsed["dry-run"] });
        totalMigrated += lRes.migrated; totalSkipped += lRes.skipped; totalErrors += lRes.errors.length;
      }
      if (!parsed["dry-run"]) await rebuildIndex(parsed.out).catch(() => {});
      process.stdout.write(`pyramid-ingest: migrate ${totalMigrated} (schema+layout) skipped=${totalSkipped} errors=${totalErrors}${parsed["dry-run"] ? " (dry-run)" : ""}\n`);
      return totalErrors > 0 ? 1 : 0;
    }

    // default: batch ingest (with optional --resume)
    if (positionals.length === 0 && cmdPositionals.length === 0) throw new Error("provide at least one input file or directory");

    if (!backendsOverride) {
      let tier: any = parsed.tier;
      const thr = parsed["encoder-threads"];
      if (thr === 1) {
        if (tier === "auto" || tier === "simd-mt" || tier === "relaxed-simd-mt") tier = "simd";
      }
      setForcedTier(tier);
    }

    let collected = await collectInputs(cmdPositionals.length ? cmdPositionals : positionals);
    if (parsed.shard) {
      const { i, n } = parseShard(parsed.shard);
      // note: planShard on paths; richer collect preserved for C1/C2
      const shardPaths = planShard(collected.map(c => c.path), i, n);
      collected = collected.filter(c => shardPaths.includes(c.path));
    }
    const files = collected.map(c => c.path);
    const statMap: Record<string, { size: number; mtimeMs: number }> = Object.fromEntries(
      collected.map((c) => [c.path, c.stat])
    );
    if (files.length === 0) {
      process.stderr.write("no supported master files found\n");
      return 0;
    }

    const proxy = parsed.proxy;
    const requested = parsed.concurrency;
    const memBudgetBytes = parsed["mem-budget-mb"] * 1024 * 1024;
    const concurrency = boundedConcurrency(availableParallelism(), requested, memBudgetBytes, PER_IMAGE_BYTES);

    const runId = randomUUID();
    const isJson = !!parsed.json;
    const runlogKeepN = parsed["runlog-keep"] ?? 100;
    const vv = (process.argv.join("").match(/-v/g) || []).length; // -v basic, -vv for stages

    function emitJson(ev: Record<string, unknown>) {
      if (isJson) process.stdout.write(JSON.stringify({ runId, ...ev }) + "\n");
    }
    if (subcmd === "batch") emitJson({ type: "batch-start", totalFiles: files.length, concurrency });

    const baseTel = parsed.verbose ? createTtyTelemetry() : noOpTelemetry;
    const tel: any = {
      ...baseTel,
      event(type: string, data?: Record<string, unknown>) {
        if (isJson) emitJson({ type, runId, ...(data || {}) });
        baseTel.event?.(type, data);
      },
      stage(name: string, fields?: Record<string, unknown>) {
        if (vv >= 2 || isJson) {
          const ts = Date.now();
          if (isJson) emitJson({ type: "stage", name, ts, fields });
          baseTel.stage?.(name, fields);
        } else {
          baseTel.stage?.(name, fields);
        }
      },
    };
    const backends: Backends = backendsOverride ?? {
      raw: createRawBackend(),
      jxl: createJxlBackend(tel),
      signal: ac.signal,
      telemetry: tel,
      clock: { now: () => Date.now() },
    };

    const dryRun = parsed["dry-run"];
    const timeoutMs = parsed["timeout-ms"];

    // acquire write lock for main ingest mutate path (L + safety for concurrent with gc/rm)
    heldLock = await acquireWriteLock(parsed.out);
    const batchOpts = {
      outDir: parsed.out,
      ...(proxy !== undefined ? { proxy } : {}),
      force: parsed.force,
      concurrency,
      acceptUnsupported: parsed["accept-unsupported"],
      ...(dryRun ? { dryRun: true } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(parsed["profile-convergence"] ? { profileConvergence: true } : {}),
      ...(parsed.resume ? { resume: true } : {}),
      ...(parsed["chaos-test"] ? { chaosTest: true } : {}),
      statMap,
    };
    const result = await ingestBatch(files, backends, batchOpts);

    process.removeListener("SIGINT", onSig);
    process.removeListener("SIGTERM", onSig);

    if (proxy === undefined && !parsed.shard && !dryRun) await rebuildIndex(parsed.out);

    const suffix = dryRun ? " (dry-run)" : (parsed.shard ? ` (shard ${parsed.shard})` : (parsed.resume ? " (resumed)" : ""));
    process.stdout.write(
      `pyramid-ingest: ${result.written} written, ${result.skipped} skipped, ${result.failed.length} failed${suffix}\n`,
    );
    for (const f of result.failed) {
      const e = f.error;
      const msg = e instanceof Error
        ? (parsed.verbose ? `${e.message}\n${e.stack ?? ""}` : e.message)
        : String(e);
      process.stderr.write(`FAILED ${f.path}: ${msg}\n`);
    }
    // O1/O3/O6: batch-end event (json mode) + runlog append (atomic, bounded)
    const endMs = Date.now();
    emitJson({ type: "batch-end", written: result.written, skipped: result.skipped, failed: result.failed.length, stagedBytes: (result as any).totalStagedBytes || 0, durationMs: endMs - (Date.now() - 100 /*approx*/) });

    if (!parsed.shard && !dryRun) {
      // append runlog (O6) - typed RunRecord with per-image (unlocked M/I/K/C/T)
      const logPath = join(parsed.out, ".pyramid-ingest.runlog.json");
      const rec: any = {
        runId,
        startedAt: endMs - 100,
        endedAt: endMs,
        producedBy: makeProducedBy(),
        args: process.argv.slice(2),
        summary: { written: result.written, skipped: result.skipped, failed: result.failed.length, stagedBytes: (result as any).totalStagedBytes || 0 },
        images: result.perImage || [],
        failures: result.failed.map(f => ({ path: f.path, error: String(f.error) })),
      };
      try {
        let arr: any[] = [];
        try { arr = JSON.parse(await readFile(logPath, "utf8") || "[]"); } catch {}
        arr.push(rec);
        if (arr.length > runlogKeepN) arr = arr.slice(-runlogKeepN);
        const tmp = `${logPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
        await writeFile(tmp, JSON.stringify(arr, null, 2));
        await rename(tmp, logPath).catch(async (e: any) => {
          if (e && e.code === "EEXIST") { await unlink(tmp).catch(()=>{}); }
          else throw e;
        });
      } catch {}
    }

    return result.failed.length > 0 ? 1 : 0;
  } finally {
    if (heldLock) {
      await heldLock.release().catch(() => {});
      heldLock = null;
    }
    // ensure listeners cleaned (in case early return before remove)
    process.removeListener("SIGINT", onSig);
    process.removeListener("SIGTERM", onSig);
  }

  // (leftover duplicate batch code excised; logic lives inside the try/finally above for unified lock + subcmd handling)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // low-no-unhandledrejection + O5: install at CLI entry; preserve stack on -v for batch errs (top fatal uses message)
  process.on("unhandledRejection", (reason) => {
    const e = reason instanceof Error ? reason : new Error(String(reason));
    process.stderr.write(`unhandledRejection: ${e.message}\n${e.stack ?? ""}\n`);
    process.exit(1);
  });
  process.on("uncaughtException", (err) => {
    process.stderr.write(`uncaughtException: ${err instanceof Error ? err.message : String(err)}\n`);
    if (err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`);
    process.exit(1);
  });

  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(2);
    },
  );
}