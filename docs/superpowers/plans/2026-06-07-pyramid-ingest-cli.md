# Pyramid Ingest CLI (Plan B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the on-device Node CLI that turns a RAW (ORF/DNG/CR2) or JPG master into a content-addressed JXL resolution pyramid plus per-image `manifest.json` and a gallery `index.json`, with a single-level proxy mode for verification.

**Architecture:** A new pure-WASM workspace package `@casabio/pyramid-ingest`. The decode/encode work is hidden behind two injected backends — `RawBackend` (wraps the Rust `web/pkg` RAW pipeline) and `JxlBackend` (wraps `@casabio/jxl-wasm`: `encodeRgba8Pyramid`, `transcodeJpegToJxl`, `createDecoder`). All orchestration (quality→distance mapping, content hashing, ladder assembly, manifest/index building, file writing, batching) is small pure modules that take the backends as parameters, so the whole pipeline is unit-testable against the scalar WASM build with a fake RAW backend.

**Tech Stack:** TypeScript (ES2022, NodeNext-style `.js` import specifiers), Node built-ins (`node:crypto`, `node:fs/promises`, `node:path`, `node:url`, `node:util`), `@casabio/jxl-wasm` (pyramid encode + transcode + decode), the Rust `web/pkg` WASM RAW pipeline, `bun test` as the runner, `sharp` as a **test-only** JPEG fixture generator (never imported by shipped code).

**Scope — M1, 8-bit only:** Every emitted level is 8-bit (`bitsPerSample: 8`). RAW 16-bit big levels `{2048, full}` are **deferred to M3** because the Rust pipeline computes a full-resolution RGB16 buffer internally then drops it (`src/lib.rs`); exposing it is an M3/Plan D2 change. Plan A still ships the 16-bit primitives (`downscaleRgba16`, the rgba16 encoder); Plan B simply does not consume them yet. This matches the amended spec (§4 Bit depth, milestone map, §15).

---

## Dependencies & Preconditions

**This plan consumes Plan A (`2026-06-07-pyramid-wasm-primitives.md`) and CANNOT run until Plan A is fully executed.** Specifically:

1. **`encodeRgba8Pyramid` must exist in `packages/jxl-wasm/src/facade.ts`** (Plan A Task 1) and be re-exported from `src/index.ts` (it already is — `index.ts` is `export * from "./facade.js"`).
2. **`packages/jxl-wasm/dist/jxl-core.scalar.{js,wasm}` must be rebuilt** with the `sidecars_v2` bridge export (Plan A Task 3). The runtime tests in this plan load that scalar build; against a stale `dist`, `encodeRgba8Pyramid` throws `CapabilityMissing` and the tests fail.
3. **`packages/jxl-wasm/dist/facade.js` + `dist/index.js` must be re-emitted from the Plan-A-edited `facade.ts`.** This is a real gap: `@casabio/jxl-wasm`'s `build` script is `node scripts/build.mjs` (WASM only — it does **not** run `tsc`), so the committed `dist/*.js` is stale after Plan A edits `facade.ts`. This package imports `@casabio/jxl-wasm`, which resolves via `package.json` `exports` to `dist/index.js` → `dist/facade.js`. **Task 1 below emits the dist JS and adds a guard test** so a stale facade fails loudly instead of silently.

**No `src/lib.rs` or `web/pkg` rebuild is required** — Plan B calls only the already-exported `process_orf_with_flags` / `process_dng_with_flags` / `process_cr2_with_flags` + `take_rgba()` (all present in `web/pkg/raw_converter_wasm.d.ts`).

**Spec alignment (already reconciled in the same commit as this plan):** the design spec was amended so RAW ingest is 8-bit in M1, the manifest example shows `bitsPerSample: 8`, `orientation` is the union `"baked" | "source"`, and 16-bit ingest moved to M3. Do not re-edit the spec for those items.

---

## Quality → Distance (libjxl) — the numbers this CLI passes

`distance = 0.1 + (100 − q) · 0.09` for `30 ≤ q < 100`; `q = 100 → distance 0` (lossless).

| Level set | Quality | Distance |
|-----------|---------|----------|
| grid `{256, 512, 1024}` | q85 | ≈ **1.45** |
| big `{2048}` and the full re-encode | q95 | ≈ **0.55** |
| JPG full level | lossless transcode | **0** (no re-encode) |
| proxy level | q85 | ≈ **1.45** |

Floating-point note: `0.1 + 15*0.09` evaluates to `1.4499999999999997` in JS, not exactly `1.45`. Tests MUST use `toBeCloseTo`, never `toBe`, on distances.

---

## File Structure

| File | Change | Responsibility |
|------|--------|----------------|
| `packages/pyramid-ingest/package.json` | Create | Workspace manifest (`@casabio/pyramid-ingest`); deps `@casabio/jxl-wasm`; scripts `build`/`typecheck`/`test`; `bin` for the CLI |
| `packages/pyramid-ingest/tsconfig.json` | Create | ES2022 + bundler resolution, strict, `skipLibCheck: true` (consumes prebuilt lib `.d.ts`) |
| `packages/pyramid-ingest/src/index.ts` | Create | Public re-exports (for tests + consumers) |
| `packages/pyramid-ingest/src/quality.ts` | Create | `qualityToDistance`, level/effort constants, `planLadder`, `planProxy` |
| `packages/pyramid-ingest/src/hash.ts` | Create | `contentHash16` (level dedupe key), `imageIdForPath` (stable per-master id) |
| `packages/pyramid-ingest/src/shard.ts` | Create | `planShard` (round-robin partition), `boundedConcurrency` (mem/core clamp) |
| `packages/pyramid-ingest/src/manifest.ts` | Create | Manifest/index types + `buildManifest`, `buildIndexEntry`, `isUpToDate`, `levelSize`, `toEntry` |
| `packages/pyramid-ingest/src/backends.ts` | Create | `RawBackend` / `JxlBackend` interfaces, shared types, `createJxlBackend` |
| `packages/pyramid-ingest/src/raw-backend.ts` | Create | `createRawBackend` — wraps `web/pkg` (lazy WASM init, `take_rgba()` full RGB8) |
| `packages/pyramid-ingest/src/ladder.ts` | Create | `buildRawLadder`, `buildJpgLadder`, `buildProxyLadder` (pure compute of level bytes) |
| `packages/pyramid-ingest/src/ingest.ts` | Create | `formatFromPath`, `ingestImage`, `ingestBatch`, `rebuildIndex`, file I/O |
| `packages/pyramid-ingest/src/cli.ts` | Create | `node:util` arg parsing, `collectInputs`, wire real backends, `main` |
| `packages/pyramid-ingest/test/*.test.ts` | Create | Pure-unit tests + scalar-WASM integration tests + sharp-fixture JPG test |
| `tools/run-workspaces.mjs` | Modify | Append `@casabio/pyramid-ingest` to `workspaceOrder` (after `@casabio/jxl-wasm`) |

**Test-runner convention:** `bun test <path>` from the repo root (same as Plan A / `packages/jxl-wasm`). Bun runs TS directly — the WASM-dependent tests need Plan A's rebuilt `dist`, but no build of *this* package.

---

## Task 1: Scaffold the package + emit jxl-wasm dist + import guard

**Files:**
- Create: `packages/pyramid-ingest/package.json`
- Create: `packages/pyramid-ingest/tsconfig.json`
- Create: `packages/pyramid-ingest/src/index.ts`
- Modify: `tools/run-workspaces.mjs`
- Test: `packages/pyramid-ingest/test/guard.test.ts`

- [ ] **Step 1: Write the failing guard test**

Create `packages/pyramid-ingest/test/guard.test.ts`:

```ts
import { expect, test } from "bun:test";

// The single most important precondition: Plan A's facade export must be present in the
// COMPILED dist that this package resolves to (package.json exports -> dist/index.js).
// If dist is stale (jxl-wasm's build is WASM-only and does not run tsc), this fails loudly.
test("@casabio/jxl-wasm exposes the pyramid encode API", async () => {
  const mod = await import("@casabio/jxl-wasm");
  expect(typeof mod.encodeRgba8Pyramid).toBe("function");
  expect(typeof mod.transcodeJpegToJxl).toBe("function");
  expect(typeof mod.createDecoder).toBe("function");
  expect(typeof mod.setJxlModuleFactoryForTesting).toBe("function");
  expect(typeof mod.setForcedTier).toBe("function");
});
```

- [ ] **Step 2: Run the guard test to verify it fails**

Run: `bun test packages/pyramid-ingest/test/guard.test.ts`
Expected: FAIL — `@casabio/pyramid-ingest` is not yet a workspace (module `@casabio/jxl-wasm` may resolve, but the package dir/`node_modules` link for this package does not exist), or `encodeRgba8Pyramid` is absent from the stale `dist/index.js`. Either way the assertion/`import` fails.

- [ ] **Step 3: Create the package manifest**

Create `packages/pyramid-ingest/package.json`:

```json
{
  "name": "@casabio/pyramid-ingest",
  "version": "0.1.0",
  "description": "On-device Node CLI: RAW/JPG master -> content-addressed JXL pyramid + manifest/index",
  "type": "module",
  "bin": {
    "pyramid-ingest": "./dist/cli.js"
  },
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "bun test"
  },
  "dependencies": {
    "@casabio/jxl-wasm": "^0.1.0"
  },
  "devDependencies": {
    "@types/node": "^22.12.0",
    "typescript": "5.5.4"
  }
}
```

- [ ] **Step 4: Create the tsconfig**

Create `packages/pyramid-ingest/tsconfig.json`. `skipLibCheck: true` deliberately deviates from `jxl-wasm` (`false`): this package consumes the prebuilt `@casabio/jxl-wasm` `.d.ts`, which declares a DOM `lib`; this is a Node-only CLI with `lib: ["ES2022"]`, so skipping dependency lib-check avoids spurious DOM-type errors.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["node"],
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "verbatimModuleSyntax": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["dist", "node_modules", "test"]
}
```

- [ ] **Step 5: Create a minimal `src/index.ts`**

Create `packages/pyramid-ingest/src/index.ts` (filled in as modules land; start with a comment so the file compiles):

```ts
// Public surface for @casabio/pyramid-ingest. Extended as each module is added.
export {};
```

- [ ] **Step 6: Register the workspace in the build order**

In `tools/run-workspaces.mjs`, add `"@casabio/pyramid-ingest"` to `workspaceOrder` immediately after `"@casabio/jxl-wasm"`:

```js
  "@casabio/jxl-wasm",
  "@casabio/pyramid-ingest",
  "@casabio/jxl-worker-browser",
