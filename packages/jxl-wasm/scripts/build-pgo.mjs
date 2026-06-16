#!/usr/bin/env node
import { access, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import { dirname, join, resolve, relative } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "..");
const distDir = join(packageRoot, "dist");
const corpusRoot = resolve(packageRoot, "..", "jxl-test-corpus");
const corpusManifestPath = join(corpusRoot, "pgo-manifest.json");
const lockPath = join(distDir, "pgo-manifest.lock.json");
const workDir = process.env.JXL_WASM_WORKDIR ?? join(os.tmpdir(), "jxl-wasm-work");
const sourceDir = join(workDir, "libjxl");
const gitBinary = resolveGitBinary();
const emcmakeBinary = resolveEmscriptenBinary("emcmake");
const emppBinary = resolveEmscriptenBinary("em++");
const bashBinary = resolveBashBinary();
const cmakeBinary = resolveCmakeBinary();
const config = {
  buildId: "jxl-wasm-0.1.0",
  libjxlRepo: process.env.LIBJXL_REPO ?? "https://github.com/libjxl/libjxl.git",
  libjxlCommit: process.env.LIBJXL_COMMIT ?? "332feb17d17311c748445f7ee75c4fb55cc38530",
  libjxlTag: process.env.LIBJXL_TAG ?? "v0.11.2",
  emscriptenTag: "4.0.14"
};

const exportedRuntimeMethods = "['HEAPU8','HEAPU32']";
const baseFlags = [
  "-O3",
  "-sMODULARIZE=1",
  "-sEXPORT_ES6=1",
  "-sEXPORT_NAME=createJxlModule",
  "-sALLOW_MEMORY_GROWTH=1",
  "-sMAXIMUM_MEMORY=4294967296",
  "-sASSERTIONS=0",
  "-sINVOKE_RUN=0",
  `-sEXPORTED_RUNTIME_METHODS=${exportedRuntimeMethods}`,
  "-sWASM_BIGINT=1",
  "-flto",
  "-mnontrapping-fptoint",
  "-fno-rtti",
  "-fno-exceptions",
  "-msimd128",
  "-sINCOMING_MODULE_JS_API=locateFile,wasmBinary"
];

const encTierFlags = [
  ...baseFlags,
  "-sENVIRONMENT=web,worker",
  "-sINITIAL_MEMORY=268435456"
];

const trainEnvFlags = [
  "-sENVIRONMENT=node",
  "-sFILESYSTEM=1",
  "-sNODERAWFS=1"
];

const applyProfileFlags = [
  "-Wno-profile-instr-unprofiled",
  "-Wno-profile-instr-out-of-date"
];
const windowsSubmoduleFallbacks = [
  { path: "testdata", url: "https://github.com/libjxl/testdata", commit: "873045a9c42ed60721756e26e2a6b32e17415205" },
  { path: "third_party/brotli", url: "https://github.com/google/brotli", commit: "36533a866ed1ca4b75cf049f4521e4ec5fe24727" },
  { path: "third_party/googletest", url: "https://github.com/google/googletest", commit: "6910c9d9165801d8827d628cb72eb7ea9dd538c5" },
  { path: "third_party/highway", url: "https://github.com/google/highway", commit: "457c891775a7397bdb0376bb1031e6e027af1c48" },
  { path: "third_party/sjpeg", url: "https://github.com/webmproject/sjpeg.git", commit: "94e0df6d0f8b44228de5be0ff35efb9f946a13c9" },
  { path: "third_party/skcms", url: "https://skia.googlesource.com/skcms", commit: "b2e692629c1fb19342517d7fb61f1cf83d075492" },
  { path: "third_party/zlib", url: "https://github.com/madler/zlib.git", commit: "51b7f2abdade71cd9bb0e7a373ef2610ec6f9daf" },
  { path: "third_party/libpng", url: "https://github.com/glennrp/libpng.git", commit: "872555f4ba910252783af1507f9e7fe1653be252" },
  { path: "third_party/libjpeg-turbo", url: "https://github.com/libjpeg-turbo/libjpeg-turbo.git", commit: "8ecba3647edb6dd940463fedf38ca33a8e2a73d1" }
];

export async function stagePgoLock(options = {}) {
  const lock = await createPgoLock(options);
  await writeJson(lockPath, lock);
  return lock;
}

