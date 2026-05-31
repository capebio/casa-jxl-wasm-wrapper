// jxl-session/src/index.ts
// Public entry point for the session facade. Spec Section 5.

export { createBrowserContext, createNodeContext } from "./context.js";
export type { JxlContext } from "./context.js";
// DecodeSessionImpl and EncodeSessionImpl are internal classes; they are
// exported here only for the test suite which needs to construct them directly.
// External consumers must use createBrowserContext/createNodeContext and the
// DecodeSession/EncodeSession interfaces (task 007-contracts-8v9w0x).
export { DecodeSessionImpl } from "./decode-session.js";
export { EncodeSessionImpl } from "./encode-session.js";
export { AsyncEventStream } from "./event-stream.js";

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
export { JxlError } from "@casabio/jxl-core/errors";
export type { JxlErrorCode } from "@casabio/jxl-core/errors";
