#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "..");
const distDir = join(packageRoot, "dist");
const corpusManifestPath = join(packageRoot, "..", "jxl-test-corpus", "pgo-manifest.json");

/**
 * P5-4: stage PGO lock (used by docker two-pass profile-generate / profile-use).
 * PGO benefits *encoder* hot loops most (libjxl modular/entropy/var-DCT, bridge enc paths, pyramid ingest).
 * "Apply to enc module first": run PGO training on encode-heavy corpus fixtures; decoder wins are secondary.
 * Full wiring requires extended Dockerfile + training execution inside emsdk (generate pass feeds profdata to use pass).
 * Currently the flow is: `node scripts/build-pgo.mjs` (or via build --pgo) then special docker invocation.
 */
export async function stagePgoLock() {
  const manifest = JSON.parse(await readFile(corpusManifestPath, "utf8"));
  const corpusHash = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  await writeFile(
    join(distDir, "pgo-manifest.lock.json"),
    `${JSON.stringify({ corpusManifestPath, corpusHash, source: "jxl-test-corpus/pgo-manifest.json" }, null, 2)}\n`
  );
  console.log("PGO manifest staged. Run the Docker build with profile-generate/profile-use stages enabled.");
}

async function main() {
  await stagePgoLock();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
