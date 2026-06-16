# JXL Session MT Fallback Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add browser-session routing that prefers MT workers for visible work, waits one short grace window, and then falls back to ST workers under contention.

**Architecture:** Keep worker pools homogeneous by introducing a browser-only routed context with two internal schedulers: MT-preferred and forced-ST. Session creation chooses one scheduler based on requested tier, shared `CoreBudget` availability, and a visible-only grace wait. Existing scheduler/pool budget accounting stays intact.

**Tech Stack:** TypeScript, `@casabio/jxl-session`, `@casabio/jxl-scheduler`, Node test runner / Bun test

---

### Task 1: Add tier-routing helper tests

**Files:**
- Create: `packages/jxl-session/test/tier-routing.test.ts`
- Modify: `packages/jxl-session/src/tier-routing.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  appendWorkerTierQuery,
  parseRequestedWorkerTier,
  shouldUseMtImmediately,
} from "../src/tier-routing.js";

describe("tier routing helpers", () => {
  it("parses explicit MT tier from wasmUrl", () => {
    assert.equal(parseRequestedWorkerTier("/worker.js?jxlWorkerTier=relaxed-simd-mt"), "relaxed-simd-mt");
  });

  it("adds or replaces jxlWorkerTier query", () => {
    assert.equal(
      appendWorkerTierQuery("/worker.js?foo=1", "simd"),
      "/worker.js?foo=1&jxlWorkerTier=simd",
    );
  });

  it("allows immediate MT only when idle worker or spawn budget is available", () => {
    assert.equal(shouldUseMtImmediately({ poolIdle: 1, poolSize: 1, poolSpawning: 0 }, 2, 0, 4), true);
    assert.equal(shouldUseMtImmediately({ poolIdle: 0, poolSize: 2, poolSpawning: 0 }, 2, 4, 4), false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk proxy bun test packages/jxl-session/test/tier-routing.test.ts`
Expected: FAIL with missing module or missing exported functions from `tier-routing.ts`

- [ ] **Step 3: Write minimal implementation**

```ts
export function parseRequestedWorkerTier(url?: string): "auto" | "relaxed-simd-mt" | "simd-mt" | "simd" | "scalar" {
  // parse query and default to auto
}

export function appendWorkerTierQuery(url: string | undefined, tier: "auto" | "relaxed-simd-mt" | "simd-mt" | "simd" | "scalar"): string | undefined {
  // replace query param on a relative/absolute URL string
}

export function shouldUseMtImmediately(
  metrics: { poolIdle: number; poolSize: number; poolSpawning: number },
  maxWorkers: number,
  budgetAvailable: number,
  mtCost: number,
): boolean {
  // true when an MT worker can run now instead of queueing
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `rtk proxy bun test packages/jxl-session/test/tier-routing.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/jxl-session/src/tier-routing.ts packages/jxl-session/test/tier-routing.test.ts
git commit -m "test: add tier routing helper coverage"
```

### Task 2: Add routed-context fallback policy tests

**Files:**
- Create: `packages/jxl-session/test/tiered-context.test.ts`
- Modify: `packages/jxl-session/src/context-base.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CoreBudget } from "@casabio/jxl-scheduler";
import { makeScheduler } from "./helpers.js";
import { createTieredSchedulerRouter } from "../src/context-base.js";

describe("tiered scheduler router", () => {
  it("background work falls back to ST immediately when MT cannot run now", async () => {
    const budget = new CoreBudget(4);
    await budget.acquire(4);
    const mt = makeScheduler(1).scheduler;
    const st = makeScheduler(1).scheduler;
    const router = createTieredSchedulerRouter({ mtScheduler: mt, stScheduler: st, mtCost: 4, maxWorkers: 1, coreBudget: budget, visibleGraceMs: 16 });
    assert.equal(await router.pick("background"), st);
    await mt.shutdown();
    await st.shutdown();
    budget.release(4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk proxy bun test packages/jxl-session/test/tiered-context.test.ts`
Expected: FAIL with missing router export

- [ ] **Step 3: Write minimal implementation**

```ts
export function createTieredSchedulerRouter(...) {
  return {
    async pick(priority) {
      // visible: try now, sleep grace, retry, else ST
      // near/background: immediate MT if runnable now else ST
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `rtk proxy bun test packages/jxl-session/test/tiered-context.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/jxl-session/src/context-base.ts packages/jxl-session/test/tiered-context.test.ts
git commit -m "test: add tiered session router coverage"
```

### Task 3: Wire browser context to use routed schedulers

**Files:**
- Modify: `packages/jxl-session/src/browser.ts`
- Modify: `packages/jxl-session/src/context.ts`
- Modify: `packages/jxl-session/src/context-base.ts`
- Modify: `packages/jxl-session/src/tier-routing.ts`

- [ ] **Step 1: Write the failing integration-oriented test**

```ts
it("visible MT-preferring browser session waits once then falls back to forced simd worker URL", async () => {
  // build routed context with fake factory recorders
  // saturate MT budget/path
  // create visible decode session
  // assert chosen scheduler/factory used the simd URL after grace
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk proxy bun test packages/jxl-session/test/tiered-context.test.ts`
Expected: FAIL because browser context still uses one scheduler and never rewrites worker tier

- [ ] **Step 3: Write minimal implementation**

```ts
const mtWorkerUrl = appendWorkerTierQuery(opts?.wasmUrl, requestedTier);
const stWorkerUrl = appendWorkerTierQuery(opts?.wasmUrl, "simd");
// create two JxlContextImpl schedulers or one routed context wrapper
// pick scheduler per session priority before constructing DecodeSessionImpl / EncodeSessionImpl
```

- [ ] **Step 4: Run targeted tests**

Run: `rtk proxy bun test packages/jxl-session/test/tier-routing.test.ts packages/jxl-session/test/tiered-context.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/jxl-session/src/browser.ts packages/jxl-session/src/context.ts packages/jxl-session/src/context-base.ts packages/jxl-session/src/tier-routing.ts packages/jxl-session/test/tier-routing.test.ts packages/jxl-session/test/tiered-context.test.ts
git commit -m "feat: route MT sessions to ST fallback under contention"
```

### Task 4: Verify package-level regressions

**Files:**
- Test: `packages/jxl-session/test/decode-session.test.ts`
- Test: `packages/jxl-session/test/encode-session.test.ts`
- Test: `packages/jxl-scheduler/test/scheduler.budget.test.ts`

- [ ] **Step 1: Run session package tests**

Run: `rtk proxy bun test packages/jxl-session/test/*.test.ts`
Expected: PASS

- [ ] **Step 2: Run scheduler budget regression tests**

Run: `rtk proxy bun test packages/jxl-scheduler/test/scheduler.budget.test.ts`
Expected: PASS

- [ ] **Step 3: Inspect for accidental doc/spec drift**

```ts
// No code change step; confirm no protocol/type drift escaped tests.
```

- [ ] **Step 4: Commit final verified implementation**

```bash
git add packages/jxl-session packages/jxl-scheduler
git commit -m "feat: add visible MT grace fallback routing"
```
