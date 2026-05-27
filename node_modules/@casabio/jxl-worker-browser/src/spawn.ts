// jxl-worker-browser/src/spawn.ts
// Creates a DedicatedWorker running worker.ts and returns a typed handle.
// The scheduler (jxl-scheduler) calls spawnWorker() to fill its pool.

import type {
  MainToWorkerMessage,
  WorkerToMainMessage,
  MsgWorkerReady,
  MsgWorkerShutdownAck,
} from "@casabio/jxl-core/protocol";

export interface WorkerHandle {
  // Post a message to the worker; transferList is for transferred buffers.
  send(msg: MainToWorkerMessage, transfer?: Transferable[]): void;
  // Register a handler for messages from the worker.
  onMessage(handler: (msg: WorkerToMainMessage) => void): void;
  // Shut down gracefully; resolves when worker_shutdown_ack received or timeout.
  shutdown(timeoutMs?: number): Promise<void>;
  // True after shutdown completes or worker crashes.
  readonly terminated: boolean;
}

// Default worker script URL. Callers may override via wasmUrl in ContextOptions.
// The bundler is expected to provide the correct final path; this default
// works for same-origin deployments where worker.js is co-located.
const DEFAULT_WORKER_URL = new URL("./worker.js", import.meta.url).href;

export function spawnWorker(workerUrl?: string): Promise<WorkerHandle> {
  return new Promise<WorkerHandle>((resolve, reject) => {
    const url = workerUrl ?? DEFAULT_WORKER_URL;
    const worker = new Worker(url, { type: "module" });

    let messageHandlers: Array<(msg: WorkerToMainMessage) => void> = [];
    let _terminated = false;
    // Guard so onerror during startup fires reject exactly once.
    let _settled = false;

    const handle: WorkerHandle = {
      send(msg: MainToWorkerMessage, transfer: Transferable[] = []) {
        worker.postMessage(msg, transfer);
      },

      onMessage(handler: (msg: WorkerToMainMessage) => void) {
        messageHandlers.push(handler);
      },

      shutdown(timeoutMs = 5000): Promise<void> {
        return new Promise<void>((res) => {
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
              } else {
                for (const h of prev) h(msg);
              }
            },
          ];

          worker.postMessage({ type: "worker_shutdown" } satisfies MainToWorkerMessage);
        });
      },

      get terminated() {
        return _terminated;
      },
    };

    // Route worker messages to registered handlers.
    worker.onmessage = (ev: MessageEvent<WorkerToMainMessage>) => {
      const msg = ev.data;

      // Intercept the first worker_ready to resolve this promise.
      if (msg.type === "worker_ready") {
        _settled = true;
        resolve(handle);
        // Install persistent post-startup error handler now that the promise
        // is settled. Crashes after startup are logged so they aren't silent.
        worker.onerror = (postStartupEv) => {
          _terminated = true;
          console.error(
            `[jxl-worker-browser] Worker crashed after startup: ${postStartupEv.message}`,
            postStartupEv,
          );
        };
        // Do not return — fall through so callers who registered before
        // spawnWorker resolved also see worker_ready.
      }

      for (const h of messageHandlers) h(msg);
    };

    worker.onerror = (ev) => {
      if (_settled) return;
      _settled = true;
      _terminated = true;
      reject(new Error(`[jxl-worker-browser] Worker error: ${ev.message}`));
    };
  });
}
