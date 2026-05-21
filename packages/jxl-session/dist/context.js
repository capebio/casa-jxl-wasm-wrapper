// jxl-session/src/context.ts
// JxlContext facade + createBrowserContext / createNodeContext.
// Spec: Section 5 (entry points), Section 12.1 (pool sizing).
//
// jxl-session is the only module callers import to drive codec work, and the
// only module that talks to jxl-worker-* (Section 4.2). Worker packages are
// loaded via dynamic import so a browser bundle never eagerly pulls
// node:worker_threads and a node bundle never pulls DedicatedWorker.
import { Scheduler } from "@casabio/jxl-scheduler";
import { DecodeSessionImpl } from "./decode-session.js";
import { EncodeSessionImpl } from "./encode-session.js";
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
// navigator.hardwareConcurrency is available in browsers and Node >= 21.
function hardwareConcurrency() {
    const nav = globalThis.navigator;
    return nav?.hardwareConcurrency ?? 4;
}
// Conservative capabilities used until the async probe resolves, and as the
// permanent value if the probe is unavailable.
function defaultCapabilities() {
    return {
        wasm: typeof WebAssembly !== "undefined",
        wasmSimd: false,
        wasmRelaxedSimd: false,
        wasmThreads: false,
        crossOriginIsolated: false,
        sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
        offscreenCanvas: false,
        imageBitmap: false,
        nativeJxlDecoder: false,
        selectedWasmBuild: "none",
        libjxlVersion: "unknown",
    };
}
class JxlContextImpl {
    scheduler;
    caps = defaultCapabilities();
    shuttingDown = false;
    constructor(factory, opts, maxWorkers) {
        this.scheduler = new Scheduler({
            factory,
            maxWorkers,
            idleTimeoutMs: opts?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
        });
    }
    // Kick off the async capability probe; capabilities() returns the cached
    // value, which updates once the probe resolves.
    probeCapabilities() {
        void (async () => {
            try {
                const mod = await import("@casabio/jxl-capabilities");
                const probed = (await mod.getCapabilities());
                this.caps = probed;
            }
            catch {
                // Probe unavailable — keep the conservative default.
            }
        })();
    }
    decode(opts) {
        if (this.shuttingDown) {
            throw new Error("[jxl-session] decode() called after shutdown()");
        }
        return new DecodeSessionImpl(this.scheduler, opts);
    }
    encode(opts) {
        if (this.shuttingDown) {
            throw new Error("[jxl-session] encode() called after shutdown()");
        }
        return new EncodeSessionImpl(this.scheduler, opts);
    }
    capabilities() {
        return this.caps;
    }
    async shutdown() {
        this.shuttingDown = true;
        await this.scheduler.shutdown();
    }
}
// ---------------------------------------------------------------------------
// Browser entry point
// ---------------------------------------------------------------------------
export function createBrowserContext(opts) {
    // Pool size: min(4, hardwareConcurrency - 1) per Section 12.1.
    const poolSize = opts?.poolSize ?? Math.max(1, Math.min(4, hardwareConcurrency() - 1));
    const factory = async () => {
        const mod = await import("@casabio/jxl-worker-browser");
        return mod.spawnWorker(opts?.wasmUrl);
    };
    const ctx = new JxlContextImpl(factory, opts, poolSize);
    ctx.probeCapabilities();
    return ctx;
}
// ---------------------------------------------------------------------------
// Node entry point
// ---------------------------------------------------------------------------
export function createNodeContext(opts) {
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