// jxl-scheduler/test/pool.test.ts
// Tests for WorkerPool: creation, idle reaping, recycling.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WorkerPool } from "../src/pool.js";
import { FakeWorker, fakeWorkerFactory } from "./helpers.js";

describe("WorkerPool", () => {
  it("spawns workers up to maxSize", async () => {
    const workers: FakeWorker[] = [];
    const pool = new WorkerPool({ factory: fakeWorkerFactory(workers), maxSize: 2, idleTimeoutMs: 60_000 });

    const w1 = await pool.acquire();
    const w2 = await pool.acquire();
    assert.ok(w1 !== null, "first acquire returns worker");
    assert.ok(w2 !== null, "second acquire returns worker");

    pool.bind(w1!, "session-1");
    pool.bind(w2!, "session-2");

    const w3 = await pool.acquire();
    assert.equal(w3, null, "third acquire returns null when at capacity");

    await pool.shutdown();
  });

  it("returns idle workers first", async () => {
    const workers: FakeWorker[] = [];
    const pool = new WorkerPool({ factory: fakeWorkerFactory(workers), maxSize: 2, idleTimeoutMs: 60_000 });

    const w1 = await pool.acquire();
    assert.ok(w1 !== null);
    pool.bind(w1!, "s1");
    pool.release(w1!); // back to idle

    const w2 = await pool.acquire();
    assert.equal(w2, w1, "reuses idle worker");
    await pool.shutdown();
  });

  it("recycles poisoned worker and removes from pool", async () => {
    const workers: FakeWorker[] = [];
    const pool = new WorkerPool({ factory: fakeWorkerFactory(workers), maxSize: 2, idleTimeoutMs: 60_000 });

    const w1 = await pool.acquire();
    assert.ok(w1 !== null);
    pool.bind(w1!, "s1");
    pool.recycle(w1!);

    assert.equal(pool.size, 0, "pool size drops after recycle");
    assert.equal(workers[0]!.terminated, true, "recycled worker is terminated");
    await pool.shutdown();
  });
});
