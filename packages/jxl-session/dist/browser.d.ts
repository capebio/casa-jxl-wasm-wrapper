import type { ContextOptions } from "@casabio/jxl-core";
import { type JxlContext } from "./context-base.js";
export type { JxlContext } from "./context-base.js";
export { DecodeSessionImpl } from "./decode-session.js";
export { EncodeSessionImpl } from "./encode-session.js";
export { AsyncEventStream } from "./event-stream.js";
export { JxlError } from "@casabio/jxl-core/errors";
export type { ContextOptions, DecodeOptions, DecodeSession, DecodeFrameEvent, EncodeOptions, EncodeSession, EncodeStats, ImageInfo, Capabilities, PixelFormat, Region, CodecMetric, } from "@casabio/jxl-core";
export type { JxlErrorCode } from "@casabio/jxl-core/errors";
export declare function createBrowserContext(opts?: ContextOptions): JxlContext;
//# sourceMappingURL=browser.d.ts.map