// Shared JxlContext implementation. Environment-specific entry points live in
// context.ts and browser.ts so browser bundlers never see node worker imports.

import type {
  ContextOptions,
  DecodeOptions,
  DecodeSession,
  EncodeOptions,
  EncodeSession,
  Capabilities,
} from "@casabio/jxl-core";
import { Scheduler, type WorkerFactory, globalCoreBudget, defaultCoreBudgetCapacity } from "@casabio/jxl-scheduler";

import { DecodeSessionImpl } from "./decode-session.js";
import { EncodeSessionImpl } from "./encode-session.js";

// JxlContext is the jxl-session surface (spec Section 5). It is defined here,
// not in jxl-core, because jxl-core carries no runtime and no facade types.
export interface JxlContext {
  decode(opts: DecodeOptions): DecodeSession;
  encode(opts: EncodeOptions): EncodeSession;
  capabilities(): Capabilities;
  shutdown(): Promise<void>;
}

const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

// Allowed URL schemes for the caller-supplied wasmUrl (task 007-security-a1b2c3d4).
const ALLOWED_WASM_URL_PREFIXES = ["https://", "http://", "blob:", "/"];

export function validateWasmUrl(url: string): void {
  if (!ALLOWED_WASM_URL_PREFIXES.some((prefix) => url.startsWith(prefix))) {
    throw new Error(
      `[jxl-session] wasmUrl must start with https://, http://, blob:, or / (got: ${JSON.stringify(url.slice(0, 64))})`,
    );
  }
}

// Validate that a probe result has the shape of a Capabilities object.
// Guards against supply-chain or service-worker tampering (task 007-security-e5f6g7h8 /
// 007-contracts-4j5k6l). Returns null when the result is not structurally valid.
function validateCapabilities(value: unknown): Capabilities | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v["wasm"] !== "boolean" ||
    typeof v["wasmSimd"] !== "boolean" ||
    typeof v["wasmRelaxedSimd"] !== "boolean" ||
    typeof v["wasmThreads"] !== "boolean" ||
    typeof v["crossOriginIsolated"] !== "boolean" ||
    typeof v["sharedArrayBuffer"] !== "boolean" ||
    typeof v["offscreenCanvas"] !== "boolean" ||
    typeof v["imageBitmap"] !== "boolean" ||
    typeof v["nativeJxlDecoder"] !== "boolean" ||
    typeof v["selectedWasmBuild"] !== "string" ||
    typeof v["libjxlVersion"] !== "string"
  ) {
    return null;
  }
  return value as Capabilities;
}

// navigator.hardwareConcurrency is available in browsers and Node >= 21.
export function hardwareConcurrency(): number {
  const nav = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator;
  return nav?.hardwareConcurrency ?? 4;
}

// Conservative capabilities used until the async probe resolves, and as the
// permanent value if the probe is unavailable.
function defaultCapabilities(): Capabilities {
  return {
    wasm: typeof WebAssembly !== "undefined",
    wasmSimd: false,
    wasmRelaxedSimd: false,
    wasmThreads: false,
    crossOriginIsolated: false,
    sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
    offscreenCanvas: false,
    imageBitmap: false,
    nativeJxlDecoder: false,
    selectedWasmBuild: "none",
    libjxlVersion: "unknown",
  };
}

export class JxlContextImpl implements JxlContext {
  private readonly scheduler: Scheduler;
  private caps: Capabilities = defaultCapabilities();
  private shuttingDown = false;
  // Track the probe so shutdown() can guard against stale writes
  // (task 007-concurrency-a5b6c7d8).
  private probeSettled = false;

  constructor(factory: WorkerFactory, opts: ContextOptions | undefined, maxWorkers: number) {
    const workerCost = this.computeWorkerCost(opts);
    this.scheduler = new Scheduler({
      factory,
      maxWorkers,
      idleTimeoutMs: opts?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      ...(opts?.pushHwm !== undefined ? { pushHwm: opts.pushHwm } : {}),
      coreBudget: globalCoreBudget,
      workerCost,
    });
  }

  private computeWorkerCost(opts: ContextOptions | undefined): number {
    const url = opts?.wasmUrl;
    if (!url) return 1;
    try {
      // Supports relative or absolute worker script URLs carrying ?jxlWorkerTier=...
      const u = new URL(url, "https://dummy.invalid");
      const tier = u.searchParams.get("jxlWorkerTier");
      if (tier === "relaxed-simd-mt" || tier === "simd-mt") {
        return defaultCoreBudgetCapacity();
      }
    } catch {
      // malformed url -> conservative ST cost
    }
    return 1;
  }

  // Kick off the async capability probe; capabilities() returns the cached
  // value, which updates once the probe resolves.
  probeCapabilities(): void {
    void (async () => {
      try {
        const mod = await import("@casabio/jxl-capabilities");
        const raw: unknown = await mod.getCapabilities();
        const validated = validateCapabilities(raw);
        if (validated !== null && !this.shuttingDown) {
          this.caps = validated;
        }
      } catch {
        // Probe unavailable - keep the conservative default.
      } finally {
        this.probeSettled = true;
      }
    })();
  }

  decode(opts: DecodeOptions): DecodeSession {
    if (this.shuttingDown) {
      throw new Error("[jxl-session] decode() called after shutdown()");
    }
    return new DecodeSessionImpl(this.scheduler, opts);
  }

  encode(opts: EncodeOptions): EncodeSession {
    if (this.shuttingDown) {
      throw new Error("[jxl-session] encode() called after shutdown()");
    }
    return new EncodeSessionImpl(this.scheduler, opts);
  }

  capabilities(): Capabilities {
    return this.caps;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await this.scheduler.shutdown();
  }
}
