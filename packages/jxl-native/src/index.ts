import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export class CapabilityMissing extends Error {
  readonly code = "CapabilityMissing";
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "CapabilityMissing";
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

export interface NativeBinding {
  version(): string;
  probe(): {
    loaded: boolean;
    path: string;
  };
}

export interface NativeLoaderOptions {
  prebuiltPath?: string;
  sourcePath?: string;
}

const require = createRequire(import.meta.url);
const packageRoot = dirname(fileURLToPath(import.meta.url));

export function loadNativeBinding(options: NativeLoaderOptions = {}): NativeBinding {
  const candidates = [
    options.prebuiltPath ?? resolvePrebuiltBinary(),
    options.sourcePath ?? resolveSourceBinary()
  ];

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return require(candidate) as NativeBinding;
    } catch (error) {
      lastError = error;
    }
  }

  throw new CapabilityMissing("jxl-native addon unavailable; falling back to WASM is required", lastError);
}

function resolvePrebuiltBinary(): string {
  const platform = process.platform;
  const arch = process.arch;
  const base = join(packageRoot, "..", "prebuilds");
  const candidate = resolve(base, `${platform}-${arch}`, "jxl-native.node");
  return candidate;
}

function resolveSourceBinary(): string {
  const release = resolve(packageRoot, "..", "build", "Release", "jxl_native.node");
  const debug = resolve(packageRoot, "..", "build", "Debug", "jxl_native.node");
  return fileExists(release) ? release : fileExists(debug) ? debug : release;
}

function fileExists(path: string): boolean {
  try {
    require("node:fs").accessSync(path);
    return true;
  } catch {
    return false;
  }
}
