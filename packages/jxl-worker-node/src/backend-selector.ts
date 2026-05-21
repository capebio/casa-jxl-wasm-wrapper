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
}

export async function selectBackend(options: BackendSelectorOptions = {}): Promise<Backend> {
  const env = options.env ?? process.env;
  const forceWasm = env["JXL_FORCE_WASM"] === "1";

  if (!forceWasm) {
    const native = await tryNative(options);
    if (native !== null) return native;
  }

  const wasm = await tryWasm(options);
  if (wasm !== null) return wasm;

  throw new Error(
    "[jxl-worker-node] Neither jxl-native nor jxl-wasm exposes a codec facade. " +
      "Install usable @casabio/jxl-native or @casabio/jxl-wasm artifacts.",
  );
}

async function tryNative(options: BackendSelectorOptions): Promise<Backend | null> {
  try {
    const imported = await (options.importNative ?? defaultImportNative)();
    const module = resolveCodecModule(imported);
    if (module === null) return null;
    return { type: "native", module };
  } catch {
    return null;
  }
}

async function tryWasm(options: BackendSelectorOptions): Promise<Backend | null> {
  try {
    const imported = await (options.importWasm ?? defaultImportWasm)();
    const module = resolveCodecModule(imported);
    if (module === null) return null;
    return { type: "wasm", module };
  } catch {
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

function resolveCodecModule(value: unknown): CodecModule | null {
  if (isRecord(value) && typeof value["loadNativeBinding"] === "function") {
    try {
      const binding = value["loadNativeBinding"]();
      return isCodecModule(binding) ? binding : null;
    } catch {
      return null;
    }
  }

  if (isCodecModule(value)) return value;
  if (isRecord(value) && isCodecModule(value["default"])) return value["default"];
  return null;
}

function isCodecModule(value: unknown): value is CodecModule {
  return isRecord(value) && typeof value["createDecoder"] === "function" && typeof value["createEncoder"] === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
