import { parentPort, workerData } from 'node:worker_threads';

globalThis.WorkerGlobalScope = globalThis.WorkerGlobalScope ?? function WorkerGlobalScope() {};
globalThis.self = globalThis;
globalThis.name = workerData?.name ?? '';
globalThis.postMessage = (message, transfer) => {
  parentPort.postMessage(message, transfer);
};
globalThis.close = () => {
  process.exit(0);
};
globalThis.onmessage = null;

parentPort.on('message', (data) => {
  const handler = globalThis.onmessage;
  if (typeof handler === 'function') {
    handler({ data });
  }
});

await import(workerData.url);
