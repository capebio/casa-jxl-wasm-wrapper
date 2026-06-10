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
  emscriptenTag: "4.0.14",
  emscriptenCommit: "refresh-after-first-4.0.14-host-build",
  emsdkImages: resolveEmsdkImages(), // 4.0.14+ for P2-3 LTO re-enable attempt
  tiers: [
    { name: "relaxed-simd-mt", threads: true, simd: true, relaxedSimd: true },
    { name: "simd-mt", threads: true, simd: true, relaxedSimd: false },
    { name: "simd", threads: false, simd: true, relaxedSimd: false }
  ],
  sizeBudgets: {
    "relaxed-simd-mt": 1_677_721.6,
    "simd-mt": 1_572_864,
    "simd": 1_363_148.8,
    "scalar": 1_048_576
  },
  // Phase 1 module split: dec for viewer (decode-only, smaller), enc for ingest (lazy loaded).
  // Separate exports.txt per role lets wasm-metadce strip unused call trees (encode in dec, unused legacy in enc).
  modules: [
    { role: "dec", exportsFile: "exports-dec.txt", decoderOnly: true },
    { role: "enc", exportsFile: "exports-enc.txt", decoderOnly: false }
  ]
};

// Authoritative list of Emscripten runtime methods we depend on.
// Must match exactly what facade.ts reads off the module (LibjxlWasmModule).
// Current consumers: HEAPU8 (all pixel I/O), HEAPU32 (buffer metadata fast-paths + sidecar dims),
// HEAP32 (advanced settings int32 arrays). No cwrap; no HEAP16/HEAPU16/HEAPF32 (16/32-bit
// pixel paths build their own typed views over the underlying buffer in JS).
const exportedRuntimeMethods = "['HEAPU8','HEAPU32']";

// Phase 1 module split: dec (viewer: decode/region/tile-container-decode, no encoder, no transcode)
// vs enc (ingest: streaming + container encode + sidecars + metadata + gain). Lazy for enc.
const moduleKinds = ["dec", "enc"] as const;
type ModuleKind = (typeof moduleKinds)[number];

const baseFlags = [
  "-O3",
  "-sENVIRONMENT=web,worker",
  "-sMODULARIZE=1",
  "-sEXPORT_ES6=1",
  "-sEXPORT_NAME=createJxlModule",
  "-sALLOW_MEMORY_GROWTH=1",
  // INITIAL_MEMORY set per module kind (16 MB dec for tile outputs; 256 MB enc for large 16-bit working sets).
  // See P3-4. Override in link + tierFlags.
  "-sMAXIMUM_MEMORY=4294967296",
  "-sFILESYSTEM=0",
  "-sASSERTIONS=0",
  "-sINVOKE_RUN=0",
  `-sEXPORTED_RUNTIME_METHODS=${exportedRuntimeMethods}`,
  "-sWASM_BIGINT=1",
  "-flto",
  // -flto (compile) re-enabled for P2-3 with emscripten 4.0.14 bump.
  // Recovers cross-TU inlining + ~3-5% size. If binaryen wasm-metadce on
  // this libjxl still says "invalid UTF-8 at offset 0:N", remove -flto here
  // and in linkBridge, pin tag back, and document.
  "-mnontrapping-fptoint",
  "-fno-rtti",
  "-fno-exceptions"
];

const relaxedSimdHighwayFlags = [
  "-mrelaxed-simd",
  "-DHWY_WANT_WASM2"
];

const sourceDir = join(workDir, "libjxl");

