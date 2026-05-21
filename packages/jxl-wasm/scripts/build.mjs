#!/usr/bin/env node
import { mkdir, readFile, writeFile, access, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "..");
const distDir = join(packageRoot, "dist");
const workDir = join(packageRoot, ".work");
const config = {
  buildId: "jxl-wasm-0.1.0",
  libjxlRepo: process.env.LIBJXL_REPO ?? "https://github.com/libjxl/libjxl.git",
  libjxlCommit: process.env.LIBJXL_COMMIT ?? "332feb17d17311c748445f7ee75c4fb55cc38530",
  libjxlTag: "v0.11.2",
  emscriptenTag: "4.0.13",
  emscriptenCommit: "404dc1ec13f64fce1af1eaf5c007e18212f63527",
  tiers: [
    { name: "relaxed-simd-mt", threads: true, simd: true, relaxedSimd: true },
    { name: "simd-mt", threads: true, simd: true, relaxedSimd: false },
    { name: "simd", threads: false, simd: true, relaxedSimd: false },
    { name: "scalar", threads: false, simd: false, relaxedSimd: false }
  ],
  sizeBudgets: {
    "relaxed-simd-mt": 1_677_721.6,
    "simd-mt": 1_572_864,
    "simd": 1_363_148.8,
    "scalar": 1_048_576
  }
};

const baseFlags = [
  "-O3",
  "-sUSE_PTHREADS=1",
  "-sPTHREAD_POOL_SIZE=navigator.hardwareConcurrency",
  "-sENVIRONMENT=web,worker",
  "-sMODULARIZE=1",
  "-sEXPORT_ES6=1",
  "-sEXPORT_NAME=createJxlModule",
  "-sALLOW_MEMORY_GROWTH=1",
  "-sINITIAL_MEMORY=33554432",
  "-sMAXIMUM_MEMORY=4294967296",
  "-sFILESYSTEM=0",
  "-sASSERTIONS=0",
  "-sINVOKE_RUN=0",
  "-sEXPORTED_RUNTIME_METHODS=['cwrap','HEAPU8','HEAP16','HEAPU16','HEAPF32']",
  "-sEXPORTED_FUNCTIONS=@exports.txt",
  "-flto",
  "-fno-rtti",
  "-fno-exceptions"
];

const sourceDir = join(workDir, "libjxl");

