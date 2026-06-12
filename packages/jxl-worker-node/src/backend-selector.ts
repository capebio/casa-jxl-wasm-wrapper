// jxl-worker-node/src/backend-selector.ts
// Selects native libjxl vs WASM at worker startup.
// Spec: Section 15.2, T-WORKER-NODE brief.

export interface Backend {
  type: "native" | "wasm";
  module: CodecModule;
}

export interface CodecModule {
  createDecoder: (...args: never[]) => unknown;
  createEncoder: (...args: never[]) => unknown;
}

export interface BackendSelectorOptions {
  env?: Record<string, string | undefined>;
  importNative?: () => Promise<unknown>;
  importWasm?: () => Promise<unknown>;
  onDiagnostic?: (msg: string) => void;
}

export async function selectBackend(options: BackendSelectorOptions = {}): Promise<Backend> {
  const env = options.env ?? process.env;
  const forceWasm = env["JXL_FORCE_WASM"] === "1";
  const forceNative = env["JXL_FORCE_NATIVE"] === "1";
  const diagnostics: string[] = [];
  const onDiagnostic = options.onDiagnostic ?? ((msg) => diagnostics.push(msg));

  if (forceWasm && forceNative) {
    throw new Error("[jxl-worker-node] Conflict: Both JXL_FORCE_WASM and JXL_FORCE_NATIVE are set to 1.");
  }

  if (!forceWasm) {
    const native = await tryNative({ ...options, onDiagnostic }, diagnostics);
    if (native !== null) return native;
  } else {
    onDiagnostic("JXL_FORCE_WASM is set, skipping native backend");
  }

  if (forceNative) {
    throw new Error(
      `[jxl-worker-node] JXL_FORCE_NATIVE=1 but native backend failed to load. Diagnostics:\n${diagnostics.join("\n")}`
    );
  }

  const wasm = await tryWasm({ ...options, onDiagnostic }, diagnostics);
  if (wasm !== null) return wasm;

  throw new Error(
    `[jxl-worker-node] Neither jxl-native nor jxl-wasm exposes a codec facade. ` +
      `Install usable @casabio/jxl-native or @casabio/jxl-wasm artifacts. Diagnostics:\n${diagnostics.join("\n")}`,
  );
}

async function tryNative(options: BackendSelectorOptions, diagnostics: string[]): Promise<Backend | null> {
  const onDiagnostic = options.onDiagnostic ?? ((msg) => diagnostics.push(msg));
  try {
    const imported = await (options.importNative ?? defaultImportNative)();
    if (imported === null) {
      onDiagnostic("Failed to import @casabio/jxl-native (returned null)");
      return null;
    }
    const module = resolveCodecModule(imported, onDiagnostic);
    if (module === null) {
      onDiagnostic("Failed to resolve native codec module from import");
      return null;
    }
    return { type: "native", module };
  } catch (err) {
    const msg = `Native import failed: ${err instanceof Error ? err.stack || err.message : String(err)}`;
    onDiagnostic(msg);
    return null;
  }
}

async function tryWasm(options: BackendSelectorOptions, diagnostics: string[]): Promise<Backend | null> {
  const onDiagnostic = options.onDiagnostic ?? ((msg) => diagnostics.push(msg));
  try {
    const imported = await (options.importWasm ?? defaultImportWasm)();
    if (imported === null) {
      onDiagnostic("Failed to import @casabio/jxl-wasm (returned null)");
      return null;
    }
    const module = resolveCodecModule(imported, onDiagnostic);
    if (module === null) {
      onDiagnostic("Failed to resolve WASM codec module from import");
      return null;
    }
    return { type: "wasm", module };
  } catch (err) {
    const msg = `WASM import failed: ${err instanceof Error ? err.stack || err.message : String(err)}`;
    onDiagnostic(msg);
    return null;
  }
}

async function defaultImportNative(): Promise<unknown> {
  // Dynamic import keeps worker startup clean when optional package absent.
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore - module may be absent until local packages are installed
  return await import("@casabio/jxl-native").catch(() => null) as unknown;
}

async function defaultImportWasm(): Promise<unknown> {
  // Dynamic import keeps worker startup clean when optional package absent.
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore - module may be absent until local packages are installed
  return await import("@casabio/jxl-wasm").catch(() => null) as unknown;
}

function resolveCodecModule(value: unknown, onDiagnostic?: (msg: string) => void): CodecModule | null {
  const candidates = [value, isRecord(value) ? value["default"] : undefined];
  let index = 0;
  for (const c of candidates) {
    const suffix = index === 0 ? "" : " (default)";
    index++;
    if (c === undefined) continue;
    if (!isRecord(c)) {
      onDiagnostic?.(`Candidate${suffix} is not a record/object`);
      continue;
    }
    if (typeof c["loadNativeBinding"] === "function") {
      try {
        const binding = (c["loadNativeBinding"] as () => unknown)();
        if (!isLoadedBinding(binding, onDiagnostic)) {
          onDiagnostic?.(`Candidate${suffix} loadNativeBinding returned an unloaded binding`);
          continue;
        }
        if (isCodecModule(binding)) {
          return binding;
        } else {
          onDiagnostic?.(`Candidate${suffix} loadNativeBinding returned a module missing createDecoder/createEncoder`);
        }
      } catch (err) {
        onDiagnostic?.(`Candidate${suffix} loadNativeBinding threw: ${err instanceof Error ? err.message : String(err)}`);
      }
      continue;
    }
    if (isCodecModule(c)) {
      return c;
    } else {
      onDiagnostic?.(`Candidate${suffix} is missing createDecoder/createEncoder`);
    }
  }
  return null;
}

function isCodecModule(value: unknown): value is CodecModule {
  return isRecord(value) && typeof value["createDecoder"] === "function" && typeof value["createEncoder"] === "function";
}

function isLoadedBinding(value: unknown, onDiagnostic?: (msg: string) => void): value is CodecModule {
  if (!isRecord(value)) {
    onDiagnostic?.("Binding is not a record");
    return false;
  }
  if (typeof value["probe"] === "function") {
    try {
      const probe = value["probe"]();
      if (!isRecord(probe)) {
        onDiagnostic?.("Binding probe did not return a record");
        return false;
      }
      if (probe["loaded"] !== true) {
        onDiagnostic?.(`Binding probe.loaded is not true (loaded: ${probe["loaded"]})`);
        return false;
      }
    } catch (err) {
      onDiagnostic?.(`Binding probe threw: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