export async function runTrainStage(options = {}) {
  const lock = await createPgoLock(options);
  ensureScenariosHaveFiles(lock);
  await writeJson(lockPath, lock);

  const profilesDir = join(workDir, "profiles");
  const profdataPath = join(distDir, "jxl.profdata");
  const trainOutJs = join(distDir, "jxl-core.enc.simd.pgo-train.js");
  const trainOutWasm = join(distDir, "jxl-core.enc.simd.pgo-train.wasm");

  await rm(profilesDir, { recursive: true, force: true });
  await mkdir(profilesDir, { recursive: true });
  await logStep("train", "ensure libjxl source", () => ensureLibjxlSource());
  await logStep("train", "ensure libjxl deps", () => ensureLibjxlDeps());
  await logStep("train", "build enc simd instrumented module", () => buildEncSimd({
    mode: "generate",
    outJs: trainOutJs,
    outWasm: trainOutWasm,
    profilesDir
  }));
  await logStep("train", "run corpus trainer", () => runTrainer({
    moduleJs: trainOutJs,
    moduleWasm: trainOutWasm,
    profilesDir,
    lockPath
  }));
  await logStep("train", "merge profraw", () => mergeProfiles(profilesDir, profdataPath));
  const profdataSha256 = await sha256File(profdataPath);
  const updated = {
    ...lock,
    pgo: {
      enabled: false,
      applied: [],
      corpusHash: lock.corpusHash,
      profdataSha256,
      scenarios: lock.scenarios.map(({ name, weight, op, effort, levels, files }) => ({ name, weight, op, effort, levels, files }))
    }
  };
  await writeJson(lockPath, updated);
  console.log(`[pgo] train stage ready: ${relative(packageRoot, profdataPath)}`);
  return updated;
}

export async function runApplyStage(options = {}) {
  const existing = await readExistingLock();
  const lock = existing ?? await createPgoLock(options);
  ensureScenariosHaveFiles(lock);

  const profdataPath = join(distDir, "jxl.profdata");
  await access(profdataPath, fsConstants.R_OK);
  const profdataSha256 = await sha256File(profdataPath);
  await logStep("apply", "ensure libjxl source", () => ensureLibjxlSource());
  await logStep("apply", "ensure libjxl deps", () => ensureLibjxlDeps());
  await logStep("apply", "build enc simd with profile-use", () => buildEncSimd({
    mode: "use",
    outJs: join(distDir, "jxl-core.enc.simd.js"),
    outWasm: join(distDir, "jxl-core.enc.simd.wasm"),
    profdataPath
  }));

  const updated = {
    ...lock,
    pgo: {
      enabled: true,
      applied: ["enc:simd"],
      corpusHash: lock.corpusHash,
      profdataSha256,
      scenarios: lock.scenarios.map(({ name, weight, op, effort, levels, files }) => ({ name, weight, op, effort, levels, files }))
    }
  };
  await writeJson(lockPath, updated);
  await mergeIntoBuildManifest(updated.pgo);
  console.log("[pgo] apply stage complete: enc:simd built with profile-use");
  return updated;
}

export async function runFullPgoPipeline(options = {}) {
  await runTrainStage(options);
  return await runApplyStage(options);
}

