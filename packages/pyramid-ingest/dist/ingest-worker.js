// Worker thread entry for WU-8 multi-file JXL encode pool.
// CRITICAL (sched-1): ALWAYS force single-threaded 'simd' here.
// Never 'relaxed-simd-mt' or similar inside pool workers — that would be
// workers * cores threads and thrash. 1 worker = 1 core.
import { parentPort } from "node:worker_threads";
import { setForcedTier } from "@casabio/jxl-wasm";
import { createJxlBackend } from "./backends.js";
import { createRawBackend } from "./raw-backend.js";
import { ingestImage } from "./ingest.js";
if (!parentPort) {
    throw new Error("ingest-worker must be run as worker_threads child");
}
// Force simd (single-threaded libjxl + raw). Matches --encoder-threads 1 intent for pool.
setForcedTier("simd");
const backends = {
    raw: createRawBackend(),
    jxl: createJxlBackend(),
};
parentPort.on("message", async (msg) => {
    const t0 = Date.now();
    try {
        if (msg.opts.chaosTest && Math.random() < 0.25) {
            throw new Error("chaos-test injected failure (for K2 resume/GC recovery test) [worker]");
        }
        const res = await ingestImage(msg.path, backends, msg.opts);
        const dur = Date.now() - t0;
        parentPort.postMessage({ id: msg.id, ok: true, outcome: res.outcome, stagedBytes: res.stagedBytes, durationMs: dur });
    }
    catch (err) {
        const e = err instanceof Error ? { message: err.message, stack: err.stack } : { message: String(err) };
        parentPort.postMessage({ id: msg.id, ok: false, error: e, durationMs: Date.now() - t0 });
    }
});
//# sourceMappingURL=ingest-worker.js.map