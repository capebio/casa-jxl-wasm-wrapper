# Strategic Overview Production Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a production-ready v1 of the raw-converter-wasm pipeline as a WASM-first product with trustworthy packaging, repeatable verification, and explicit scope boundaries.

**Architecture:** Keep the existing workspace graph, but force every package to prove itself from packed artifacts, not from local `dist` or nested `node_modules`. Make capability detection, worker startup, and session typing share one contract so browser and Node paths make the same tier decisions. Use docs and smoke tests to lock v1 scope to the features we can actually support today, and defer native acceleration, PGO, and true ROI to separate milestones.

**Tech Stack:** Node/npm workspaces, TypeScript, Rust, C++/libjxl, node:test, Playwright, npm pack, browser workers.

---

### Task 1: Freeze v1 scope and release contract

**Files:**
- Modify: `docs/Strategic_overview.md`
- Modify: `docs/Strategic_overview_checklist.md`
- Create: `docs/Strategic_overview_v1_scope.md`

- [ ] **Step 1: Write the v1 scope note**

Draft a short scope file that states the supported product shape for v1:

```md
WASM-first in browser and Node.
Metadata-preserving encode/decode.
Progressive preview support.
Viewport helpers with honest full-frame-then-crop fallback.
No native acceleration guarantee in v1.
No PGO guarantee in v1.
No true tile-based ROI guarantee in v1.
```

- [ ] **Step 2: Tighten the overview language**

Edit `docs/Strategic_overview.md` so the production-readiness narrative matches current repo state:

```md
v1 ships as WASM-first with honest ROI fallback and no native guarantee.
Native Node, PGO, and true ROI are follow-on milestones.
```

- [ ] **Step 3: Update the checklist to match the scope**

Mark the deferred items as explicit follow-ons in `docs/Strategic_overview_checklist.md` and keep the rest of the checklist conservative.

- [ ] **Step 4: Verify the docs read as one story**

Run:

```bash
npm exec --yes prettier --check docs/Strategic_overview.md docs/Strategic_overview_checklist.md docs/Strategic_overview_v1_scope.md
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docs/Strategic_overview.md docs/Strategic_overview_checklist.md docs/Strategic_overview_v1_scope.md
git commit -m "docs: freeze v1 production scope"
```

### Task 2: Make packed-package proof the release gate

**Files:**
- Modify: `tools/pack-test.mjs`
- Modify: `tools/run-workspaces.mjs`
- Modify: `package.json`
- Test: `packages/jxl-session/test/integration.test.ts`
- Test: `packages/jxl-worker-browser/test/wasm-loader.test.ts`
- Test: `packages/jxl-worker-node/test/backend-selector.test.ts`

- [ ] **Step 1: Write the failing packed-artifact smoke coverage**

Extend `tools/pack-test.mjs` so the smoke app imports the actual public subpaths the product exposes, including worker entry points:

```js
["@casabio/jxl-worker-browser/worker", () => import("@casabio/jxl-worker-browser/worker")],
["@casabio/jxl-worker-node/worker", () => import("@casabio/jxl-worker-node/worker")],
```

- [ ] **Step 2: Run the current pack test**

Run:

```bash
npm run clean
npm run pack-test
```

Expected: If the smoke coverage is incomplete, it should fail on a missing public export or a bad packed import path.

- [ ] **Step 3: Fix the pack-test blind spots**

Update `tools/pack-test.mjs` so it validates the exported entry points that production consumers will import, not just the package root.

- [ ] **Step 4: Normalize workspace execution**

Keep `tools/run-workspaces.mjs` as the single root orchestrator and ensure `npm run build`, `npm run typecheck`, and `npm run test` all traverse the same workspace order.

- [ ] **Step 5: Re-run the release gate**

Run:

```bash
npm run build
npm run typecheck
npm run test
npm run pack-test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tools/pack-test.mjs tools/run-workspaces.mjs package.json packages/jxl-session/test/integration.test.ts packages/jxl-worker-browser/test/wasm-loader.test.ts packages/jxl-worker-node/test/backend-selector.test.ts
git commit -m "chore: make packed artifacts the release gate"
```

