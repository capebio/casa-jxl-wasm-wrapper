import { readFile, readdir, stat } from "node:fs/promises";
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

export async function collectInputs(roots: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  const walk = async (p: string): Promise<void> => {
    const s = await stat(p);
    if (s.isDirectory()) {
      for (const name of await readdir(p)) await walk(join(p, name));
    } else if (formatFromPath(p)) {
      out.push(p);
    }
  };
  for (const root of roots) await walk(root);
  // INVARIANT (D3): ingest order must be deterministic so that --shard partitions
  // a stable file list across machines / readdir orders. Do not remove this sort.
  out.sort();
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
    },
  });

  const parsed = cliArgsSchema.parse(values);

  if (!parsed.out) throw new Error("--out <dir> is required");

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
    const imageId = imageIdForPath(masterPath);
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

  if (positionals.length === 0) throw new Error("provide at least one input file or directory");

  if (!backendsOverride) {
    let tier: any = parsed.tier;
    const thr = parsed["encoder-threads"];
    if (thr === 1) {
      // F9/D1: force non-mt tier for byte determinism (mt libjxl not det at effort>=3)
      if (tier === "auto" || tier === "simd-mt" || tier === "relaxed-simd-mt") tier = "simd";
    }
    setForcedTier(tier);
  }

  let files = await collectInputs(positionals);
  if (parsed.shard) {
    const { i, n } = parseShard(parsed.shard);
    files = planShard(files, i, n);
  }
  if (files.length === 0) {
    process.stderr.write("no supported master files found\n");
    return 0;
  }

  const proxy = parsed.proxy;
  const requested = parsed.concurrency;
  const memBudgetBytes = parsed["mem-budget-mb"] * 1024 * 1024;
  const concurrency = boundedConcurrency(availableParallelism(), requested, memBudgetBytes, PER_IMAGE_BYTES);

  const ac = new AbortController();
  const onSig = () => ac.abort();
  process.once("SIGINT", onSig);
  process.once("SIGTERM", onSig);

  const tel = parsed.verbose ? createTtyTelemetry() : noOpTelemetry;
  const backends: Backends = backendsOverride ?? {
    raw: createRawBackend(),
    jxl: createJxlBackend(),
    signal: ac.signal,
    telemetry: tel,
    clock: { now: () => Date.now() },
  };

  const dryRun = parsed["dry-run"];
  const timeoutMs = parsed["timeout-ms"];

  const batchOpts = {
    outDir: parsed.out,
    ...(proxy !== undefined ? { proxy } : {}),
    force: parsed.force,
    concurrency,
    ...(dryRun ? { dryRun: true } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
  const result = await ingestBatch(files, backends, batchOpts);

  process.removeListener("SIGINT", onSig);
  process.removeListener("SIGTERM", onSig);

  if (proxy === undefined && !parsed.shard && !dryRun) await rebuildIndex(parsed.out);

  const suffix = dryRun ? " (dry-run)" : (parsed.shard ? ` (shard ${parsed.shard})` : "");
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
  return result.failed.length > 0 ? 1 : 0;
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