export async function runConfigureProbe(options = {}) {
  const lock = await createPgoLock(options);
  ensureScenariosHaveFiles(lock);
  const probeDir = join(workDir, `pgo-configure-probe-${process.pid}-${Date.now()}`);
  await rm(probeDir, { recursive: true, force: true });
  await mkdir(probeDir, { recursive: true });
  await logStep("probe", "ensure libjxl source", () => ensureLibjxlSource());
  await logStep("probe", "ensure libjxl deps", () => ensureLibjxlDeps());

  const tierFlags = [...encTierFlags, "-sENVIRONMENT=node", "-sFILESYSTEM=1", "-sNODERAWFS=1"];
  const cmakeArgs = [
    "-S",
    sourceDir,
    "-B",
    probeDir,
    "-G",
    "Ninja",
    "-DCMAKE_BUILD_TYPE=Release",
    "-DBUILD_TESTING=OFF",
    "-DJPEGXL_ENABLE_TOOLS=OFF",
    "-DJPEGXL_ENABLE_EXAMPLES=OFF",
    "-DJPEGXL_ENABLE_BENCHMARK=OFF",
    "-DJPEGXL_ENABLE_JPEGLI=OFF",
    "-DTHREADS_PREFER_PTHREAD_FLAG=ON",
    "-DCMAKE_HAVE_LIBC_PTHREAD=1",
    "-DCMAKE_USE_PTHREADS_INIT=1",
    "-DCMAKE_THREAD_LIBS_INIT=-pthread",
    "-DCMAKE_REQUIRED_FLAGS=-pthread",
    "-DCMAKE_REQUIRED_LIBRARIES=-latomic",
    "-DCMAKE_REQUIRED_LINK_OPTIONS=-pthread",
    "-DCMAKE_C_COMPILER_CLANG_SCAN_DEPS:FILEPATH=",
    "-DCMAKE_CXX_COMPILER_CLANG_SCAN_DEPS:FILEPATH=",
    `-DPKG_CONFIG_EXECUTABLE:FILEPATH=${toCmakePath(join(packageRoot, "cmake-shims", "pkg-config-disabled.bat"))}`,
    "-DCMAKE_C_COMPILER_FORCED=TRUE",
    "-DCMAKE_CXX_COMPILER_FORCED=TRUE",
    "-DCMAKE_CXX_LINK_PIE_SUPPORTED=0",
    "-DCMAKE_CXX_LINK_NO_PIE_SUPPORTED=0",
    "-DCXX_FUZZERS_SUPPORTED=0",
    "-DCXX_MACRO_PREFIX_MAP=1",
    "-DCXX_NO_RTTI_SUPPORTED=1",
    "-DJXL_HWY_DISABLED_TARGETS_FORCED=1",
    "-DHWY_EMSCRIPTEN=1",
    "-DHWY_RISCV=0",
    "-DATOMICS_LOCK_FREE_INSTRUCTIONS=1",
    "-DCMAKE_CXX_SCAN_FOR_MODULES=OFF",
    "-DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY",
    `-DCMAKE_MODULE_PATH=${toCmakePath(join(packageRoot, "cmake-shims"))}`
  ];
  const env = {
    ...buildPgoToolEnv(),
    CFLAGS: tierFlags.join(" "),
    CXXFLAGS: tierFlags.join(" "),
    LDFLAGS: tierFlags.join(" ")
  };
  await logStep("probe", "configure enc simd", () => runEmscripten(emcmakeBinary, ["cmake", ...cmakeArgs], { cwd: packageRoot, env }));
  console.log(`[pgo:probe] configure complete: ${probeDir}`);
}

async function createPgoLock(options = {}) {
  await mkdir(distDir, { recursive: true });
  const manifestPath = options.manifestPath ?? corpusManifestPath;
  const sourceLabel = options.source ?? "jxl-test-corpus/pgo-manifest.json";
  let manifestText;
  try {
    manifestText = await readFile(manifestPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`PGO corpus manifest not found at ${manifestPath}`);
    }
    throw error;
  }
  const manifest = normalizeManifest(JSON.parse(manifestText));
  const canonicalManifest = canonicalize(manifest);
  const scenarios = await resolveManifestScenarios(manifest, dirname(manifestPath));
  const fileEntries = await hashScenarioFiles(scenarios);
  const corpusHash = createHash("sha256")
    .update(canonicalManifest)
    .update("\n")
    .update(fileEntries.map((entry) => `${entry.path}:${entry.sha256}`).join("\n"))
    .digest("hex");
  return {
    corpusManifestPath: manifestPath,
    source: sourceLabel,
    corpusHash,
    summary: {
      files: fileEntries.length,
      bytes: fileEntries.reduce((sum, entry) => sum + entry.bytes, 0)
    },
    manifest: JSON.parse(canonicalManifest),
    scenarios,
    files: fileEntries.map(({ path, sha256, bytes }) => ({ path, sha256, bytes }))
  };
}

function normalizeManifest(raw) {
  if (Array.isArray(raw?.scenarios)) {
    return {
      version: raw.version ?? 2,
      scenarios: raw.scenarios.map((scenario) => ({
        name: String(scenario.name),
        weight: Number(scenario.weight ?? 1),
        op: String(scenario.op ?? "encode"),
        files: Array.isArray(scenario.files) ? scenario.files.map(String) : [],
        effort: scenario.effort == null ? null : Number(scenario.effort),
        levels: scenario.levels == null ? null : Number(scenario.levels),
        note: scenario.note == null ? null : String(scenario.note)
      }))
    };
  }
  if (Array.isArray(raw?.pgo_fixtures)) {
    return {
      version: 1,
      scenarios: raw.pgo_fixtures.map((name) => ({
        name: String(name),
        weight: 1,
        op: "encode",
        files: [],
        effort: 3,
        levels: null,
        note: "Legacy v1 manifest entry; no file globs recorded"
      }))
    };
  }
  throw new Error("Unsupported PGO manifest schema: expected `scenarios` or legacy `pgo_fixtures`");
}

