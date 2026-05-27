import { mkdtemp, writeFile, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import process from "node:process";

const root = process.cwd();
const packDir = await mkdtemp(join(tmpdir(), "jxl-pack-"));
const smokeDir = await mkdtemp(join(tmpdir(), "jxl-smoke-"));

function runNpm(args, options = {}) {
  const npmCli = process.env.npm_execpath;
  if (npmCli) {
    return execFileSync(process.execPath, [npmCli, ...args], {
      encoding: "utf8",
      ...options,
    });
  }
  return execFileSync("cmd.exe", ["/d", "/s", "/c", "npm", ...args], {
    encoding: "utf8",
    ...options,
  });
}

async function collectPublishablePackages() {
  const entries = await readdir(join(root, "packages"), { withFileTypes: true });
  const packages = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pkgJsonPath = join(root, "packages", entry.name, "package.json");
    const pkg = JSON.parse(await readFile(pkgJsonPath, "utf8"));
    if (pkg.private) continue;
    if (typeof pkg.name !== "string" || !pkg.name.startsWith("@casabio/")) continue;
    packages.push({ name: pkg.name, dir: join(root, "packages", entry.name) });
  }
  return packages;
}

try {
  const tarballs = [];
  const publishablePackages = await collectPublishablePackages();
  for (const { name, dir } of publishablePackages) {
    const output = runNpm(["pack", "--pack-destination", packDir, "--json"], {
      cwd: dir,
    }).trim();
    const packed = JSON.parse(output);
    const entry = Array.isArray(packed) ? packed.at(-1) : packed;
    if (!entry?.filename) {
      throw new Error(`npm pack did not return a tarball filename for ${name}`);
    }
    tarballs.push(join(packDir, entry.filename));
  }

  await writeFile(
    join(smokeDir, "package.json"),
    JSON.stringify(
      {
        name: "jxl-pack-smoke",
        private: true,
        type: "module",
      },
      null,
      2,
    ),
    "utf8",
  );

  runNpm(["install", "--ignore-scripts", "--no-package-lock", ...tarballs], {
    cwd: smokeDir,
    stdio: "inherit",
  });

  await writeFile(
    join(smokeDir, "smoke.mjs"),
    `
const modules = [
  ["@casabio/jxl-core", () => import("@casabio/jxl-core")],
  ["@casabio/jxl-core/errors", () => import("@casabio/jxl-core/errors")],
  ["@casabio/jxl-capabilities", () => import("@casabio/jxl-capabilities")],
  ["@casabio/jxl-policy", () => import("@casabio/jxl-policy")],
  ["@casabio/jxl-cache", () => import("@casabio/jxl-cache")],
  ["@casabio/jxl-scheduler", () => import("@casabio/jxl-scheduler")],
  ["@casabio/jxl-wasm", () => import("@casabio/jxl-wasm")],
  ["@casabio/jxl-worker-browser", () => import("@casabio/jxl-worker-browser")],
  ["@casabio/jxl-worker-node", () => import("@casabio/jxl-worker-node")],
  ["@casabio/jxl-stream", () => import("@casabio/jxl-stream")],
  ["@casabio/jxl-session", () => import("@casabio/jxl-session")],
];

for (const [name, load] of modules) {
  const mod = await load();
  if (!mod || typeof mod !== "object") {
    throw new Error(\`Import failed for \${name}\`);
  }
}
`,
    "utf8",
  );

  execFileSync("node", ["smoke.mjs"], { cwd: smokeDir, stdio: "inherit" });

  console.log(`pack-test ok: ${resolve(smokeDir)}`);
} finally {
  await rm(packDir, { recursive: true, force: true });
  await rm(smokeDir, { recursive: true, force: true });
}
