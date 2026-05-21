# T-NATIVE-BIND Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the four compiled WASM tiers to the TS facade with browser capability-based tier selection, then verify the round-trip encode→decode smoke test passes against real WASM artifacts.

**Architecture:** Add `detectTier()` to `facade.ts` — it probes SIMD/relaxed-SIMD via `WebAssembly.validate` and checks `SharedArrayBuffer`, returns `"scalar"` in Node/Bun. `loadGeneratedLibjxlModule` calls `detectTier()` to pick the right `jxl-core.<tier>.js` file. No new files — all changes in `src/facade.ts`. Tests run via `bun test`.

**Tech Stack:** TypeScript, Bun (test runner), Emscripten-generated ES6 modules (`-sEXPORT_ES6=1`), `WebAssembly.validate` for capability probing.

---

## File Map

| File | Change |
|------|--------|
| `packages/jxl-wasm/src/facade.ts` | Add `Tier` type, `detectTier()`, `probeSimd()`, `probeRelaxedSimd()`; update `loadGeneratedLibjxlModule` to use detected tier; export `detectTier` |
| `packages/jxl-wasm/test/facade.test.ts` | Add test block for `detectTier` |

---

### Task 1: Export `detectTier` and add its test (TDD — test first)

**Files:**
- Modify: `packages/jxl-wasm/test/facade.test.ts`

Context: `facade.test.ts` uses `bun:test`. The test file imports from `../src/index` which re-exports everything from `facade.ts`. We will add `detectTier` as an export in the next task; write the test now so it fails first.

- [ ] **Step 1: Add the `detectTier` import and test block to facade.test.ts**

Add this import at the top of `packages/jxl-wasm/test/facade.test.ts`, alongside the existing import:

```typescript
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createDecoder, createEncoder, detectTier, setJxlModuleFactoryForTesting } from "../src/index";
```

Add this describe block after the existing `@casabio/jxl-wasm facade` describe block:

```typescript
describe("detectTier", () => {
  test("returns a valid tier string", () => {
    const tier = detectTier();
    expect(["relaxed-simd-mt", "simd-mt", "simd", "scalar"]).toContain(tier);
  });

  test("returns scalar in Node/Bun (no cross-origin isolation)", () => {
    // Bun test runner has no SharedArrayBuffer-with-COOP, so tier falls to scalar
    const tier = detectTier();
    expect(tier).toBe("scalar");
  });
});
```

- [ ] **Step 2: Run the test — expect import failure**

```
cd packages/jxl-wasm
bun test test/facade.test.ts
```

Expected: error like `Export 'detectTier' is not found in '../src/index'` or a TS compilation error. This confirms we need to implement it.

---

### Task 2: Implement `detectTier` and wire it into `loadGeneratedLibjxlModule`

**Files:**
- Modify: `packages/jxl-wasm/src/facade.ts`

- [ ] **Step 1: Add the `Tier` type and three helper functions after the `CapabilityMissing` class (around line 144)**

Insert this block immediately after the closing `}` of `CapabilityMissing` (before `let modulePromise`):

```typescript
export type Tier = "relaxed-simd-mt" | "simd-mt" | "simd" | "scalar";

export function detectTier(): Tier {
  if (isNode()) return "scalar";
  if (typeof WebAssembly === "undefined") return "scalar";
  const hasSimd = probeSimd();
  if (!hasSimd) return "scalar";
  const hasSab = typeof SharedArrayBuffer !== "undefined";
  const hasRelaxedSimd = probeRelaxedSimd();
  if (hasSab && hasRelaxedSimd) return "relaxed-simd-mt";
  if (hasSab) return "simd-mt";
  return "simd";
}

function probeSimd(): boolean {
  try {
    // Minimal WASM: () -> v128, body: i32.const 0; i8x16.splat; end
    return WebAssembly.validate(new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // magic + version
      0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b,         // type: () -> v128
      0x03, 0x02, 0x01, 0x00,                             // func section
      0x0a, 0x08, 0x01, 0x06, 0x00,                       // code section
      0x41, 0x00,                                          // i32.const 0
      0xfd, 0x0f,                                          // i8x16.splat
      0x0b,                                                // end
    ]));
  } catch {
    return false;
  }
}

function probeRelaxedSimd(): boolean {
  try {
    // Minimal WASM: (v128, v128) -> v128, body: local.get 0; local.get 1; i8x16.relaxed_swizzle (fd 0x100); end
    return WebAssembly.validate(new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // magic + version
      0x01, 0x07, 0x01, 0x60, 0x02, 0x7b, 0x7b, 0x01, 0x7b, // type: (v128, v128) -> v128
      0x03, 0x02, 0x01, 0x00,                                   // func section
      0x0a, 0x0b, 0x01, 0x09, 0x00,                             // code section
      0x20, 0x00,                                                // local.get 0
      0x20, 0x01,                                                // local.get 1
      0xfd, 0x80, 0x02,                                          // i8x16.relaxed_swizzle (opcode 0x100)
      0x0b,                                                       // end
    ]));
  } catch {
    return false;
  }
}
```