async function main() {
  const insideDocker = process.argv.includes("--inside-docker");
  const hostToolchain = process.argv.includes("--host-toolchain");
  const pgoRequested = process.argv.includes("--pgo");
  await mkdir(distDir, { recursive: true });
  await mkdir(workDir, { recursive: true });

  // P5-4: wire PGO staging into main build.
  // Unwired before: build-pgo.mjs only staged lock; no call from build, no flags in Dockerfile/build tiers, no pgo info in manifest.
  // Determination: staging script + pgo-manifest.json exist and are documented; actual profile-generate/use two-pass + training on corpus fixtures (for emcc/libjxl) is not present in build.mjs or Dockerfile.
  // "If viable, apply to enc module first": encoder paths (createImage*/enc_finish + libjxl entropy/modular) benefit most from realistic image training corpus. Decoder PGO is lower priority.
  if (pgoRequested) {
    try {
      const { stagePgoLock } = await import("./build-pgo.mjs");
      await stagePgoLock();
    } catch (e) {
      console.warn("[pgo] staging failed (corpus manifest may be absent):", e?.message ?? e);
    }
  } else {
    // Auto-stage when corpus pgo manifest is present (cheap, no harm).
    try {
      const corpusPgo = join(packageRoot, "..", "jxl-test-corpus", "pgo-manifest.json");
      const { access } = await import("node:fs/promises");
      const { constants } = await import("node:fs");
      await access(corpusPgo, constants.R_OK);
      const { stagePgoLock } = await import("./build-pgo.mjs");
      await stagePgoLock();
    } catch {}
  }

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
    skippedTiers: (hostToolchain && !process.argv.includes("--include-mt")) ? config.tiers.filter((tier) => tier.threads).map((tier) => tier.name) : [],
    // P5-4: PGO info (if staged). Encoder benefits first.
    pgo: null
  };

  // Populate from just-staged lock (or prior partial build merge below will carry it).
  try {
    const lockPath = join(distDir, "pgo-manifest.lock.json");
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    manifest.pgo = { enabled: true, corpusHash: lock.corpusHash, source: lock.source };
  } catch {}

  const onlyMt = process.argv.includes("--only-mt");
  const activeTiers = onlyMt
    ? config.tiers.filter((tier) => tier.threads)
    : (hostToolchain && !process.argv.includes("--include-mt")) ? config.tiers.filter((tier) => !tier.threads) : config.tiers;

  // Phase 1/3: build matrix is (kind x tier). dec = viewer (decode + tile-decode + region, no enc, transcode=OFF).
  // enc = ingest (streaming/container encode, sidecars, metadata, gain). Lazy-loaded.
  // MT tiers still gated by --include-mt on host-toolchain (COOP/COEP requirement for SharedArrayBuffer).
  for (const kind of moduleKinds) {
    for (const tier of activeTiers) {
      const outJs = join(distDir, `jxl-core.${kind}.${tier.name}.js`);
      const outWasm = join(distDir, `jxl-core.${kind}.${tier.name}.wasm`);
      const buildDir = join(workDir, `${kind}-${tier.name}`);
      await rmDir(buildDir);
      await mkdir(buildDir, { recursive: true });

      // Per-module memory and allocator (P3-4 + P2-6). dec: small for tiles (256px ~256KB out), emmalloc.
      // enc: large working set (20MP RGBA16 ~160MB), avoid repeated grows. mimalloc only behind benchmark.
      const isDec = kind === "dec";
      const isMt = !!tier.threads;
      const initialMem = isDec ? 16777216 : 268435456; // 16 MB vs 256 MB
      const poolSize = isMt ? (isDec ? "4" : "navigator.hardwareConcurrency") : undefined;
      // P3-3: enc ingest prefers single MT instance (pool fan-out in scheduler workers is N^2 hazard).
      // For dec MT inside pooled workers, cap or STRICT=0 for lazy. Numeric values require benchmark on target HW before merge.
      const mallocFlag = isDec ? "-sMALLOC=emmalloc" : undefined;

      const tierFlags = [
        ...baseFlags,
        `-sINITIAL_MEMORY=${initialMem}`,
        ...(isMt ? ["-pthread", "-sUSE_PTHREADS=1", `-sPTHREAD_POOL_SIZE=${poolSize}`] : []),
        ...(isMt && isDec ? ["-sPTHREAD_POOL_SIZE_STRICT=0"] : []), // lazy spawn for worker dec-MT
        ...(tier.simd ? ["-msimd128"] : []),
        ...(tier.relaxedSimd ? relaxedSimdHighwayFlags : []),
        ...(mallocFlag ? [mallocFlag] : [])
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
        "-DJPEGXL_ENABLE_TOOLS=OFF",
        "-DJPEGXL_ENABLE_EXAMPLES=OFF",
        "-DJPEGXL_ENABLE_BENCHMARK=OFF",
        "-DJPEGXL_ENABLE_JPEGLI=OFF",
        ...(isDec ? ["-DJPEGXL_ENABLE_TRANSCODE_JPEG=OFF"] : []),
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
      const exportsFile = isDec ? "exports-dec.txt" : "exports-enc.txt";
      await linkBridge(buildDir, outJs, tierFlags, tierEnv, kind, exportsFile, initialMem);

      const jsStats = await stat(outJs);
      const wasmStats = await stat(outWasm);
      const linkExtras = ["--closure", "1"];
      if (!isMt && !tierFlags.some((f) => /pthread|USE_PTHREADS/.test(f))) {
        linkExtras.push("-sEVAL_CTORS=2");
      }
      const tierKey = `${kind}:${tier.name}`;
      manifest.tiers[tierKey] = {
        kind,
        tier: tier.name,
        jsBytes: jsStats.size,
        wasmBytes: wasmStats.size,
        jsSha256: await sha256File(outJs),
        wasmSha256: await sha256File(outWasm),
        flags: [...tierFlags, ...linkExtras]
      };

      const budgetKey = tier.name; // budgets remain per cpu tier; dec/enc measured separately
      const budget = config.sizeBudgets[budgetKey];
      if (budget && wasmStats.size > budget) {
        await writeFile(
          join(distDir, `${kind}.${tier.name}.size-report.txt`),
          [
            `Module ${kind} tier ${tier.name} exceeded the size budget.`,
            `Budget: ${budget} bytes`,
            `Actual: ${wasmStats.size} bytes`,
            "Run the linked map/size-report helper to identify the heaviest objects."
          ].join("\n")
        );
      }
    }
  }

  assertDistinctRelaxedSimdMt(manifest);
  await writeManifest(manifest);
}