### Task 3: Align tier detection and capability reporting

**Files:**
- Modify: `packages/jxl-capabilities/src/index.ts`
- Modify: `packages/jxl-worker-browser/src/wasm-loader.ts`
- Modify: `packages/jxl-worker-node/src/backend-selector.ts`
- Test: `packages/jxl-capabilities/test/tier.test.ts`
- Test: `packages/jxl-worker-browser/test/wasm-loader.test.ts`
- Test: `packages/jxl-worker-node/test/backend-selector.test.ts`

- [ ] **Step 1: Write the failing tier tests**

Add tests that prove threaded tiers only appear when the runtime has the same prerequisites everywhere:

```ts
expect(detectTier()).toBe("scalar");
expect(capabilities.selectedWasmBuild).toBe("scalar");
```

- [ ] **Step 2: Run the failing tests**

Run:

```bash
npm test --workspace @casabio/jxl-capabilities --if-present
npm test --workspace @casabio/jxl-worker-browser --if-present
npm test --workspace @casabio/jxl-worker-node --if-present
```

Expected: The current mismatch around thread eligibility should fail before the fix.

- [ ] **Step 3: Centralize the MT eligibility rule**

Make `packages/jxl-capabilities/src/index.ts` the source of truth for threaded WASM eligibility. The rule should require all three conditions:

```ts
const canDoMT = wasmThreads && sharedArrayBuffer && crossOriginIsolated;
```

Use that same rule in the worker-browser and worker-node startup path so `detectTier()` and `getCapabilities()` cannot disagree.

- [ ] **Step 4: Re-run the tier tests**

Run:

```bash
npm test --workspace @casabio/jxl-capabilities --if-present
npm test --workspace @casabio/jxl-worker-browser --if-present
npm test --workspace @casabio/jxl-worker-node --if-present
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/jxl-capabilities/src/index.ts packages/jxl-worker-browser/src/wasm-loader.ts packages/jxl-worker-node/src/backend-selector.ts packages/jxl-capabilities/test/tier.test.ts packages/jxl-worker-browser/test/wasm-loader.test.ts packages/jxl-worker-node/test/backend-selector.test.ts
git commit -m "fix: align capability and tier selection"
```

### Task 4: Fix session and package type coherence

**Files:**
- Modify: `packages/jxl-session/src/index.ts`
- Modify: `packages/jxl-session/src/context.ts`
- Modify: `packages/jxl-session/test/jxl-core.test.ts`
- Modify: `packages/jxl-session/tsconfig.test.json`
- Modify: `packages/jxl-core/package.json`
- Modify: `packages/jxl-capabilities/package.json`

- [ ] **Step 1: Write the failing type checks**

Add or update a session test that imports the package the same way production does and exercises the package surface that previously diverged:

```ts
import { createEncoder } from "@casabio/jxl-wasm";

expect(() =>
  createEncoder({
    format: "rgba8",
    width: 100000,
    height: 100000,
    hasAlpha: true,
    iccProfile: null,
    exif: null,
    xmp: null,
    distance: null,
    quality: null,
    effort: 7,
    progressive: false,
    previewFirst: false,
    chunked: false,
  }),
).toThrow(/Image too large/);
```

- [ ] **Step 2: Run the package typecheck and session tests**

Run:

```bash
npm run typecheck --workspace @casabio/jxl-session --if-present
npm test --workspace @casabio/jxl-session --if-present
```

Expected: Failures point at type identity drift, stale exports, or mismatched optional property shapes.

- [ ] **Step 3: Remove the type drift**

Keep every session-facing type import rooted in the published package exports, not local copies. If a type is only needed to compile tests, move it into the test-only tsconfig instead of widening the runtime surface.

- [ ] **Step 4: Re-run the session checks**

Run:

