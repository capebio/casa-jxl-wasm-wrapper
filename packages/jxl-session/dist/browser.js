// Browser-only public entry. Package "browser" condition points here so browser
// bundlers do not parse createNodeContext or @casabio/jxl-worker-node.
import { hardwareConcurrency, JxlContextImpl, TieredJxlContextImpl, validateWasmUrl, } from "./context-base.js";
import { isMtRequestedTier, parseRequestedWorkerTier, withWorkerTier } from "./tier-routing.js";
export { DecodeSessionImpl } from "./decode-session.js";
export { EncodeSessionImpl } from "./encode-session.js";
export { AsyncEventStream } from "./event-stream.js";
export { JxlError } from "@casabio/jxl-core/errors";
export function createBrowserContext(opts) {
    const poolSize = opts?.poolSize ?? Math.max(1, Math.min(4, hardwareConcurrency() - 1));
    if (opts?.wasmUrl !== undefined) {
        validateWasmUrl(opts.wasmUrl);
    }
    const factoryForUrl = (workerUrl) => async () => {
        const mod = await import("@casabio/jxl-worker-browser");
        return mod.spawnWorker(workerUrl);
    };
    const requestedTier = parseRequestedWorkerTier(opts?.wasmUrl);
    const ctx = isMtRequestedTier(requestedTier)
        ? new TieredJxlContextImpl({
            mtFactory: factoryForUrl(withWorkerTier(opts?.wasmUrl, requestedTier)),
            stFactory: factoryForUrl(withWorkerTier(opts?.wasmUrl, "simd")),
            opts,
            maxWorkers: poolSize,
        })
        : new JxlContextImpl(factoryForUrl(opts?.wasmUrl), opts, poolSize);
    ctx.probeCapabilities();
    return ctx;
}
//# sourceMappingURL=browser.js.map