```

- [ ] **Step 7: Install workspaces so the new package links**

Run from the repo root: `npm install`
Expected: npm links `@casabio/pyramid-ingest` into `node_modules/@casabio/` and resolves its `@casabio/jxl-wasm` dependency to the workspace.

- [ ] **Step 8: Emit the jxl-wasm dist JS from the Plan-A-edited facade**

Plan A edited `facade.ts` but its `build` script rebuilds only WASM. Re-emit the TypeScript dist so `encodeRgba8Pyramid` is in `dist/facade.js`/`dist/index.js`:

Run: `cd packages/jxl-wasm && npx tsc && cd ../..`
Expected: PASS — `tsc` uses `packages/jxl-wasm/tsconfig.json` (`outDir: ./dist`, no `noEmit`) and regenerates `dist/facade.js`, `dist/index.js`, `dist/loader.js` (+ `.d.ts`/maps). No type errors (Plan A Task 1/2 already typechecked).

- [ ] **Step 9: Run the guard test to verify it passes**

Run: `bun test packages/pyramid-ingest/test/guard.test.ts`
Expected: PASS — the compiled `dist/index.js` now exports `encodeRgba8Pyramid` and friends.

- [ ] **Step 10: Commit**

```bash
git add packages/pyramid-ingest/package.json packages/pyramid-ingest/tsconfig.json packages/pyramid-ingest/src/index.ts packages/pyramid-ingest/test/guard.test.ts tools/run-workspaces.mjs packages/jxl-wasm/dist package-lock.json
git commit -m "feat(pyramid-ingest): scaffold workspace + jxl-wasm dist emit guard"
```

---

## Task 2: Quality → distance + ladder plan (`quality.ts`)

**Files:**
- Create: `packages/pyramid-ingest/src/quality.ts`
- Modify: `packages/pyramid-ingest/src/index.ts`
- Test: `packages/pyramid-ingest/test/quality.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/pyramid-ingest/test/quality.test.ts`:

```ts
import { expect, test } from "bun:test";
import {
  qualityToDistance,
  planLadder,
  planProxy,
  EFFORT,
  LEVEL_SIZES,
  GRID_QUALITY,
  BIG_QUALITY,
} from "../src/quality";

test("qualityToDistance follows libjxl 0.1 + (100-q)*0.09", () => {
  expect(qualityToDistance(85)).toBeCloseTo(1.45, 5);
  expect(qualityToDistance(95)).toBeCloseTo(0.55, 5);
  expect(qualityToDistance(100)).toBe(0); // lossless short-circuit
});

test("qualityToDistance rejects q below the libjxl-defined range", () => {
  expect(() => qualityToDistance(29)).toThrow();
});

test("planLadder pairs grid sizes with q85 and the 2048 big level with q95", () => {
  const plan = planLadder();
  expect(plan.sidecarSizes).toEqual([...LEVEL_SIZES]);
  expect(plan.effort).toBe(EFFORT);
  // sizes < 2048 -> q85 distance; size 2048 -> q95 distance
  expect(plan.sidecarDistances.length).toBe(plan.sidecarSizes.length);
  expect(plan.sidecarDistances[0]).toBeCloseTo(qualityToDistance(GRID_QUALITY), 5); // 256
  expect(plan.sidecarDistances[2]).toBeCloseTo(qualityToDistance(GRID_QUALITY), 5); // 1024
  expect(plan.sidecarDistances[3]).toBeCloseTo(qualityToDistance(BIG_QUALITY), 5);  // 2048
  expect(plan.fullDistance).toBeCloseTo(qualityToDistance(BIG_QUALITY), 5);
});