async function resolveManifestScenarios(manifest, manifestDir) {
  const scenarios = [];
  for (const scenario of manifest.scenarios) {
    const files = new Set();
    for (const pattern of scenario.files) {
      for (const match of await expandGlob(manifestDir, pattern)) {
        files.add(match);
      }
    }
    scenarios.push({
      ...scenario,
      files: [...files].sort((a, b) => a.localeCompare(b))
    });
  }
  return scenarios;
}

async function hashScenarioFiles(scenarios) {
  const seen = new Set();
  const entries = [];
  for (const scenario of scenarios) {
    for (const file of scenario.files) {
      if (seen.has(file)) continue;
      seen.add(file);
      const sha256 = await sha256File(file);
      const stat = await import("node:fs/promises").then((fs) => fs.stat(file));
      entries.push({ path: file, sha256, bytes: stat.size });
    }
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}

function ensureScenariosHaveFiles(lock) {
  if (lock.summary.files > 0) return;
  throw new Error(`PGO corpus at ${lock.corpusManifestPath} resolved 0 training files. Add scenario globs with real pixels before running full PGO.`);
}

async function expandGlob(root, pattern) {
  const normalized = pattern.replaceAll("\\", "/");
  const star = normalized.indexOf("*");
  if (star < 0) {
    const resolved = resolve(root, normalized);
    try {
      await access(resolved, fsConstants.R_OK);
      return [resolved];
    } catch {
      return [];
    }
  }
  const slash = normalized.lastIndexOf("/", star);
  const dirPart = slash >= 0 ? normalized.slice(0, slash) : "";
  const filePattern = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  const dir = resolve(root, dirPart);
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const regex = globToRegExp(filePattern);
  return entries
    .filter((entry) => entry.isFile() && regex.test(entry.name))
    .map((entry) => join(dir, entry.name));
}

async function listFilesRecursive(root) {
  const out = [];
  async function visit(dir) {
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        out.push(path);
      }
    }
  }
  await visit(root);
  return out;
}

