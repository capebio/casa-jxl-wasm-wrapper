// jxl-worker-node/src/spawn.ts
// Spawns a worker_threads worker running worker.ts and returns a typed handle.
// Lifecycle parity with jxl-worker-browser/spawn.ts.
import { Worker } from "node:worker_threads";
const WORKER_PATH = new URL("./worker.js", import.meta.url);
export function spawnWorker(options = {}) {
    const { readyTimeoutMs = 30000, resourceLimits, env, execArgv } = options;
    return new Promise((resolve, reject) => {
        const worker = new Worker(WORKER_PATH, {
            resourceLimits,
            env: env ? { ...process.env, ...env } : undefined,
            execArgv,
        });
        let messageHandlers = [];
        let _terminated = false;
        let isResolved = false;
        let shutdownPromise = null;
        let readyTimer;
        if (readyTimeoutMs > 0) {
            readyTimer = setTimeout(() => {
                if (!isResolved) {
                    isResolved = true;
                    _terminated = true;
                    void worker.terminate();
                    reject(new Error(`[jxl-worker-node] Spawn timed out waiting for worker_ready after ${readyTimeoutMs}ms`));
                }
            }, readyTimeoutMs);
        }
        const handle = {
            send(msg, transfer = []) {
                if (_terminated)
                    return;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                worker.postMessage(msg, transfer);
            },
            onMessage(handler) {
                messageHandlers.push(handler);
            },
            shutdown(timeoutMs = 5000) {
                if (shutdownPromise !== null)
                    return shutdownPromise;
                shutdownPromise = new Promise((res) => {
                    const timer = setTimeout(() => {
                        void worker.terminate();
                        _terminated = true;
                        res();
                    }, timeoutMs);
                    const prev = messageHandlers.slice();
                    messageHandlers = [
                        (msg) => {
                            if (msg.type === "worker_shutdown_ack") {
                                clearTimeout(timer);
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
                return shutdownPromise;
            },
            get terminated() {
                return _terminated;
            },
        };
        worker.on("message", (msg) => {
            if (msg.type === "worker_ready") {
                if (readyTimer)
                    clearTimeout(readyTimer);
                isResolved = true;
                resolve(handle);
            }
            for (const h of messageHandlers)
                h(msg);
        });
        worker.on("error", (err) => {
            _terminated = true;
            if (readyTimer)
                clearTimeout(readyTimer);
            if (!isResolved) {
                isResolved = true;
                reject(new Error(`[jxl-worker-node] Worker error: ${err.message}`));
            }
            else {
                const workerError = {
                    type: "worker_error",
                    code: "WorkerError",
                    message: `[jxl-worker-node] Worker error: ${err.message}`,
                };
                for (const h of messageHandlers)
                    h(workerError);
            }
        });
        worker.on("exit", (code) => {
            _terminated = true;
            if (readyTimer)
                clearTimeout(readyTimer);
            if (!isResolved) {
                isResolved = true;
                reject(new Error(`[jxl-worker-node] Worker exited with code ${code} before ready`));
                return;
            }
            if (code !== 0) {
                for (const h of messageHandlers.slice()) {
                    h({
                        type: "worker_error",
                        code: "WorkerCrashed",
                        message: `[jxl-worker-node] worker exited with code ${code}`,
                    });
                }
                for (const h of messageHandlers.slice()) {
                    h({
                        type: "worker_shutdown_ack",
                    });
                }
            }
        });
    });
}
//# sourceMappingURL=spawn.js.map