```bash
npm run typecheck --workspace @casabio/jxl-session --if-present
npm test --workspace @casabio/jxl-session --if-present
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/jxl-session/src/index.ts packages/jxl-session/src/context.ts packages/jxl-session/test/jxl-core.test.ts packages/jxl-session/tsconfig.test.json packages/jxl-core/package.json packages/jxl-capabilities/package.json
git commit -m "fix: align session package types"
```

### Task 5: Make browser worker imports publishable

**Files:**
- Modify: `packages/jxl-worker-browser/src/wasm-loader.ts`
- Modify: `packages/jxl-worker-browser/src/worker.ts`
- Modify: `packages/jxl-worker-browser/package.json`
- Modify: `packages/jxl-worker-browser/test/wasm-loader.test.ts`
- Modify: `packages/jxl-worker-browser/test/handlers.test.ts`

- [ ] **Step 1: Write the failing worker-loader test**

Add a test that imports the browser worker from its packed package shape and confirms it does not depend on repo-relative `dist` paths at runtime.

- [ ] **Step 2: Run the worker-browser tests**

Run:

```bash
npm test --workspace @casabio/jxl-worker-browser --if-present
```

Expected: The current workspace-only import path should fail once the package is installed from tarball instead of the repo checkout.

- [ ] **Step 3: Switch the worker loader to a publishable import path**

Replace the workspace-relative WASM import in `packages/jxl-worker-browser/src/wasm-loader.ts` with a package-resolved path that still works after `npm pack` and `npm install` into a clean smoke app.

- [ ] **Step 4: Re-run the browser worker tests**

Run:

```bash
npm test --workspace @casabio/jxl-worker-browser --if-present
npm run pack-test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/jxl-worker-browser/src/wasm-loader.ts packages/jxl-worker-browser/src/worker.ts packages/jxl-worker-browser/package.json packages/jxl-worker-browser/test/wasm-loader.test.ts packages/jxl-worker-browser/test/handlers.test.ts
git commit -m "fix: make browser worker imports publishable"
```

### Task 6: Normalize test runners and CI expectations

**Files:**
- Modify: `packages/jxl-scheduler/package.json`
- Modify: `packages/jxl-stream/package.json`
- Modify: `packages/jxl-session/package.json`
- Modify: `packages/jxl-worker-browser/package.json`
- Modify: `packages/jxl-worker-node/package.json`
- Modify: `packages/jxl-wasm/package.json`

- [ ] **Step 1: Inventory runner mismatches**

Check each package script and make one runner per package explicit. Keep `node:test` packages on `node --test`, TypeScript-only packages on `tsc`, and browser-specific suites on their own harness.

- [ ] **Step 2: Run each package test script directly**

Run:

```bash
npm test --workspace @casabio/jxl-scheduler --if-present
npm test --workspace @casabio/jxl-stream --if-present
npm test --workspace @casabio/jxl-session --if-present
npm test --workspace @casabio/jxl-worker-browser --if-present
npm test --workspace @casabio/jxl-worker-node --if-present
```

Expected: No package should require an undeclared runner or a stale local install.

- [ ] **Step 3: Remove any package-local assumptions**

Keep package scripts and tests compatible with clean packed installs. Do not rely on `node_modules` that only exist inside the repo checkout.

- [ ] **Step 4: Re-run the root suite**

Run:

```bash
npm run build
npm run typecheck
npm run test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/jxl-scheduler/package.json packages/jxl-stream/package.json packages/jxl-session/package.json packages/jxl-worker-browser/package.json packages/jxl-worker-node/package.json packages/jxl-wasm/package.json
git commit -m "chore: normalize package test runners"
```

### Task 7: Add production deployment docs and smoke paths

**Files:**
- Create: `docs/JXL_production_integration.md`
- Modify: `packages/jxl-worker-browser/README.md`
- Modify: `packages/jxl-worker-node/README.md`
- Modify: `packages/jxl-wasm/README.md`
- Modify: `README.md`

- [ ] **Step 1: Write the failing doc checklist**

