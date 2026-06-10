// jxl-worker-browser/src/spawn.ts
// Creates a DedicatedWorker running worker.ts and returns a typed handle.
// The scheduler (jxl-scheduler) calls spawnWorker() to fill its pool.
// Default worker script URL. Callers may override via wasmUrl in ContextOptions.
// The bundler is expected to provide the correct final path; this default
// works for same-origin deployments where worker.js is co-located.
const DEFAULT_WORKER_URL = new URL("./worker.js", import.meta.url).href;
export function spawnWorker(workerUrl, opts = {}) {
    return new Promise((resolve, reject) => {
        const url = workerUrl ?? DEFAULT_WORKER_URL;
        const worker = new Worker(url, { type: "module", name: opts.name ?? "jxl-worker" });
        const messageHandlers = [];
        const crashHandlers = [];
        let _terminated = false;
        // Guard so startup paths (timeout / error / early shutdown) settle the promise exactly once.
        let _settled = false;
        let _crashed = false;
        let shutdownPromise = null;
        let onShutdownAck = null;
        // S-3: startup watchdog. Prevents leaked pending spawn promise on hung boot (wasm stall, init loop).
        const startupTimer = setTimeout(() => {
            if (_settled)
                return;
            _settled = true;
            _terminated = true;
            worker.terminate();
            reject(new Error("[jxl-worker-browser] Worker startup timed out"));
        }, opts.startupTimeoutMs ?? 30_000);
        const handle = {
            send(msg, transfer = []) {
                worker.postMessage(msg, transfer);
            },
            onMessage(handler) {
                messageHandlers.push(handler);
            },
            onCrash(handler) {
                crashHandlers.push(handler);
            },
            shutdown(timeoutMs = 5000) {
                if (_terminated)
                    return Promise.resolve();
                if (shutdownPromise)
                    return shutdownPromise;
                // S-2: single memoized promise + dedicated ack hook (no messageHandlers swap/restore).
                // S-8: early shutdown rejects the still-pending spawn promise instead of leaking it.
                shutdownPromise = new Promise((res) => {
                    let ackTimer;
                    const finish = () => {
                        if (ackTimer !== undefined)
                            clearTimeout(ackTimer);
                        worker.terminate();
                        _terminated = true;
                        onShutdownAck = null;
                        if (!_settled) {
                            _settled = true;
                            clearTimeout(startupTimer);
                            reject(new Error("[jxl-worker-browser] Worker shut down before ready"));
                        }
                        res();
                    };
                    ackTimer = setTimeout(finish, timeoutMs);
                    onShutdownAck = finish;
                    worker.postMessage({ type: "worker_shutdown" });
                });
                return shutdownPromise;
            },
            get terminated() {
                return _terminated;
            },
        };
        // Route worker messages to registered handlers.
        worker.onmessage = (ev) => {
            const msg = ev.data;
            if (msg.type === "worker_shutdown_ack") {
                onShutdownAck?.();
                return;
            }
            // Intercept the first worker_ready to resolve this promise.
            if (msg.type === "worker_ready" && !_settled) {
                _settled = true;
                clearTimeout(startupTimer);
                resolve(handle);
                // Do not return — fall through so callers who registered before
                // spawnWorker resolved also see worker_ready.
            }
            for (const h of messageHandlers) {
                try {
                    h(msg);
                }
                catch (e) {
                    console.error("[jxl-worker-browser] message handler threw", e);
                }
            }
        };
        // onerror: startup path rejects the spawn promise; post-startup (after ready)
        // routes to onCrash handlers (S-1). The guard keeps startup reject behavior intact.
        worker.onerror = (ev) => {
            if (_settled) {
                doCrash(`error: ${ev.message ?? "unknown"}`, ev);
                return;
            }
            _settled = true;
            _terminated = true;
            clearTimeout(startupTimer);
            reject(new Error(`[jxl-worker-browser] Worker error: ${ev.message}`));
        };
        // S-4: onmessageerror uses the same post-startup crash path (reason "messageerror").
        // Pre-ready: treat as terminal startup failure so the spawn promise settles.
        worker.onmessageerror = () => {
            if (!_settled) {
                _settled = true;
                _terminated = true;
                clearTimeout(startupTimer);
                reject(new Error("[jxl-worker-browser] Worker messageerror before ready"));
                return;
            }
            doCrash("messageerror");
        };
        function doCrash(reason, detail) {
            _terminated = true;
            console.error(`[jxl-worker-browser] Worker crashed after startup: ${reason}`, detail);
            if (_crashed)
                return;
            _crashed = true;
            for (const ch of crashHandlers) {
                try {
                    ch(reason);
                }
                catch (e) {
                    console.error("[jxl-worker-browser] crash handler threw", e);
                }
            }
        }
    });
}
//# sourceMappingURL=spawn.js.map