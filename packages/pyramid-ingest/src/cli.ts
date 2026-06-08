import { readdir, stat } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { setForcedTier } from "@casabio/jxl-wasm";
import { createJxlBackend } from "./backends.js";
import { createRawBackend } from "./raw-backend.js";
import { formatFromPath, ingestBatch, rebuildIndex, type Backends } from "./ingest.js";
import { boundedConcurrency, planShard } from "./shard.js";

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
  out.sort();
  return out;
}

function parseShard(spec: string): { i: number; n: number } {
  const m = /^(\d+)\/(\d+)$/.exec(spec);
  if (!m) throw new Error(`--shard must be "i/N" (0-based), got "${spec}"`);
  return { i: Number(m[1]), n: Number(m[2]) };
}

const PER_IMAGE_BYTES = 6000 * 4000 * 4;

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
    },
  });

  if (!values.out) throw new Error("--out <dir> is required");

  if (values["reindex-only"]) {
    const index = await rebuildIndex(values.out);
    process.stdout.write(`pyramid-ingest: reindexed ${index.images.length} images\n`);
    return 0;
  }

  if (positionals.length === 0) throw new Error("provide at least one input file or directory");

  if (!backendsOverride) {
    setForcedTier(values.tier as Parameters<typeof setForcedTier>[0]);
  }

  let files = await collectInputs(positionals);
  if (values.shard) {
    const { i, n } = parseShard(values.shard);
    files = planShard(files, i, n);
  }
  if (files.length === 0) {
    process.stderr.write("no supported master files found\n");
    return 0;
  }

  const proxy = values.proxy !== undefined ? Number(values.proxy) : undefined;
  const requested = values.concurrency !== undefined ? Number(values.concurrency) : undefined;
  const memBudgetBytes =
    (values["mem-budget-mb"] !== undefined ? Number(values["mem-budget-mb"]) : 4096) * 1024 * 1024;
  const concurrency = boundedConcurrency(availableParallelism(), requested, memBudgetBytes, PER_IMAGE_BYTES);

  const backends: Backends = backendsOverride ?? { raw: createRawBackend(), jxl: createJxlBackend() };
  const result = await ingestBatch(files, backends, {
    outDir: values.out,
    ...(proxy !== undefined ? { proxy } : {}),
    force: values.force,
    concurrency,
  });

  if (proxy === undefined && !values.shard) await rebuildIndex(values.out);

  process.stdout.write(
    `pyramid-ingest: ${result.written} written, ${result.skipped} skipped, ${result.failed.length} failed` +
      (values.shard ? ` (shard ${values.shard})` : "") + "\n",
  );
  for (const f of result.failed) process.stderr.write(`FAILED ${f.path}: ${f.error}\n`);
  return result.failed.length > 0 ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(2);
    },
  );
}