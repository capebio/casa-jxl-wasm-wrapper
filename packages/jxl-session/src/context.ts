// jxl-session/src/context.ts
// Default entry keeps both browser and node factories for non-browser consumers.

import type { ContextOptions } from "@casabio/jxl-core";
import { createBrowserContext as createBrowserContextImpl } from "./browser.js";
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
  return createBrowserContextImpl(opts);
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
