import type { JxlModuleFactory } from "@casabio/jxl-wasm";

// Loads the rebuilt scalar WASM from the sibling package's dist (Plan A Task 3 output).
export async function loadScalarModule() {
  const imported = await import("../../jxl-wasm/dist/jxl-core.scalar.js");
  if (typeof imported.default !== "function") {
    throw new Error("jxl-core.scalar.js did not export a loader function");
  }
  const baseUrl = new URL("../../jxl-wasm/dist/", import.meta.url);
  const module = await imported.default({
    locateFile: (path: string) => new URL(path, baseUrl).href,
  });
  if (!module || typeof module._malloc !== "function") {
    throw new Error("scalar WASM module missing required exports");
  }
  return module;
}

/** A factory that always returns the loaded scalar module (for setJxlModuleFactoryForTesting). */
export function scalarFactory(module: Awaited<ReturnType<typeof loadScalarModule>>): JxlModuleFactory {
  return (async () => module) as unknown as JxlModuleFactory;
}