function assertDistinctRelaxedSimdMt(manifest) {
  // Check per-kind if both MT tiers were built for that kind.
  for (const kind of moduleKinds) {
    const relaxed = manifest.tiers[`${kind}:relaxed-simd-mt`];
    const simdMt = manifest.tiers[`${kind}:simd-mt`];
    if (!relaxed || !simdMt) continue;
    if (relaxed.wasmSha256 === simdMt.wasmSha256) {
      throw new Error(
        `${kind}: relaxed-simd-mt wasm matched simd-mt wasm; relaxed tier did not produce a distinct optimized artifact`
      );
    }
  }
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

async function linkBridge(buildDir, outJs, tierFlags, env, kind: ModuleKind, exportsFile: string, initialMem: number) {
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
    `-sINITIAL_MEMORY=${initialMem}`,
    "-sMAXIMUM_MEMORY=4294967296",
    "-sFILESYSTEM=0",
    "-sASSERTIONS=0",
    "-sINVOKE_RUN=0",
    `-sEXPORTED_RUNTIME_METHODS=${exportedRuntimeMethods}`,
    `-sEXPORTED_FUNCTIONS=@${toCmakePath(join(packageRoot, exportsFile))}`,
    "-sWASM_BIGINT=1",
    "-flto",
    "--closure", "1",
    // EVAL_CTORS shrinks .data/ctors but is incompatible with pthreads (passive segments error in libpthread.js).
    // Apply only to non-MT tiers. MT glue still gets --closure 1 (P2-1) for the 31k->~20k win.
    ...(!tierFlags.some((f) => /pthread|USE_PTHREADS/.test(f)) ? ["-sEVAL_CTORS=2"] : []),
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
  const manifestPath = join(distDir, "build-manifest.json");
  // Merge with existing manifest so partial builds (--only-mt, --host-toolchain) preserve
  // tier entries produced by an earlier run instead of clobbering them.
  let existing = null;
  try {
    const text = await readFile(manifestPath, "utf8");
    existing = JSON.parse(text);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  if (existing && existing.buildId === manifest.buildId && existing.libjxlCommit === manifest.libjxlCommit) {
    const mergedTiers = { ...(existing.tiers ?? {}), ...manifest.tiers };
    const builtNames = new Set(Object.keys(manifest.tiers));
    const mergedSkipped = Array.isArray(manifest.skippedTiers)
      ? manifest.skippedTiers.filter((name) => !builtNames.has(name))
      : [];
    // Hygiene: never persist provenance for tiers we have explicitly skipped in this build.
    // Stale MT entries from prior --include-mt runs must not remain under `tiers` when skipped.
    for (const s of mergedSkipped) delete mergedTiers[s];
    const mergedPgo = manifest.pgo || existing.pgo || null;
    manifest = { ...existing, ...manifest, tiers: mergedTiers, skippedTiers: mergedSkipped, pgo: mergedPgo };
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
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
    "docker.io/emscripten/emsdk:4.0.14",
    "ghcr.io/emscripten-core/emsdk:4.0.14"
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
