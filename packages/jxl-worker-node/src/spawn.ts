// jxl-worker-node/src/spawn.ts
// Spawns a worker_threads worker running worker.ts and returns a typed handle.
// Lifecycle parity with jxl-worker-browser/spawn.ts.

import { Worker, MessageChannel } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import type {
  MainToWorkerMessage,
  WorkerToMainMessage,
  MsgWorkerShutdownAck,
} from "@casabio/jxl-core/protocol";

export interface WorkerHandle {
  send(msg: MainToWorkerMessage, transfer?: unknown[]): void;
  onMessage(handler: (msg: WorkerToMainMessage) => void): void;
  shutdown(timeoutMs?: number): Promise<void>;
  readonly terminated: boolean;
}

const WORKER_PATH = new URL("./worker.js", import.meta.url);

export function spawnWorker(): Promise<WorkerHandle> {
  return new Promise<WorkerHandle>((resolve, reject) => {
    const worker = new Worker(WORKER_PATH);

    let messageHandlers: Array<(msg: WorkerToMainMessage) => void> = [];
    let _terminated = false;

    const handle: WorkerHandle = {
      send(msg: MainToWorkerMessage, transfer: unknown[] = []) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        worker.postMessage(msg, transfer as any);
      },

      onMessage(handler: (msg: WorkerToMainMessage) => void) {
        messageHandlers.push(handler);
      },

      shutdown(timeoutMs = 5000): Promise<void> {
        return new Promise<void>((res) => {
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

    worker.on("message", (msg: WorkerToMainMessage) => {
      if (msg.type === "worker_ready") {
        resolve(handle);
      }
      for (const h of messageHandlers) h(msg);
    });

    worker.on("error", (err) => {
      _terminated = true;
      reject(new Error(`[jxl-worker-node] Worker error: ${err.message}`));
    });

    worker.on("exit", (code) => {
      _terminated = true;
      if (code !== 0) {
        for (const h of messageHandlers) {
          h({
            type: "worker_shutdown_ack",
          });
        }
      }
    });
  });
}
