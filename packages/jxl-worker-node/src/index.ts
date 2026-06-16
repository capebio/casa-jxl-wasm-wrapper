// jxl-worker-node/src/index.ts
// Host-side: spawn and communicate with node worker_threads workers.

export { spawnWorker } from "./spawn.js";
export type { WorkerHandle } from "./spawn.js";
export { selectBackend } from "./backend-selector.js";
export type { Backend, BackendSelectorOptions, CodecModule } from "./backend-selector.js";