Create a production integration guide that lists the exact deployment requirements:

```md
COOP and COEP headers for threaded WASM.
Worker asset URLs.
WASM MIME types.
Cache policy.
Fallback behavior when threaded tiers are unavailable.
Node runtime requirements.
```

- [ ] **Step 2: Add sample deployment snippets**

Include one browser server snippet and one Node usage snippet that match the actual worker/package entry points in this repo.

- [ ] **Step 3: Verify the docs do not overpromise**

The guide must say that v1 is WASM-first and that native, PGO, and true ROI are not product guarantees yet.

- [ ] **Step 4: Review the rendered docs**

Run:

```bash
npm exec --yes prettier --check README.md docs/JXL_production_integration.md packages/jxl-worker-browser/README.md packages/jxl-worker-node/README.md packages/jxl-wasm/README.md
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docs/JXL_production_integration.md packages/jxl-worker-browser/README.md packages/jxl-worker-node/README.md packages/jxl-wasm/README.md README.md
git commit -m "docs: add production integration guide"
```

### Task 8: Harden security and acceptance gates

**Files:**
- Modify: `packages/jxl-wasm/test/facade.test.ts`
- Modify: `packages/jxl-wasm/test/progressive-detail.test.ts`
- Modify: `packages/jxl-session/test/integration.test.ts`
- Modify: `packages/jxl-worker-node/test/handlers.test.ts`
- Modify: `packages/jxl-test-corpus/src/index.ts`
- Modify: `packages/jxl-test-corpus/src/manifest.ts`

- [ ] **Step 1: Write the failing abuse-limit tests**

Add tests for oversized dimensions, cancellation under load, queue limits, and malformed fixture handling.

```ts
import { createEncoder } from "@casabio/jxl-wasm";

expect(() =>
  createEncoder({
    format: "rgba8",
    width: 100000,
    height: 100000,
    hasAlpha: true,
    iccProfile: null,
    exif: null,
    xmp: null,
    distance: null,
    quality: null,
    effort: 7,
    progressive: false,
    previewFirst: false,
    chunked: false,
  }),
).toThrow(/Image too large/);
```

- [ ] **Step 2: Run the security-relevant tests**

Run:

```bash
npm test --workspace @casabio/jxl-wasm --if-present
npm test --workspace @casabio/jxl-session --if-present
npm test --workspace @casabio/jxl-worker-node --if-present
```

Expected: The new tests should fail until the bounds and cancellation paths are covered.

- [ ] **Step 3: Add or tighten the runtime guards**

Keep the guards in the package that enforces the behavior closest to the risk:

```ts
if (bytes > 1024 * 1024 * 1024) {
  throw new Error("Image too large for WASM encode");
}
```

- [ ] **Step 4: Re-run the security tests and root suite**

Run:

```bash
npm run test
npm run pack-test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/jxl-wasm/test/facade.test.ts packages/jxl-wasm/test/progressive-detail.test.ts packages/jxl-session/test/integration.test.ts packages/jxl-worker-node/test/handlers.test.ts packages/jxl-test-corpus/src/index.ts packages/jxl-test-corpus/src/manifest.ts
git commit -m "fix: harden production acceptance gates"
```

## Deferred Milestones

- [ ] Native Node acceleration remains a separate milestone. Keep it documented as optional and do not block v1 on native prebuilds or host-library packaging.
- [ ] PGO remains a separate milestone. Keep build scripts and corpus support available, but do not claim production PGO until there is a reproducible release proof.
- [ ] True tile-based ROI remains a separate milestone. Keep the honest full-frame-then-crop fallback in v1 and add real tile ROI only when libjxl support and benchmarks prove the win.

## Exit Criteria

- `npm run clean`
- `npm run build`
- `npm run typecheck`
- `npm run test`
- `npm run pack-test`

All five commands pass from a clean checkout, the packed smoke app can import every publishable package, browser and Node tier selection agree on threaded eligibility, and the docs state the v1 limitations plainly.
