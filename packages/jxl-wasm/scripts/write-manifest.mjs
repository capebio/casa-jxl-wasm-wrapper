#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "..");
const distDir = join(packageRoot, "dist");

async function main() {
  await mkdir(distDir, { recursive: true });
  const entries = await readFile(join(packageRoot, "exports.txt"), "utf8");
  await writeFile(
    join(distDir, "build-manifest.json"),
    `${JSON.stringify(
      {
        buildId: "jxl-wasm-0.1.0",
        exportsSha256: createHash("sha256").update(entries).digest("hex"),
        note: "Run scripts/build.mjs inside the pinned Docker image to replace this manifest with real artifact metadata."
      },
      null,
      2
    )}\n`
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
