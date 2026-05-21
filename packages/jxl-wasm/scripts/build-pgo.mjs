#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "..");
const distDir = join(packageRoot, "dist");
const corpusManifestPath = join(packageRoot, "..", "jxl-test-corpus", "pgo-manifest.json");

async function main() {
  const manifest = JSON.parse(await readFile(corpusManifestPath, "utf8"));
  const corpusHash = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  await writeFile(
    join(distDir, "pgo-manifest.lock.json"),
    `${JSON.stringify({ corpusManifestPath, corpusHash, source: "jxl-test-corpus/pgo-manifest.json" }, null, 2)}\n`
  );
  console.log("PGO manifest staged. Run the Docker build with profile-generate/profile-use stages enabled.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
