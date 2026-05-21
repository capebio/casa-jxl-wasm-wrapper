import type { ContextOptions, DecodeOptions, DecodeSession, EncodeOptions, EncodeSession, Capabilities } from "@casabio/jxl-core";
export interface JxlContext {
    decode(opts: DecodeOptions): DecodeSession;
    encode(opts: EncodeOptions): EncodeSession;
    capabilities(): Capabilities;
    shutdown(): Promise<void>;
}
export declare function createBrowserContext(opts?: ContextOptions): JxlContext;
export declare function createNodeContext(opts?: ContextOptions): JxlContext;
//# sourceMappingURL=context.d.ts.map