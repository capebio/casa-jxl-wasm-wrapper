// jxl-session/src/context.ts
// Default entry keeps both browser and node factories for non-browser consumers.
import { createBrowserContext as createBrowserContextImpl } from "./browser.js";
import { hardwareConcurrency, JxlContextImpl, } from "./context-base.js";
// ---------------------------------------------------------------------------
// Browser entry point
// ---------------------------------------------------------------------------
export function createBrowserContext(opts) {
    return createBrowserContextImpl(opts);
}
// ---------------------------------------------------------------------------
// Node entry point
// ---------------------------------------------------------------------------
export function createNodeContext(opts) {
    if (opts?.wasmUrl !== undefined) {
        throw new Error("[jxl-session] createNodeContext() does not support wasmUrl; node worker resolution is controlled by @casabio/jxl-worker-node");
    }
    // ContextOptions.wasmUrl (and browser-only tier routing) is not supported for node
    // until @casabio/jxl-worker-node provides asset override. Explicit error prevents
    // silent no-op (see Agent 2 handoff in BrowserContextTierEvent.md).
    // Pool size: hardwareConcurrency - 1 per Section 12.1 (no min(4) cap server-side).
    const poolSize = opts?.poolSize ?? Math.max(1, hardwareConcurrency() - 1);
    const factory = async () => {
        const mod = await import("@casabio/jxl-worker-node");
        return mod.spawnWorker();
    };
    const ctx = new JxlContextImpl(factory, opts, poolSize);
    ctx.probeCapabilities();
    return ctx;
}
//# sourceMappingURL=context.js.map