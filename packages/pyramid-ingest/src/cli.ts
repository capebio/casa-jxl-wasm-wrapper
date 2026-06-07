#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { createRawBackend } from "./raw-backend.js";
import { createJxlBackend } from "./backends.js";
import { ingestBatch, formatFromPath } from "./ingest.js";
import { planShard } from "./shard.js";

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      out: { type: "string", short: "o" },
      proxy: { type: "string" },
      shard: { type: "string" },
      "reindex-only": { type: "boolean" },
      force: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log("pyramid-ingest [options] <master1.orf|dng|cr2|jpg> ...");
    console.log("  --out <dir>          output root (default ./pyramid-out)");
    console.log("  --proxy <256|512|1024>  single-level verification mode (no index)");
    console.log("  --shard i/N          this process handles shard i of N (0-based)");
    console.log("  --reindex-only       rebuild index.json from existing manifests (post-shard)");
    console.log("  --force              re-ingest even if mtime matches");
    process.exit(0);
  }

  const outRoot = resolve(values.out || "pyramid-out");
  const proxySize = values.proxy ? parseInt(values.proxy, 10) : null;
  if (proxySize != null && ![256, 512, 1024].includes(proxySize)) {
    throw new Error("--proxy must be 256|512|1024");
  }

  let shard: { i: number; n: number } | undefined;
  if (values.shard) {
    const s = values.shard as string;
    const [iStr, nStr] = s.split("/");
    const i = parseInt(iStr, 10), n = parseInt(nStr, 10);
    if (!Number.isFinite(i) || !Number.isFinite(n)) throw new Error("bad --shard");
    shard = { i, n };
  }

  const inputs = positionals.filter((p) => formatFromPath(p));

  const raw = createRawBackend();
  const jxl = createJxlBackend();

  if (values["reindex-only"]) {
    // minimal: just call rebuild (stub in this impl)
    console.log("[cli] reindex-only: (stub) index would be rebuilt from manifests under", outRoot);
    return;
  }

  let toIngest = inputs;
  if (shard) {
    toIngest = planShard(inputs, shard.i, shard.n);
  }

  const { manifests } = await ingestBatch(toIngest, outRoot, raw, jxl, {
    proxy: proxySize ?? undefined,
    shard: shard ?? undefined,
    force: !!values.force,
  } as any);

  console.log(`[cli] done. ${manifests.length} manifests written under ${outRoot}`);
  if (!proxySize && !shard) {
    console.log(`[cli] index.json written (non-proxy, non-shard run).`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
