# Production Hygiene Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the repo installable, buildable, and packable from one workspace root with coherent internal package resolution and a real packed-artifact smoke check.

**Architecture:** Convert the repository into a single workspace root with workspace-resolved internal packages instead of nested `file:` copies. Normalize package scripts so root-level commands can build, typecheck, test, and pack-check the whole graph. Add one smoke harness that installs packed tarballs into a clean temp directory and proves the published shape works outside the source tree.

**Tech Stack:** npm workspaces, TypeScript, Node test runner, existing package `dist/` builds, local shell scripts.

---

### Task 1: Define the workspace root and remove nested package links

**Files:**
- Modify: `package.json`
- Modify: `packages/jxl-core/package.json`
- Modify: `packages/jxl-policy/package.json`
- Modify: `packages/jxl-cache/package.json`
- Modify: `packages/jxl-session/package.json`
- Modify: `packages/jxl-scheduler/package.json`
- Modify: `packages/jxl-worker-browser/package.json`
- Modify: `packages/jxl-worker-node/package.json`
- Modify: `packages/jxl-stream/package.json`
- Modify: `packages/jxl-capabilities/package.json`
- Modify: `packages/jxl-wasm/package.json`
- Modify: `packages/jxl-native/package.json`
- Modify: `packages/jxl-test-corpus/package.json`
- Update: `package-lock.json`

- [ ] **Step 1: Replace local `file:` references with workspace-safe semver references**

Use the same package version across internal deps so the root workspace can resolve them without nested copies:

```json
{
  "dependencies": {
    "@casabio/jxl-core": "^0.1.0"
  }
}
```

Keep `@casabio/jxl-core` as the single source of truth for shared types.

- [ ] **Step 2: Turn the root `package.json` into a workspace root**

Add a package identity, workspace list, and root commands:

```json
{
  "name": "raw-converter-wasm",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "build": "npm run -ws build",
    "typecheck": "npm run -ws typecheck",
    "test": "npm run -ws test",
    "pack-test": "node tools/pack-test.mjs",
    "clean": "node tools/clean.mjs"
  }
}
```

- [ ] **Step 3: Refresh the lockfile from the new workspace graph**

Run:

```bash
npm install
```

Expected: one root lockfile that resolves all workspace packages without nested `packages/*/node_modules/@casabio/*` copies.

- [ ] **Step 4: Verify workspace resolution**

Run:

```bash
npm ls @casabio/jxl-core --workspaces
```

Expected: every internal consumer resolves the workspace package, not a `file:` clone.

### Task 2: Normalize package scripts around one canonical runner per package

**Files:**
- Modify: `packages/jxl-scheduler/package.json`
- Modify: `packages/jxl-session/package.json`
- Modify: `packages/jxl-stream/package.json`
- Modify: `packages/jxl-worker-browser/package.json`
- Modify: `packages/jxl-worker-node/package.json`
- Modify: `packages/jxl-capabilities/package.json`
- Modify: `packages/jxl-cache/package.json`
- Modify: `packages/jxl-policy/package.json`
- Modify: `packages/jxl-core/package.json`
- Modify: `packages/jxl-wasm/package.json`

- [ ] **Step 1: Give every workspace a predictable `typecheck` script**

Example:

```json
{
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit"
  }
}
```

For packages that only build generated output, keep `build` and add `typecheck` if absent.

- [ ] **Step 2: Replace the dead Jest entry in `jxl-scheduler`**

Use the package’s existing `test/*.test.ts` files and the Node test runner that the package already compiles for:

```json
{
  "scripts": {
    "test": "tsc -p tsconfig.test.json && node --test --test-force-exit dist-test/test/*.test.js"
  }
}
```

- [ ] **Step 3: Keep `jxl-session` and `jxl-stream` aligned with their compiled-test flow**

Make sure their test scripts compile test sources first, then run the built JS under `node --test`.

- [ ] **Step 4: Run the package-level checks once the scripts are normalized**

Run:

```bash
npm run -w packages/jxl-scheduler test
npm run -w packages/jxl-session test
npm run -w packages/jxl-stream test
```

Expected: no runner mismatch, no missing Jest install, no source-vs-dist confusion.

### Task 3: Make the WASM package publishable and rebuildable from source

**Files:**
- Modify: `packages/jxl-wasm/package.json`
- Modify: `packages/jxl-wasm/scripts/build.mjs`
- Modify: `packages/jxl-wasm/scripts/build-pgo.mjs`
- Modify: `packages/jxl-wasm/scripts/write-manifest.mjs`
- Modify: `packages/jxl-wasm/tsconfig.json`

- [ ] **Step 1: Remove the `private` block from `@casabio/jxl-wasm`**

Keep the package scoped and file-restricted, but allow `npm pack` so downstream consumers can install the published shape.

- [ ] **Step 2: Confirm `dist/` is always generated from source before use**

Make the build script emit the JS and `.d.ts` files that the package exports, then write the manifest from the same build output.

- [ ] **Step 3: Keep the package export map pointed only at built artifacts**

The published entrypoints must continue to resolve to `./dist/*` and not rely on source files.

- [ ] **Step 4: Verify the package can be packed**

Run:

```bash
npm pack --workspace @casabio/jxl-wasm
```

Expected: a tarball containing `dist/` and the published entrypoints, with no source-path assumptions.

### Task 4: Add a packed-artifact smoke test and root clean command

**Files:**
- Create: `tools/pack-test.mjs`
- Create: `tools/clean.mjs`
- Modify: `package.json`

- [ ] **Step 1: Add a smoke harness that installs packed tarballs into a temp app**

The harness should:

1. Create a temp directory under `tmp/`.
2. `npm pack` the workspace packages that are meant to ship.
3. Install the tarballs into a clean temp project.
4. Import the public entrypoints and verify basic resolution.

Minimal smoke assertions:

```js
import { createSession } from "@casabio/jxl-session";
import { getCapabilities } from "@casabio/jxl-capabilities";
```

This is a resolution test first, not a full codec benchmark.

- [ ] **Step 2: Add a root clean script that only removes generated artifacts**

Keep the deletion list explicit and bounded to build output:

```js
// tools/clean.mjs
// remove dist, dist-test, tmp work folders, and package-local node_modules that are generated
```

- [ ] **Step 3: Wire both scripts into the root `package.json`**

Root commands must stay one-line and reproducible:

```json
{
  "scripts": {
    "pack-test": "node tools/pack-test.mjs",
    "clean": "node tools/clean.mjs"
  }
}
```

- [ ] **Step 4: Run the smoke test from a clean tree**

Run:

```bash
npm run clean
npm run build
npm run pack-test
```

Expected: packed tarballs install and resolve outside the source tree.

### Task 5: Rebuild and verify the workspace end to end

**Files:**
- No new files expected
- May update: generated `dist/` and `package-lock.json`

- [ ] **Step 1: Rebuild all workspace packages**

Run:

```bash
npm run build
```

Expected: all package `dist/` outputs regenerate from the source tree.

- [ ] **Step 2: Typecheck all workspace packages**

Run:

```bash
npm run typecheck
```

Expected: no stale-export or duplicate-type-identity errors remain.

- [ ] **Step 3: Run workspace tests**

Run:

```bash
npm run test
```

Expected: package test suites use the runner each package declares, not an accidental fallback.

- [ ] **Step 4: Record any remaining verification gaps**

If a package still fails for environmental reasons, capture that in `QUESTIONS.md` or a follow-up handoff rather than leaving the repo half-normalized.

