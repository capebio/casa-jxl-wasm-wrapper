// jxl-scheduler/test/queue.test.ts
// Tests for PriorityQueue: visible > near > background ordering.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PriorityQueue } from "../src/queue.js";

describe("PriorityQueue", () => {
  it("dequeues visible before near before background", () => {
    const q = new PriorityQueue<number>();
    q.enqueue({ priority: "background", sessionId: "bg1", payload: 1 });
    q.enqueue({ priority: "near", sessionId: "nr1", payload: 2 });
    q.enqueue({ priority: "visible", sessionId: "vs1", payload: 3 });

    assert.equal(q.dequeue()?.priority, "visible");
    assert.equal(q.dequeue()?.priority, "near");
    assert.equal(q.dequeue()?.priority, "background");
    assert.equal(q.dequeue(), null);
  });

  it("remove by sessionId", () => {
    const q = new PriorityQueue<number>();
    q.enqueue({ priority: "near", sessionId: "s1", payload: 1 });
    q.enqueue({ priority: "near", sessionId: "s2", payload: 2 });

    assert.equal(q.remove("s1"), true);
    assert.equal(q.size, 1);
    assert.equal(q.dequeue()?.sessionId, "s2");
  });

  it("returns background IDs", () => {
    const q = new PriorityQueue<number>();
    q.enqueue({ priority: "background", sessionId: "bg1", payload: 1 });
    q.enqueue({ priority: "background", sessionId: "bg2", payload: 2 });
    q.enqueue({ priority: "visible", sessionId: "vs1", payload: 3 });

    assert.deepEqual(q.backgroundIds().sort(), ["bg1", "bg2"]);
  });
});