function globToRegExp(pattern) {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      out += ".*";
    } else if (ch === "?") {
      out += ".";
    } else if (/[\\^$+?.()|[\]{}]/.test(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  out += "$";
  return new RegExp(out);
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function runTrainer({ moduleJs, moduleWasm, profilesDir, lockPath }) {
  const trainerPath = join(__dirname, "pgo-train.mjs");
  const llvmProfileFile = join(profilesDir, "jxl-%p-%m.profraw");
  await run("node", [trainerPath], {
    cwd: packageRoot,
    env: {
      ...process.env,
      JXL_PGO_MODULE_JS: moduleJs,
      JXL_PGO_MODULE_WASM: moduleWasm,
      JXL_PGO_LOCK_PATH: lockPath,
      LLVM_PROFILE_FILE: llvmProfileFile
    }
  });
}

async function mergeProfiles(profilesDir, profdataPath) {
  const profrawFiles = (await listFilesRecursive(profilesDir)).filter((file) => file.endsWith(".profraw"));
  if (profrawFiles.length === 0) {
    throw new Error(`PGO training produced no .profraw files under ${profilesDir}`);
  }
  console.log(`[pgo] merge ${profrawFiles.length} profraw files`);
  await run("llvm-profdata", ["merge", "-output", profdataPath, ...profrawFiles], { cwd: packageRoot });
}

async function buildEncSimd({ mode, outJs, outWasm, profilesDir, profdataPath }) {
  const buildDir = join(workDir, `pgo-enc-simd-${mode}-${process.pid}-${Date.now()}`);
  await rm(buildDir, { recursive: true, force: true });
  await mkdir(buildDir, { recursive: true });

  const tierFlags = [...encTierFlags];
  if (mode === "generate") {
    tierFlags.push(`-fprofile-generate=${profilesDir}`, ...trainEnvFlags);
  } else if (mode === "use") {
    tierFlags.push(`-fprofile-use=${profdataPath}`, ...applyProfileFlags);
  }

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
    "-DTHREADS_PREFER_PTHREAD_FLAG=ON",
    "-DCMAKE_HAVE_LIBC_PTHREAD=1",
    "-DCMAKE_USE_PTHREADS_INIT=1",
    "-DCMAKE_THREAD_LIBS_INIT=-pthread",
    "-DCMAKE_REQUIRED_FLAGS=-pthread",
    "-DCMAKE_REQUIRED_LIBRARIES=-latomic",
    "-DCMAKE_REQUIRED_LINK_OPTIONS=-pthread",
    "-DCMAKE_C_COMPILER_CLANG_SCAN_DEPS:FILEPATH=",
    "-DCMAKE_CXX_COMPILER_CLANG_SCAN_DEPS:FILEPATH=",
    `-DPKG_CONFIG_EXECUTABLE:FILEPATH=${toCmakePath(join(packageRoot, "cmake-shims", "pkg-config-disabled.bat"))}`,
    "-DCMAKE_C_COMPILER_FORCED=TRUE",
    "-DCMAKE_CXX_COMPILER_FORCED=TRUE",
    "-DCMAKE_CXX_LINK_PIE_SUPPORTED=0",
    "-DCMAKE_CXX_LINK_NO_PIE_SUPPORTED=0",
    "-DCXX_FUZZERS_SUPPORTED=0",
    "-DCXX_MACRO_PREFIX_MAP=1",
    "-DCXX_NO_RTTI_SUPPORTED=1",
    "-DJXL_HWY_DISABLED_TARGETS_FORCED=1",
    "-DHWY_EMSCRIPTEN=1",
    "-DHWY_RISCV=0",
    "-DATOMICS_LOCK_FREE_INSTRUCTIONS=1",
    "-DCMAKE_CXX_SCAN_FOR_MODULES=OFF",
    "-DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY",
    `-DCMAKE_MODULE_PATH=${toCmakePath(join(packageRoot, "cmake-shims"))}`
  ];

  const env = {
    ...buildPgoToolEnv(),
    CFLAGS: tierFlags.join(" "),
    CXXFLAGS: tierFlags.join(" "),
    LDFLAGS: tierFlags.join(" ")
  };

  console.log(`[pgo] configure ${mode} build: ${buildDir}`);
  await runEmscripten(emcmakeBinary, ["cmake", ...cmakeArgs], { cwd: packageRoot, env });
  console.log(`[pgo] build ${mode} build: ${buildDir}`);
  await run("cmake", ["--build", buildDir, "-j", String(osCpusMinusOne())], { cwd: packageRoot, env });

  try {
    console.log(`[pgo] link ${mode} bridge: ${outJs}`);
    await linkBridge({ buildDir, outJs, outWasm, tierFlags, env });
  } catch (error) {
    if (mode !== "generate" || !tierFlags.includes("-flto")) throw error;
    const fallbackFlags = tierFlags.filter((flag, index) => !(flag === "-flto" && index === tierFlags.indexOf("-flto")));
    const fallbackEnv = {
      ...env,
      CFLAGS: fallbackFlags.join(" "),
      CXXFLAGS: fallbackFlags.join(" "),
      LDFLAGS: fallbackFlags.join(" ")
    };
    await rm(buildDir, { recursive: true, force: true });
    await mkdir(buildDir, { recursive: true });
    console.log(`[pgo] retry configure ${mode} build without -flto: ${buildDir}`);
    await runEmscripten(emcmakeBinary, ["cmake", ...cmakeArgs], { cwd: packageRoot, env: fallbackEnv });
    console.log(`[pgo] retry build ${mode} build without -flto: ${buildDir}`);
    await run("cmake", ["--build", buildDir, "-j", String(osCpusMinusOne())], { cwd: packageRoot, env: fallbackEnv });
    console.log(`[pgo] retry link ${mode} bridge without -flto: ${outJs}`);
    await linkBridge({ buildDir, outJs, outWasm, tierFlags: fallbackFlags, env: fallbackEnv });
  }
}

async function linkBridge({ buildDir, outJs, outWasm, tierFlags, env }) {
  const archives = await findStaticArchives(buildDir);
  const includeDirs = [
    join(sourceDir, "lib", "include"),
    sourceDir,
    buildDir,
    join(buildDir, "lib", "include")
  ];
  await runEmscripten(emppBinary, [
    join(packageRoot, "src", "bridge.cpp"),
    ...includeDirs.flatMap((dir) => ["-I", dir]),
    ...sortArchivesForLink(archives),
    "-o",
    outJs,
    ...tierFlags,
    `-sEXPORTED_FUNCTIONS=@${toCmakePath(join(packageRoot, "exports-enc.txt"))}`,
    "--closure", "1",
    "-sEVAL_CTORS=2"
  ], { cwd: packageRoot, env });
  const wasmBytes = await readFile(outWasm);
  if (!WebAssembly.validate(wasmBytes)) {
    throw new Error(`PGO build produced invalid wasm: ${outWasm}`);
  }
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
    const info = await stat(sourceDir);
    if (!info.isDirectory()) throw new Error("libjxl source path is not a directory");
    await access(join(sourceDir, ".git"), fsConstants.R_OK);
    return;
  } catch {
    await rm(sourceDir, { recursive: true, force: true });
  }

  await runGit([
    "clone",
    "--recursive",
    "--shallow-submodules",
    "--branch",
    config.libjxlTag,
    "--depth",
    "1",
    config.libjxlRepo,
    sourceDir
  ], { cwd: packageRoot });
  const head = await runGitCapture(["-C", sourceDir, "rev-parse", "HEAD"]);
  if (head.trim() !== config.libjxlCommit) {
    throw new Error(`libjxl HEAD ${head.trim()} does not match pinned commit ${config.libjxlCommit}`);
  }
}

