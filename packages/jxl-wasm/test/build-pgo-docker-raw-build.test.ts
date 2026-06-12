import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const buildPgoSource = readFileSync(new URL("../scripts/build-pgo.mjs", import.meta.url), "utf8");
const dockerfileSource = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
const rawBuildSource = readFileSync(new URL("../../../build-parallel-wasm.ps1", import.meta.url), "utf8");

test("build-pgo exposes staged and full-pipeline entrypoints", () => {
  expect(buildPgoSource).toContain("--stage-only");
  expect(buildPgoSource).toContain("--train");
  expect(buildPgoSource).toContain("--apply");
  expect(buildPgoSource).toContain("llvm-profdata");
  expect(buildPgoSource).toContain("-fprofile-generate=");
  expect(buildPgoSource).toContain("-fprofile-use=");
  expect(buildPgoSource).toContain("profdataSha256");
  expect(buildPgoSource).toContain("scenarios");
  expect(buildPgoSource).toContain("populateLibjxlSubmodulesDirectly");
  expect(buildPgoSource).toContain('git", ["-C", sourceDir, "cat-file", "-p", "HEAD:.gitmodules"]');
});

test("dockerfile warms libjxl source, emscripten cache, and ccache", () => {
  expect(dockerfileSource).toContain("ARG PGO=0");
  expect(dockerfileSource).toContain("git clone --recursive --shallow-submodules --depth 1");
  expect(dockerfileSource).toContain("./deps.sh");
  expect(dockerfileSource).toContain("embuilder build");
  expect(dockerfileSource).toContain("ccache");
  expect(dockerfileSource).toContain("EM_COMPILER_WRAPPER=ccache");
  expect(dockerfileSource).toContain("EMCC_SKIP_SANITY_CHECK=1");
  expect(dockerfileSource).toContain("safe.directory '*'");
});

test("parallel raw build pins toolchain, validates wasm-bindgen, and optimizes with SIMD-aware wasm-opt", () => {
  expect(rawBuildSource).toContain("param([string[]]$Features = @('parallel-wasm'))");
  expect(rawBuildSource).toContain('$nightly = "nightly-2026-06-01"');
  expect(rawBuildSource).toContain('& cargo "+$nightly" build');
  expect(rawBuildSource).toContain("--locked");
  expect(rawBuildSource).toContain("--enable-simd");
  expect(rawBuildSource).toContain("--enable-mutable-globals");
  expect(rawBuildSource).toContain("--enable-nontrapping-float-to-int");
  expect(rawBuildSource).toContain("--enable-sign-ext");
  expect(rawBuildSource).toContain("build-manifest.json");
  expect(rawBuildSource).toContain("Copy-Item -Recurse -Force $pkgDir $webPkgDir");
  expect(rawBuildSource).toContain("wasm-bindgen-cli");
});
