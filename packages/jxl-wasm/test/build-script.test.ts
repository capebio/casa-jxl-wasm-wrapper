import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const scriptPath = new URL("../scripts/build.mjs", import.meta.url);
const source = readFileSync(scriptPath, "utf8");

test("build script uses plain JavaScript syntax", () => {
  expect(source).not.toContain(' as const;');
  expect(source).not.toContain("type ModuleKind");
  expect(source).not.toContain("kind: ModuleKind");
  expect(source).not.toContain("exportsFile: string");
  expect(source).not.toContain("initialMem: number");
});

test("skipped MT tiers are qualified by module kind", () => {
  expect(source).toContain(".flatMap((tier) => moduleKinds.map((kind) => `${kind}:${tier.name}`))");
});

test("parallelism defaults to host CPU count", () => {
  expect(source).toContain("os.availableParallelism?.() ?? os.cpus().length");
});

test("docker build forwards CLI flags", () => {
  expect(source).toContain('const passthrough = process.argv.slice(2).filter((arg) => arg !== "--inside-docker");');
  expect(source).toContain('"--inside-docker",');
  expect(source).toContain("...passthrough");
});

test("size budget violations fail after manifest write", () => {
  expect(source).toContain("const budgetViolations = [];");
  expect(source).toContain("budgetViolations.push(`${tierKey}: ${wasmArtifact.bytes} > ${budget}`);");
  expect(source).toContain('throw new Error(`Size budgets exceeded:\\n${budgetViolations.join("\\n")}`);');
});

test("build workdirs are removed after success unless keep-work is set", () => {
  expect(source).toContain('const keepWork = process.argv.includes("--keep-work");');
  expect(source).toContain("if (!keepWork) {");
  expect(source).toContain("await rmDir(buildDir);");
});

test("bridge exports are preflighted before the build matrix runs", () => {
  expect(source).toContain("await validateBridgeExports();");
  expect(source).toContain("function findBridgeExportMismatches(");
});

test("incoming Module API is trimmed to handwritten loader hooks", () => {
  expect(source).toContain('return "-sINCOMING_MODULE_JS_API=locateFile,wasmBinary";');
});

test("artifact metadata records wire bytes and SRI hashes", () => {
  expect(source).toContain("jsBrotliBytes");
  expect(source).toContain("wasmBrotliBytes");
  expect(source).toContain("jsIntegrity");
  expect(source).toContain("wasmIntegrity");
  expect(source).toContain('sha384-${createHash("sha384").update(data).digest("base64")}');
});

test("wasm artifacts are validated and checked against exports files", () => {
  expect(source).toContain("await validateWasmArtifact(outWasm, exportsFile, tierKey");
  expect(source).toContain("WebAssembly.Module.exports(module)");
  expect(source).toContain('throw new Error(`${tierKey}: exports missing from wasm: ${missing.join(", ")}`);');
});

test("size report can request symbol maps and prints real rebuild command", () => {
  expect(source).toContain('const sizeReportRequested = process.argv.includes("--size-report");');
  expect(source).toContain('"--emit-symbol-map"');
  expect(source).toContain('formatBuildCommand(["--size-report"])');
});
