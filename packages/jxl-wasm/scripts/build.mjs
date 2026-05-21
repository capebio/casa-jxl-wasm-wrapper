#!/usr/bin/env node
import { mkdir, readFile, writeFile, access, stat, readdir } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "..");
const distDir = join(packageRoot, "dist");
const workDir = join(os.tmpdir(), "jxl-wasm-work");
const dockerBinary = resolveDockerBinary();
const emcmakeBinary = resolveEmscriptenBinary("emcmake");
const emppBinary = resolveEmscriptenBinary("em++");
const bashBinary = resolveBashBinary();
const config = {
  buildId: "jxl-wasm-0.1.0",
  libjxlRepo: process.env.LIBJXL_REPO ?? "https://github.com/libjxl/libjxl.git",
  libjxlCommit: process.env.LIBJXL_COMMIT ?? "332feb17d17311c748445f7ee75c4fb55cc38530",
  libjxlTag: "v0.11.2",
  emscriptenTag: "4.0.13",
  emscriptenCommit: "404dc1ec13f64fce1af1eaf5c007e18212f63527",
  emsdkImages: resolveEmsdkImages(),
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
  "-sINITIAL_MEMORY=67108864",
  "-sMAXIMUM_MEMORY=4294967296",
  "-sFILESYSTEM=0",
  "-sASSERTIONS=0",
  "-sINVOKE_RUN=0",
  "-sEXPORTED_RUNTIME_METHODS=['cwrap','HEAPU8','HEAP16','HEAPU16','HEAPF32']",
  "-sWASM_BIGINT=1",
  "-flto",
  "-fno-rtti",
  "-fno-exceptions"
];

const sourceDir = join(workDir, "libjxl");

async function main() {
  const insideDocker = process.argv.includes("--inside-docker");
  const hostToolchain = process.argv.includes("--host-toolchain");
  await mkdir(distDir, { recursive: true });
  await mkdir(workDir, { recursive: true });

  if (!insideDocker && !hostToolchain) {
    await runDockerBuild();
    return;
  }

  const manifest = {
    buildId: config.buildId,
    libjxlCommit: config.libjxlCommit,
    emscriptenTag: config.emscriptenTag,
    emscriptenCommit: config.emscriptenCommit,
    emsdkImage: process.env.JXL_WASM_EMSDK_IMAGE ?? null,
    buildMode: hostToolchain ? "host-toolchain" : insideDocker ? "docker" : "local",
    generatedAt: new Date().toISOString(),
    tiers: {},
    skippedTiers: hostToolchain ? config.tiers.filter((tier) => tier.threads).map((tier) => tier.name) : []
  };

  const activeTiers = hostToolchain ? config.tiers.filter((tier) => !tier.threads) : config.tiers;

  for (const tier of activeTiers) {
    const outJs = join(distDir, `jxl-core.${tier.name}.js`);
    const outWasm = join(distDir, `jxl-core.${tier.name}.wasm`);
    const buildDir = join(workDir, tier.name);
    await rmDir(buildDir);
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
      "-DBUILD_TESTING=OFF",
      "-DTHREADS_PREFER_PTHREAD_FLAG=ON",
      "-DCMAKE_HAVE_LIBC_PTHREAD=1",
      "-DCMAKE_USE_PTHREADS_INIT=1",
      "-DCMAKE_THREAD_LIBS_INIT=-pthread",
      "-DCMAKE_REQUIRED_FLAGS=-pthread",
      "-DCMAKE_REQUIRED_LIBRARIES=-latomic",
      "-DCMAKE_REQUIRED_LINK_OPTIONS=-pthread",
      `-DCMAKE_MODULE_PATH=${toCmakePath(join(packageRoot, "cmake-shims"))}`
    ];
    const tierEnv = {
      ...process.env,
      CFLAGS: tierFlags.join(" "),
      CXXFLAGS: tierFlags.join(" "),
      LDFLAGS: tierFlags.join(" ")
    };
    await ensureLibjxlSource();
    await ensureLibjxlDeps(hostToolchain);
    await runEmscripten(emcmakeBinary, ["cmake", ...cmakeArgs], { cwd: packageRoot, env: tierEnv });
    await run("cmake", ["--build", buildDir, "--", "-j", `${Math.max(1, osCpusMinusOne())}`], { cwd: packageRoot, env: tierEnv });
    await linkBridge(buildDir, outJs, tierFlags, tierEnv);

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

  await writeManifest(manifest);
}

async function runDockerBuild() {
  const image = "jxl-wasm-builder:local";
  const dockerEnv = { ...process.env };
  await assertBinary(dockerBinary);
  await assertDockerDaemon(dockerEnv);
  const emsdkImage = await buildDockerImage(image, dockerEnv);
  await run(dockerBinary, [
    "run",
    "--rm",
    "-e",
    `JXL_WASM_EMSDK_IMAGE=${emsdkImage}`,
    "-v",
    `${packageRoot}:/work/jxl-wasm`,
    "-w",
    "/work/jxl-wasm",
    image,
    "node",
    "scripts/build.mjs",
    "--inside-docker"
  ], { cwd: packageRoot, env: dockerEnv });
}

