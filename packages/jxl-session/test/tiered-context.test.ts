import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CoreBudget } from "@casabio/jxl-scheduler";
import { createTieredSchedulerRouter } from "../src/context-base.js";

function metrics(overrides: Partial<{
  poolIdle: number;
  poolSize: number;
  poolSpawning: number;
}> = {}) {
  return {
    running: 0,
    queued: 0,
    paused: 0,
    background: 0,
    preemptions: 0,
    totalSessions: 0,
    subscribers: 0,
    drainLatencyEmaMs: 0,
    effectiveHwm: 0,
    poolSize: 0,
    poolIdle: 0,
    poolParked: 0,
    poolSpawning: 0,
    ...overrides,
  };
}

describe("tiered scheduler router", () => {
  it("background work falls back to ST immediately when MT cannot run now", async () => {
    const budget = new CoreBudget(4);
    await budget.acquire(4);
    const mtScheduler = { getMetrics: () => metrics({ poolIdle: 0, poolSize: 1, poolSpawning: 0 }) };
    const stScheduler = { getMetrics: () => metrics({ poolIdle: 0, poolSize: 0, poolSpawning: 0 }) };
    const router = createTieredSchedulerRouter({
      mtScheduler,
      stScheduler,
      mtCost: 4,
      maxWorkers: 1,
      coreBudget: budget,
      visibleGraceMs: 16,
    });

    assert.equal(await router.pick("background"), stScheduler);
    budget.release(4);
  });

  it("visible work waits one grace window before falling back to ST", async () => {
    const budget = new CoreBudget(4);
    await budget.acquire(4);
    const mtScheduler = { getMetrics: () => metrics({ poolIdle: 0, poolSize: 1, poolSpawning: 0 }) };
    const stScheduler = { getMetrics: () => metrics({ poolIdle: 0, poolSize: 0, poolSpawning: 0 }) };
    let sleeps = 0;
    const router = createTieredSchedulerRouter({
      mtScheduler,
      stScheduler,
      mtCost: 4,
      maxWorkers: 1,
      coreBudget: budget,
      visibleGraceMs: 16,
      sleep: async () => { sleeps++; },
    });

    assert.equal(await router.pick("visible"), stScheduler);
    assert.equal(sleeps, 1);
    budget.release(4);
  });

  it("visible work stays on MT when capacity appears during grace wait", async () => {
    const budget = new CoreBudget(4);
    await budget.acquire(4);
    let afterSleep = false;
    const mtScheduler = {
      getMetrics: () => afterSleep
        ? metrics({ poolIdle: 1, poolSize: 1, poolSpawning: 0 })
        : metrics({ poolIdle: 0, poolSize: 1, poolSpawning: 0 }),
    };
    const stScheduler = { getMetrics: () => metrics({ poolIdle: 0, poolSize: 0, poolSpawning: 0 }) };
    const router = createTieredSchedulerRouter({
      mtScheduler,
      stScheduler,
      mtCost: 4,
      maxWorkers: 1,
      coreBudget: budget,
      visibleGraceMs: 16,
      sleep: async () => {
        afterSleep = true;
        budget.release(4);
      },
    });

    assert.equal(await router.pick("visible"), mtScheduler);
  });
});
