// jxl-worker-browser/src/spawn.ts
// Creates a DedicatedWorker running worker.ts and returns a typed handle.
// The scheduler (jxl-scheduler) calls spawnWorker() to fill its pool.
// Default worker script URL. Callers may override via wasmUrl in ContextOptions.
// The bundler is expected to provide the correct final path; this default
// works for same-origin deployments where worker.js is co-located.
const DEFAULT_WORKER_URL = new URL("./worker.js", import.meta.url).href;
export function spawnWorker(workerUrl) {
    return new Promise((resolve, reject) => {
        const url = workerUrl ?? DEFAULT_WORKER_URL;
        const worker = new Worker(url, { type: "module" });
        let messageHandlers = [];
        let _terminated = false;
        // Guard so onerror during startup fires reject exactly once.
        let _settled = false;
        const handle = {
            send(msg, transfer = []) {
                worker.postMessage(msg, transfer);
            },
            onMessage(handler) {
                messageHandlers.push(handler);
            },
            shutdown(timeoutMs = 5000) {
                return new Promise((res) => {
                    const timer = setTimeout(() => {
                        worker.terminate();
                        _terminated = true;
                        res();
                    }, timeoutMs);
                    const prev = messageHandlers.slice();
                    messageHandlers = [
                        (msg) => {
                            if (msg.type === "worker_shutdown_ack") {
                                clearTimeout(timer);
                                worker.terminate();
                                _terminated = true;
                                messageHandlers = prev;
                                res();
                            }
                            else {
                                for (const h of prev)
                                    h(msg);
                            }
                        },
                    ];
                    worker.postMessage({ type: "worker_shutdown" });
                });
            },
            get terminated() {
                return _terminated;
            },
        };
        // Route worker messages to registered handlers.
        worker.onmessage = (ev) => {
            const msg = ev.data;
            // Intercept the first worker_ready to resolve this promise.
            if (msg.type === "worker_ready") {
                _settled = true;
                resolve(handle);
                // Install persistent post-startup error handler now that the promise
                // is settled. Crashes after startup are logged so they aren't silent.
                worker.onerror = (postStartupEv) => {
                    _terminated = true;
                    console.error(`[jxl-worker-browser] Worker crashed after startup: ${postStartupEv.message}`, postStartupEv);
                };
                // Do not return — fall through so callers who registered before
                // spawnWorker resolved also see worker_ready.
            }
            for (const h of messageHandlers)
                h(msg);
        };
        worker.onerror = (ev) => {
            if (_settled)
                return;
            _settled = true;
            _terminated = true;
            reject(new Error(`[jxl-worker-browser] Worker error: ${ev.message}`));
        };
    });
}
//# sourceMappingURL=spawn.js.map