async function ensureLibjxlDeps() {
  if (await hasReadyLibjxlDeps()) return;
  if (process.platform === "win32") {
    await populateLibjxlSubmodulesDirectly();
    if (await hasReadyLibjxlDeps()) return;
  }
  await run(bashBinary, ["deps.sh"], { cwd: sourceDir });
}

async function mergeIntoBuildManifest(pgo) {
  const manifestPath = join(distDir, "build-manifest.json");
  let manifest = null;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return;
  }
  manifest.pgo = pgo;
  await writeJson(manifestPath, manifest);
}

async function hasReadyLibjxlDeps() {
  const sentinels = [
    join(sourceDir, "third_party", "brotli", "c", "common", "constants.h"),
    join(sourceDir, "third_party", "highway", "hwy", "highway.h"),
    join(sourceDir, "third_party", "skcms", "skcms.h"),
    join(sourceDir, "third_party", "libpng", "png.h"),
    join(sourceDir, "third_party", "libjpeg-turbo", "CMakeLists.txt"),
    join(sourceDir, "third_party", "zlib", "zlib.h"),
    join(sourceDir, "third_party", "sjpeg", "src", "enc.cc")
  ];
  for (const sentinel of sentinels) {
    try {
      await access(sentinel, fsConstants.R_OK);
    } catch {
      return false;
    }
  }
  return true;
}

async function populateLibjxlSubmodulesDirectly() {
  for (const mod of windowsSubmoduleFallbacks) {
    await cloneSubmoduleAtCommit(mod);
  }
}

async function cloneSubmoduleAtCommit(mod) {
  const targetDir = join(sourceDir, mod.path.replaceAll("/", "\\"));
  const gitDir = join(targetDir, ".git");
  try {
    const head = await runGitCapture(["-C", targetDir, "rev-parse", "HEAD"]);
    if (head.trim() === mod.commit) return;
  } catch {}

  await rm(targetDir, { recursive: true, force: true });
  await mkdir(dirname(targetDir), { recursive: true });
  await runGit(["init", targetDir], { cwd: packageRoot });
  await runGit(["-C", targetDir, "remote", "add", "origin", mod.url], { cwd: packageRoot });
  await runGit(["-C", targetDir, "fetch", "--depth", "1", "origin", mod.commit], { cwd: packageRoot });
  await runGit(["-C", targetDir, "checkout", "--detach", "FETCH_HEAD"], { cwd: packageRoot });
  try {
    await access(gitDir, fsConstants.R_OK);
  } catch {
    throw new Error(`Submodule clone missing .git dir: ${mod.path}`);
  }
}

