// Browser-only public entry. Package "browser" condition points here so browser
// bundlers do not parse createNodeContext or @casabio/jxl-worker-node.

import type { ContextOptions } from "@casabio/jxl-core";
import type { WorkerFactory } from "@casabio/jxl-scheduler";

import {
  hardwareConcurrency,
  JxlContextImpl,
  validateWasmUrl,
  type JxlContext,
} from "./context-base.js";

export type { JxlContext } from "./context-base.js";
export { DecodeSessionImpl } from "./decode-session.js";
export { EncodeSessionImpl } from "./encode-session.js";
export { AsyncEventStream } from "./event-stream.js";
export { JxlError } from "@casabio/jxl-core/errors";

// Re-export the core contract types so callers import from one place.
export type {
  ContextOptions,
  DecodeOptions,
  DecodeSession,
  DecodeFrameEvent,
  EncodeOptions,
  EncodeSession,
  EncodeStats,
  ImageInfo,
  Capabilities,
  PixelFormat,
  Region,
  CodecMetric,
} from "@casabio/jxl-core";
export type { JxlErrorCode } from "@casabio/jxl-core/errors";

export function createBrowserContext(opts?: ContextOptions): JxlContext {
  const poolSize = opts?.poolSize ?? Math.max(1, Math.min(4, hardwareConcurrency() - 1));

  if (opts?.wasmUrl !== undefined) {
    validateWasmUrl(opts.wasmUrl);
  }

  const factory: WorkerFactory = async () => {
    const mod = await import("@casabio/jxl-worker-browser");
    return mod.spawnWorker(opts?.wasmUrl) as unknown as Awaited<ReturnType<WorkerFactory>>;
  };

  const ctx = new JxlContextImpl(factory, opts, poolSize);
  ctx.probeCapabilities();
  return ctx;
}
