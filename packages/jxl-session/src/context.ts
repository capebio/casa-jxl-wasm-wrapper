// jxl-session/src/context.ts
// JxlContext facade + createBrowserContext / createNodeContext.
// Spec: Section 5 (entry points), Section 12.1 (pool sizing).
//
// jxl-session is the only module callers import to drive codec work, and the
// only module that talks to jxl-worker-* (Section 4.2). Worker packages are
// loaded via dynamic import so a browser bundle never eagerly pulls
// node:worker_threads and a node bundle never pulls DedicatedWorker.

import type {
  ContextOptions,
  DecodeOptions,
  DecodeSession,
  EncodeOptions,
  EncodeSession,
  Capabilities,
} from "@casabio/jxl-core";
import { Scheduler, type WorkerFactory } from "@casabio/jxl-scheduler";

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

// navigator.hardwareConcurrency is available in browsers and Node >= 21.
function hardwareConcurrency(): number {
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

class JxlContextImpl implements JxlContext {
  private readonly scheduler: Scheduler;
  private caps: Capabilities = defaultCapabilities();
  private shuttingDown = false;

  constructor(factory: WorkerFactory, opts: ContextOptions | undefined, maxWorkers: number) {
    this.scheduler = new Scheduler({
      factory,
      maxWorkers,
      idleTimeoutMs: opts?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    });
  }

  // Kick off the async capability probe; capabilities() returns the cached
  // value, which updates once the probe resolves.
  probeCapabilities(): void {
    void (async () => {
      try {
        const mod = await import("@casabio/jxl-capabilities");
        const probed = (await mod.getCapabilities()) as Capabilities;
        this.caps = probed;
      } catch {
        // Probe unavailable — keep the conservative default.
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

// ---------------------------------------------------------------------------
// Browser entry point
// ---------------------------------------------------------------------------

export function createBrowserContext(opts?: ContextOptions): JxlContext {
  // Pool size: min(4, hardwareConcurrency - 1) per Section 12.1.
  const poolSize = opts?.poolSize ?? Math.max(1, Math.min(4, hardwareConcurrency() - 1));

  const factory: WorkerFactory = async () => {
    const mod = await import("@casabio/jxl-worker-browser");
    return mod.spawnWorker(opts?.wasmUrl) as unknown as Awaited<ReturnType<WorkerFactory>>;
  };

  const ctx = new JxlContextImpl(factory, opts, poolSize);
  ctx.probeCapabilities();
  return ctx;
}

// ---------------------------------------------------------------------------
// Node entry point
// ---------------------------------------------------------------------------

export function createNodeContext(opts?: ContextOptions): JxlContext {
  // Pool size: hardwareConcurrency - 1 per Section 12.1 (no min(4) cap server-side).
  const poolSize = opts?.poolSize ?? Math.max(1, hardwareConcurrency() - 1);

  const factory: WorkerFactory = async () => {
    const mod = await import("@casabio/jxl-worker-node");
    return mod.spawnWorker() as unknown as Awaited<ReturnType<WorkerFactory>>;
  };

  const ctx = new JxlContextImpl(factory, opts, poolSize);
  ctx.probeCapabilities();
  return ctx;
}