async function readExistingLock() {
  try {
    return JSON.parse(await readFile(lockPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function sha256File(path) {
  const hash = createHash("sha256");
  await new Promise((resolvePromise, rejectPromise) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolvePromise);
    stream.on("error", rejectPromise);
  });
  return hash.digest("hex");
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function osCpusMinusOne() {
  const count = process.env.CPU_COUNT
    ? Number(process.env.CPU_COUNT)
    : (os.availableParallelism?.() ?? os.cpus().length);
  return Math.max(1, count - 1);
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: "inherit",
      shell: options.shell ?? false
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
      shell: options.shell ?? false
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

function runGit(args, options = {}) {
  if (process.platform === "win32") {
    return run("cmd", ["/c", gitBinary, ...args], options);
  }
  return run(gitBinary, args, options);
}

function runGitCapture(args, options = {}) {
  if (process.platform === "win32") {
    return runCapture("cmd", ["/c", gitBinary, ...args], options);
  }
  return runCapture(gitBinary, args, options);
}

function runEmscripten(command, args, options = {}) {
  if (process.platform === "win32" && command.endsWith(".bat")) {
    return run(command, args, { ...options, shell: true });
  }
  return run(command, args, options);
}

async function logStep(stage, label, fn) {
  const started = Date.now();
  console.log(`[pgo:${stage}] start ${label}`);
  try {
    const result = await fn();
    console.log(`[pgo:${stage}] done ${label} in ${Date.now() - started}ms`);
    return result;
  } catch (error) {
    console.log(`[pgo:${stage}] fail ${label} after ${Date.now() - started}ms`);
    throw error;
  }
}

function resolveEmscriptenBinary(name) {
  const root = process.env.EMSDK;
  if (!root) return name;
  if (process.platform === "win32") {
    return join(root, "upstream", "emscripten", `${name}.bat`);
  }
  return join(root, "upstream", "emscripten", name);
}

function resolveCmakeBinary() {
  if (process.platform === "win32") {
    return "C:\\Program Files\\CMake\\bin\\cmake.exe";
  }
  return "cmake";
}

function resolveBashBinary() {
  if (process.platform === "win32") {
    return "C:\\Program Files\\Git\\bin\\bash.exe";
  }
  return "bash";
}

function resolveGitBinary() {
  if (process.env.GIT_BIN) return process.env.GIT_BIN;
  if (process.platform === "win32") {
    return "C:\\Program Files\\Git\\cmd\\git.exe";
  }
  return "git";
}

function buildPgoToolEnv() {
  const pathEntries = [];
  const add = (value) => {
    if (!value) return;
    for (const entry of String(value).split(pathDelimiter())) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      if (!pathEntries.includes(trimmed)) {
        pathEntries.push(trimmed);
      }
    }
  };

  add(dirname(emcmakeBinary));
  add(dirname(emppBinary));
  add(process.env.EMSDK);
  add(dirname(cmakeBinary));
  add(dirname(gitBinary));
  add(dirname(bashBinary));

  const keepPathEntry = (entry) => {
    if (!entry) return false;
    const normalized = entry.replaceAll("/", "\\").toLowerCase();
    return normalized.includes("\\emsdk")
      || normalized.includes("\\cmake\\bin")
      || normalized.includes("\\git\\cmd")
      || normalized.includes("\\git\\bin")
      || normalized.includes("\\windows\\system32")
      || normalized === "c:\\windows"
      || normalized.includes("\\powershell\\7")
      || normalized.includes("\\nodejs")
      || normalized.includes("\\python")
      || normalized.includes("ninja-build.ninja");
  };

  for (const entry of String(process.env.PATH ?? "").split(pathDelimiter())) {
    if (keepPathEntry(entry.trim())) {
      add(entry);
    }
  }

  return {
    ...process.env,
    PATH: pathEntries.join(pathDelimiter())
  };
}

function pathDelimiter() {
  return process.platform === "win32" ? ";" : ":";
}

function toCmakePath(path) {
  return path.replaceAll("\\", "/");
}

function parseArgs(argv) {
  return {
    stageOnly: argv.includes("--stage-only"),
    trainOnly: argv.includes("--train"),
    applyOnly: argv.includes("--apply"),
    configureOnly: argv.includes("--configure-only")
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.stageOnly) {
    const lock = await stagePgoLock();
    console.log(`[pgo] staged corpus lock: ${lock.summary.files} files, ${lock.summary.bytes} bytes`);
    return;
  }
  if (args.trainOnly) {
    await runTrainStage();
    return;
  }
  if (args.applyOnly) {
    await runApplyStage();
    return;
  }
  if (args.configureOnly) {
    await runConfigureProbe();
    return;
  }
  await runFullPgoPipeline();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