Note: `isNode()` is already defined later in `facade.ts` at line ~447. TypeScript hoists function declarations but not `const`/`let`, so this works fine — `isNode` is a `function` declaration.

Wait — check `facade.ts`: `isNode` is defined inside `loader.ts` NOT `facade.ts`. In `facade.ts`, `isNode()` equivalent logic is done inline inside `loadGeneratedLibjxlModule` via the `try { import("node:fs/promises") }` pattern. **You must add `isNode()` as a function in `facade.ts`** — do not import from loader.ts to avoid a circular dependency.

Replace the insertion above with this (includes `isNode` helper):

```typescript
export type Tier = "relaxed-simd-mt" | "simd-mt" | "simd" | "scalar";

export function detectTier(): Tier {
  if (typeof process !== "undefined" && !!process.versions?.node) return "scalar";
  if (typeof WebAssembly === "undefined") return "scalar";
  const hasSimd = probeSimd();
  if (!hasSimd) return "scalar";
  const hasSab = typeof SharedArrayBuffer !== "undefined";
  const hasRelaxedSimd = probeRelaxedSimd();
  if (hasSab && hasRelaxedSimd) return "relaxed-simd-mt";
  if (hasSab) return "simd-mt";
  return "simd";
}

function probeSimd(): boolean {
  try {
    // Minimal WASM: () -> v128, body: i32.const 0; i8x16.splat; end
    return WebAssembly.validate(new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b,
      0x03, 0x02, 0x01, 0x00,
      0x0a, 0x08, 0x01, 0x06, 0x00,
      0x41, 0x00, 0xfd, 0x0f, 0x0b,
    ]));
  } catch {
    return false;
  }
}

function probeRelaxedSimd(): boolean {
  try {
    // Minimal WASM: (v128, v128) -> v128, body: local.get 0; local.get 1; i8x16.relaxed_swizzle; end
    return WebAssembly.validate(new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      0x01, 0x07, 0x01, 0x60, 0x02, 0x7b, 0x7b, 0x01, 0x7b,
      0x03, 0x02, 0x01, 0x00,
      0x0a, 0x0b, 0x01, 0x09, 0x00,
      0x20, 0x00, 0x20, 0x01, 0xfd, 0x80, 0x02, 0x0b,
    ]));
  } catch {
    return false;
  }
}
```

- [ ] **Step 2: Update `loadGeneratedLibjxlModule` to use the detected tier**

Replace the entire `loadGeneratedLibjxlModule` function (lines 447–467) with:

```typescript
async function loadGeneratedLibjxlModule(): Promise<LibjxlWasmModule> {
  const tier = detectTier();
  const modulePath = `./jxl-core.${tier}.js`;
  const imported = await import(modulePath) as { default?: unknown };
  const factory = imported.default;
  if (typeof factory !== "function") {
    throw new CapabilityMissing("Generated libjxl WASM module is missing default Emscripten factory");
  }
  const baseUrl = new URL("./", import.meta.url);
  const options: Record<string, unknown> = {
    locateFile: (path: string) => new URL(path, baseUrl).href,
  };
  try {
    const fsMod = await import("node:fs/promises" as string) as { readFile: (p: URL | string) => Promise<Uint8Array> };
    const urlMod = await import("node:url" as string) as { fileURLToPath: (u: URL | string) => string };
    options["wasmBinary"] = await fsMod.readFile(urlMod.fileURLToPath(new URL(`jxl-core.${tier}.wasm`, baseUrl)));
  } catch {
    // Not in Node/Bun, or WASM binary not found — Emscripten loads via fetch
  }
  return await (factory as (options: Record<string, unknown>) => Promise<LibjxlWasmModule>)(options);
}
```

- [ ] **Step 3: Run typecheck**

```
cd packages/jxl-wasm
bun run typecheck
```

Expected: no errors. Fix any type errors before proceeding.

- [ ] **Step 4: Run the tests — expect the detectTier tests to pass**

```
cd packages/jxl-wasm
bun test test/facade.test.ts
```

Expected output includes:
```
✓ detectTier > returns a valid tier string
✓ detectTier > returns scalar in Node/Bun (no cross-origin isolation)
```

