// Worker thread entry for WU-8 multi-file JXL encode pool.
// CRITICAL (sched-1): ALWAYS force single-threaded 'simd' here.
// Never 'relaxed-simd-mt' or similar inside pool workers — that would be
// workers * cores threads and thrash. 1 worker = 1 core.
import { parentPort } from "node:worker_threads";
import { setForcedTier } from "@casabio/jxl-wasm";
import { createJxlBackend } from "./backends.js";
import { createRawBackend } from "./raw-backend.js";
import { ingestImage, type IngestOptions, type IngestOutcome } from "./ingest.js";

if (!parentPort) {
  throw new Error("ingest-worker must be run as worker_threads child");
}

// Force simd (single-threaded libjxl + raw). Matches --encoder-threads 1 intent for pool.
setForcedTier("simd");

const backends = {
  raw: createRawBackend(),
  jxl: createJxlBackend(),
};

parentPort.on("message", async (msg: { id: number; path: string; opts: IngestOptions & { dryRun?: boolean; timeoutMs?: number } }) => {
  try {
    const outcome: IngestOutcome = await ingestImage(msg.path, backends, msg.opts);
    parentPort!.postMessage({ id: msg.id, ok: true, outcome });
  } catch (err: unknown) {
    const e = err instanceof Error ? { message: err.message, stack: err.stack } : { message: String(err) };
    parentPort!.postMessage({ id: msg.id, ok: false, error: e });
  }
});
