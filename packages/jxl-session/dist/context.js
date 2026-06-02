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
// Allowed URL schemes for the caller-supplied wasmUrl (task 007-security-a1b2c3d4).
const ALLOWED_WASM_URL_PREFIXES = ["https://", "http://", "blob:", "/"];
function validateWasmUrl(url) {
    if (!ALLOWED_WASM_URL_PREFIXES.some((prefix) => url.startsWith(prefix))) {
        throw new Error(`[jxl-session] wasmUrl must start with https://, http://, blob:, or / (got: ${JSON.stringify(url.slice(0, 64))})`);
    }
}
// Validate that a probe result has the shape of a Capabilities object.
// Guards against supply-chain or service-worker tampering (task 007-security-e5f6g7h8 /
// 007-contracts-4j5k6l). Returns null when the result is not structurally valid.
function validateCapabilities(value) {
    if (value === null || typeof value !== "object")
        return null;
    const v = value;
    if (typeof v["wasm"] !== "boolean" ||
        typeof v["wasmSimd"] !== "boolean" ||
        typeof v["wasmRelaxedSimd"] !== "boolean" ||
        typeof v["wasmThreads"] !== "boolean" ||
        typeof v["crossOriginIsolated"] !== "boolean" ||
        typeof v["sharedArrayBuffer"] !== "boolean" ||
        typeof v["offscreenCanvas"] !== "boolean" ||
        typeof v["imageBitmap"] !== "boolean" ||
        typeof v["nativeJxlDecoder"] !== "boolean" ||
        typeof v["selectedWasmBuild"] !== "string" ||
        typeof v["libjxlVersion"] !== "string") {
        return null;
    }
    return value;
}
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
    // Track the probe so shutdown() can guard against stale writes
    // (task 007-concurrency-a5b6c7d8).
    probeSettled = false;
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
                const raw = await mod.getCapabilities();
                // Validate the probe result before trusting it (task 007-security-e5f6g7h8 /
                // 007-contracts-4j5k6l). Drop silently on structural mismatch.
                const validated = validateCapabilities(raw);
                // Do not update caps if shutdown() has already been called — the context
                // is being torn down and writing to this.caps would be a dangling write
                // (task 007-concurrency-a5b6c7d8).
                if (validated !== null && !this.shuttingDown) {
                    this.caps = validated;
                }
            }
            catch {
                // Probe unavailable — keep the conservative default.
            }
            finally {
                this.probeSettled = true;
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
    // Validate wasmUrl eagerly so callers get a clear error at construction time
    // rather than at first worker spawn (task 007-security-a1b2c3d4).
    if (opts?.wasmUrl !== undefined) {
        validateWasmUrl(opts.wasmUrl);
    }
    const factory = async () => {
        const mod = await import("@casabio/jxl-worker-browser");
        // The double-cast (as unknown as ...) hides structural mismatches between
        // jxl-worker-browser's WorkerHandle and the scheduler's WorkerHandle.
        // This is an acceptable boundary cast here because the worker packages are
        // internal — document it explicitly (task 007-contracts-3g4h5i).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
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