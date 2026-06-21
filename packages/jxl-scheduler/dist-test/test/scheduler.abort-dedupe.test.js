// jxl-scheduler/test/scheduler.abort-dedupe.test.ts
// Regression: abortAcquisition must synthesize a KIND-AWARE terminal for deduped
// subscribers. An encode subscriber on a primary that aborts before assignment must
// receive encode_cancelled (not decode_cancelled), otherwise its consumer never
// recognizes the terminal and hangs. Mirrors the kind-aware synthesis already present
// in shutdown() and the preempt-timeout path.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Scheduler } from "../src/scheduler.js";
import { FakeWorker, fakeWorkerFactory } from "./helpers.js";
// A gate whose admit() stays pending until the test releases it — lets us hold the
// primary inside acquireSlot (post-register, pre-assignment) and abort it deterministically.
function makeBlockingGate() {
    let release;
    const gate = {
        admit: () => new Promise((resolve) => {
            release = () => resolve(() => { });
        }),
    };
    return { gate, release: () => release() };
}
describe("Scheduler abort-during-acquisition dedupe", () => {
    it("encode subscriber on aborted primary receives encode_cancelled, not decode_cancelled", async () => {
        const workers = [];
        const { gate, release } = makeBlockingGate();
        const sched = new Scheduler({
            factory: fakeWorkerFactory(workers),
            maxWorkers: 2,
            idleTimeoutMs: 60_000,
            admissionGate: gate,
        });
        const encStart = (sessionId) => ({ type: "encode_start", sessionId, priority: "background" });
        // Primary encode: registers its sourceKey, then parks awaiting the gate.
        const ac = new AbortController();
        const primaryPromise = sched.acquireSlot({
            sessionId: "enc-primary",
            priority: "background",
            startMsg: encStart("enc-primary"),
            sourceKey: "enc-key",
            signal: ac.signal,
        });
        // Let the primary reach the gate await before subscribing.
        await new Promise((r) => setTimeout(r, 0));
        // Encode subscriber fans out onto the primary (returns immediately, no gate).
        await sched.acquireSlot({
            sessionId: "enc-sub",
            priority: "background",
            startMsg: encStart("enc-sub"),
            sourceKey: "enc-key",
            signal: null,
        });
        const subTerminals = [];
        sched.onMessage("enc-sub", (m) => subTerminals.push(m));
        // Abort the primary, then unblock the gate so the post-await guard runs abortAcquisition.
        ac.abort();
        release();
        await assert.rejects(primaryPromise);
        assert.ok(subTerminals.some((m) => m.type === "encode_cancelled"), "encode subscriber must receive encode_cancelled");
        assert.ok(!subTerminals.some((m) => m.type === "decode_cancelled"), "encode subscriber must NOT receive decode_cancelled");
        await sched.shutdown();
    });
    it("decode subscriber on aborted primary still receives decode_cancelled", async () => {
        const workers = [];
        const { gate, release } = makeBlockingGate();
        const sched = new Scheduler({
            factory: fakeWorkerFactory(workers),
            maxWorkers: 2,
            idleTimeoutMs: 60_000,
            admissionGate: gate,
        });
        const decStart = (sessionId) => ({ type: "decode_start", sessionId, priority: "background" });
        const ac = new AbortController();
        const primaryPromise = sched.acquireSlot({
            sessionId: "dec-primary",
            priority: "background",
            startMsg: decStart("dec-primary"),
            sourceKey: "dec-key",
            signal: ac.signal,
        });
        await new Promise((r) => setTimeout(r, 0));
        await sched.acquireSlot({
            sessionId: "dec-sub",
            priority: "background",
            startMsg: decStart("dec-sub"),
            sourceKey: "dec-key",
            signal: null,
        });
        const subTerminals = [];
        sched.onMessage("dec-sub", (m) => subTerminals.push(m));
        ac.abort();
        release();
        await assert.rejects(primaryPromise);
        assert.ok(subTerminals.some((m) => m.type === "decode_cancelled"), "decode subscriber must receive decode_cancelled");
        await sched.shutdown();
    });
});
//# sourceMappingURL=scheduler.abort-dedupe.test.js.map