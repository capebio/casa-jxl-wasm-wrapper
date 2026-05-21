#!/usr/bin/env node
import { copyFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const [buildDir, outJs, outWasm] = process.argv.slice(2);

async function main() {
  const files = await readdir(buildDir);
  const jsSource = files.find((name) => name.endsWith(".js")) ?? null;
  const wasmSource = files.find((name) => name.endsWith(".wasm")) ?? null;

  if (!jsSource || !wasmSource) {
    throw new Error(`Expected JS/WASM outputs in ${buildDir}`);
  }

  await copyFile(join(buildDir, jsSource), outJs);
  await copyFile(join(buildDir, wasmSource), outWasm);

  const jsStats = await stat(outJs);
  const wasmStats = await stat(outWasm);
  console.log(JSON.stringify({ outJs, outWasm, jsBytes: jsStats.size, wasmBytes: wasmStats.size }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