All previously passing tests must still pass.

- [ ] **Step 5: Commit**

```
git add packages/jxl-wasm/src/facade.ts packages/jxl-wasm/test/facade.test.ts
git commit -m "feat(jxl-wasm): add browser tier detection to WASM loader"
```

---

### Task 3: Round-trip smoke test with real WASM artifacts

**Files:**
- Read: `packages/jxl-wasm/dist/jxl-core.scalar.js` (confirm present)
- Run: `packages/jxl-wasm/test/facade.test.ts` round-trip tests

Context: `facade.test.ts` has `loadPreferredLibjxlModule` which imports `../dist/jxl-core.scalar.js` and falls back to a fake module if it fails. The real WASM artifacts are already in `dist/`. These tests prove the facade's ABI calls match the compiled bridge.

- [ ] **Step 1: Confirm WASM artifacts exist**

```
ls packages/jxl-wasm/dist/jxl-core.scalar.js packages/jxl-wasm/dist/jxl-core.scalar.wasm
```

Expected: both files present (sizes ~12 KB JS, ~2.5 MB WASM).

- [ ] **Step 2: Run the full test suite**

```
cd packages/jxl-wasm
bun test test/facade.test.ts --reporter=verbose
```

Expected: all tests pass, including:
- `encodes and decodes rgba8 pixels through the WASM codec facade`
- `honors header-only decode target`
- `emits a dc progress event when the decode target stops early`
- `emits a progress event when emitEveryPass is enabled`
- `progressive decoder emits a flush before input is closed`

If tests fall back to the fake module (no `_malloc` etc. present), the round-trip tests pass but don't prove real WASM works. Check the console — if the real module loads, there will be no fallback log.

- [ ] **Step 3: Verify real WASM loaded (not fake)**

Add a temporary `console.log` inside `loadPreferredLibjxlModule` in the test file to confirm real WASM branch was taken:

```typescript
async function loadPreferredLibjxlModule() {
  try {
    const imported = await import("../dist/jxl-core.scalar.js");
    if (typeof imported.default === "function") {
      const baseUrl = new URL("../dist/", import.meta.url);
      const module = await imported.default({
        locateFile: (path: string) => new URL(path, baseUrl).href,
      });
      if (module && typeof module._malloc === "function" && typeof module._jxl_wasm_encode_rgba8 === "function") {
        console.log("[test] Real WASM module loaded successfully");
        return module;
      }
    }
  } catch (err) {
    console.warn("[test] Real WASM unavailable, falling back to fake:", err);
  }
  return createFakeLibjxlModule();
}
```

Re-run: `bun test test/facade.test.ts --reporter=verbose`

Expected console output: `[test] Real WASM module loaded successfully`

- [ ] **Step 4: Remove the temporary log**

Revert `loadPreferredLibjxlModule` in `facade.test.ts` to its original form (without the console lines).

- [ ] **Step 5: Update STATE.md**

Replace the `## Current Task` value and move `T-NATIVE-BIND` to `## Completed`:

In `packages/jxl-wasm/STATE.md`:
- Change `## Current Task` → `T-TIER-SELECT (or next task)`
- Add to `## Completed`: `- Added browser tier detection (relaxed-simd-mt / simd-mt / simd / scalar) to facade loadGeneratedLibjxlModule.`
- Remove from `## Blockers` the entry about facade needing T-WASM-BUILD artifacts (now resolved).

- [ ] **Step 6: Final commit**

```
git add packages/jxl-wasm/test/facade.test.ts packages/jxl-wasm/STATE.md
git commit -m "test(jxl-wasm): verify round-trip smoke test passes with real WASM; mark T-NATIVE-BIND complete"
```

---

## Self-Review

**Spec coverage check:**
1. ✅ Verify facade.ts calls real ABI — analyzed in brainstorm; `exports.txt` ↔ `LibjxlWasmModule` match exactly.
2. ✅ Wire loader tier selection — Task 2 adds `detectTier` + updates `loadGeneratedLibjxlModule`.
3. ✅ Worker integration — `jxl-worker-browser/wasm-loader.ts` checks `createDecoder`/`createEncoder` on import; `index.ts` re-exports both; no changes needed.
4. ✅ Round-trip smoke test — Task 3.

**Placeholder scan:** None — all steps have exact code.

**Type consistency:**
- `Tier` type defined in Task 2, used in `detectTier()` return, referenced in `loadGeneratedLibjxlModule` via template literal — consistent.
- `detectTier` exported from `facade.ts`, imported in test via `../src/index` — index re-exports `* from "./facade.js"` — consistent.