test("planProxy emits a single q85 level at the requested size", () => {
  const plan = planProxy(512);
  expect(plan.sidecarSizes).toEqual([512]);
  expect(plan.sidecarDistances[0]).toBeCloseTo(qualityToDistance(85), 5);
  expect(plan.fullDistance).toBeCloseTo(qualityToDistance(85), 5);
  expect(plan.effort).toBe(EFFORT);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/pyramid-ingest/test/quality.test.ts`
Expected: FAIL — `../src/quality` does not exist (module-not-found).

- [ ] **Step 3: Implement `quality.ts`**

Create `packages/pyramid-ingest/src/quality.ts`:

```ts
import type { PyramidEncodeOptions } from "./backends.js";

/** libjxl quality->distance: distance = 0.1 + (100 - q) * 0.09, with q=100 lossless (0). */
export function qualityToDistance(quality: number): number {
  if (quality >= 100) return 0;
  if (quality < 30) {
    throw new Error(`quality ${quality} out of range: libjxl distance mapping requires q >= 30`);
  }
  return 0.1 + (100 - quality) * 0.09;
}

export const EFFORT = 3; // memory: effort 3 best on speed + filesize
export const GRID_QUALITY = 85;
export const BIG_QUALITY = 95;
export const PROXY_QUALITY = 85;

/** Long-edge targets, ascending. Sizes >= the master long edge are skipped by the encoder. */
export const LEVEL_SIZES = [256, 512, 1024, 2048] as const;
/** Sizes that get the higher (q95) distance; the rest get q85. */
const BIG_SIZES = new Set<number>([2048]);

/** The full RAW/JPG ladder plan: grid sizes at q85, the 2048 big level + full at q95. */
export function planLadder(): PyramidEncodeOptions {
  const gridDistance = qualityToDistance(GRID_QUALITY);
  const bigDistance = qualityToDistance(BIG_QUALITY);
  return {
    sidecarSizes: [...LEVEL_SIZES],
    sidecarDistances: LEVEL_SIZES.map((s) => (BIG_SIZES.has(s) ? bigDistance : gridDistance)),
    fullDistance: bigDistance,
    effort: EFFORT,
  };
}

/** Proxy plan: one q85 level at `size` (verification probe). */
export function planProxy(size: number): PyramidEncodeOptions {
  const d = qualityToDistance(PROXY_QUALITY);
  return { sidecarSizes: [size], sidecarDistances: [d], fullDistance: d, effort: EFFORT };
}
```

- [ ] **Step 4: Re-export from `index.ts`**

Replace the contents of `packages/pyramid-ingest/src/index.ts`:

```ts
// Public surface for @casabio/pyramid-ingest. Extended as each module is added.
export * from "./quality.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/pyramid-ingest/test/quality.test.ts`
Expected: PASS — 4 tests pass. (`PyramidEncodeOptions` is imported as a type only; `backends.ts` is created in Task 6, but `bun test` strips type-only imports, so this compiles and runs now. `tsc` typecheck waits until Task 6.)

- [ ] **Step 6: Commit**

```bash
git add packages/pyramid-ingest/src/quality.ts packages/pyramid-ingest/src/index.ts packages/pyramid-ingest/test/quality.test.ts
git commit -m "feat(pyramid-ingest): quality->distance mapping + ladder/proxy plans"
```

---

## Task 3: Content hashing + image id (`hash.ts`)

**Files:**
- Create: `packages/pyramid-ingest/src/hash.ts`
- Modify: `packages/pyramid-ingest/src/index.ts`
- Test: `packages/pyramid-ingest/test/hash.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/pyramid-ingest/test/hash.test.ts`:

```ts
import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { contentHash16, imageIdForPath } from "../src/hash";

test("contentHash16 is the first 16 hex chars of SHA-256", () => {
  // SHA-256("") = e3b0c44298fc1c149afbf4c8996fb924... -> first 16 chars below.
  expect(contentHash16(new Uint8Array(0))).toBe("e3b0c44298fc1c14");
  expect(contentHash16(new Uint8Array(0))).toHaveLength(16);
});

test("contentHash16 is deterministic and content-sensitive", () => {
  const a = contentHash16(new Uint8Array([1, 2, 3]));
  const b = contentHash16(new Uint8Array([1, 2, 3]));
  const c = contentHash16(new Uint8Array([1, 2, 4]));
  expect(a).toBe(b);
  expect(a).not.toBe(c);
});

test("imageIdForPath normalizes the path so equivalent spellings collide", () => {
  const id1 = imageIdForPath("a/b/master.orf");
  const id2 = imageIdForPath("a/./b/master.orf");
  expect(id1).toBe(id2);
  expect(id1).toHaveLength(16);
  // independently reproducible from the resolved absolute path
  expect(imageIdForPath(resolve("a/b/master.orf"))).toBe(id1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/pyramid-ingest/test/hash.test.ts`
Expected: FAIL — `../src/hash` does not exist.

- [ ] **Step 3: Implement `hash.ts`**

Create `packages/pyramid-ingest/src/hash.ts`:

```ts
import { createHash } from "node:crypto";
import { resolve } from "node:path";

/** Content-address a level's JXL bytes: first 16 hex chars (64 bits) of SHA-256. */
export function contentHash16(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

/** Stable per-master id: SHA-256 of the resolved absolute path, first 16 hex chars. */
export function imageIdForPath(masterPath: string): string {
  return createHash("sha256").update(resolve(masterPath)).digest("hex").slice(0, 16);
}
```

- [ ] **Step 4: Re-export from `index.ts`**

Append to `packages/pyramid-ingest/src/index.ts`:

```ts
export * from "./hash.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/pyramid-ingest/test/hash.test.ts`
Expected: PASS — 3 tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/pyramid-ingest/src/hash.ts packages/pyramid-ingest/src/index.ts packages/pyramid-ingest/test/hash.test.ts
git commit -m "feat(pyramid-ingest): content hash + stable image id"
```

---

## Task 4: Sharding + bounded concurrency (`shard.ts`)

**Files:**
- Create: `packages/pyramid-ingest/src/shard.ts`
- Modify: `packages/pyramid-ingest/src/index.ts`
- Test: `packages/pyramid-ingest/test/shard.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/pyramid-ingest/test/shard.test.ts`:

```ts
import { expect, test } from "bun:test";
import { planShard, boundedConcurrency } from "../src/shard";

test("planShard round-robins files into a disjoint, complete partition", () => {
  const files = ["a", "b", "c", "d", "e"];
  const s0 = planShard(files, 0, 2);
  const s1 = planShard(files, 1, 2);
  expect(s0).toEqual(["a", "c", "e"]);
  expect(s1).toEqual(["b", "d"]);
  // union == all, no overlap
  expect([...s0, ...s1].sort()).toEqual([...files].sort());
});

test("planShard with N=1 returns everything", () => {
  expect(planShard(["a", "b"], 0, 1)).toEqual(["a", "b"]);
});

test("planShard rejects an out-of-range index", () => {
  expect(() => planShard(["a"], 2, 2)).toThrow();
  expect(() => planShard(["a"], -1, 2)).toThrow();
  expect(() => planShard(["a"], 0, 0)).toThrow();
});

test("boundedConcurrency clamps to the tightest of cores, request, and memory", () => {
  const GB = 1024 * 1024 * 1024;
  // 8 cores, no request, 8 GB budget, 800 MB/image -> mem allows 10, cores cap 8
  expect(boundedConcurrency(8, undefined, 8 * GB, 800 * 1024 * 1024)).toBe(8);
  // explicit request below cores wins
  expect(boundedConcurrency(8, 2, 8 * GB, 800 * 1024 * 1024)).toBe(2);
  // tiny memory budget forces 1
  expect(boundedConcurrency(8, undefined, 1 * GB, 800 * 1024 * 1024)).toBe(1);
  // never below 1
  expect(boundedConcurrency(0, 0, 0, 0)).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/pyramid-ingest/test/shard.test.ts`
Expected: FAIL — `../src/shard` does not exist.

- [ ] **Step 3: Implement `shard.ts`**

Create `packages/pyramid-ingest/src/shard.ts`:

```ts
/** Round-robin partition: shard `i` of `n` takes files at indices where idx % n === i. */
export function planShard<T>(files: readonly T[], i: number, n: number): T[] {
  if (!Number.isInteger(n) || n < 1) throw new Error(`shard count must be >= 1, got ${n}`);
  if (!Number.isInteger(i) || i < 0 || i >= n) throw new Error(`shard index ${i} out of range for n=${n}`);
  return files.filter((_, idx) => idx % n === i);
}

/**
 * Pick a worker count: the tightest of available cores, an optional explicit request,
 * and how many per-image RGBA buffers fit in the memory budget. Always >= 1.
 */
export function boundedConcurrency(
  cores: number,
  requested: number | undefined,
  memBudgetBytes: number,
  perImageBytes: number,
): number {
  const byMem = Math.max(1, Math.floor(memBudgetBytes / Math.max(1, perImageBytes)));
  const byCores = Math.max(1, Math.floor(cores) || 1);
  const ceiling = requested && requested > 0 ? Math.floor(requested) : byCores;
  return Math.max(1, Math.min(byCores, ceiling, byMem));
}
```

- [ ] **Step 4: Re-export from `index.ts`**

Append to `packages/pyramid-ingest/src/index.ts`:

```ts
export * from "./shard.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/pyramid-ingest/test/shard.test.ts`
Expected: PASS — 4 tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/pyramid-ingest/src/shard.ts packages/pyramid-ingest/src/index.ts packages/pyramid-ingest/test/shard.test.ts
git commit -m "feat(pyramid-ingest): round-robin shard + bounded concurrency"
```

---

## Task 5: Manifest + index model (`manifest.ts`)

**Files:**
- Create: `packages/pyramid-ingest/src/manifest.ts`
- Modify: `packages/pyramid-ingest/src/index.ts`
- Test: `packages/pyramid-ingest/test/manifest.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/pyramid-ingest/test/manifest.test.ts`:

```ts
import { expect, test } from "bun:test";
import {
  levelSize,
  toEntry,
  buildManifest,
  buildIndexEntry,
  isUpToDate,
  type LevelEntry,
} from "../src/manifest";

test("levelSize reports 'full' only when dims match the master", () => {
  expect(levelSize(4624, 3468, 4624, 3468)).toBe("full");
  expect(levelSize(256, 192, 4624, 3468)).toBe(256); // long edge
  expect(levelSize(192, 256, 4624, 3468)).toBe(256); // portrait long edge
});

test("toEntry builds an 8-bit, untiled level entry with a content hash", () => {
  const data = new Uint8Array([9, 8, 7, 6]);
  const e = toEntry({ data, width: 256, height: 192 }, 4624, 3468);
  expect(e.size).toBe(256);
  expect(e.w).toBe(256);
  expect(e.h).toBe(192);
  expect(e.bytes).toBe(4);
  expect(e.bitsPerSample).toBe(8);
  expect(e.tiled).toBe(false);
  expect(e.contenthash).toHaveLength(16);
});

test("buildManifest sorts levels ascending by pixel count and rounds aspect to 4dp", () => {
  const big: LevelEntry = { size: "full", w: 4624, h: 3468, bytes: 9, bitsPerSample: 8, contenthash: "f".repeat(16), tiled: false };
  const small: LevelEntry = { size: 256, w: 256, h: 192, bytes: 3, bitsPerSample: 8, contenthash: "a".repeat(16), tiled: false };
  const m = buildManifest({
    imageId: "9f86d081884c7d65",
    master: { name: "P2200566.ORF", format: "orf", mtimeMs: 1717689600000 },
    orientation: "baked",
    width: 4624,
    height: 3468,
    levels: [big, small], // intentionally out of order
  });
  expect(m.schema).toBe(1);
  expect(m.levels.map((l) => l.size)).toEqual([256, "full"]); // ascending
  expect(m.aspect).toBeCloseTo(1.3333, 4);
  expect(m.proxy).toBeUndefined();
});

test("buildManifest flags proxy and buildIndexEntry inlines L0", () => {
  const small: LevelEntry = { size: 512, w: 512, h: 384, bytes: 3, bitsPerSample: 8, contenthash: "b".repeat(16), tiled: false };
  const proxy = buildManifest({
    imageId: "id1", master: { name: "x.jpg", format: "jpg", mtimeMs: 1 },
    orientation: "source", width: 4000, height: 3000, levels: [small], proxy: true,
  });
  expect(proxy.proxy).toBe(true);
  expect(proxy.orientation).toBe("source");

  const idx = buildIndexEntry(proxy);
  expect(idx.imageId).toBe("id1");
  expect(idx.l0).toEqual({ contenthash: "b".repeat(16), w: 512, h: 384 });
});

test("isUpToDate requires a matching mtime and a non-proxy manifest", () => {
  const base = buildManifest({
    imageId: "id", master: { name: "x.orf", format: "orf", mtimeMs: 1000 },
    orientation: "baked", width: 10, height: 10,
    levels: [{ size: "full", w: 10, h: 10, bytes: 1, bitsPerSample: 8, contenthash: "c".repeat(16), tiled: false }],
  });
  expect(isUpToDate(base, 1000)).toBe(true);
  expect(isUpToDate(base, 1000.4)).toBe(true); // sub-ms drift rounds to the same whole ms
  expect(isUpToDate(base, 2000)).toBe(false);
  const proxy = buildManifest({ ...base, proxy: true } as never);
  expect(isUpToDate({ ...base, proxy: true }, 1000)).toBe(false);
  void proxy;
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/pyramid-ingest/test/manifest.test.ts`
Expected: FAIL — `../src/manifest` does not exist.

- [ ] **Step 3: Implement `manifest.ts`**

Create `packages/pyramid-ingest/src/manifest.ts`:

```ts
import { contentHash16 } from "./hash.js";
import type { MasterFormat, Orientation, PyramidLevelBytes } from "./backends.js";

export type LevelSize = number | "full";

/** A single level recorded in a manifest. M1: every level is 8-bit and untiled. */
export interface LevelEntry {
  size: LevelSize;
  w: number;
  h: number;
  bytes: number;
  bitsPerSample: 8;
  contenthash: string;
  tiled: boolean;
}

export interface MasterInfo {
  name: string;
  format: MasterFormat;
  mtimeMs: number;
}

export interface Manifest {
  schema: 1;
  imageId: string;
  master: MasterInfo;
  orientation: Orientation;
  width: number;
  height: number;
  aspect: number;
  levels: LevelEntry[];
  proxy?: true;
}

export interface IndexEntry {
  imageId: string;
  aspect: number;
  l0: { contenthash: string; w: number; h: number };
}

export interface GalleryIndex {
  schema: 1;
  images: IndexEntry[];
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

/** "full" when the level matches the master dims, else the long-edge target. */
export function levelSize(w: number, h: number, masterW: number, masterH: number): LevelSize {
  if (w === masterW && h === masterH) return "full";
  return Math.max(w, h);
}

/** Map level bytes -> a manifest entry (computes the content hash + long-edge size). */
export function toEntry(level: PyramidLevelBytes, masterW: number, masterH: number): LevelEntry {
  return {
    size: levelSize(level.width, level.height, masterW, masterH),
    w: level.width,
    h: level.height,
    bytes: level.data.length,
    bitsPerSample: 8,
    contenthash: contentHash16(level.data),
    tiled: false,
  };
}

export function buildManifest(args: {
  imageId: string;
  master: MasterInfo;
  orientation: Orientation;
  width: number;
  height: number;
  levels: LevelEntry[];
  proxy?: boolean;
}): Manifest {
  const levels = [...args.levels].sort((a, b) => a.w * a.h - b.w * b.h);
  const manifest: Manifest = {
    schema: 1,
    imageId: args.imageId,
    master: args.master,
    orientation: args.orientation,
    width: args.width,
    height: args.height,
    aspect: round4(args.width / args.height),
    levels,
  };
  if (args.proxy) manifest.proxy = true;
  return manifest;
}

export function buildIndexEntry(manifest: Manifest): IndexEntry {
  const l0 = manifest.levels[0];
  if (!l0) throw new Error(`manifest ${manifest.imageId} has no levels`);
  return {
    imageId: manifest.imageId,
    aspect: manifest.aspect,
    l0: { contenthash: l0.contenthash, w: l0.w, h: l0.h },
  };
}

/** Resumability: an existing full (non-proxy) manifest whose master mtime is unchanged. */
export function isUpToDate(existing: Manifest, mtimeMs: number): boolean {
  // Compare at whole-ms granularity: fs.stat sub-ms precision is not preserved identically
  // across runtimes/filesystems (Node vs Bun, Docker volumes, NTFS vs ext4), so an exact
  // float compare would spuriously re-ingest unchanged masters.
  return existing.proxy !== true && Math.round(existing.master.mtimeMs) === Math.round(mtimeMs);
}
```

- [ ] **Step 4: Re-export from `index.ts`**

Append to `packages/pyramid-ingest/src/index.ts`:

```ts
export * from "./manifest.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/pyramid-ingest/test/manifest.test.ts`
Expected: PASS — 5 tests pass. (Types `MasterFormat`/`Orientation`/`PyramidLevelBytes` are type-only imports satisfied at runtime by erasure; `tsc` typecheck waits until Task 6 lands `backends.ts`.)

- [ ] **Step 6: Commit**

```bash
git add packages/pyramid-ingest/src/manifest.ts packages/pyramid-ingest/src/index.ts packages/pyramid-ingest/test/manifest.test.ts
git commit -m "feat(pyramid-ingest): manifest + index model"
```

---

## Task 6: Backend interfaces + JXL backend (`backends.ts`)

This is the boundary between pure orchestration and the WASM codecs. The interfaces are what the fake RAW backend (in later tests) implements; `createJxlBackend` is the real wrapper around `@casabio/jxl-wasm`. The runtime test drives the real **scalar** build via `setJxlModuleFactoryForTesting`, exactly like Plan A's runtime tests, and proves the JPEG transcode round-trips.

**Files:**
- Create: `packages/pyramid-ingest/src/backends.ts`
- Modify: `packages/pyramid-ingest/src/index.ts`
- Test: `packages/pyramid-ingest/test/backends.test.ts`
- Helper: `packages/pyramid-ingest/test/scalar.ts` (shared scalar-module loader)

- [ ] **Step 1: Write the shared scalar loader helper**

Create `packages/pyramid-ingest/test/scalar.ts` (mirrors Plan A's `loadScalarModule`; reaches the sibling `jxl-wasm` dist — a test-only cross-package path):

```ts
import type { JxlModuleFactory } from "@casabio/jxl-wasm";

// Loads the rebuilt scalar WASM from the sibling package's dist (Plan A Task 3 output).
export async function loadScalarModule() {
  const imported = await import("../../jxl-wasm/dist/jxl-core.scalar.js");
  if (typeof imported.default !== "function") {
    throw new Error("jxl-core.scalar.js did not export a loader function");
  }
  const baseUrl = new URL("../../jxl-wasm/dist/", import.meta.url);
  const module = await imported.default({
    locateFile: (path: string) => new URL(path, baseUrl).href,
  });
  if (!module || typeof module._malloc !== "function") {
    throw new Error("scalar WASM module missing required exports");
  }
  return module;
}

/** A factory that always returns the loaded scalar module (for setJxlModuleFactoryForTesting). */
export function scalarFactory(module: Awaited<ReturnType<typeof loadScalarModule>>): JxlModuleFactory {
  return (async () => module) as unknown as JxlModuleFactory;
}
```

> Note: if `@casabio/jxl-wasm` does not export the type `JxlModuleFactory`, replace the import with `type JxlModuleFactory = (...args: never[]) => Promise<unknown>;` locally — the value passed to `setJxlModuleFactoryForTesting` only needs to be an async function returning the module.

- [ ] **Step 2: Write the failing test**

Create `packages/pyramid-ingest/test/backends.test.ts`:

```ts
import { expect, test, afterEach } from "bun:test";
import sharp from "sharp";
import { setForcedTier, setJxlModuleFactoryForTesting } from "@casabio/jxl-wasm";
import { createJxlBackend } from "../src/backends";
import { loadScalarModule, scalarFactory } from "./scalar";

afterEach(() => {
  setJxlModuleFactoryForTesting(null);
});

async function jpegFixture(w: number, h: number): Promise<Uint8Array> {
  // Non-flat content so the transcode/encode has something to compress.
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      raw[o] = (x * 31 + y * 17) & 0xff;
      raw[o + 1] = (x * 7 + y * 53) & 0xff;
      raw[o + 2] = (x * 13 + y * 29) & 0xff;
    }
  }
  const jpg = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
  return new Uint8Array(jpg);
}

test("createJxlBackend transcodes a JPEG and decodes it back to RGBA8", async () => {
  setForcedTier("simd"); // single-thread CLI tier; reset by the scalar factory below
  const module = await loadScalarModule();
  setJxlModuleFactoryForTesting(scalarFactory(module));

  const jxl = createJxlBackend();
  const jpeg = await jpegFixture(640, 480);

  const transcoded = await jxl.transcodeJpeg(jpeg);
  expect(transcoded.byteLength).toBeGreaterThan(0);

  const decoded = await jxl.decodeToRgba8(transcoded);
  expect(decoded.width).toBe(640);
  expect(decoded.height).toBe(480);
  expect(decoded.rgba.length).toBe(640 * 480 * 4);
});

test("createJxlBackend.encodePyramid returns ascending 8-bit levels, full last", async () => {
  const module = await loadScalarModule();
  setJxlModuleFactoryForTesting(scalarFactory(module));

  const jxl = createJxlBackend();
  const W = 1280, H = 960;
  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = i & 0xff; rgba[i + 1] = (i >> 3) & 0xff; rgba[i + 2] = (i >> 6) & 0xff; rgba[i + 3] = 255;
  }
  const levels = await jxl.encodePyramid(rgba, W, H, {
    fullDistance: 0.55, sidecarSizes: [256, 512, 1024], sidecarDistances: [1.45, 1.45, 1.45], effort: 3,
  });
  expect(levels.map((l) => l.width)).toEqual([256, 512, 1024, 1280]);
  for (let i = 1; i < levels.length; i++) {
    expect(levels[i]!.width).toBeGreaterThan(levels[i - 1]!.width);
  }
  expect(levels[0]!.data.byteLength).toBeGreaterThan(0);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test packages/pyramid-ingest/test/backends.test.ts`
Expected: FAIL — `../src/backends` does not exist (module-not-found).

- [ ] **Step 4: Implement `backends.ts`**

Create `packages/pyramid-ingest/src/backends.ts`:

```ts
import { createDecoder, encodeRgba8Pyramid, transcodeJpegToJxl } from "@casabio/jxl-wasm";

export type MasterFormat = "orf" | "dng" | "cr2" | "jpg";
export type RawFormat = "orf" | "dng" | "cr2";
export type Orientation = "baked" | "source";

/** Decoded master pixels (RGBA8) + dims + how orientation is represented. */
export interface DecodedMaster {
  rgba: Uint8Array;
  width: number;
  height: number;
  orientation: Orientation;
}

/** Raw bytes of one encoded pyramid level. */
export interface PyramidLevelBytes {
  data: Uint8Array;
  width: number;
  height: number;
}

export interface PyramidEncodeOptions {
  fullDistance: number;
  sidecarSizes: readonly number[];
  sidecarDistances: readonly number[];
  effort: number;
}

/** RAW decode boundary — implemented by raw-backend.ts (real) and fakes in tests. */
export interface RawBackend {
  decode(bytes: Uint8Array, format: RawFormat): Promise<DecodedMaster>;
}

/** JXL codec boundary — wraps @casabio/jxl-wasm. */
export interface JxlBackend {
  encodePyramid(
    rgba: Uint8Array,
    width: number,
    height: number,
    opts: PyramidEncodeOptions,
  ): Promise<PyramidLevelBytes[]>;
  transcodeJpeg(jpeg: Uint8Array): Promise<Uint8Array>;
  decodeToRgba8(jxl: Uint8Array): Promise<{ rgba: Uint8Array; width: number; height: number }>;
}

export function createJxlBackend(): JxlBackend {
  return {
    async encodePyramid(rgba, width, height, opts) {
      const levels = await encodeRgba8Pyramid(rgba, width, height, {
        fullDistance: opts.fullDistance,
        sidecarSizes: opts.sidecarSizes,
        sidecarDistances: opts.sidecarDistances,
        effort: opts.effort,
        hasAlpha: false, // masters are opaque; drop the full-level alpha plane
        resampling: 1,
      });
      return levels.map((l) => ({ data: l.data, width: l.width, height: l.height }));
    },

    async transcodeJpeg(jpeg) {
      return transcodeJpegToJxl(jpeg);
    },

    async decodeToRgba8(jxl) {
      const decoder = createDecoder({
        format: "rgba8",
        progressionTarget: "final",
        emitEveryPass: false,
        preserveIcc: false,
        preserveMetadata: false,
      });
      let result: { rgba: Uint8Array; width: number; height: number } | null = null;
      const drain = (async () => {
        for await (const ev of decoder.events()) {
          if (ev.type === "final") {
            const px = ev.pixels instanceof Uint8Array ? ev.pixels : new Uint8Array(ev.pixels);
            result = { rgba: px, width: ev.info.width, height: ev.info.height };
          } else if (ev.type === "error") {
            throw new Error(`decode ${ev.code}: ${ev.message}`);
          }
        }
      })();
      await decoder.push(jxl);
      await decoder.close();
      await drain;
      await decoder.dispose();
      if (!result) throw new Error("decode produced no final frame");
      return result;
    },
  };
}
```

- [ ] **Step 5: Re-export from `index.ts`**

Append to `packages/pyramid-ingest/src/index.ts`:

```ts
export * from "./backends.js";
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test packages/pyramid-ingest/test/backends.test.ts`
Expected: PASS — 2 tests pass. **Requires Plan A's rebuilt scalar `dist`** (Task 3 of Plan A); against a stale build `encodeRgba8Pyramid` throws `CapabilityMissing`.

- [ ] **Step 7: Full typecheck (all modules now have their types)**

Run: `cd packages/pyramid-ingest && npx tsc --noEmit && cd ../..`
Expected: PASS — `quality.ts`, `manifest.ts`, etc. now resolve `PyramidEncodeOptions` / `MasterFormat` / `Orientation` / `PyramidLevelBytes` from `backends.ts`. No type errors.

- [ ] **Step 8: Commit**

```bash
git add packages/pyramid-ingest/src/backends.ts packages/pyramid-ingest/src/index.ts packages/pyramid-ingest/test/backends.test.ts packages/pyramid-ingest/test/scalar.ts
git commit -m "feat(pyramid-ingest): backend interfaces + JXL backend (transcode/decode/pyramid)"
```

---

## Task 7: Ladder assembly (`ladder.ts`)

Pure compute of level *bytes* from a decoded master. Three shapes: RAW (keep every encoded level), JPG (drop the re-encoded full, substitute the lossless transcode), proxy (one level). No file I/O here.

**Files:**
- Create: `packages/pyramid-ingest/src/ladder.ts`
- Modify: `packages/pyramid-ingest/src/index.ts`
- Test: `packages/pyramid-ingest/test/ladder.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/pyramid-ingest/test/ladder.test.ts`:

```ts
import { expect, test, afterEach } from "bun:test";
import { setJxlModuleFactoryForTesting } from "@casabio/jxl-wasm";
import { buildRawLadder, buildJpgLadder, buildProxyLadder } from "../src/ladder";
import { createJxlBackend, type JxlBackend, type DecodedMaster } from "../src/backends";
import { loadScalarModule, scalarFactory } from "./scalar";

afterEach(() => setJxlModuleFactoryForTesting(null));

function gradientRgba(w: number, h: number): Uint8Array {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      px[o] = (x * 31 + y * 17) & 0xff;
      px[o + 1] = (x * 7 + y * 53) & 0xff;
      px[o + 2] = (x * 13 + y * 29) & 0xff;
      px[o + 3] = 255;
    }
  }
  return px;
}

test("buildRawLadder keeps every encoded level, ascending, full last, all 8-bit baked", async () => {
  const module = await loadScalarModule();
  setJxlModuleFactoryForTesting(scalarFactory(module));
  const jxl = createJxlBackend();
  const W = 1280, H = 960;
  const decoded: DecodedMaster = { rgba: gradientRgba(W, H), width: W, height: H, orientation: "baked" };

  const ladder = await buildRawLadder(jxl, decoded);
  expect(ladder.orientation).toBe("baked");
  expect(ladder.width).toBe(W);
  expect(ladder.height).toBe(H);
  // grid 256/512/1024 fit; 2048 >= 1280 long edge so it is skipped; then full.
  expect(ladder.levels.map((l) => l.width)).toEqual([256, 512, 1024, 1280]);
});

test("buildJpgLadder substitutes the lossless transcode as the full level", async () => {
  // Fake backend: deterministic, no WASM. Proves the substitution + ordering logic.
  const transcodeBytes = new Uint8Array([0xff, 0x0a, 0x42, 0x13]); // sentinel "lossless full"
  const fake: JxlBackend = {
    async transcodeJpeg() { return transcodeBytes; },
    async decodeToRgba8() { return { rgba: gradientRgba(1280, 960), width: 1280, height: 960 }; },
    async encodePyramid(_rgba, _w, _h, opts) {
      // emulate the bridge: emit a level per non-skipped sidecar size (long edge < 1280), then full.
      const sidecars = opts.sidecarSizes.filter((s) => s < 1280).map((s) => ({
        data: new Uint8Array([s & 0xff]), width: s, height: Math.round((s * 960) / 1280),
      }));
      return [...sidecars, { data: new Uint8Array([0xde, 0xad]), width: 1280, height: 960 }];
    },
  };
  const ladder = await buildJpgLadder(fake, new Uint8Array([1, 2, 3]));
  expect(ladder.orientation).toBe("source");
  // sidecars 256/512/1024 + the transcode as full (NOT the re-encoded 0xde,0xad full)
  expect(ladder.levels.map((l) => l.width)).toEqual([256, 512, 1024, 1280]);
  const full = ladder.levels[ladder.levels.length - 1]!;
  expect(full.data).toEqual(transcodeBytes);
});

test("buildProxyLadder returns exactly one level", async () => {
  const module = await loadScalarModule();
  setJxlModuleFactoryForTesting(scalarFactory(module));
  const jxl = createJxlBackend();
  const W = 2000, H = 1500;
  const ladder = await buildProxyLadder(jxl, gradientRgba(W, H), W, H, 512, "baked");
  expect(ladder.levels).toHaveLength(1);
  expect(Math.max(ladder.levels[0]!.width, ladder.levels[0]!.height)).toBe(512);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/pyramid-ingest/test/ladder.test.ts`
Expected: FAIL — `../src/ladder` does not exist.

- [ ] **Step 3: Implement `ladder.ts`**

Create `packages/pyramid-ingest/src/ladder.ts`:

```ts
import { planLadder, planProxy } from "./quality.js";
import type { DecodedMaster, JxlBackend, Orientation, PyramidLevelBytes } from "./backends.js";

export interface LadderResult {
  levels: PyramidLevelBytes[];
  orientation: Orientation;
  width: number;
  height: number;
}

/** RAW: one pyramid encode; every returned level is a real, kept level (smallest-first, full last). */
export async function buildRawLadder(jxl: JxlBackend, decoded: DecodedMaster): Promise<LadderResult> {
  const levels = await jxl.encodePyramid(decoded.rgba, decoded.width, decoded.height, planLadder());
  return { levels, orientation: decoded.orientation, width: decoded.width, height: decoded.height };
}

/**
 * JPG: the lossless transcode IS the full level (distance 0, native JXL, smaller). Decode it
 * once for the smaller levels, encode the ladder, then DROP the re-encoded full and append the
 * transcode. Orientation is "source" (the transcode preserves the JPEG's EXIF tag, not baked).
 */
export async function buildJpgLadder(jxl: JxlBackend, jpeg: Uint8Array): Promise<LadderResult> {
  const fullJxl = await jxl.transcodeJpeg(jpeg);
  const decoded = await jxl.decodeToRgba8(fullJxl);
  const produced = await jxl.encodePyramid(decoded.rgba, decoded.width, decoded.height, planLadder());
  const sidecars = produced.slice(0, -1); // drop the re-encoded full (last element)
  const fullLevel: PyramidLevelBytes = { data: fullJxl, width: decoded.width, height: decoded.height };
  return {
    levels: [...sidecars, fullLevel],
    orientation: "source",
    width: decoded.width,
    height: decoded.height,
  };
}

/** Proxy: a single verification level at `size` (q85). */
export async function buildProxyLadder(
  jxl: JxlBackend,
  rgba: Uint8Array,
  width: number,
  height: number,
  size: number,
  orientation: Orientation,
): Promise<LadderResult> {
  const produced = await jxl.encodePyramid(rgba, width, height, planProxy(size));
  const level = produced[0];
  if (!level) throw new Error("proxy encode produced no level");
  return { levels: [level], orientation, width, height };
}
```

- [ ] **Step 4: Re-export from `index.ts`**

Append to `packages/pyramid-ingest/src/index.ts`:

```ts
export * from "./ladder.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/pyramid-ingest/test/ladder.test.ts`
Expected: PASS — 3 tests pass (two against real scalar, one fully fake). **Requires Plan A's rebuilt scalar `dist`.**

- [ ] **Step 6: Commit**

```bash
git add packages/pyramid-ingest/src/ladder.ts packages/pyramid-ingest/src/index.ts packages/pyramid-ingest/test/ladder.test.ts
git commit -m "feat(pyramid-ingest): RAW/JPG/proxy ladder assembly"
```

---

## Task 8: Ingest orchestration + file I/O (`ingest.ts`)

Ties the pure modules to the filesystem: decode → ladder → write content-addressed level files → write the per-image manifest; plus a bounded-concurrency batch driver and the index rebuild. The integration tests run against a **tmp output dir**, a **fake RAW backend** (deterministic gradient, no WASM), and the **real scalar JXL backend**.

**Files:**
- Create: `packages/pyramid-ingest/src/ingest.ts`
- Modify: `packages/pyramid-ingest/src/index.ts`
- Test: `packages/pyramid-ingest/test/ingest.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/pyramid-ingest/test/ingest.test.ts`:

```ts
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setJxlModuleFactoryForTesting } from "@casabio/jxl-wasm";
import {
  formatFromPath, ingestBatch, ingestImage, rebuildIndex, type Backends,
} from "../src/ingest";
import { createJxlBackend, type DecodedMaster, type RawBackend, type RawFormat } from "../src/backends";
import { imageIdForPath } from "../src/hash";
import type { GalleryIndex, Manifest } from "../src/manifest";
import { loadScalarModule, scalarFactory } from "./scalar";

afterEach(() => setJxlModuleFactoryForTesting(null));

function gradientRgba(w: number, h: number): Uint8Array {
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < px.length; i += 4) {
    px[i] = i & 0xff; px[i + 1] = (i >> 3) & 0xff; px[i + 2] = (i >> 6) & 0xff; px[i + 3] = 255;
  }
  return px;
}

/** Fake RAW backend: ignores bytes, returns a fixed baked gradient. Deterministic, no WASM. */
function fakeRaw(w = 1280, h = 960): RawBackend {
  return {
    async decode(_bytes: Uint8Array, _format: RawFormat): Promise<DecodedMaster> {
      return { rgba: gradientRgba(w, h), width: w, height: h, orientation: "baked" };
    },
  };
}

async function makeBackends(): Promise<Backends> {
  const module = await loadScalarModule();
  setJxlModuleFactoryForTesting(scalarFactory(module));
  return { raw: fakeRaw(), jxl: createJxlBackend() };
}

async function tmpOut(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pyramid-ingest-"));
}

async function writeMaster(dir: string, name: string): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, new Uint8Array([0, 1, 2, 3])); // RAW bytes are ignored by fakeRaw
  return p;
}

test("formatFromPath maps known extensions (case-insensitive) and rejects others", () => {
  expect(formatFromPath("a/b.ORF")).toBe("orf");
  expect(formatFromPath("a/b.dng")).toBe("dng");
  expect(formatFromPath("a/b.Cr2")).toBe("cr2");
  expect(formatFromPath("a/b.JPG")).toBe("jpg");
  expect(formatFromPath("a/b.jpeg")).toBe("jpg");
  expect(formatFromPath("a/b.png")).toBeNull();
  expect(formatFromPath("noext")).toBeNull();
});

test("ingestImage writes a full RAW pyramid + manifest, then skips on re-run", async () => {
  const out = await tmpOut();
  const b = await makeBackends();
  const master = await writeMaster(out, "P1.orf");

  expect(await ingestImage(master, b, { outDir: out })).toBe("written");

  const imageId = imageIdForPath(master);
  const manifestPath = join(out, "images", imageId, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
  expect(manifest.schema).toBe(1);
  expect(manifest.orientation).toBe("baked");
  expect(manifest.proxy).toBeUndefined();
  // 2048 >= 1280 long edge -> skipped; grid 256/512/1024 + full.
  expect(manifest.levels.map((l) => l.size)).toEqual([256, 512, 1024, "full"]);
  for (const l of manifest.levels) expect(l.bitsPerSample).toBe(8);

  // every referenced level file exists with the recorded byte length
  for (const l of manifest.levels) {
    const lf = join(out, "levels", `${l.contenthash}.jxl`);
    expect((await stat(lf)).size).toBe(l.bytes);
  }

  // unchanged mtime -> skipped
  expect(await ingestImage(master, b, { outDir: out })).toBe("skipped");
});

test("force re-ingests even when the manifest is up to date", async () => {
  const out = await tmpOut();
  const b = await makeBackends();
  const master = await writeMaster(out, "P2.orf");
  expect(await ingestImage(master, b, { outDir: out })).toBe("written");
  expect(await ingestImage(master, b, { outDir: out, force: true })).toBe("written");
});

test("identical level content across masters is stored once (content-addressed dedupe)", async () => {
  const out = await tmpOut();
  const b = await makeBackends(); // fakeRaw returns the SAME gradient for any input
  const m1 = await writeMaster(out, "A.orf");
  const m2 = await writeMaster(out, "B.orf");
  await ingestImage(m1, b, { outDir: out });
  await ingestImage(m2, b, { outDir: out });

  const man1 = JSON.parse(await readFile(join(out, "images", imageIdForPath(m1), "manifest.json"), "utf8")) as Manifest;
  const man2 = JSON.parse(await readFile(join(out, "images", imageIdForPath(m2), "manifest.json"), "utf8")) as Manifest;
  expect(man1.levels.map((l) => l.contenthash)).toEqual(man2.levels.map((l) => l.contenthash));

  const levelFiles = await readdir(join(out, "levels"));
  expect(levelFiles.length).toBe(man1.levels.length); // deduped, not 2x
});

test("proxy mode writes exactly one level and flags the manifest", async () => {
  const out = await tmpOut();
  const b = await makeBackends();
  const master = await writeMaster(out, "P3.orf");
  expect(await ingestImage(master, b, { outDir: out, proxy: 512 })).toBe("written");

  const manifest = JSON.parse(
    await readFile(join(out, "images", imageIdForPath(master), "manifest.json"), "utf8"),
  ) as Manifest;
  expect(manifest.proxy).toBe(true);
  expect(manifest.levels).toHaveLength(1);
  expect(Math.max(manifest.levels[0]!.w, manifest.levels[0]!.h)).toBe(512);
});

test("ingestBatch isolates failures; rebuildIndex inlines L0 for non-proxy images only", async () => {
  const out = await tmpOut();
  const b = await makeBackends();
  const good1 = await writeMaster(out, "G1.orf");
  const good2 = await writeMaster(out, "G2.orf");
  const bad = join(out, "missing.orf"); // never created -> stat throws -> isolated failure

  const batch = await ingestBatch([good1, good2, bad], b, { outDir: out, concurrency: 2 });
  expect(batch.written).toBe(2);
  expect(batch.skipped).toBe(0);
  expect(batch.failed).toHaveLength(1);
  expect(batch.failed[0]!.path).toBe(bad);

  // a proxy image must be excluded from the gallery index
  const proxyMaster = await writeMaster(out, "PX.orf");
  await ingestImage(proxyMaster, b, { outDir: out, proxy: 256 });

  const index = await rebuildIndex(out);
  const ids = index.images.map((e) => e.imageId);
  expect(ids).toContain(imageIdForPath(good1));
  expect(ids).toContain(imageIdForPath(good2));
  expect(ids).not.toContain(imageIdForPath(proxyMaster));
  const g1 = index.images.find((e) => e.imageId === imageIdForPath(good1))!;
  expect(g1.l0.w).toBe(256); // smallest level inlined
  expect([...ids].sort()).toEqual(ids); // sorted ascending by imageId

  const onDisk = JSON.parse(await readFile(join(out, "index.json"), "utf8")) as GalleryIndex;
  expect(onDisk.images.length).toBe(index.images.length);
});

test("rebuildIndex skips a corrupt manifest instead of throwing", async () => {
  const out = await tmpOut();
  const b = await makeBackends();
  const good = await writeMaster(out, "OK.orf");
  const broken = await writeMaster(out, "BROKEN.orf");
  await ingestBatch([good, broken], b, { outDir: out, concurrency: 1 });

  // Simulate a manifest left corrupt by an earlier crash (atomic writes prevent partials,
  // but a genuinely bad file must not abort the index pass).
  const brokenManifest = join(out, "images", imageIdForPath(broken), "manifest.json");
  await writeFile(brokenManifest, "{ not valid json");

  const index = await rebuildIndex(out); // must not throw
  const ids = index.images.map((e) => e.imageId);
  expect(ids).toContain(imageIdForPath(good));
  expect(ids).not.toContain(imageIdForPath(broken));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/pyramid-ingest/test/ingest.test.ts`
Expected: FAIL — `../src/ingest` does not exist.

- [ ] **Step 3: Implement `ingest.ts`**

Create `packages/pyramid-ingest/src/ingest.ts`:

```ts
import { access, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { imageIdForPath } from "./hash.js";
import { buildJpgLadder, buildProxyLadder, buildRawLadder, type LadderResult } from "./ladder.js";
import {
  buildIndexEntry, buildManifest, isUpToDate, toEntry,
  type GalleryIndex, type LevelEntry, type Manifest,
} from "./manifest.js";
import type { DecodedMaster, JxlBackend, MasterFormat, RawBackend, RawFormat } from "./backends.js";

export interface Backends {
  raw: RawBackend;
  jxl: JxlBackend;
}

export interface IngestOptions {
  outDir: string;
  proxy?: number;  // when set, emit a single proxy level of this long-edge size
  force?: boolean; // ignore the up-to-date check and re-ingest
}

export type IngestOutcome = "written" | "skipped";

export interface BatchResult {
  written: number;
  skipped: number;
  failed: { path: string; error: string }[];
}

const RAW_EXT: Record<string, RawFormat> = { ".orf": "orf", ".dng": "dng", ".cr2": "cr2" };

/** Map a path's extension to a master format, or null if unsupported. */
export function formatFromPath(p: string): MasterFormat | null {
  const lower = p.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = lower.slice(dot);
  const raw = RAW_EXT[ext];
  if (raw) return raw;
  if (ext === ".jpg" || ext === ".jpeg") return "jpg";
  return null;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Decode a master to RGBA8 (+ orientation). JPG: transcode->decode ("source"); RAW: the RAW backend ("baked"). */
async function decodeMaster(b: Backends, format: MasterFormat, bytes: Uint8Array): Promise<DecodedMaster> {
  if (format === "jpg") {
    const fullJxl = await b.jxl.transcodeJpeg(bytes);
    const d = await b.jxl.decodeToRgba8(fullJxl);
    return { rgba: d.rgba, width: d.width, height: d.height, orientation: "source" };
  }
  return b.raw.decode(bytes, format);
}

/** Write each level under levels/{contenthash}.jxl (skip existing -> cross-image dedupe). */
export async function writeLevelFiles(
  outDir: string,
  levels: LadderResult["levels"],
  masterW: number,
  masterH: number,
): Promise<LevelEntry[]> {
  const levelsDir = join(outDir, "levels");
  await mkdir(levelsDir, { recursive: true });
  const entries: LevelEntry[] = [];
  for (const level of levels) {
    const entry = toEntry(level, masterW, masterH);
    const dest = join(levelsDir, `${entry.contenthash}.jxl`);
    if (!(await fileExists(dest))) await writeFile(dest, level.data);
    entries.push(entry);
  }
  return entries;
}

export async function ingestImage(
  masterPath: string,
  backends: Backends,
  opts: IngestOptions,
): Promise<IngestOutcome> {
  const format = formatFromPath(masterPath);
  if (!format) throw new Error(`unsupported master format: ${masterPath}`);

  const imageId = imageIdForPath(masterPath);
  const info = await stat(masterPath);
  const imageDir = join(opts.outDir, "images", imageId);
  const manifestPath = join(imageDir, "manifest.json");

  // Resumability: a full (non-proxy) run skips an unchanged master. Proxy/force always re-run.
  if (!opts.force && opts.proxy === undefined && (await fileExists(manifestPath))) {
    const existing = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
    if (isUpToDate(existing, info.mtimeMs)) return "skipped";
  }

  const bytes = new Uint8Array(await readFile(masterPath));

  let ladder: LadderResult;
  if (opts.proxy !== undefined) {
    const decoded = await decodeMaster(backends, format, bytes);
    ladder = await buildProxyLadder(
      backends.jxl, decoded.rgba, decoded.width, decoded.height, opts.proxy, decoded.orientation,
    );
  } else if (format === "jpg") {
    ladder = await buildJpgLadder(backends.jxl, bytes);
  } else {
    const decoded = await backends.raw.decode(bytes, format);
    ladder = await buildRawLadder(backends.jxl, decoded);
  }

  const entries = await writeLevelFiles(opts.outDir, ladder.levels, ladder.width, ladder.height);
  const manifest = buildManifest({
    imageId,
    master: { name: basename(masterPath), format, mtimeMs: info.mtimeMs },
    orientation: ladder.orientation,
    width: ladder.width,
    height: ladder.height,
    levels: entries,
    proxy: opts.proxy !== undefined,
  });

  await mkdir(imageDir, { recursive: true });
  // Atomic write: a concurrent sharded process — or the final rebuildIndex pass — must never
  // observe a half-written manifest. Write a temp file then rename (atomic within the dir).
  // Each imageId dir is owned by exactly one shard, so the temp name cannot collide.
  const manifestTmp = `${manifestPath}.tmp`;
  await writeFile(manifestTmp, JSON.stringify(manifest, null, 2));
  await rename(manifestTmp, manifestPath);
  return "written";
}

/**
 * Bounded-concurrency batch. A shared cursor feeds `workers` async runners; each file's failure is
 * isolated into `failed` so one bad master never aborts the run. NOTE: with a single shared WASM
 * module, safe parallelism relies on the facade's synchronous encode critical section; for true
 * cross-core throughput prefer multi-process `--shard i/N` (separate modules). Defaults to 1.
 */
export async function ingestBatch(
  files: readonly string[],
  backends: Backends,
  opts: IngestOptions & { concurrency?: number },
): Promise<BatchResult> {
  const result: BatchResult = { written: 0, skipped: 0, failed: [] };
  const workers = Math.max(1, Math.min(opts.concurrency ?? 1, files.length || 1));
  let next = 0;
  const run = async (): Promise<void> => {
    for (;;) {
      const idx = next++;
      if (idx >= files.length) return;
      const path = files[idx]!;
      try {
        const outcome = await ingestImage(path, backends, opts);
        if (outcome === "written") result.written++;
        else result.skipped++;
      } catch (err) {
        result.failed.push({ path, error: err instanceof Error ? err.message : String(err) });
      }
    }
  };
  await Promise.all(Array.from({ length: workers }, () => run()));
  return result;
}

/** Scan images/*/manifest.json (skipping proxies), build a sorted gallery index.json. */
export async function rebuildIndex(outDir: string): Promise<GalleryIndex> {
  const imagesDir = join(outDir, "images");
  const index: GalleryIndex = { schema: 1, images: [] };
  let imageIds: string[];
  try {
    imageIds = await readdir(imagesDir);
  } catch {
    imageIds = [];
  }
  for (const id of imageIds) {
    const manifestPath = join(imagesDir, id, "manifest.json");
    if (!(await fileExists(manifestPath))) continue;
    let manifest: Manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
    } catch (err) {
      // A corrupt (or, defensively, a partially-written) manifest must not abort the whole
      // index pass. Atomic writes make partials unreachable here, but a genuinely corrupt
      // file left by an earlier crash should be skipped with a warning, not crash the build.
      process.stderr.write(
        `warning: skipping unreadable manifest ${manifestPath}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      continue;
    }
    if (manifest.proxy) continue;
    index.images.push(buildIndexEntry(manifest));
  }
  index.images.sort((a, b) => (a.imageId < b.imageId ? -1 : a.imageId > b.imageId ? 1 : 0));
  await writeFile(join(outDir, "index.json"), JSON.stringify(index, null, 2));
  return index;
}
```

- [ ] **Step 4: Re-export from `index.ts`**

Append to `packages/pyramid-ingest/src/index.ts`:

```ts
export * from "./ingest.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/pyramid-ingest/test/ingest.test.ts`
Expected: PASS — 6 tests pass. **Requires Plan A's rebuilt scalar `dist`.**

- [ ] **Step 6: Commit**

```bash
git add packages/pyramid-ingest/src/ingest.ts packages/pyramid-ingest/src/index.ts packages/pyramid-ingest/test/ingest.test.ts
git commit -m "feat(pyramid-ingest): ingest orchestration, batch driver, index rebuild"
```

---

## Task 9: Real RAW backend + CLI entry point (`raw-backend.ts`, `cli.ts`)

Wires the real Rust `web/pkg` RAW pipeline behind `RawBackend`, and the `node:util` argument parser + input walker behind `main`. `main` takes an **optional injected `Backends`** so the CLI orchestration is testable against the scalar build with a fake RAW backend (no in-repo RAW fixture). The real RAW decode path is covered by a documented **manual smoke** (Step 8) — there is no committed `.orf/.dng/.cr2` fixture.

**Files:**
- Create: `packages/pyramid-ingest/src/raw-backend.ts`
- Create: `packages/pyramid-ingest/src/cli.ts`
- Modify: `packages/pyramid-ingest/src/index.ts`
- Test: `packages/pyramid-ingest/test/cli.test.ts` (collectInputs + `main` E2E via fake RAW + real scalar)
- Test: `packages/pyramid-ingest/test/jpg.test.ts` (real transcode: full level is bit-exact)

- [ ] **Step 1: Write the failing CLI test**

Create `packages/pyramid-ingest/test/cli.test.ts`:

```ts
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setJxlModuleFactoryForTesting } from "@casabio/jxl-wasm";
import { collectInputs, main } from "../src/cli";
import {
  createJxlBackend, type Backends, type DecodedMaster, type RawBackend, type RawFormat,
} from "../src/backends";
import { imageIdForPath } from "../src/hash";
import type { GalleryIndex, Manifest } from "../src/manifest";
import { loadScalarModule, scalarFactory } from "./scalar";

afterEach(() => setJxlModuleFactoryForTesting(null));

function gradientRgba(w: number, h: number): Uint8Array {
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < px.length; i += 4) {
    px[i] = i & 0xff; px[i + 1] = (i >> 3) & 0xff; px[i + 2] = (i >> 6) & 0xff; px[i + 3] = 255;
  }
  return px;
}

function fakeRaw(w = 1280, h = 960): RawBackend {
  return {
    async decode(_bytes: Uint8Array, _format: RawFormat): Promise<DecodedMaster> {
      return { rgba: gradientRgba(w, h), width: w, height: h, orientation: "baked" };
    },
  };
}

async function scalarBackends(): Promise<Backends> {
  const module = await loadScalarModule();
  setJxlModuleFactoryForTesting(scalarFactory(module));
  return { raw: fakeRaw(), jxl: createJxlBackend() };
}

test("collectInputs walks dirs recursively, keeps supported masters, sorts", async () => {
  const root = await mkdtemp(join(tmpdir(), "pyr-collect-"));
  await mkdir(join(root, "sub"), { recursive: true });
  await writeFile(join(root, "b.orf"), new Uint8Array([0]));
  await writeFile(join(root, "a.jpg"), new Uint8Array([0]));
  await writeFile(join(root, "note.txt"), new Uint8Array([0]));
  await writeFile(join(root, "sub", "c.CR2"), new Uint8Array([0]));
  await writeFile(join(root, "sub", "skip.png"), new Uint8Array([0]));

  const found = await collectInputs([root]);
  const rel = found.map((p) => p.slice(root.length + 1).replaceAll("\\", "/"));
  expect(rel).toEqual(["a.jpg", "b.orf", "sub/c.CR2"]);
});

test("main ingests a directory and writes a gallery index (RAW path via fake backend)", async () => {
  const out = await mkdtemp(join(tmpdir(), "pyr-cli-"));
  const src = await mkdtemp(join(tmpdir(), "pyr-src-"));
  await writeFile(join(src, "one.orf"), new Uint8Array([1]));
  await writeFile(join(src, "two.orf"), new Uint8Array([2]));

  const code = await main(["--out", out, src], await scalarBackends());
  expect(code).toBe(0);

  const index = JSON.parse(await readFile(join(out, "index.json"), "utf8")) as GalleryIndex;
  expect(index.images).toHaveLength(2);
  expect(index.images.map((e) => e.imageId)).toContain(imageIdForPath(join(src, "one.orf")));

  const levelFiles = await readdir(join(out, "levels"));
  expect(levelFiles.length).toBeGreaterThan(0);
});

test("main --proxy writes single-level proxy manifests and skips index rebuild", async () => {
  const out = await mkdtemp(join(tmpdir(), "pyr-cli-px-"));
  const src = await mkdtemp(join(tmpdir(), "pyr-src-px-"));
  await writeFile(join(src, "one.orf"), new Uint8Array([1]));

  const code = await main(["--out", out, "--proxy", "256", src], await scalarBackends());
  expect(code).toBe(0);

  const manifest = JSON.parse(
    await readFile(join(out, "images", imageIdForPath(join(src, "one.orf")), "manifest.json"), "utf8"),
  ) as Manifest;
  expect(manifest.proxy).toBe(true);
  expect(manifest.levels).toHaveLength(1);

  await expect(readFile(join(out, "index.json"), "utf8")).rejects.toThrow(); // no index in proxy mode
});

test("main --shard processes only its slice and skips the index; --reindex-only builds it", async () => {
  const out = await mkdtemp(join(tmpdir(), "pyr-cli-sh-"));
  const src = await mkdtemp(join(tmpdir(), "pyr-src-sh-"));
  for (const n of ["a.orf", "b.orf", "c.orf", "d.orf"]) await writeFile(join(src, n), new Uint8Array([1]));

  // A shard writes manifests but must NOT touch index.json — concurrent shards would race on it.
  const code = await main(["--out", out, "--shard", "0/2", src], await scalarBackends());
  expect(code).toBe(0);
  await expect(readFile(join(out, "index.json"), "utf8")).rejects.toThrow(); // no index from a shard
  // collectInputs sorts -> [a,b,c,d]; shard 0/2 -> indices 0,2 -> two image dirs written.
  expect(await readdir(join(out, "images"))).toHaveLength(2);

  // The single final reindex pass (run once after every shard finishes) builds index.json.
  const reindexCode = await main(["--out", out, "--reindex-only"], await scalarBackends());
  expect(reindexCode).toBe(0);
  const index = JSON.parse(await readFile(join(out, "index.json"), "utf8")) as GalleryIndex;
  expect(index.images).toHaveLength(2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/pyramid-ingest/test/cli.test.ts`
Expected: FAIL — `../src/cli` does not exist.

- [ ] **Step 3: Implement `raw-backend.ts`**

Create `packages/pyramid-ingest/src/raw-backend.ts`. The 14 look arguments after `output_flags` are all neutral; `wb_r_override`/`wb_b_override` are `NaN`, which the Rust pipeline reads as "trust the camera-stored white balance" (do not apply a gray-world override).

```ts
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import initRaw, {
  process_cr2_with_flags,
  process_dng_with_flags,
  process_orf_with_flags,
  type ProcessResult,
} from "../../../web/pkg/raw_converter_wasm.js";
import type { DecodedMaster, RawBackend, RawFormat } from "./backends.js";

const OUT_FULL_RGB8 = 1;

let initPromise: Promise<unknown> | null = null;

/** Lazily initialize the RAW WASM module from the sibling web/pkg build (idempotent). */
function ensureInit(): Promise<unknown> {
  if (!initPromise) {
    initPromise = (async () => {
      const wasmPath = fileURLToPath(new URL("../../../web/pkg/raw_converter_wasm_bg.wasm", import.meta.url));
      const bytes = await readFile(wasmPath);
      return initRaw({ module_or_path: bytes });
    })();
  }
  return initPromise;
}

type ProcessFn = (
  data: Uint8Array, output_flags: number,
  exposure_ev: number, contrast: number, highlights: number, shadows: number,
  whites: number, blacks: number, saturation: number, vibrance: number,
  temp: number, tint: number, wb_r_override: number, wb_b_override: number,
  texture: number, clarity: number,
) => ProcessResult;

/** Decode one RAW master to full-resolution RGBA8 with a neutral look; orientation is baked into pixels. */
function decodeWith(fn: ProcessFn, bytes: Uint8Array): DecodedMaster {
  const pr = fn(bytes, OUT_FULL_RGB8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NaN, NaN, 0, 0);
  try {
    const rgba = pr.take_rgba(); // full RGBA8 copied out of WASM; caller owns the buffer
    return { rgba, width: pr.width, height: pr.height, orientation: "baked" };
  } finally {
    pr.free();
  }
}

export function createRawBackend(): RawBackend {
  return {
    async decode(bytes: Uint8Array, format: RawFormat): Promise<DecodedMaster> {
      await ensureInit();
      switch (format) {
        case "orf": return decodeWith(process_orf_with_flags, bytes);
        case "dng": return decodeWith(process_dng_with_flags, bytes);
        case "cr2": return decodeWith(process_cr2_with_flags, bytes);
      }
    },
  };
}
```

- [ ] **Step 4: Implement `cli.ts`**

Create `packages/pyramid-ingest/src/cli.ts`. `main` accepts an optional injected `Backends` (the tests pass scalar-backed backends + a fake RAW backend); when omitted it builds the real backends and forces a single-thread tier.

```ts
import { readdir, stat } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { setForcedTier } from "@casabio/jxl-wasm";
import { createJxlBackend, type Backends } from "./backends.js";
import { createRawBackend } from "./raw-backend.js";
import { formatFromPath, ingestBatch, rebuildIndex } from "./ingest.js";
import { boundedConcurrency, planShard } from "./shard.js";

/** Recursively collect supported master files under the given roots (files or dirs), sorted. */
export async function collectInputs(roots: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  const walk = async (p: string): Promise<void> => {
    const s = await stat(p);
    if (s.isDirectory()) {
      for (const name of await readdir(p)) await walk(join(p, name));
    } else if (formatFromPath(p)) {
      out.push(p);
    }
  };
  for (const root of roots) await walk(root);
  out.sort();
  return out;
}

function parseShard(spec: string): { i: number; n: number } {
  const m = /^(\d+)\/(\d+)$/.exec(spec);
  if (!m) throw new Error(`--shard must be "i/N" (0-based), got "${spec}"`);
  return { i: Number(m[1]), n: Number(m[2]) };
}

// Per-image RGBA working-set estimate (~96 MB at 6000x4000) for the memory-budget clamp.
const PER_IMAGE_BYTES = 6000 * 4000 * 4;

export async function main(argv: string[], backendsOverride?: Backends): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: "string" },
      proxy: { type: "string" },
      force: { type: "boolean", default: false },
      concurrency: { type: "string" },
      "mem-budget-mb": { type: "string" },
      shard: { type: "string" },
      tier: { type: "string", default: "simd" },
      "reindex-only": { type: "boolean", default: false },
    },
  });

  if (!values.out) throw new Error("--out <dir> is required");

  // Final single-pass index build, run once after all shards finish (see --shard below).
  // Takes no inputs and never loads a backend — it only reads existing manifests.
  if (values["reindex-only"]) {
    const index = await rebuildIndex(values.out);
    process.stdout.write(`pyramid-ingest: reindexed ${index.images.length} images\n`);
    return 0;
  }

  if (positionals.length === 0) throw new Error("provide at least one input file or directory");

  if (!backendsOverride) {
    setForcedTier(values.tier as Parameters<typeof setForcedTier>[0]); // single-thread CLI; "simd" default
  }

  let files = await collectInputs(positionals);
  if (values.shard) {
    const { i, n } = parseShard(values.shard);
    files = planShard(files, i, n);
  }
  if (files.length === 0) {
    process.stderr.write("no supported master files found\n");
    return 0;
  }

  const proxy = values.proxy !== undefined ? Number(values.proxy) : undefined;
  const requested = values.concurrency !== undefined ? Number(values.concurrency) : undefined;
  const memBudgetBytes =
    (values["mem-budget-mb"] !== undefined ? Number(values["mem-budget-mb"]) : 4096) * 1024 * 1024;
  const concurrency = boundedConcurrency(availableParallelism(), requested, memBudgetBytes, PER_IMAGE_BYTES);

  const backends: Backends = backendsOverride ?? { raw: createRawBackend(), jxl: createJxlBackend() };
  const result = await ingestBatch(files, backends, {
    outDir: values.out,
    ...(proxy !== undefined ? { proxy } : {}),
    force: values.force,
    concurrency,
  });

  // Sharded runs each see only their slice and would race on index.json (concurrent writers,
  // partial reads), so they skip it — the caller runs one `--reindex-only` pass once every
  // shard has finished. A non-sharded full run owns the whole set and builds the index inline.
  if (proxy === undefined && !values.shard) await rebuildIndex(values.out);

  process.stdout.write(
    `pyramid-ingest: ${result.written} written, ${result.skipped} skipped, ${result.failed.length} failed` +
      (values.shard ? ` (shard ${values.shard})` : "") + "\n",
  );
  for (const f of result.failed) process.stderr.write(`FAILED ${f.path}: ${f.error}\n`);
  return result.failed.length > 0 ? 1 : 0;
}

// Run as a bin (dist/cli.js) but stay importable from tests without side effects.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(2);
    },
  );
}
```

- [ ] **Step 5: Re-export the real RAW backend from `index.ts`**

Append to `packages/pyramid-ingest/src/index.ts`:

```ts
export * from "./raw-backend.js";
```

(`cli.ts` is the bin entry; it is intentionally NOT re-exported — tests import it directly from `../src/cli`.)

- [ ] **Step 6: Run the CLI test to verify it passes**

Run: `bun test packages/pyramid-ingest/test/cli.test.ts`
Expected: PASS — 4 tests pass. **Requires Plan A's rebuilt scalar `dist`.**

- [ ] **Step 7: Add the JPG bit-exact integration test**

Create `packages/pyramid-ingest/test/jpg.test.ts` (proves the JPG full level is the lossless transcode byte-for-byte, not a re-encode):

```ts
import { afterEach, expect, test } from "bun:test";
import sharp from "sharp";
import { setJxlModuleFactoryForTesting, transcodeJpegToJxl } from "@casabio/jxl-wasm";
import { buildJpgLadder } from "../src/ladder";
import { createJxlBackend } from "../src/backends";
import { loadScalarModule, scalarFactory } from "./scalar";

afterEach(() => setJxlModuleFactoryForTesting(null));

async function jpegFixture(w: number, h: number): Promise<Uint8Array> {
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      raw[o] = (x * 31 + y * 17) & 0xff;
      raw[o + 1] = (x * 7 + y * 53) & 0xff;
      raw[o + 2] = (x * 13 + y * 29) & 0xff;
    }
  }
  const jpg = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
  return new Uint8Array(jpg);
}

test("buildJpgLadder uses the bit-exact lossless transcode as the full level", async () => {
  const module = await loadScalarModule();
  setJxlModuleFactoryForTesting(scalarFactory(module));
  const jxl = createJxlBackend();

  const jpeg = await jpegFixture(1280, 960);
  const expectedFull = await transcodeJpegToJxl(jpeg);

  const ladder = await buildJpgLadder(jxl, jpeg);
  expect(ladder.orientation).toBe("source");
  expect(ladder.width).toBe(1280);
  expect(ladder.height).toBe(960);

  const widths = ladder.levels.map((l) => l.width);
  expect(widths).toEqual([256, 512, 1024, 1280]); // sidecars + full last
  for (let i = 1; i < widths.length; i++) expect(widths[i]!).toBeGreaterThan(widths[i - 1]!);

  const full = ladder.levels[ladder.levels.length - 1]!;
  expect(Buffer.from(full.data)).toEqual(Buffer.from(expectedFull)); // byte-for-byte transcode
});
```

Run: `bun test packages/pyramid-ingest/test/jpg.test.ts`
Expected: PASS — 1 test. The full level equals `transcodeJpegToJxl(jpeg)` exactly (lossless transcode is deterministic). **Requires Plan A's rebuilt scalar `dist`** and the root `sharp` devDependency.

- [ ] **Step 8: Manual RAW smoke (no committed fixture — run once by hand)**

There is no in-repo RAW fixture, so the real `web/pkg` decode path is verified manually. Use a real RAW master (known local fixtures live under `c:\995\` and `c:\Foo\raw-converter\tests\`). Bun runs the TS entry directly:

```bash
bun packages/pyramid-ingest/src/cli.ts --out "%TEMP%\pyr-smoke" --tier scalar "c:\Foo\raw-converter\tests\<some-master>.ORF"
```

Expected: prints `pyramid-ingest: 1 written, 0 skipped, 0 failed`; `%TEMP%\pyr-smoke\index.json` lists one image; `%TEMP%\pyr-smoke\images/<id>/manifest.json` has `orientation: "baked"`, levels `[256,512,1024,(2048?),"full"]` (2048 present only if the master's long edge exceeds 2048), every level `bitsPerSample: 8`; each `levels/<hash>.jxl` opens in a JXL viewer. Record the result in the PR description.

- [ ] **Step 9: Full typecheck**

Run: `cd packages/pyramid-ingest && npx tsc --noEmit && cd ../..`
Expected: PASS — no type errors across all `src/*.ts` (the `web/pkg` `.d.ts` resolves via the relative import; `skipLibCheck` suppresses DOM-lib noise from `@casabio/jxl-wasm`).

- [ ] **Step 10: Commit**

```bash
git add packages/pyramid-ingest/src/raw-backend.ts packages/pyramid-ingest/src/cli.ts packages/pyramid-ingest/src/index.ts packages/pyramid-ingest/test/cli.test.ts packages/pyramid-ingest/test/jpg.test.ts
git commit -m "feat(pyramid-ingest): real RAW backend + CLI entry point"
```

---

## Task 10: Full suite + workspace wiring verification

No new source. Confirm the package builds, typechecks, and the whole test suite is green, and that the workspace runner picks it up. The spec is **already reconciled** in the same commit that introduced this plan (8-bit M1, manifest `bitsPerSample: 8`, `orientation: "baked" | "source"`, 16-bit deferred to M3) — do not edit the spec here.

**Files:** none created. Verification + a final commit only.

- [ ] **Step 1: Build the package (emit dist for the bin)**

Run: `npm run build --workspace @casabio/pyramid-ingest`
Expected: PASS — `tsc` emits `dist/cli.js` (+ all modules, `.d.ts`, maps). `dist/cli.js` is the resolved `bin` target.

- [ ] **Step 2: Typecheck the whole package**

Run: `npm run typecheck --workspace @casabio/pyramid-ingest`
Expected: PASS — `tsc --noEmit`, zero errors.

- [ ] **Step 3: Run the full package test suite**

Run: `bun test packages/pyramid-ingest/test/`
Expected: PASS — all suites green: `guard`, `quality`, `hash`, `shard`, `manifest`, `backends`, `ladder`, `ingest`, `cli`, `jpg`. **Requires Plan A's rebuilt scalar `dist`** for every WASM-backed suite.

- [ ] **Step 4: Verify the workspace runner includes the package**

Run: `node tools/run-workspaces.mjs typecheck` (or the repo's equivalent task entry)
Expected: the run visits `@casabio/pyramid-ingest` in order (immediately after `@casabio/jxl-wasm`) with no error. Confirms Task 1's `workspaceOrder` edit.

- [ ] **Step 5: Commit**

```bash
git add -u packages/pyramid-ingest
git commit -m "test(pyramid-ingest): full suite green + workspace wiring verified"
```

(If `git add -u` would stage anything outside `packages/pyramid-ingest`, stage by explicit path instead — this repo's working tree carries unrelated modified `dist/`/`web/` artifacts that must NOT be committed.)

---

## Self-Review

Run with fresh eyes against the spec and the task list.

**1. Spec coverage (design spec §2–§5, §10, §14):**
- §3 ingest pipeline (RAW/JPG → JXL pyramid) → Tasks 6–9 ✓
- §3 one-call sidecar encoder with per-level distances → `planLadder` (Task 2) + `encodeRgba8Pyramid` wrapper (Task 6) ✓
- §4 8-bit M1 decode (RAW full RGB8 via `take_rgba`; JPG transcode→decode) → Task 9 raw-backend + Task 6 `decodeToRgba8` ✓
- §4 orientation `"baked"` (RAW) / `"source"` (JPG) → carried through `DecodedMaster`/`LadderResult` into the manifest (Tasks 6–8) ✓
- §5 manifest schema (levels, contenthash, bitsPerSample 8, aspect, proxy) + gallery `index.json` (L0 inline) → Task 5 + Task 8 ✓
- §5 content-addressed level files + cross-image dedupe → `contentHash16` (Task 3) + `writeLevelFiles` skip-existing (Task 8), proven by the dedupe test ✓
- §10 push to a dumb static host → out is a plain directory tree (`images/`, `levels/`, `index.json`); no host-specific code, so any static/CDN sync (rsync/`aws s3 sync`) works ✓ (the sync command itself is out of scope for this plan — it is a one-line user step over the emitted tree)
- §10 verification proxy mode → `--proxy` single level + `proxy: true` manifest, excluded from the index (Tasks 8–9) ✓
- §4 resumability + multi-process safety → mtime compared at whole-ms granularity (cross-runtime/FS robustness); manifests written atomically (temp→rename); sharded runs skip `index.json`, then a single `--reindex-only` pass builds it once all shards finish; `rebuildIndex` skips unreadable/partial manifests instead of aborting (Tasks 5, 8, 9) ✓
- §14 testing (unit + WASM integration + fixtures) → pure-unit (quality/hash/shard/manifest), scalar-WASM integration (backends/ladder/ingest/cli/jpg), sharp fixtures, manual RAW smoke ✓
- **Deferred by design (M3, not a gap):** 16-bit big levels, `downscaleRgba16` consumption, the web gallery/lightbox client (Plan C), the RAW 16-bit highlight/shadow recovery (Plan D). These are explicitly out of M1 scope per the reconciled spec.

**2. Placeholder scan:** No `TBD`/`TODO`/"handle edge cases"/"similar to Task N". Every code step contains complete, runnable code; every run step has an exact command + expected result. ✓

**3. Type consistency across tasks:**
- `PyramidEncodeOptions` shape (`fullDistance`, `sidecarSizes`, `sidecarDistances`, `effort`) — defined in Task 6, produced by `planLadder`/`planProxy` (Task 2), consumed by `encodePyramid` (Task 6) and the fake in Task 7. ✓
- `PyramidLevelBytes` (`data`, `width`, `height`) — Task 6; consumed by `toEntry` (Task 5), `LadderResult` (Task 7), `writeLevelFiles` (Task 8). ✓
- `DecodedMaster` (`rgba`, `width`, `height`, `orientation`) — Task 6; produced by `RawBackend.decode`/`decodeMaster`, consumed by `buildRawLadder`/`buildProxyLadder`. ✓
- `Orientation = "baked" | "source"` — Task 6; flows into `Manifest.orientation` (Task 5) and the manifest test asserts both. ✓
- `MasterFormat`/`RawFormat` — Task 6; `formatFromPath` returns `MasterFormat | null` (Task 8), `RawBackend.decode` takes `RawFormat` (Task 6/9). ✓
- `Backends` (`{ raw, jxl }`) — Task 8; consumed by `ingestImage`/`ingestBatch` (Task 8) and `main` (Task 9). ✓
- `LevelEntry.bitsPerSample` is the literal `8` everywhere (Task 5 type, Task 8 assertions). ✓
- Method names stable: `encodePyramid`, `transcodeJpeg`, `decodeToRgba8` (Task 6) are the exact names called in Tasks 7–9. ✓

**4. Ordering / TDD discipline:** Each task is test-first → run-fail → implement → run-pass → commit. The type-only forward references in Tasks 2/5 (to `backends.ts`, created in Task 6) are flagged in-step: `bun test` erases type-only imports so the runtime tests pass immediately, and the first full `tsc` is Task 6 Step 7. ✓

No issues found that require changes beyond what is already written.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-07-pyramid-ingest-cli.md`. It depends on Plan A (`2026-06-07-pyramid-wasm-primitives.md`) being executed first (the `sidecars_v2` bridge + rebuilt scalar `dist`).

Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?

**If Subagent-Driven chosen:** REQUIRED SUB-SKILL — use superpowers:subagent-driven-development (fresh subagent per task + two-stage review).

**If Inline Execution chosen:** REQUIRED SUB-SKILL — use superpowers:executing-plans (batch execution with checkpoints for review).