async function main() {
  const insideDocker = process.argv.includes("--inside-docker");
  await mkdir(distDir, { recursive: true });
  await mkdir(workDir, { recursive: true });

  await ensureLibjxlSource();

  const manifest = {
    buildId: config.buildId,
    libjxlCommit: config.libjxlCommit,
    emscriptenTag: config.emscriptenTag,
    emscriptenCommit: config.emscriptenCommit,
    generatedAt: new Date().toISOString(),
    tiers: {}
  };

  for (const tier of config.tiers) {
    const outJs = join(distDir, `jxl-core.${tier.name}.js`);
    const outWasm = join(distDir, `jxl-core.${tier.name}.wasm`);
    const buildDir = join(workDir, tier.name);
    await mkdir(buildDir, { recursive: true });

    const tierFlags = [
      ...baseFlags.filter((flag) => flag !== "-sUSE_PTHREADS=1" && flag !== "-sPTHREAD_POOL_SIZE=navigator.hardwareConcurrency"),
      ...(tier.threads ? ["-pthread", "-sUSE_PTHREADS=1", "-sPTHREAD_POOL_SIZE=navigator.hardwareConcurrency"] : []),
      ...(tier.simd ? ["-msimd128"] : []),
      ...(tier.relaxedSimd ? ["-mrelaxed-simd"] : [])
    ];

    const cmakeArgs = [
      "-S",
      sourceDir,
      "-B",
      buildDir,
      "-G",
      "Ninja",
      "-DCMAKE_BUILD_TYPE=Release",
      "-DBUILD_TESTING=OFF"
    ];
    const tierEnv = {
      ...process.env,
      CFLAGS: tierFlags.join(" "),
      CXXFLAGS: tierFlags.join(" "),
      LDFLAGS: tierFlags.join(" ")
    };

    if (!insideDocker) {
      await assertBinary("docker");
      const image = "jxl-wasm-builder:local";
      await run("docker", [
        "build",
        "-t",
        image,
        "--build-arg",
        `LIBJXL_COMMIT=${config.libjxlCommit}`,
        "--build-arg",
        `LIBJXL_REPO=${config.libjxlRepo}`,
        "-f",
        join(packageRoot, "Dockerfile"),
        packageRoot
      ], { cwd: packageRoot });
      await run("docker", [
        "run",
        "--rm",
        "-v",
        `${packageRoot}:/work/jxl-wasm`,
        "-w",
        "/work/jxl-wasm",
        image,
        "node",
        "scripts/build.mjs",
        "--inside-docker"
      ], { cwd: packageRoot });
      return;
    }

    await run("emcmake", ["cmake", ...cmakeArgs], { cwd: packageRoot, env: tierEnv });
    await run("cmake", ["--build", buildDir, "--", "-j", `${Math.max(1, osCpusMinusOne())}`], { cwd: packageRoot, env: tierEnv });
    await run("node", [join(__dirname, "postprocess-tier.mjs"), buildDir, outJs, outWasm], { cwd: packageRoot, env: { ...tierEnv, JXL_WASM_TIER: tier.name, JXL_WASM_FLAGS: JSON.stringify(tierFlags) } });

    const jsStats = await stat(outJs);
    const wasmStats = await stat(outWasm);
    manifest.tiers[tier.name] = {
      jsBytes: jsStats.size,
      wasmBytes: wasmStats.size,
      jsSha256: await sha256File(outJs),
      wasmSha256: await sha256File(outWasm),
      flags: tierFlags
    };

    if (wasmStats.size > config.sizeBudgets[tier.name]) {
      await writeFile(
        join(distDir, `${tier.name}.size-report.txt`),
        [
          `Tier ${tier.name} exceeded the size budget.`,
          `Budget: ${config.sizeBudgets[tier.name]} bytes`,
          `Actual: ${wasmStats.size} bytes`,
          "Run the linked map/size-report helper to identify the heaviest objects."
        ].join("\n")
      );
    }
  }

  if (process.argv.includes("--inside-docker")) {
    await writeManifest(manifest);
  }
}

async function ensureLibjxlSource() {
  try {
    await access(sourceDir, fsConstants.R_OK);
    const head = await runCapture("git", ["-C", sourceDir, "rev-parse", "HEAD"]);
    if (head.trim() === config.libjxlCommit) {
      return;
    }
    await rmDir(sourceDir);
    await clonePinnedSource();
    return;
  } catch {}

  await clonePinnedSource();
}

async function clonePinnedSource() {
  await run("git", [
    "clone",
    "--recursive",
    "--branch",
    config.libjxlTag,
    "--depth",
    "1",
    config.libjxlRepo,
    sourceDir
  ], { cwd: packageRoot });
  const head = await runCapture("git", ["-C", sourceDir, "rev-parse", "HEAD"]);
  if (head.trim() !== config.libjxlCommit) {
    throw new Error(`libjxl HEAD ${head.trim()} does not match pinned commit ${config.libjxlCommit}`);
  }
}

async function writeManifest(manifest) {
  await writeFile(join(distDir, "build-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function sha256File(path) {
  const data = await readFile(path);
  return createHash("sha256").update(data).digest("hex");
}

function osCpusMinusOne() {
  const count = Number(process.env.CPU_COUNT ?? 8);
  return Math.max(1, count - 1);
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: "inherit",
      shell: false
    });

    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`${command} exited with ${code ?? signal}`));
    });
    child.on("error", rejectPromise);
  });
}

function runCapture(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "inherit"],
      shell: false
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise(output);
        return;
      }
      rejectPromise(new Error(`${command} exited with ${code}`));
    });
    child.on("error", rejectPromise);
  });
}

async function assertBinary(name) {
  try {
    await run(name, ["--version"]);
  } catch (error) {
    throw new Error(`${name} is required for this build: ${error.message}`);
  }
}

async function rmDir(path) {
  const { rm } = await import("node:fs/promises");
  await rm(path, { recursive: true, force: true });
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
