import { describe, test, afterEach } from "node:test";
import { spawnWorker } from "../src/spawn.js";
import { expect } from "./expect.js";
class MockWorker {
    url;
    options;
    onmessage = null;
    onerror = null;
    onmessageerror = null;
    terminated = false;
    posted = [];
    constructor(url, options = {}) {
        this.url = url;
        this.options = options;
        createdWorkers.push(this);
    }
    postMessage(msg, _transfer) {
        this.posted.push(msg);
    }
    terminate() {
        this.terminated = true;
    }
    // Test helpers to simulate worker->main
    simulateMessage(data) {
        this.onmessage?.({ data });
    }
    simulateError(message) {
        this.onerror?.({ message });
    }
    simulateMessageError() {
        this.onmessageerror?.();
    }
}
let createdWorkers = [];
let originalWorker;
function installMockWorker() {
    originalWorker = globalThis.Worker;
    globalThis.Worker = MockWorker;
    createdWorkers = [];
}
function restoreWorker() {
    if (originalWorker !== undefined) {
        globalThis.Worker = originalWorker;
    }
    createdWorkers = [];
}
afterEach(() => {
    restoreWorker();
});
describe("spawnWorker (Agent 5: crash + robustness)", () => {
    test("crash-after-ready fires onCrash exactly once", async () => {
        installMockWorker();
        const spawnP = spawnWorker("file:///mock.js");
        const w = createdWorkers[0];
        if (!w)
            throw new Error("no worker created");
        // Drive ready so spawn resolves and post-startup crash path is armed.
        w.simulateMessage({ type: "worker_ready" });
        const handle = await spawnP;
        const crashes = [];
        handle.onCrash((r) => crashes.push(r));
        // First post-ready error -> crash
        w.simulateError("boom");
        expect(handle.terminated).toBe(true);
        expect(crashes).toEqual(["error: boom"]);
        // Second error must not re-fire (exactly once guard)
        w.simulateError("boom2");
        expect(crashes).toEqual(["error: boom"]);
        // Also via onmessageerror after ready
        w.simulateMessageError();
        expect(crashes).toEqual(["error: boom"]);
    });
    test("onmessageerror after ready also fires onCrash", async () => {
        installMockWorker();
        const spawnP = spawnWorker();
        const w = createdWorkers[0];
        w.simulateMessage({ type: "worker_ready" });
        const handle = await spawnP;
        const crashes = [];
        handle.onCrash((r) => crashes.push(r));
        w.simulateMessageError();
        expect(crashes).toEqual(["messageerror"]);
        expect(handle.terminated).toBe(true);
    });
    test("throwing message handler does not starve later handlers", async () => {
        installMockWorker();
        const spawnP = spawnWorker();
        const w = createdWorkers[0];
        w.simulateMessage({ type: "worker_ready" });
        const handle = await spawnP;
        const seen = [];
        handle.onMessage(() => {
            throw new Error("handler1 boom");
        });
        handle.onMessage((m) => {
            if (m && m.type)
                seen.push(m.type);
        });
        w.simulateMessage({ type: "some_other" });
        // Second handler must have run despite first throwing.
        // Tolerate a preceding worker_ready in seen if the recorder was attached
        // in time for the (simulated) ready fanout — per required "ready falls through"
        // semantics preserved by Agent 4 restructure.
        const filtered = seen.filter((s) => s !== "worker_ready");
        expect(filtered).toEqual(["some_other"]);
    });
    test("name option defaults to jxl-worker and is passed to Worker", async () => {
        installMockWorker();
        const p1 = spawnWorker(undefined, {});
        const w1 = createdWorkers[createdWorkers.length - 1];
        w1.simulateMessage({ type: "worker_ready" });
        await p1;
        expect(w1.options.name).toEqual("jxl-worker");
        const p2 = spawnWorker("file:///x.js", { name: "custom-jxl" });
        const w2 = createdWorkers[createdWorkers.length - 1];
        w2.simulateMessage({ type: "worker_ready" });
        await p2;
        expect(w2.options.name).toEqual("custom-jxl");
    });
});
//# sourceMappingURL=spawn.test.js.map