async function buildDockerImage(image, dockerEnv) {
  let lastError;
  for (const emsdkImage of config.emsdkImages) {
    try {
      await run(dockerBinary, [
        "build",
        "-t",
        image,
        "--build-arg",
        `EMSDK_IMAGE=${emsdkImage}`,
        "--build-arg",
        `LIBJXL_COMMIT=${config.libjxlCommit}`,
        "--build-arg",
        `LIBJXL_REPO=${config.libjxlRepo}`,
        "-f",
        join(packageRoot, "Dockerfile"),
        packageRoot
      ], { cwd: packageRoot, env: { ...dockerEnv, JXL_WASM_EMSDK_IMAGE: emsdkImage } });
      return emsdkImage;
    } catch (error) {
      lastError = error;
      console.warn(`Emscripten Docker image failed: ${emsdkImage}`);
    }
  }
  throw lastError ?? new Error("No Emscripten Docker images configured");
}

async function linkBridge(buildDir, outJs, tierFlags, env) {
  const archives = await findStaticArchives(buildDir);
  const preferred = sortArchivesForLink(archives);
  const includeDirs = [
    join(sourceDir, "lib", "include"),
    sourceDir,
    buildDir,
    join(buildDir, "lib", "include")
  ];
  await runEmscripten(emppBinary, [
    join(packageRoot, "src", "bridge.cpp"),
    ...includeDirs.flatMap((dir) => ["-I", dir]),
    ...preferred,
    "-o",
    outJs,
    ...tierFlags,
    "-sMODULARIZE=1",
    "-sEXPORT_ES6=1",
    "-sEXPORT_NAME=createJxlModule",
    "-sALLOW_MEMORY_GROWTH=1",
    "-sINITIAL_MEMORY=67108864",
    "-sMAXIMUM_MEMORY=4294967296",
    "-sFILESYSTEM=0",
    "-sASSERTIONS=0",
    "-sINVOKE_RUN=0",
    "-sEXPORTED_RUNTIME_METHODS=['HEAPU8','HEAPU32']",
    `-sEXPORTED_FUNCTIONS=@${toCmakePath(join(packageRoot, "exports.txt"))}`,
    "-sWASM_BIGINT=1",
    "-flto",
    "-fno-rtti",
    "-fno-exceptions"
  ], { cwd: packageRoot, env });
}

async function findStaticArchives(root) {
  const out = [];
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && entry.name.endsWith(".a")) {
        out.push(path);
      }
    }
  }
  await visit(root);
  return out;
}

function sortArchivesForLink(archives) {
  const priority = (path) => {
    const name = path.replaceAll("\\", "/").split("/").pop() ?? "";
    if (name === "libjxl.a") return 0;
    if (name === "libjxl_threads.a") return 1;
    if (name === "libjxl_cms.a") return 2;
    return 10;
  };
  return [...archives].sort((a, b) => priority(a) - priority(b) || a.localeCompare(b));
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

async function ensureLibjxlDeps(hostToolchain) {
  if (!hostToolchain) {
    return;
  }
  await run(bashBinary, ["deps.sh"], { cwd: sourceDir });
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

async function assertDockerDaemon(env) {
  try {
    await run(dockerBinary, ["info"], { cwd: packageRoot, env });
  } catch (error) {
    throw new Error(
      `Docker CLI is installed, but the Docker daemon is not reachable. Start Docker Desktop/Linux engine and retry. ${error.message}`
    );
  }
}

function runEmscripten(command, args, options = {}) {
  if (process.platform === "win32" && command.endsWith(".bat")) {
    return run("cmd", ["/c", command, ...args], options);
  }
  return run(command, args, options);
}

function resolveDockerBinary() {
  if (process.env.DOCKER_BIN) return process.env.DOCKER_BIN;
  if (process.platform === "win32") {
    return "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe";
  }
  return "docker";
}

function resolveEmscriptenBinary(name) {
  const root = process.env.EMSDK;
  if (!root) return name;
  if (process.platform === "win32") {
    return join(root, "upstream", "emscripten", `${name}.bat`);
  }
  return join(root, "upstream", "emscripten", name);
}

function resolveEmsdkImages() {
  if (process.env.EMSDK_IMAGE) {
    return [process.env.EMSDK_IMAGE];
  }
  return [
    "ghcr.io/emscripten-core/emsdk:4.0.13",
    "docker.io/emscripten/emsdk:4.0.13"
  ];
}

function resolveBashBinary() {
  if (process.platform === "win32") {
    return "C:\\Program Files\\Git\\bin\\bash.exe";
  }
  return "bash";
}

function toCmakePath(path) {
  return path.replaceAll("\\", "/");
}

async function rmDir(path) {
  const { rm } = await import("node:fs/promises");
  await rm(path, { recursive: true, force: true });
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
