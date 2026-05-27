import { rm } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

const root = process.cwd();

const directPaths = [
  "node_modules",
  "target",
  "tmp",
  "pkg",
  "bun-chrome-BwwgLC",
  "node-cdp-oL9ZjF",
];

const packageDirs = [
  "packages/jxl-cache",
  "packages/jxl-core",
  "packages/jxl-capabilities",
  "packages/jxl-native",
  "packages/jxl-policy",
  "packages/jxl-scheduler",
  "packages/jxl-session",
  "packages/jxl-stream",
  "packages/jxl-wasm",
  "packages/jxl-worker-browser",
  "packages/jxl-worker-node",
  "packages/jxl-test-corpus",
];

for (const rel of directPaths) {
  await rm(join(root, rel), { recursive: true, force: true });
}

for (const rel of packageDirs) {
  await rm(join(root, rel, "dist"), { recursive: true, force: true });
  await rm(join(root, rel, "dist-test"), { recursive: true, force: true });
  await rm(join(root, rel, "node_modules"), { recursive: true, force: true });
  await rm(join(root, rel, "build"), { recursive: true, force: true });
}

for (const entry of await readdir(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  if (entry.name.startsWith("bun-chrome-") || entry.name.startsWith("node-cdp-") || entry.name.startsWith("pkg-backup-")) {
    await rm(join(root, entry.name), { recursive: true, force: true });
  }
}
