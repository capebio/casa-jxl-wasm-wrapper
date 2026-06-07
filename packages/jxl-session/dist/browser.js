// Browser-only public entry. Package "browser" condition points here so browser
// bundlers do not parse createNodeContext or @casabio/jxl-worker-node.
import { hardwareConcurrency, JxlContextImpl, validateWasmUrl, } from "./context-base.js";
export { DecodeSessionImpl } from "./decode-session.js";
export { EncodeSessionImpl } from "./encode-session.js";
export { AsyncEventStream } from "./event-stream.js";
export { JxlError } from "@casabio/jxl-core/errors";
export function createBrowserContext(opts) {
    const poolSize = opts?.poolSize ?? Math.max(1, Math.min(4, hardwareConcurrency() - 1));
    if (opts?.wasmUrl !== undefined) {
        validateWasmUrl(opts.wasmUrl);
    }
    const factory = async () => {
        const mod = await import("@casabio/jxl-worker-browser");
        return mod.spawnWorker(opts?.wasmUrl);
    };
    const ctx = new JxlContextImpl(factory, opts, poolSize);
    ctx.probeCapabilities();
    return ctx;
}
//# sourceMappingURL=browser.js.map