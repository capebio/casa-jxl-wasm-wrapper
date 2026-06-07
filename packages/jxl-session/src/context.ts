// jxl-session/src/context.ts
// Default entry keeps both browser and node factories for non-browser consumers.

import type { ContextOptions } from "@casabio/jxl-core";
import type { WorkerFactory } from "@casabio/jxl-scheduler";

import {
  hardwareConcurrency,
  JxlContextImpl,
  validateWasmUrl,
  type JxlContext,
} from "./context-base.js";

export type { JxlContext } from "./context-base.js";

// ---------------------------------------------------------------------------
// Browser entry point
// ---------------------------------------------------------------------------

export function createBrowserContext(opts?: ContextOptions): JxlContext {
  // Pool size: min(4, hardwareConcurrency - 1) per Section 12.1.
  const poolSize = opts?.poolSize ?? Math.max(1, Math.min(4, hardwareConcurrency() - 1));

  // Validate wasmUrl eagerly so callers get a clear error at construction time
  // rather than at first worker spawn (task 007-security-a1b2c3d4).
  if (opts?.wasmUrl !== undefined) {
    validateWasmUrl(opts.wasmUrl);
  }

  const factory: WorkerFactory = async () => {
    const mod = await import("@casabio/jxl-worker-browser");
    // The double-cast hides structural mismatches between jxl-worker-browser's
    // WorkerHandle and the scheduler's WorkerHandle. This boundary cast is
    // acceptable because worker packages are internal.
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
