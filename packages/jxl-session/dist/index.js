// jxl-session/src/index.ts
// Public entry point for the session facade. Spec Section 5.
export { createBrowserContext, createNodeContext } from "./context.js";
// DecodeSessionImpl and EncodeSessionImpl are internal classes; they are
// exported here only for the test suite which needs to construct them directly.
// External consumers must use createBrowserContext/createNodeContext and the
// DecodeSession/EncodeSession interfaces (task 007-contracts-8v9w0x).
export { DecodeSessionImpl } from "./decode-session.js";
export { EncodeSessionImpl } from "./encode-session.js";
export { AsyncEventStream } from "./event-stream.js";
export { JxlError } from "@casabio/jxl-core/errors";
//# sourceMappingURL=index.js.map