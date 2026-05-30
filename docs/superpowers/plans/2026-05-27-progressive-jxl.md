# Progressive JXL Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the `packages/jxl-progressive/` package — manifest schema, dry-run profiler, tier-range streaming, gallery scheduler, cache layer, saliency policy — as specified in `docs/superpowers/specs/2026-05-27-progressive-jxl-implementation-design.md`.

**Architecture:** New `@casabio/jxl-progressive` package sits above `jxl-session` / `jxl-stream` / `jxl-cache`. Gallery scheduler (`ProgressiveGallery`) owns `IntersectionObserver`, weighted round-robin job queue, and `DecodeSession` lifecycle. It does **not** touch `jxl-scheduler` (worker pool). Profiler (`profileJxl`) drives a throw-away `DecodeSession` in small increments to discover real progression byte offsets, then writes a `.jxl.json` manifest.

**Tech Stack:** TypeScript 5.5, `node:test` + `node:assert/strict` for unit tests, Bun for wasm-level tests (not used here), Node `--test` runner, ESM modules, `@casabio/jxl-session`, `@casabio/jxl-stream`, `@casabio/jxl-cache`.

---

## File Map

```
packages/jxl-progressive/
  package.json
  tsconfig.json
  tsconfig.test.json
  src/
    types.ts              ← SessionFactory + shared re-exports
    progressive-manifest.ts ← schema, validate, lookupTier, checkHash, migrate
    saliency-policy.ts    ← shouldUseSaliency, normaliseCenter, selectBestCenter
    progressive-profile.ts ← profileJxl, profileJxlFile, tier boundary selection
    progressive-stream.ts ← fetchTier, streamTierFrames, fetchFull
    progressive-cache.ts  ← ProgressiveCache (wraps JxlCacheBrowser)
    progressive-scheduler.ts ← ProgressiveGallery + fairnessScore + tierRank
    index.ts              ← barrel export
  test/
    manifest.test.ts
    saliency.test.ts
    profile.test.ts
    stream.test.ts
    cache.test.ts
    scheduler.test.ts
web/
  jxl-progressive-gallery.html  ← demo page
  jxl-progressive-gallery.js    ← demo script
```

---

## Task 1: Package Scaffold

**Files:**
- Create: `packages/jxl-progressive/package.json`
- Create: `packages/jxl-progressive/tsconfig.json`
- Create: `packages/jxl-progressive/tsconfig.test.json`
- Create: `packages/jxl-progressive/src/types.ts`
- Create: `packages/jxl-progressive/src/index.ts` (stub)

- [ ] **Step 1.1: Create `package.json`**

```json
{
  "name": "@casabio/jxl-progressive",
  "version": "0.1.0",
  "description": "Progressive JXL streaming: manifest-derived tiers, gallery scheduler, saliency policy",
  "type": "module",
  "sideEffects": false,
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
    "test": "tsc -p tsconfig.test.json && node --test --test-force-exit dist-test/test/*.test.js"
  },
  "dependencies": {
    "@casabio/jxl-core": "^0.1.0",
    "@casabio/jxl-session": "^0.1.0",
    "@casabio/jxl-stream": "^0.1.0",
    "@casabio/jxl-cache": "^0.1.0"
  },
  "devDependencies": {
    "@types/node": "^22.12.0",
    "typescript": "5.5.4"
  }
}
```

Save to `packages/jxl-progressive/package.json`.

- [ ] **Step 1.2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
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
    "skipLibCheck": false,
    "types": ["node"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["dist", "node_modules"]
}
```

Save to `packages/jxl-progressive/tsconfig.json`.

- [ ] **Step 1.3: Create `tsconfig.test.json`**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "rootDir": ".",
    "outDir": "./dist-test",
    "noEmit": false
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Save to `packages/jxl-progressive/tsconfig.test.json`.

- [ ] **Step 1.4: Create `src/types.ts`**

```typescript
// packages/jxl-progressive/src/types.ts
// Shared types for @casabio/jxl-progressive.

import type { DecodeSession } from "@casabio/jxl-session";

export type { DecodeSession };

/**
 * Factory function that returns a fresh DecodeSession configured for
 * progressive decode (emitEveryPass: true, progressionTarget: "final").
 * Used by profileJxl and ProgressiveGallery.
 */
export type SessionFactory = () => DecodeSession;
```

- [ ] **Step 1.5: Create stub `src/index.ts`**

```typescript
// packages/jxl-progressive/src/index.ts
// Barrel — filled in Task 8.
export {};
```

- [ ] **Step 1.6: Install dependencies and verify TypeScript compiles**

Run from `packages/jxl-progressive/`:
```
cd packages/jxl-progressive && npm install
```

Then from repo root:
```
npm run typecheck -w packages/jxl-progressive
```

Expected: no errors (only the stub index.ts so far).

- [ ] **Step 1.7: Commit**

```
git add packages/jxl-progressive/
git commit -m "feat(jxl-progressive): scaffold package with tsconfig and types"
```

---

## Task 2: `progressive-manifest.ts`

**Files:**
- Create: `packages/jxl-progressive/src/progressive-manifest.ts`
- Create: `packages/jxl-progressive/test/manifest.test.ts`

- [ ] **Step 2.1: Write failing tests**

Create `packages/jxl-progressive/test/manifest.test.ts`:

```typescript
// packages/jxl-progressive/test/manifest.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateManifest,
  lookupTier,
  checkHash,
  migrateManifest,
  ManifestValidationError,
  ManifestStaleError,
  type ProgressiveManifest,
} from "../src/progressive-manifest.js";

const validManifest: ProgressiveManifest = {
  version: 1,
  source: { width: 4000, height: 3000, hasAlpha: false, orientation: 1 },
  jxl: { bytes: 1843921, sha256: "a".repeat(64) },
  encoder: { name: "cjxl", libjxlVersion: "0.11.0", flags: ["--progressive"] },
  tiers: [
    { name: "dc", byteStart: 0, byteEnd: 156320, progressionIndex: 1, intendedUse: "thumbnail" },
    { name: "preview", byteStart: 0, byteEnd: 642112, progressionIndex: 3, intendedUse: "visible-card" },
    { name: "full", byteStart: 0, byteEnd: 1843921, progressionIndex: "final", intendedUse: "zoom-export" },
  ],
};

describe("validateManifest", () => {
  it("accepts a valid manifest", () => {
    const m = validateManifest(validManifest);
    assert.equal(m.version, 1);
    assert.equal(m.tiers.length, 3);
  });

  it("throws on null", () => {
    assert.throws(() => validateManifest(null), ManifestValidationError);
  });

  it("throws on wrong version", () => {
    assert.throws(
      () => validateManifest({ ...validManifest, version: 2 }),
      (e: unknown) => e instanceof ManifestValidationError && e.field === "version",
    );
  });

  it("throws when tiers is empty", () => {
    assert.throws(
      () => validateManifest({ ...validManifest, tiers: [] }),
      (e: unknown) => e instanceof ManifestValidationError && e.field === "tiers",
    );
  });

  it("throws on invalid tier name", () => {
    const bad = {
      ...validManifest,
      tiers: [{ name: "bad", byteStart: 0, byteEnd: 100, progressionIndex: 1, intendedUse: "x" }],
    };
    assert.throws(
      () => validateManifest(bad),
      (e: unknown) => e instanceof ManifestValidationError && /tiers\[0\]\.name/.test(e.field),
    );
  });

  it("throws on missing jxl.sha256", () => {
    const bad = { ...validManifest, jxl: { bytes: 100 } };
    assert.throws(
      () => validateManifest(bad),
      (e: unknown) => e instanceof ManifestValidationError && /jxl\.sha256/.test(e.field),
    );
  });

  it("accepts optional saliency field", () => {
    const m = validateManifest({
      ...validManifest,
      saliency: { enabled: true, centerX: 0.5, centerY: 0.4, confidence: 0.9, method: "attention" },
    });
    assert.equal(m.saliency?.enabled, true);
  });
});

describe("lookupTier", () => {
  it("finds dc tier", () => {
    const t = lookupTier(validManifest, "dc");
    assert.equal(t?.byteEnd, 156320);
  });

  it("finds full tier", () => {
    const t = lookupTier(validManifest, "full");
    assert.equal(t?.progressionIndex, "final");
  });

  it("returns undefined for missing tier", () => {
    const m: ProgressiveManifest = { ...validManifest, tiers: [validManifest.tiers[2]!] };
    assert.equal(lookupTier(m, "dc"), undefined);
  });
});

describe("checkHash", () => {
  it("returns true when hash matches manifest sha256", async () => {
    // Build a buffer whose SHA-256 we know
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
    // Compute expected sha256 via SubtleCrypto
    const hashBuf = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    const expectedHex = Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const m: ProgressiveManifest = { ...validManifest, jxl: { bytes: 4, sha256: expectedHex } };
    assert.equal(await checkHash(m, bytes), true);
  });

  it("returns false when hash does not match", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
    const m: ProgressiveManifest = { ...validManifest, jxl: { bytes: 4, sha256: "0".repeat(64) } };
    assert.equal(await checkHash(m, bytes), false);
  });
});

describe("migrateManifest", () => {
  it("passes through version 1 unchanged", () => {
    const m = migrateManifest(validManifest);
    assert.equal(m.version, 1);
  });

  it("throws on version 2 (future, unsupported)", () => {
    assert.throws(
      () => migrateManifest({ ...validManifest, version: 2 }),
      ManifestValidationError,
    );
  });
});
```

- [ ] **Step 2.2: Run tests — expect compile or import failure**

```
cd packages/jxl-progressive && npm test
```

Expected: TypeScript compile error — `progressive-manifest.js` not found.

- [ ] **Step 2.3: Implement `src/progressive-manifest.ts`**

```typescript
// packages/jxl-progressive/src/progressive-manifest.ts

export type TierName = "dc" | "preview" | "full";

export interface ManifestTier {
  name: TierName;
  byteStart: number;
  byteEnd: number;
  progressionIndex: number | "final";
  intendedUse: string;
}

export interface ProgressiveManifest {
  version: 1;
  source: {
    width: number;
    height: number;
    hasAlpha: boolean;
    orientation: number;
  };
  jxl: {
    bytes: number;
    sha256: string;
  };
  encoder: {
    name: string;
    libjxlVersion: string;
    flags: string[];
  };
  saliency?: {
    enabled: boolean;
    centerX: number; // normalised 0–1
    centerY: number; // normalised 0–1
    confidence: number;
    method: string;
  };
  tiers: ManifestTier[];
}

export class ManifestValidationError extends Error {
  constructor(
    message: string,
    public readonly field: string,
  ) {
    super(message);
    this.name = "ManifestValidationError";
  }
}

export class ManifestStaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestStaleError";
  }
}

function assertField(
  condition: boolean,
  field: string,
  message: string,
): asserts condition {
  if (!condition) throw new ManifestValidationError(message, field);
}

const VALID_TIER_NAMES = new Set<string>(["dc", "preview", "full"]);

export function validateManifest(json: unknown): ProgressiveManifest {
  assertField(
    typeof json === "object" && json !== null,
    "root",
    "Manifest must be an object",
  );
  const obj = json as Record<string, unknown>;

  assertField(obj["version"] === 1, "version", "Manifest version must be 1");

  // source
  assertField(
    typeof obj["source"] === "object" && obj["source"] !== null,
    "source",
    "source must be an object",
  );
  const src = obj["source"] as Record<string, unknown>;
  assertField(typeof src["width"] === "number", "source.width", "source.width must be a number");
  assertField(typeof src["height"] === "number", "source.height", "source.height must be a number");
  assertField(typeof src["hasAlpha"] === "boolean", "source.hasAlpha", "source.hasAlpha must be a boolean");
  assertField(typeof src["orientation"] === "number", "source.orientation", "source.orientation must be a number");

  // jxl
  assertField(
    typeof obj["jxl"] === "object" && obj["jxl"] !== null,
    "jxl",
    "jxl must be an object",
  );
  const jxl = obj["jxl"] as Record<string, unknown>;
  assertField(typeof jxl["bytes"] === "number", "jxl.bytes", "jxl.bytes must be a number");
  assertField(typeof jxl["sha256"] === "string", "jxl.sha256", "jxl.sha256 must be a string");

  // encoder
  assertField(
    typeof obj["encoder"] === "object" && obj["encoder"] !== null,
    "encoder",
    "encoder must be an object",
  );
  const enc = obj["encoder"] as Record<string, unknown>;
  assertField(typeof enc["name"] === "string", "encoder.name", "encoder.name must be a string");
  assertField(typeof enc["libjxlVersion"] === "string", "encoder.libjxlVersion", "encoder.libjxlVersion must be a string");
  assertField(Array.isArray(enc["flags"]), "encoder.flags", "encoder.flags must be an array");

  // tiers
  assertField(Array.isArray(obj["tiers"]), "tiers", "tiers must be an array");
  const tiersArr = obj["tiers"] as unknown[];
  assertField(tiersArr.length > 0, "tiers", "tiers must not be empty");

  for (let i = 0; i < tiersArr.length; i++) {
    const t = tiersArr[i] as Record<string, unknown>;
    const f = `tiers[${i}]`;
    assertField(typeof t === "object" && t !== null, f, `${f} must be an object`);
    assertField(VALID_TIER_NAMES.has(t["name"] as string), `${f}.name`, `${f}.name must be dc|preview|full`);
    assertField(typeof t["byteStart"] === "number", `${f}.byteStart`, `${f}.byteStart must be a number`);
    assertField(typeof t["byteEnd"] === "number", `${f}.byteEnd`, `${f}.byteEnd must be a number`);
    assertField(
      typeof t["progressionIndex"] === "number" || t["progressionIndex"] === "final",
      `${f}.progressionIndex`,
      `${f}.progressionIndex must be number or "final"`,
    );
    assertField(typeof t["intendedUse"] === "string", `${f}.intendedUse`, `${f}.intendedUse must be a string`);
  }

  return json as ProgressiveManifest;
}

export function lookupTier(
  manifest: ProgressiveManifest,
  name: TierName,
): ManifestTier | undefined {
  return manifest.tiers.find((t) => t.name === name);
}

export async function checkHash(
  manifest: ProgressiveManifest,
  jxlBytes: ArrayBuffer,
): Promise<boolean> {
  let hashHex: string;

  if (
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.subtle?.digest === "function"
  ) {
    const hashBuf = await globalThis.crypto.subtle.digest("SHA-256", jxlBytes);
    hashHex = Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } else {
    // Node.js fallback (crypto.subtle not available or not cross-origin-isolated)
    const { createHash } = await import("node:crypto");
    hashHex = createHash("sha256")
      .update(Buffer.from(jxlBytes))
      .digest("hex");
  }

  return hashHex === manifest.jxl.sha256;
}

export function migrateManifest(json: unknown): ProgressiveManifest {
  if (typeof json === "object" && json !== null) {
    const v = (json as Record<string, unknown>)["version"];
    if (typeof v === "number" && v > 1) {
      throw new ManifestValidationError(
        `Cannot migrate manifest version ${v} (only version 1 supported)`,
        "version",
      );
    }
  }
  return validateManifest(json);
}
```

- [ ] **Step 2.4: Run tests — expect all pass**

```
cd packages/jxl-progressive && npm test
```

Expected:
```
▶ validateManifest
  ✓ accepts a valid manifest
  ✓ throws on null
  ✓ throws on wrong version
  ✓ throws when tiers is empty
  ✓ throws on invalid tier name
  ✓ throws on missing jxl.sha256
  ✓ accepts optional saliency field
▶ lookupTier
  ✓ finds dc tier
  ✓ finds full tier
  ✓ returns undefined for missing tier
▶ checkHash
  ✓ returns true when hash matches manifest sha256
  ✓ returns false when hash does not match
▶ migrateManifest
  ✓ passes through version 1 unchanged
  ✓ throws on version 2 (future, unsupported)
```

- [ ] **Step 2.5: Commit**

```
git add packages/jxl-progressive/src/progressive-manifest.ts packages/jxl-progressive/test/manifest.test.ts
git commit -m "feat(jxl-progressive): progressive-manifest schema, validate, lookupTier, checkHash"
```

---

## Task 3: `saliency-policy.ts`

**Files:**
- Create: `packages/jxl-progressive/src/saliency-policy.ts`
- Create: `packages/jxl-progressive/test/saliency.test.ts`

- [ ] **Step 3.1: Write failing tests**

Create `packages/jxl-progressive/test/saliency.test.ts`:

```typescript
// packages/jxl-progressive/test/saliency.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  shouldUseSaliency,
  normaliseCenter,
  selectBestCenter,
} from "../src/saliency-policy.js";

describe("shouldUseSaliency", () => {
  it("returns false for diagnostic image type regardless of confidence", () => {
    assert.equal(shouldUseSaliency({ imageType: "diagnostic", confidence: 0.99, centerCount: 1 }), false);
  });

  it("returns false for herbarium type", () => {
    assert.equal(shouldUseSaliency({ imageType: "herbarium", confidence: 0.99, centerCount: 1 }), false);
  });

  it("returns false for map type", () => {
    assert.equal(shouldUseSaliency({ imageType: "map", confidence: 0.99, centerCount: 1 }), false);
  });

  it("returns false for plate type", () => {
    assert.equal(shouldUseSaliency({ imageType: "plate", confidence: 0.99, centerCount: 1 }), false);
  });

  it("returns false for microscopy type", () => {
    assert.equal(shouldUseSaliency({ imageType: "microscopy", confidence: 0.99, centerCount: 1 }), false);
  });

  it("returns false when confidence < default threshold (0.6)", () => {
    assert.equal(shouldUseSaliency({ imageType: "portrait", confidence: 0.59, centerCount: 1 }), false);
  });

  it("returns false when confidence == 0.6 - epsilon (just below threshold)", () => {
    assert.equal(shouldUseSaliency({ imageType: "portrait", confidence: 0.5999, centerCount: 1 }), false);
  });

  it("returns true when confidence >= default threshold for portrait", () => {
    assert.equal(shouldUseSaliency({ imageType: "portrait", confidence: 0.6, centerCount: 1 }), true);
  });

  it("returns true for macro with high confidence", () => {
    assert.equal(shouldUseSaliency({ imageType: "macro", confidence: 0.8, centerCount: 1 }), true);
  });

  it("returns false when centerCount is 0", () => {
    assert.equal(shouldUseSaliency({ imageType: "portrait", confidence: 0.9, centerCount: 0 }), false);
  });

  it("respects custom confidenceThreshold", () => {
    assert.equal(shouldUseSaliency({ imageType: "portrait", confidence: 0.4, centerCount: 1, confidenceThreshold: 0.3 }), true);
    assert.equal(shouldUseSaliency({ imageType: "portrait", confidence: 0.4, centerCount: 1, confidenceThreshold: 0.5 }), false);
  });

  it("returns true for landscape with confidence above threshold (neutral, allowed)", () => {
    assert.equal(shouldUseSaliency({ imageType: "landscape", confidence: 0.75, centerCount: 1 }), true);
  });
});

describe("normaliseCenter", () => {
  it("converts pixel centre to 0-1 range", () => {
    const result = normaliseCenter(200, 150, 400, 300);
    assert.equal(result.x, 0.5);
    assert.equal(result.y, 0.5);
  });

  it("handles top-left corner", () => {
    const result = normaliseCenter(0, 0, 800, 600);
    assert.equal(result.x, 0);
    assert.equal(result.y, 0);
  });

  it("handles bottom-right corner", () => {
    const result = normaliseCenter(800, 600, 800, 600);
    assert.equal(result.x, 1);
    assert.equal(result.y, 1);
  });

  it("handles non-square images", () => {
    const result = normaliseCenter(100, 200, 400, 800);
    assert.equal(result.x, 0.25);
    assert.equal(result.y, 0.25);
  });
});

describe("selectBestCenter", () => {
  it("returns null for empty array", () => {
    assert.equal(selectBestCenter([]), null);
  });

  it("returns null when best confidence is below threshold", () => {
    assert.equal(
      selectBestCenter([{ x: 0.5, y: 0.5, confidence: 0.3 }]),
      null,
    );
  });

  it("returns the highest-confidence centre above threshold", () => {
    const result = selectBestCenter([
      { x: 0.3, y: 0.3, confidence: 0.7 },
      { x: 0.8, y: 0.8, confidence: 0.9 },
      { x: 0.1, y: 0.1, confidence: 0.5 },
    ]);
    assert.deepEqual(result, { x: 0.8, y: 0.8, confidence: 0.9 });
  });

  it("respects custom threshold", () => {
    const result = selectBestCenter(
      [{ x: 0.5, y: 0.5, confidence: 0.5 }],
      { threshold: 0.4 },
    );
    assert.deepEqual(result, { x: 0.5, y: 0.5, confidence: 0.5 });
  });
});
```

- [ ] **Step 3.2: Run tests — expect compile failure**

```
cd packages/jxl-progressive && npm test
```

Expected: TypeScript error — `saliency-policy.js` not found.

- [ ] **Step 3.3: Implement `src/saliency-policy.ts`**

```typescript
// packages/jxl-progressive/src/saliency-policy.ts

export type ImageType =
  | "portrait"
  | "product"
  | "macro"
  | "landscape"
  | "habitat"
  | "map"
  | "plate"
  | "herbarium"
  | "microscopy"
  | "diagnostic";

// These types have spatially distributed diagnostic detail — saliency encoding
// is counterproductive (spec §Saliency Fallback Rules).
const SALIENCY_DISABLED_TYPES = new Set<ImageType>([
  "map",
  "plate",
  "herbarium",
  "microscopy",
  "diagnostic",
]);

export interface ShouldUseSaliencyOpts {
  imageType: ImageType;
  /** Attention-centre confidence from 0 to 1. */
  confidence: number;
  /** Number of detected attention centres. */
  centerCount: number;
  /** Minimum confidence to enable saliency. Default 0.6. */
  confidenceThreshold?: number;
}

/** Returns true if attention-centre saliency encoding is appropriate. */
export function shouldUseSaliency(opts: ShouldUseSaliencyOpts): boolean {
  const { imageType, confidence, centerCount, confidenceThreshold = 0.6 } = opts;
  if (SALIENCY_DISABLED_TYPES.has(imageType)) return false;
  if (centerCount === 0) return false;
  if (confidence < confidenceThreshold) return false;
  return true;
}

/** Normalise pixel coordinates to the 0–1 range. */
export function normaliseCenter(
  cx: number,
  cy: number,
  imageWidth: number,
  imageHeight: number,
): { x: number; y: number } {
  return { x: cx / imageWidth, y: cy / imageHeight };
}

/**
 * From multiple attention centres, pick the single best.
 * Returns null if no centre meets the confidence threshold.
 */
export function selectBestCenter(
  centers: Array<{ x: number; y: number; confidence: number }>,
  opts?: { threshold?: number },
): { x: number; y: number; confidence: number } | null {
  const threshold = opts?.threshold ?? 0.6;
  if (centers.length === 0) return null;
  const sorted = [...centers].sort((a, b) => b.confidence - a.confidence);
  const best = sorted[0];
  if (best === undefined || best.confidence < threshold) return null;
  return best;
}
```

- [ ] **Step 3.4: Run tests — expect all pass**

```
cd packages/jxl-progressive && npm test
```

Expected: all 16 tests pass across manifest + saliency suites.

- [ ] **Step 3.5: Commit**

```
git add packages/jxl-progressive/src/saliency-policy.ts packages/jxl-progressive/test/saliency.test.ts
git commit -m "feat(jxl-progressive): saliency-policy: shouldUseSaliency, normaliseCenter, selectBestCenter"
```

---

## Task 4: `progressive-profile.ts`

**Files:**
- Create: `packages/jxl-progressive/src/progressive-profile.ts`
- Create: `packages/jxl-progressive/test/profile.test.ts`

- [ ] **Step 4.1: Write failing tests**

Create `packages/jxl-progressive/test/profile.test.ts`:

```typescript
// packages/jxl-progressive/test/profile.test.ts
// Uses a mock DecodeSession that emits fake frames at controlled byte offsets.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { profileJxl, type ProfileOptions } from "../src/progressive-profile.js";
import type { SessionFactory } from "../src/types.js";
import type { DecodeSession, DecodeFrameEvent, ImageInfo } from "@casabio/jxl-session";

// Minimal ImageInfo for frame events
const fakeInfo: ImageInfo = {
  width: 100, height: 100, bitsPerSample: 8, hasAlpha: false,
  hasAnimation: false, jpegReconstructionAvailable: false,
};

// fakePixels: a small ArrayBuffer representing pixel data
function fakePixels(): ArrayBuffer { return new ArrayBuffer(100 * 100 * 4); }

/**
 * MockDecodeSession emits one frame event per N bytes pushed.
 * After close(), it resolves frames() iteration.
 */
function makeMockSession(opts: {
  // emit a frame event after these many bytes have been pushed (cumulative)
  emitAtBytes: number[];
  stages?: string[];
}): { session: DecodeSession; factory: SessionFactory } {
  let bytesPushed = 0;
  let frameIdx = 0;
  const { emitAtBytes, stages = [] } = opts;

  // We use an async generator that yields frames on demand.
  // The session yields a frame whenever bytesPushed crosses the next threshold.
  let resolveNext: (() => void) | null = null;
  const pending: DecodeFrameEvent[] = [];
  let done = false;

  function maybeTrigger() {
    while (
      frameIdx < emitAtBytes.length &&
      bytesPushed >= (emitAtBytes[frameIdx] ?? Infinity)
    ) {
      const stage = stages[frameIdx] ?? "pass";
      pending.push({
        stage: stage as DecodeFrameEvent["stage"],
        info: fakeInfo,
        pixels: fakePixels(),
        format: "rgba8",
        pixelStride: 100 * 4,
      });
      frameIdx++;
    }
    resolveNext?.();
    resolveNext = null;
  }

  const session: DecodeSession = {
    id: "mock-session",
    async push(chunk) {
      bytesPushed += (chunk instanceof ArrayBuffer ? chunk.byteLength : (chunk as Uint8Array).byteLength);
      maybeTrigger();
    },
    async close() {
      done = true;
      maybeTrigger();
    },
    async cancel() {
      done = true;
      resolveNext?.();
    },
    async done() { return fakeInfo; },
    async *frames() {
      while (true) {
        while (pending.length > 0) {
          yield pending.shift()!;
        }
        if (done && pending.length === 0) break;
        await new Promise<void>((r) => { resolveNext = r; });
      }
    },
  };

  const factory: SessionFactory = () => session;
  return { session, factory };
}

describe("profileJxl", () => {
  it("returns a manifest with version 1", async () => {
    const { factory } = makeMockSession({ emitAtBytes: [1024, 4096, 8192] });
    const jxl = new ArrayBuffer(10000);
    const m = await profileJxl(jxl, factory, { width: 100, height: 100, hasAlpha: false });
    assert.equal(m.version, 1);
  });

  it("includes full tier with byteEnd = jxl.byteLength", async () => {
    const { factory } = makeMockSession({ emitAtBytes: [1000, 4000] });
    const jxl = new ArrayBuffer(8000);
    const m = await profileJxl(jxl, factory, { width: 100, height: 100, hasAlpha: false });
    const full = m.tiers.find((t) => t.name === "full");
    assert.ok(full, "full tier must exist");
    assert.equal(full!.byteEnd, 8000);
  });

  it("dc tier byteEnd is less than full file size", async () => {
    const { factory } = makeMockSession({
      emitAtBytes: [500, 3000, 7000],
      stages: ["dc", "pass", "pass"],
    });
    const jxl = new ArrayBuffer(10000);
    const m = await profileJxl(jxl, factory, { width: 100, height: 100, hasAlpha: false });
    const dc = m.tiers.find((t) => t.name === "dc");
    assert.ok(dc, "dc tier must exist");
    assert.ok(dc!.byteEnd < 10000, "dc byteEnd must be < full size");
  });

  it("falls back to single full tier when no progression events occur", async () => {
    const { factory } = makeMockSession({ emitAtBytes: [] });
    const jxl = new ArrayBuffer(5000);
    const m = await profileJxl(jxl, factory, { width: 50, height: 50, hasAlpha: false });
    assert.equal(m.tiers.length, 1);
    assert.equal(m.tiers[0]?.name, "full");
  });

  it("jxl.bytes equals jxlBytes.byteLength", async () => {
    const { factory } = makeMockSession({ emitAtBytes: [1000] });
    const jxl = new ArrayBuffer(9000);
    const m = await profileJxl(jxl, factory, { width: 100, height: 100, hasAlpha: false });
    assert.equal(m.jxl.bytes, 9000);
  });

  it("jxl.sha256 is a 64-char hex string", async () => {
    const { factory } = makeMockSession({ emitAtBytes: [500] });
    const jxl = new ArrayBuffer(2000);
    const m = await profileJxl(jxl, factory, { width: 100, height: 100, hasAlpha: false });
    assert.match(m.jxl.sha256, /^[0-9a-f]{64}$/);
  });

  it("includes saliency metadata when provided", async () => {
    const { factory } = makeMockSession({ emitAtBytes: [500] });
    const jxl = new ArrayBuffer(2000);
    const saliency = { enabled: true, centerX: 0.5, centerY: 0.3, confidence: 0.85, method: "attention" };
    const m = await profileJxl(
      jxl, factory, { width: 100, height: 100, hasAlpha: false },
      { saliency },
    );
    assert.deepEqual(m.saliency, saliency);
  });

  it("calls onProgress with increasing byte offsets", async () => {
    const { factory } = makeMockSession({ emitAtBytes: [500] });
    const jxl = new ArrayBuffer(3000);
    const offsets: number[] = [];
    await profileJxl(jxl, factory, { width: 100, height: 100, hasAlpha: false }, {
      chunkSize: 1000,
      onProgress: (offset) => offsets.push(offset),
    });
    assert.ok(offsets.length > 0);
    // offsets must be non-decreasing
    for (let i = 1; i < offsets.length; i++) {
      assert.ok(offsets[i]! >= offsets[i - 1]!);
    }
    assert.equal(offsets[offsets.length - 1], 3000);
  });

  it("rejects when signal is pre-aborted", async () => {
    const { factory } = makeMockSession({ emitAtBytes: [] });
    const ctrl = new AbortController();
    ctrl.abort();
    const jxl = new ArrayBuffer(1000);
    await assert.rejects(
      profileJxl(jxl, factory, { width: 10, height: 10, hasAlpha: false }, { signal: ctrl.signal }),
    );
  });
});
```

- [ ] **Step 4.2: Run tests — expect compile failure**

```
cd packages/jxl-progressive && npm test
```

Expected: TypeScript error — `progressive-profile.js` not found.

- [ ] **Step 4.3: Implement `src/progressive-profile.ts`**

```typescript
// packages/jxl-progressive/src/progressive-profile.ts

import type { SessionFactory } from "./types.js";
import {
  type ProgressiveManifest,
  type ManifestTier,
  type TierName,
} from "./progressive-manifest.js";

export type { SessionFactory };

export interface ProfileOptions {
  /** Bytes to feed per push. Default 16384 (16 KiB). */
  chunkSize?: number;
  encoderName?: string;
  libjxlVersion?: string;
  encoderFlags?: string[];
  saliency?: ProgressiveManifest["saliency"];
  /** Called after each chunk push with (byteOffset, totalBytes). */
  onProgress?: (byteOffset: number, total: number) => void;
  signal?: AbortSignal;
}

interface ProgressionEvent {
  byteOffset: number;
  stage: string;
  progressionIndex: number;
}

async function computeSha256(buffer: ArrayBuffer): Promise<string> {
  if (
    typeof globalThis.crypto !== "undefined" &&
    typeof (globalThis.crypto as { subtle?: { digest?: unknown } }).subtle?.digest === "function"
  ) {
    const hashBuf = await globalThis.crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  // Node.js fallback
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(Buffer.from(buffer)).digest("hex");
}

function selectTiers(
  events: ProgressionEvent[],
  totalBytes: number,
): ManifestTier[] {
  const tiers: ManifestTier[] = [];

  if (events.length === 0) {
    tiers.push({
      name: "full",
      byteStart: 0,
      byteEnd: totalBytes,
      progressionIndex: "final",
      intendedUse: "zoom-export",
    });
    return tiers;
  }

  // DC tier: first 'dc' stage event, or first event before 25% of file.
  const dcEvent =
    events.find((e) => e.stage === "dc") ??
    events.find((e) => e.byteOffset < totalBytes * 0.25) ??
    events[0];

  if (dcEvent !== undefined) {
    tiers.push({
      name: "dc",
      byteStart: 0,
      byteEnd: dcEvent.byteOffset,
      progressionIndex: dcEvent.progressionIndex,
      intendedUse: "thumbnail",
    });
  }

  // Preview tier: last event before 70% of file, distinct from dc.
  const before70 = events.filter((e) => e.byteOffset < totalBytes * 0.7);
  const previewEvent =
    before70.length > 0 ? before70[before70.length - 1] : undefined;

  if (
    previewEvent !== undefined &&
    previewEvent !== dcEvent &&
    previewEvent.byteOffset > (dcEvent?.byteOffset ?? 0)
  ) {
    tiers.push({
      name: "preview",
      byteStart: 0,
      byteEnd: previewEvent.byteOffset,
      progressionIndex: previewEvent.progressionIndex,
      intendedUse: "visible-card",
    });
  }

  // Full tier: always the complete file.
  tiers.push({
    name: "full",
    byteStart: 0,
    byteEnd: totalBytes,
    progressionIndex: "final",
    intendedUse: "zoom-export",
  });

  return tiers;
}

/**
 * Drive a throw-away DecodeSession in small byte increments,
 * record progression events, and return a ProgressiveManifest.
 *
 * Works in both Node.js and browser environments — accepts pre-loaded bytes,
 * performs no I/O internally.
 */
export async function profileJxl(
  jxlBytes: ArrayBuffer,
  sessionFactory: SessionFactory,
  source: { width: number; height: number; hasAlpha: boolean; orientation?: number },
  opts: ProfileOptions = {},
): Promise<ProgressiveManifest> {
  const {
    chunkSize = 16384,
    signal,
    onProgress,
    encoderName = "unknown",
    libjxlVersion = "unknown",
    encoderFlags = [],
    saliency,
  } = opts;

  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  const session = sessionFactory();
  const events: ProgressionEvent[] = [];
  let bytesPushed = 0;
  let progressionIdx = 0;

  // Collect frames concurrently with pushing bytes.
  // JavaScript is single-threaded: bytesPushed is read safely from the frame task.
  const framesTask = (async () => {
    for await (const frame of session.frames()) {
      events.push({
        byteOffset: bytesPushed,
        stage: frame.stage,
        progressionIndex: progressionIdx++,
      });
    }
  })();

  const pushTask = (async () => {
    const total = jxlBytes.byteLength;
    let offset = 0;
    while (offset < total) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const end = Math.min(offset + chunkSize, total);
      await session.push(jxlBytes.slice(offset, end));
      bytesPushed = end;
      onProgress?.(end, total);
      offset = end;
    }
    await session.close();
  })();

  await Promise.all([pushTask, framesTask]);

  const sha256 = await computeSha256(jxlBytes);

  const manifest: ProgressiveManifest = {
    version: 1,
    source: {
      width: source.width,
      height: source.height,
      hasAlpha: source.hasAlpha,
      orientation: source.orientation ?? 1,
    },
    jxl: { bytes: jxlBytes.byteLength, sha256 },
    encoder: { name: encoderName, libjxlVersion, flags: encoderFlags },
    tiers: selectTiers(events, jxlBytes.byteLength),
  };

  if (saliency !== undefined) {
    manifest.saliency = saliency;
  }

  return manifest;
}

/**
 * Node.js helper: read a .jxl file, profile it, and optionally write
 * the manifest as `${path}.json` beside the original file.
 */
export async function profileJxlFile(
  path: string,
  sessionFactory: SessionFactory,
  source: { width: number; height: number; hasAlpha: boolean; orientation?: number },
  opts: ProfileOptions & { writeManifest?: boolean } = {},
): Promise<ProgressiveManifest> {
  const { readFile, writeFile } = await import("node:fs/promises");
  const buf = await readFile(path);
  const manifest = await profileJxl(buf.buffer, sessionFactory, source, opts);
  if (opts.writeManifest !== false) {
    await writeFile(`${path}.json`, JSON.stringify(manifest, null, 2), "utf-8");
  }
  return manifest;
}
```

- [ ] **Step 4.4: Run tests — expect all pass**

```
cd packages/jxl-progressive && npm test
```

Expected: all manifest + saliency + profile tests pass (≥15 tests total).

- [ ] **Step 4.5: Commit**

```
git add packages/jxl-progressive/src/progressive-profile.ts packages/jxl-progressive/test/profile.test.ts
git commit -m "feat(jxl-progressive): progressive-profile: dry-run decode → manifest"
```

---

## Task 5: `progressive-stream.ts`

**Files:**
- Create: `packages/jxl-progressive/src/progressive-stream.ts`
- Create: `packages/jxl-progressive/test/stream.test.ts`

- [ ] **Step 5.1: Write failing tests**

Create `packages/jxl-progressive/test/stream.test.ts`:

```typescript
// packages/jxl-progressive/test/stream.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  fetchTier,
  fetchFull,
  streamTierFrames,
} from "../src/progressive-stream.js";
import type { ManifestTier } from "../src/progressive-manifest.js";
import type { DecodeSession, DecodeFrameEvent, ImageInfo } from "@casabio/jxl-session";

const fakeInfo: ImageInfo = {
  width: 100, height: 100, bitsPerSample: 8, hasAlpha: false,
  hasAnimation: false, jpegReconstructionAvailable: false,
};

function makeFakeSession(frames: DecodeFrameEvent[] = []): DecodeSession & {
  pushes: number[];
  closed: boolean;
  cancelled: boolean;
} {
  const session = {
    id: "test",
    pushes: [] as number[],
    closed: false,
    cancelled: false,
    async push(chunk: ArrayBuffer | Uint8Array) {
      session.pushes.push(chunk instanceof ArrayBuffer ? chunk.byteLength : (chunk as Uint8Array).byteLength);
    },
    async close() { session.closed = true; },
    async cancel() { session.cancelled = true; },
    async done() { return fakeInfo; },
    async *frames() { yield* frames; },
  };
  return session;
}

function makeBody(byteLength: number, status = 206): Response {
  const data = new Uint8Array(byteLength).fill(0xab);
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(c) { c.enqueue(data); c.close(); },
    }),
    {
      status,
      headers:
        status === 206
          ? { "Content-Range": `bytes 0-${byteLength - 1}/${byteLength * 10}` }
          : { "Content-Length": String(byteLength) },
    },
  );
}

const dcTier: ManifestTier = {
  name: "dc",
  byteStart: 0,
  byteEnd: 1000,
  progressionIndex: 1,
  intendedUse: "thumbnail",
};

describe("fetchTier", () => {
  it("fetches exactly byteEnd bytes via range request", async () => {
    const session = makeFakeSession();
    await fetchTier("https://example.com/img.jxl", dcTier, session, {
      fetchImpl: async () => makeBody(1000),
    });
    const total = session.pushes.reduce((s, n) => s + n, 0);
    assert.equal(total, 1000);
    assert.equal(session.closed, true);
  });

  it("does not overshoot when server returns more bytes (200 OK fallback)", async () => {
    const session = makeFakeSession();
    await fetchTier("https://example.com/img.jxl", dcTier, session, {
      fetchImpl: async () => makeBody(5000, 200), // server ignores range, returns more
    });
    const total = session.pushes.reduce((s, n) => s + n, 0);
    assert.equal(total, 1000, "must cap at tier.byteEnd");
    assert.equal(session.closed, true);
  });

  it("propagates AbortSignal: session cancelled when signal fires", async () => {
    const ctrl = new AbortController();
    const session = makeFakeSession();

    const slowFetch: typeof fetch = () =>
      new Promise((resolve) => {
        setTimeout(() => resolve(makeBody(1000)), 500);
      }) as Promise<Response>;

    const p = fetchTier("https://example.com/img.jxl", dcTier, session, {
      fetchImpl: slowFetch,
      signal: ctrl.signal,
    });
    ctrl.abort();
    await assert.rejects(p);
  });
});

describe("fetchFull", () => {
  it("fetches and pushes entire response body", async () => {
    const session = makeFakeSession();
    await fetchFull("https://example.com/img.jxl", session, {
      fetchImpl: async () => makeBody(5000, 200),
    });
    const total = session.pushes.reduce((s, n) => s + n, 0);
    assert.equal(total, 5000);
    assert.equal(session.closed, true);
  });

  it("throws on HTTP error", async () => {
    const session = makeFakeSession();
    await assert.rejects(
      fetchFull("https://example.com/img.jxl", session, {
        fetchImpl: async () => new Response(null, { status: 503, statusText: "Service Unavailable" }),
      }),
      (e: unknown) => e instanceof Error && /503/.test((e as Error).message),
    );
  });
});

describe("streamTierFrames", () => {
  it("yields all frames from session.frames()", async () => {
    const fakeFrames: DecodeFrameEvent[] = [
      { stage: "dc", info: fakeInfo, pixels: new ArrayBuffer(4), format: "rgba8", pixelStride: 4 },
      { stage: "pass", info: fakeInfo, pixels: new ArrayBuffer(4), format: "rgba8", pixelStride: 4 },
    ];
    const session = makeFakeSession(fakeFrames);
    const collected: DecodeFrameEvent[] = [];
    for await (const f of streamTierFrames(session)) {
      collected.push(f);
    }
    assert.equal(collected.length, 2);
    assert.equal(collected[0]?.stage, "dc");
    assert.equal(collected[1]?.stage, "pass");
  });

  it("yields nothing from an empty session", async () => {
    const session = makeFakeSession([]);
    const collected: DecodeFrameEvent[] = [];
    for await (const f of streamTierFrames(session)) {
      collected.push(f);
    }
    assert.equal(collected.length, 0);
  });
});
```

- [ ] **Step 5.2: Run tests — expect compile failure**

```
cd packages/jxl-progressive && npm test
```

Expected: TypeScript error — `progressive-stream.js` not found.

- [ ] **Step 5.3: Implement `src/progressive-stream.ts`**

```typescript
// packages/jxl-progressive/src/progressive-stream.ts

import { fromRangePrefix, fromResponse, type RangeNegotiation } from "@casabio/jxl-stream";
import type { DecodeSession, DecodeFrameEvent } from "@casabio/jxl-session";
import type { ManifestTier } from "./progressive-manifest.js";

export type { RangeNegotiation };

export interface TierFetchOptions {
  headers?: HeadersInit;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  onRangeNegotiated?: (info: RangeNegotiation) => void;
}

/**
 * Fetch bytes 0..tier.byteEnd of `url` via HTTP Range and push into `session`.
 * All tiers are cumulative from byte 0 (per spec §Byte Range Semantics).
 * Calls session.close() on success.
 */
export async function fetchTier(
  url: string,
  tier: ManifestTier,
  session: DecodeSession,
  opts: TierFetchOptions = {},
): Promise<void> {
  await fromRangePrefix(url, tier.byteEnd, session, opts);
}

/**
 * Async iterator over frames from an active DecodeSession.
 * Yields every DecodeFrameEvent until the session closes or is cancelled.
 */
export async function* streamTierFrames(
  session: DecodeSession,
): AsyncGenerator<DecodeFrameEvent> {
  yield* session.frames();
}

/**
 * Fetch the full resource (no Range header) and push into `session`.
 * Used as fallback when no manifest is available.
 */
export async function fetchFull(
  url: string,
  session: DecodeSession,
  opts: TierFetchOptions = {},
): Promise<void> {
  const { signal, headers, fetchImpl = globalThis.fetch } = opts;
  const mergedHeaders = new Headers(headers);
  const resp = await fetchImpl(url, { headers: mergedHeaders, signal });
  if (!resp.ok) {
    throw new Error(
      `[progressive-stream] HTTP ${resp.status} ${resp.statusText}: ${url}`,
    );
  }
  await fromResponse(resp, session, signal);
}
```

- [ ] **Step 5.4: Run tests — expect all pass**

```
cd packages/jxl-progressive && npm test
```

Expected: all stream tests pass alongside prior suites.

- [ ] **Step 5.5: Commit**

```
git add packages/jxl-progressive/src/progressive-stream.ts packages/jxl-progressive/test/stream.test.ts
git commit -m "feat(jxl-progressive): progressive-stream: fetchTier, streamTierFrames, fetchFull"
```

---

## Task 6: `progressive-cache.ts`

**Files:**
- Create: `packages/jxl-progressive/src/progressive-cache.ts`
- Create: `packages/jxl-progressive/test/cache.test.ts`

- [ ] **Step 6.1: Write failing tests**

Create `packages/jxl-progressive/test/cache.test.ts`:

```typescript
// packages/jxl-progressive/test/cache.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProgressiveCache } from "../src/progressive-cache.js";
import type { ProgressiveManifest } from "../src/progressive-manifest.js";

// Minimal in-memory stub for JxlCacheBrowser
function makeInnerCache(): {
  get(key: string): Promise<ArrayBuffer | undefined>;
  set(key: string, buf: ArrayBuffer): Promise<void>;
  store: Map<string, ArrayBuffer>;
} {
  const store = new Map<string, ArrayBuffer>();
  return {
    store,
    async get(key) { return store.get(key); },
    async set(key, buf) { store.set(key, buf); },
  };
}

const validManifest: ProgressiveManifest = {
  version: 1,
  source: { width: 100, height: 100, hasAlpha: false, orientation: 1 },
  jxl: { bytes: 5000, sha256: "a".repeat(64) },
  encoder: { name: "cjxl", libjxlVersion: "0.11.0", flags: [] },
  tiers: [
    { name: "dc", byteStart: 0, byteEnd: 500, progressionIndex: 1, intendedUse: "thumbnail" },
    { name: "full", byteStart: 0, byteEnd: 5000, progressionIndex: "final", intendedUse: "zoom-export" },
  ],
};

describe("ProgressiveCache — manifests", () => {
  it("returns null for unknown jxlUrl", async () => {
    const cache = new ProgressiveCache(makeInnerCache() as never);
    assert.equal(await cache.getManifest("https://example.com/img.jxl"), null);
  });

  it("stores and retrieves a manifest", async () => {
    const cache = new ProgressiveCache(makeInnerCache() as never);
    await cache.setManifest("https://example.com/img.jxl", validManifest);
    const retrieved = await cache.getManifest("https://example.com/img.jxl");
    assert.ok(retrieved !== null);
    assert.equal(retrieved!.version, 1);
    assert.equal(retrieved!.jxl.bytes, 5000);
  });

  it("invalidateManifest removes the entry", async () => {
    const cache = new ProgressiveCache(makeInnerCache() as never);
    await cache.setManifest("https://example.com/img.jxl", validManifest);
    await cache.invalidateManifest("https://example.com/img.jxl");
    assert.equal(await cache.getManifest("https://example.com/img.jxl"), null);
  });
});

describe("ProgressiveCache — byte ranges", () => {
  it("returns null for unknown byte range", async () => {
    const cache = new ProgressiveCache(makeInnerCache() as never);
    assert.equal(await cache.getByteRange("https://example.com/img.jxl", "dc"), null);
  });

  it("stores and retrieves a byte range", async () => {
    const cache = new ProgressiveCache(makeInnerCache() as never);
    const buf = new ArrayBuffer(1024);
    await cache.setByteRange("https://example.com/img.jxl", "dc", buf);
    const retrieved = await cache.getByteRange("https://example.com/img.jxl", "dc");
    assert.ok(retrieved !== null);
    assert.equal(retrieved!.byteLength, 1024);
  });

  it("different tiers stored independently", async () => {
    const cache = new ProgressiveCache(makeInnerCache() as never);
    await cache.setByteRange("https://example.com/img.jxl", "dc", new ArrayBuffer(100));
    await cache.setByteRange("https://example.com/img.jxl", "preview", new ArrayBuffer(500));
    const dc = await cache.getByteRange("https://example.com/img.jxl", "dc");
    const preview = await cache.getByteRange("https://example.com/img.jxl", "preview");
    assert.equal(dc?.byteLength, 100);
    assert.equal(preview?.byteLength, 500);
  });
});

describe("ProgressiveCache — invalidate all", () => {
  it("invalidate removes manifest and byte ranges for a url", async () => {
    const inner = makeInnerCache();
    const cache = new ProgressiveCache(inner as never);
    await cache.setManifest("https://example.com/img.jxl", validManifest);
    await cache.setByteRange("https://example.com/img.jxl", "dc", new ArrayBuffer(100));
    await cache.invalidate("https://example.com/img.jxl");
    assert.equal(await cache.getManifest("https://example.com/img.jxl"), null);
    assert.equal(await cache.getByteRange("https://example.com/img.jxl", "dc"), null);
  });

  it("does not affect different url", async () => {
    const cache = new ProgressiveCache(makeInnerCache() as never);
    await cache.setManifest("https://example.com/a.jxl", validManifest);
    await cache.setManifest("https://example.com/b.jxl", validManifest);
    await cache.invalidate("https://example.com/a.jxl");
    assert.ok(await cache.getManifest("https://example.com/b.jxl") !== null);
  });
});
```

- [ ] **Step 6.2: Run tests — expect compile failure**

```
cd packages/jxl-progressive && npm test
```

Expected: TypeScript error — `progressive-cache.js` not found.

- [ ] **Step 6.3: Implement `src/progressive-cache.ts`**

```typescript
// packages/jxl-progressive/src/progressive-cache.ts

import type { JxlCacheBrowser } from "@casabio/jxl-cache";
import {
  validateManifest,
  type ProgressiveManifest,
  type TierName,
} from "./progressive-manifest.js";

export interface ProgressiveCacheOptions {
  /** Manifest TTL in ms. After expiry, getManifest returns null. Default 1 hour. */
  manifestTtlMs?: number;
}

interface ManifestEntry {
  manifest: ProgressiveManifest;
  storedAt: number;
}

const MANIFEST_KEY_PREFIX = "jxl-progressive:manifest:";
const BYTES_KEY_PREFIX = "jxl-progressive:bytes:";
// Bitmap cache is in-memory only (ImageBitmap is not serialisable to OPFS).
const BITMAP_KEY_PREFIX = "jxl-progressive:bitmap:";

const DEFAULT_MANIFEST_TTL_MS = 3_600_000; // 1 hour

/**
 * Progressive-specific cache layer wrapping JxlCacheBrowser.
 *
 * Key conventions:
 *   Manifests  — "jxl-progressive:manifest:{jxlUrl}"
 *   Byte ranges — "jxl-progressive:bytes:{jxlUrl}#{tierName}"
 *
 * Manifests are stored as UTF-8 JSON (ArrayBuffer). Byte ranges are stored raw.
 */
export class ProgressiveCache {
  private readonly inner: JxlCacheBrowser;
  private readonly manifestTtlMs: number;
  private readonly bitmapStore = new Map<string, ImageBitmap>();

  constructor(
    inner: JxlCacheBrowser,
    opts: ProgressiveCacheOptions = {},
  ) {
    this.inner = inner;
    this.manifestTtlMs = opts.manifestTtlMs ?? DEFAULT_MANIFEST_TTL_MS;
  }

  // ---------------------------------------------------------------------------
  // Manifests
  // ---------------------------------------------------------------------------

  async getManifest(jxlUrl: string): Promise<ProgressiveManifest | null> {
    const key = MANIFEST_KEY_PREFIX + jxlUrl;
    const buf = await this.inner.get(key);
    if (buf === undefined) return null;
    try {
      const text = new TextDecoder().decode(buf);
      const entry = JSON.parse(text) as ManifestEntry;
      if (Date.now() - entry.storedAt > this.manifestTtlMs) {
        // Expired — remove and return null
        void this.inner.set(key, new ArrayBuffer(0)); // empty = sentinel for eviction; jxl-cache LRU will drop it
        return null;
      }
      return validateManifest(entry.manifest);
    } catch {
      return null;
    }
  }

  async setManifest(
    jxlUrl: string,
    manifest: ProgressiveManifest,
  ): Promise<void> {
    const entry: ManifestEntry = { manifest, storedAt: Date.now() };
    const text = JSON.stringify(entry);
    const buf = new TextEncoder().encode(text).buffer;
    await this.inner.set(MANIFEST_KEY_PREFIX + jxlUrl, buf as ArrayBuffer);
  }

  async invalidateManifest(jxlUrl: string): Promise<void> {
    // Store empty ArrayBuffer to evict — jxl-cache will overwrite the slot.
    // On next get() the empty buffer triggers the parse failure path → returns null.
    await this.inner.set(MANIFEST_KEY_PREFIX + jxlUrl, new ArrayBuffer(0));
  }

  // ---------------------------------------------------------------------------
  // Byte ranges
  // ---------------------------------------------------------------------------

  async getByteRange(
    jxlUrl: string,
    tier: TierName,
  ): Promise<ArrayBuffer | null> {
    const buf = await this.inner.get(BYTES_KEY_PREFIX + jxlUrl + "#" + tier);
    if (buf === undefined || buf.byteLength === 0) return null;
    return buf;
  }

  async setByteRange(
    jxlUrl: string,
    tier: TierName,
    bytes: ArrayBuffer,
  ): Promise<void> {
    await this.inner.set(BYTES_KEY_PREFIX + jxlUrl + "#" + tier, bytes);
  }

  // ---------------------------------------------------------------------------
  // Decoded bitmaps (in-memory only)
  // ---------------------------------------------------------------------------

  async getBitmap(
    jxlUrl: string,
    tier: TierName,
  ): Promise<ImageBitmap | null> {
    return this.bitmapStore.get(BITMAP_KEY_PREFIX + jxlUrl + "#" + tier) ?? null;
  }

  async setBitmap(
    jxlUrl: string,
    tier: TierName,
    bitmap: ImageBitmap,
  ): Promise<void> {
    this.bitmapStore.set(BITMAP_KEY_PREFIX + jxlUrl + "#" + tier, bitmap);
  }

  /**
   * Evict decoded bitmaps for all URLs except those in `exceptJxlUrls`.
   * Call when memory pressure is detected.
   */
  evictBitmaps(exceptJxlUrls: string[] = []): void {
    const keep = new Set(
      exceptJxlUrls.map((u) => BITMAP_KEY_PREFIX + u),
    );
    for (const key of this.bitmapStore.keys()) {
      // key format: "jxl-progressive:bitmap:{jxlUrl}#{tier}"
      const urlPart = key.slice(0, key.lastIndexOf("#"));
      if (!keep.has(urlPart)) {
        this.bitmapStore.delete(key);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Full invalidation
  // ---------------------------------------------------------------------------

  /** Invalidate all cached data for a URL (manifest + byte ranges + bitmaps). */
  async invalidate(jxlUrl: string): Promise<void> {
    await this.invalidateManifest(jxlUrl);
    for (const tier of ["dc", "preview", "full"] as TierName[]) {
      await this.inner.set(
        BYTES_KEY_PREFIX + jxlUrl + "#" + tier,
        new ArrayBuffer(0),
      );
    }
    for (const key of [...this.bitmapStore.keys()]) {
      if (key.includes(jxlUrl)) this.bitmapStore.delete(key);
    }
  }
}
```

- [ ] **Step 6.4: Run tests — expect all pass**

```
cd packages/jxl-progressive && npm test
```

Expected: all cache tests pass alongside prior suites.

- [ ] **Step 6.5: Commit**

```
git add packages/jxl-progressive/src/progressive-cache.ts packages/jxl-progressive/test/cache.test.ts
git commit -m "feat(jxl-progressive): ProgressiveCache wrapping JxlCacheBrowser"
```

---

## Task 7: `progressive-scheduler.ts`

**Files:**
- Create: `packages/jxl-progressive/src/progressive-scheduler.ts`
- Create: `packages/jxl-progressive/test/scheduler.test.ts`

The scheduler uses `IntersectionObserver` and `requestAnimationFrame`. To make it testable in Node without DOM globals, inject both via `GalleryOptions`.

- [ ] **Step 7.1: Write failing tests**

Create `packages/jxl-progressive/test/scheduler.test.ts`:

```typescript
// packages/jxl-progressive/test/scheduler.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  tierRank,
  fairnessScore,
  ProgressiveGallery,
  type Tier,
  type ProgressiveImageJob,
} from "../src/progressive-scheduler.js";
import { ProgressiveCache } from "../src/progressive-cache.js";
import type { SessionFactory } from "../src/types.js";
import type { DecodeSession, ImageInfo } from "@casabio/jxl-session";
import type { ProgressiveManifest } from "../src/progressive-manifest.js";

// ── Pure-function tests ──────────────────────────────────────────────────────

describe("tierRank", () => {
  it("none=0, dc=1, preview=2, full=3", () => {
    assert.equal(tierRank("none"), 0);
    assert.equal(tierRank("dc"), 1);
    assert.equal(tierRank("preview"), 2);
    assert.equal(tierRank("full"), 3);
  });
});

describe("fairnessScore", () => {
  it("lower priority number (higher importance) → higher score", () => {
    const now = 1000;
    const lightbox = makeJob({ priority: 1, currentTier: "dc", lastServedAt: 1000 });
    const offscreen = makeJob({ priority: 7, currentTier: "dc", lastServedAt: 1000 });
    assert.ok(fairnessScore(lightbox, now) > fairnessScore(offscreen, now));
  });

  it("starvation bonus increases score for long-unserved jobs", () => {
    const now = 10000;
    const fresh = makeJob({ priority: 3, currentTier: "dc", lastServedAt: 9000 });
    const starved = makeJob({ priority: 3, currentTier: "dc", lastServedAt: 0 });
    assert.ok(fairnessScore(starved, now) > fairnessScore(fresh, now));
  });

  it("under-refined bonus: lower currentTier = higher score", () => {
    const now = 1000;
    const atNone = makeJob({ priority: 3, currentTier: "none", lastServedAt: 1000 });
    const atPreview = makeJob({ priority: 3, currentTier: "preview", lastServedAt: 1000 });
    assert.ok(fairnessScore(atNone, now) > fairnessScore(atPreview, now));
  });
});

// ── ProgressiveGallery unit tests ────────────────────────────────────────────

// Minimal stub for IntersectionObserver
class MockIntersectionObserver {
  callback: IntersectionObserverCallback;
  observed = new Set<Element>();
  constructor(cb: IntersectionObserverCallback, _opts?: IntersectionObserverInit) {
    this.callback = cb;
  }
  observe(el: Element) { this.observed.add(el); }
  unobserve(el: Element) { this.observed.delete(el); }
  disconnect() { this.observed.clear(); }
  // Test helper: fire intersection for an element
  fire(el: Element, isIntersecting: boolean, ratio = 1.0) {
    this.callback([{
      target: el,
      isIntersecting,
      intersectionRatio: ratio,
      boundingClientRect: {} as DOMRectReadOnly,
      intersectionRect: {} as DOMRectReadOnly,
      rootBounds: {} as DOMRectReadOnly,
      time: performance.now(),
    }], this as unknown as IntersectionObserver);
  }
}

// Minimal DOM Element stub
function makeElement(id: string): Element {
  return { id, nodeType: 1 } as unknown as Element;
}

// Inner cache stub
function makeInnerCache() {
  const store = new Map<string, ArrayBuffer>();
  return {
    store,
    async get(key: string) { return store.get(key); },
    async set(key: string, buf: ArrayBuffer) { store.set(key, buf); },
  };
}

function makeJob(overrides: Partial<ProgressiveImageJob> = {}): ProgressiveImageJob {
  return {
    id: "test",
    element: makeElement("test"),
    jxlUrl: "https://example.com/img.jxl",
    manifestUrl: "https://example.com/img.jxl.json",
    visible: true,
    nearViewport: false,
    selected: false,
    currentTier: "none",
    targetTier: "preview",
    priority: 3,
    lastServedAt: 0,
    bytesLoaded: 0,
    manifest: null,
    decoderAbort: null,
    ...overrides,
  };
}

// Session factory that returns a session that immediately finishes with no frames
function makeInstantFactory(): SessionFactory {
  const fakeInfo: ImageInfo = {
    width: 1, height: 1, bitsPerSample: 8, hasAlpha: false,
    hasAnimation: false, jpegReconstructionAvailable: false,
  };
  return () => ({
    id: "instant",
    async push() {},
    async close() {},
    async cancel() {},
    async done() { return fakeInfo; },
    async *frames() {},
  } as DecodeSession);
}

describe("ProgressiveGallery", () => {
  it("observe registers the element with IntersectionObserver", () => {
    let observer!: MockIntersectionObserver;
    const cache = new ProgressiveCache(makeInnerCache() as never);
    const gallery = new ProgressiveGallery(cache, makeInstantFactory(), {
      intersectionObserverFactory: (cb, opts) => {
        observer = new MockIntersectionObserver(cb, opts);
        return observer as unknown as IntersectionObserver;
      },
      rafScheduler: () => 0, // disable ticking
      rafCanceller: () => {},
    });

    const el = makeElement("img-1");
    gallery.observe(el, "img-1", "https://example.com/img.jxl");
    assert.ok(observer.observed.has(el), "element must be observed");
    gallery.destroy();
  });

  it("unobserve removes element", () => {
    let observer!: MockIntersectionObserver;
    const cache = new ProgressiveCache(makeInnerCache() as never);
    const gallery = new ProgressiveGallery(cache, makeInstantFactory(), {
      intersectionObserverFactory: (cb, opts) => {
        observer = new MockIntersectionObserver(cb, opts);
        return observer as unknown as IntersectionObserver;
      },
      rafScheduler: () => 0,
      rafCanceller: () => {},
    });

    const el = makeElement("img-1");
    gallery.observe(el, "img-1", "https://example.com/img.jxl");
    gallery.unobserve("img-1");
    assert.ok(!observer.observed.has(el), "element must be unobserved");
    gallery.destroy();
  });

  it("select boosts priority to 1 and sets targetTier to full", () => {
    let observer!: MockIntersectionObserver;
    const cache = new ProgressiveCache(makeInnerCache() as never);
    const gallery = new ProgressiveGallery(cache, makeInstantFactory(), {
      intersectionObserverFactory: (cb, opts) => {
        observer = new MockIntersectionObserver(cb, opts);
        return observer as unknown as IntersectionObserver;
      },
      rafScheduler: () => 0,
      rafCanceller: () => {},
    });

    gallery.observe(makeElement("img-1"), "img-1", "https://example.com/img.jxl");
    gallery.select("img-1");
    // Access internal job state via expose method (see implementation)
    const job = gallery.getJob("img-1");
    assert.equal(job?.priority, 1);
    assert.equal(job?.targetTier, "full");
    gallery.destroy();
  });

  it("deselect restores priority and sets targetTier back to preview", () => {
    let observer!: MockIntersectionObserver;
    const cache = new ProgressiveCache(makeInnerCache() as never);
    const gallery = new ProgressiveGallery(cache, makeInstantFactory(), {
      intersectionObserverFactory: (cb, opts) => {
        observer = new MockIntersectionObserver(cb, opts);
        return observer as unknown as IntersectionObserver;
      },
      rafScheduler: () => 0,
      rafCanceller: () => {},
    });

    gallery.observe(makeElement("img-1"), "img-1", "https://example.com/img.jxl");
    gallery.select("img-1");
    gallery.deselect("img-1");
    const job = gallery.getJob("img-1");
    assert.equal(job?.targetTier, "preview");
    assert.ok((job?.priority ?? 0) > 1);
    gallery.destroy();
  });

  it("intersection change: visible image gets priority 3, offscreen gets 7", () => {
    let observer!: MockIntersectionObserver;
    const cache = new ProgressiveCache(makeInnerCache() as never);
    const gallery = new ProgressiveGallery(cache, makeInstantFactory(), {
      intersectionObserverFactory: (cb, opts) => {
        observer = new MockIntersectionObserver(cb, opts);
        return observer as unknown as IntersectionObserver;
      },
      rafScheduler: () => 0,
      rafCanceller: () => {},
    });

    const el = makeElement("img-1");
    gallery.observe(el, "img-1", "https://example.com/img.jxl");

    observer.fire(el, true, 1.0);
    assert.equal(gallery.getJob("img-1")?.priority, 3);

    observer.fire(el, false, 0);
    assert.equal(gallery.getJob("img-1")?.priority, 7);
    gallery.destroy();
  });

  it("destroy disconnects observer and cancels active decodes", () => {
    let disconnected = false;
    const cache = new ProgressiveCache(makeInnerCache() as never);
    const gallery = new ProgressiveGallery(cache, makeInstantFactory(), {
      intersectionObserverFactory: (cb, opts) => {
        const obs = new MockIntersectionObserver(cb, opts);
        const origDisconnect = obs.disconnect.bind(obs);
        obs.disconnect = () => { disconnected = true; origDisconnect(); };
        return obs as unknown as IntersectionObserver;
      },
      rafScheduler: () => 0,
      rafCanceller: () => {},
    });

    gallery.observe(makeElement("img-1"), "img-1", "https://example.com/img.jxl");
    gallery.destroy();
    assert.equal(disconnected, true);
  });
});
```

- [ ] **Step 7.2: Run tests — expect compile failure**

```
cd packages/jxl-progressive && npm test
```

Expected: TypeScript error — `progressive-scheduler.js` not found.

- [ ] **Step 7.3: Implement `src/progressive-scheduler.ts`**

```typescript
// packages/jxl-progressive/src/progressive-scheduler.ts

import type { SessionFactory } from "./types.js";
import type { DecodeFrameEvent } from "@casabio/jxl-session";
import {
  validateManifest,
  lookupTier,
  type ProgressiveManifest,
  type TierName,
} from "./progressive-manifest.js";
import { fetchTier, fetchFull, streamTierFrames } from "./progressive-stream.js";
import type { ProgressiveCache } from "./progressive-cache.js";

export type Tier = "none" | "dc" | "preview" | "full";

export interface ProgressiveImageJob {
  id: string;
  element: Element;
  jxlUrl: string;
  manifestUrl: string;
  visible: boolean;
  nearViewport: boolean;
  selected: boolean;
  currentTier: Tier;
  targetTier: Tier;
  /** 1 (highest) to 7 (lowest). See priority table in spec. */
  priority: number;
  lastServedAt: number;
  bytesLoaded: number;
  manifest: ProgressiveManifest | null;
  decoderAbort: AbortController | null;
}

export interface GalleryOptions {
  maxActiveDecoders?: number;
  maxConcurrentFetches?: number;
  maxQueuedJobs?: number;
  rootMargin?: string;
  onFrame?: (id: string, frame: DecodeFrameEvent) => void;
  onTier?: (id: string, tier: Tier) => void;
  onError?: (id: string, err: Error) => void;
  manifestSuffix?: string;
  autoProfile?: boolean;
  /** Injected for testing. Default: global IntersectionObserver constructor. */
  intersectionObserverFactory?: (
    callback: IntersectionObserverCallback,
    options?: IntersectionObserverInit,
  ) => IntersectionObserver;
  /** Injected for testing. Default: globalThis.requestAnimationFrame. */
  rafScheduler?: (fn: FrameRequestCallback) => number;
  /** Injected for testing. Default: globalThis.cancelAnimationFrame. */
  rafCanceller?: (id: number) => void;
}

/** Lower priority number = more important. Maps to a score where higher = better. */
export function tierRank(tier: Tier): number {
  const ranks: Record<Tier, number> = { none: 0, dc: 1, preview: 2, full: 3 };
  return ranks[tier];
}

/** Higher score = schedule this job sooner. */
export function fairnessScore(job: ProgressiveImageJob, now: number): number {
  // (8 - priority): priority 1 → 7, priority 7 → 1
  const importanceScore = 8 - job.priority;
  const starvationBonus = Math.min((now - job.lastServedAt) / 1000, 5);
  const underRefinedBonus = 3 - tierRank(job.currentTier);
  return importanceScore + starvationBonus + underRefinedBonus;
}

function nextTier(current: Tier): Tier | null {
  const map: Partial<Record<Tier, Tier>> = { none: "dc", dc: "preview", preview: "full" };
  return map[current] ?? null;
}

/**
 * Gallery-level progressive scheduler.
 *
 * Manages IntersectionObserver, a weighted round-robin job queue,
 * and DecodeSession lifecycle. Does NOT touch jxl-scheduler (worker pool).
 */
export class ProgressiveGallery {
  private readonly jobs = new Map<string, ProgressiveImageJob>();
  private readonly cache: ProgressiveCache;
  private readonly sessionFactory: SessionFactory;
  private readonly observer: IntersectionObserver;
  private readonly raf: (fn: FrameRequestCallback) => number;
  private readonly caf: (id: number) => void;
  private readonly opts: Required<
    Omit<GalleryOptions, "intersectionObserverFactory" | "rafScheduler" | "rafCanceller">
  >;
  private activeDecoders = 0;
  private rafHandle: number | null = null;
  private destroyed = false;

  constructor(
    cache: ProgressiveCache,
    sessionFactory: SessionFactory,
    opts: GalleryOptions = {},
  ) {
    this.cache = cache;
    this.sessionFactory = sessionFactory;
    this.raf =
      opts.rafScheduler ??
      ((fn) => globalThis.requestAnimationFrame(fn));
    this.caf =
      opts.rafCanceller ??
      ((id) => globalThis.cancelAnimationFrame(id));
    this.opts = {
      maxActiveDecoders: opts.maxActiveDecoders ?? 4,
      maxConcurrentFetches: opts.maxConcurrentFetches ?? 3,
      maxQueuedJobs: opts.maxQueuedJobs ?? 50,
      rootMargin: opts.rootMargin ?? "200px",
      onFrame: opts.onFrame ?? (() => {}),
      onTier: opts.onTier ?? (() => {}),
      onError: opts.onError ?? (() => {}),
      manifestSuffix: opts.manifestSuffix ?? ".json",
      autoProfile: opts.autoProfile ?? true,
    };
    const ioFactory =
      opts.intersectionObserverFactory ??
      ((cb, ioOpts) => new IntersectionObserver(cb, ioOpts));
    this.observer = ioFactory(this.handleIntersection, {
      rootMargin: this.opts.rootMargin,
      threshold: [0, 0.5, 1.0],
    });
    this.scheduleTick();
  }

  /** Register an image. `jxlUrl` is the .jxl resource URL. */
  observe(element: Element, id: string, jxlUrl: string): void {
    if (this.destroyed) return;
    if (this.jobs.size >= this.opts.maxQueuedJobs) return;
    const job: ProgressiveImageJob = {
      id,
      element,
      jxlUrl,
      manifestUrl: jxlUrl + this.opts.manifestSuffix,
      visible: false,
      nearViewport: false,
      selected: false,
      currentTier: "none",
      targetTier: "preview",
      priority: 5,
      lastServedAt: 0,
      bytesLoaded: 0,
      manifest: null,
      decoderAbort: null,
    };
    this.jobs.set(id, job);
    this.observer.observe(element);
  }

  unobserve(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.decoderAbort?.abort("unobserved");
    this.observer.unobserve(job.element);
    this.jobs.delete(id);
  }

  select(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.selected = true;
    job.priority = 1;
    job.targetTier = "full";
  }

  deselect(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.selected = false;
    job.priority = job.visible ? 3 : 5;
    job.targetTier = "preview";
  }

  setTargetTier(id: string, tier: Tier): void {
    const job = this.jobs.get(id);
    if (job) job.targetTier = tier;
  }

  /** Exposed for testing only — returns a copy of the internal job. */
  getJob(id: string): ProgressiveImageJob | undefined {
    return this.jobs.get(id);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.rafHandle !== null) this.caf(this.rafHandle);
    this.observer.disconnect();
    for (const job of this.jobs.values()) {
      job.decoderAbort?.abort("destroyed");
    }
    this.jobs.clear();
  }

  private handleIntersection = (entries: IntersectionObserverEntry[]): void => {
    for (const entry of entries) {
      for (const job of this.jobs.values()) {
        if (job.element !== entry.target) continue;
        const fullyVisible =
          entry.isIntersecting && entry.intersectionRatio >= 1.0;
        const partiallyVisible =
          entry.isIntersecting && entry.intersectionRatio >= 0.5;
        job.visible = partiallyVisible;
        job.nearViewport = entry.isIntersecting;

        if (job.selected) {
          // Selected jobs keep priority 1 regardless.
        } else if (fullyVisible) {
          job.priority = 3;
        } else if (partiallyVisible) {
          job.priority = 4;
        } else if (job.nearViewport) {
          job.priority = 5;
        } else {
          job.priority = 7;
          this.scheduleViewportExitCleanup(job);
        }
        break;
      }
    }
  };

  private scheduleViewportExitCleanup(job: ProgressiveImageJob): void {
    const graceMs = 2000;
    setTimeout(() => {
      if (!job.visible && !job.selected && job.decoderAbort !== null) {
        job.decoderAbort.abort("left-viewport");
        job.decoderAbort = null;
        this.activeDecoders = Math.max(0, this.activeDecoders - 1);
      }
    }, graceMs);
  }

  private scheduleTick(): void {
    if (this.destroyed) return;
    this.rafHandle = this.raf(() => {
      this.tick();
      this.scheduleTick();
    });
  }

  private tick(): void {
    if (this.destroyed) return;
    const now =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    const candidates = [...this.jobs.values()]
      .filter((j) => j.visible || j.nearViewport || j.selected)
      .filter((j) => tierRank(j.currentTier) < tierRank(j.targetTier))
      .filter((j) => j.decoderAbort === null)
      .sort((a, b) => fairnessScore(b, now) - fairnessScore(a, now));

    for (const job of candidates) {
      if (this.activeDecoders >= this.opts.maxActiveDecoders) break;
      void this.startDecode(job);
    }
  }

  private async startDecode(job: ProgressiveImageJob): Promise<void> {
    this.activeDecoders++;
    const abort = new AbortController();
    job.decoderAbort = abort;
    job.lastServedAt =
      typeof performance !== "undefined" ? performance.now() : Date.now();

    try {
      // Load manifest if not already loaded
      if (job.manifest === null) {
        job.manifest = await this.cache.getManifest(job.jxlUrl);
      }
      if (job.manifest === null) {
        job.manifest = await this.fetchAndCacheManifest(job);
      }

      const target = nextTier(job.currentTier);
      if (target === null) return;

      const manifestTier =
        job.manifest !== null ? lookupTier(job.manifest, target as TierName) : undefined;

      const session = this.sessionFactory();

      if (manifestTier !== undefined) {
        void fetchTier(job.jxlUrl, manifestTier, session, { signal: abort.signal });
      } else {
        void fetchFull(job.jxlUrl, session, { signal: abort.signal });
      }

      for await (const frame of streamTierFrames(session)) {
        if (abort.signal.aborted) break;
        this.opts.onFrame(job.id, frame);
      }

      if (!abort.signal.aborted) {
        job.currentTier = target;
        this.opts.onTier(job.id, target);
      }
    } catch (e) {
      if (!abort.signal.aborted) {
        this.opts.onError(
          job.id,
          e instanceof Error ? e : new Error(String(e)),
        );
      }
    } finally {
      job.decoderAbort = null;
      this.activeDecoders = Math.max(0, this.activeDecoders - 1);
    }
  }

  private async fetchAndCacheManifest(
    job: ProgressiveImageJob,
  ): Promise<ProgressiveManifest | null> {
    try {
      const resp = await fetch(job.manifestUrl);
      if (!resp.ok) return null;
      const json: unknown = await resp.json();
      const manifest = validateManifest(json);
      await this.cache.setManifest(job.jxlUrl, manifest);
      return manifest;
    } catch {
      return null;
    }
  }
}
```

- [ ] **Step 7.4: Run tests — expect all pass**

```
cd packages/jxl-progressive && npm test
```

Expected: all scheduler tests plus all prior tests pass.

- [ ] **Step 7.5: Commit**

```
git add packages/jxl-progressive/src/progressive-scheduler.ts packages/jxl-progressive/test/scheduler.test.ts
git commit -m "feat(jxl-progressive): ProgressiveGallery scheduler with round-robin and viewport priority"
```

---

## Task 8: Barrel Export + Build Verification

**Files:**
- Modify: `packages/jxl-progressive/src/index.ts`

- [ ] **Step 8.1: Write `src/index.ts`**

```typescript
// packages/jxl-progressive/src/index.ts

// Manifest
export {
  validateManifest,
  lookupTier,
  checkHash,
  migrateManifest,
  ManifestValidationError,
  ManifestStaleError,
} from "./progressive-manifest.js";
export type {
  TierName,
  ManifestTier,
  ProgressiveManifest,
} from "./progressive-manifest.js";

// Saliency policy
export {
  shouldUseSaliency,
  normaliseCenter,
  selectBestCenter,
} from "./saliency-policy.js";
export type { ImageType, ShouldUseSaliencyOpts } from "./saliency-policy.js";

// Profiler
export {
  profileJxl,
  profileJxlFile,
} from "./progressive-profile.js";
export type { ProfileOptions } from "./progressive-profile.js";

// Stream
export {
  fetchTier,
  fetchFull,
  streamTierFrames,
} from "./progressive-stream.js";
export type { TierFetchOptions } from "./progressive-stream.js";

// Cache
export { ProgressiveCache } from "./progressive-cache.js";
export type { ProgressiveCacheOptions } from "./progressive-cache.js";

// Scheduler
export {
  ProgressiveGallery,
  tierRank,
  fairnessScore,
} from "./progressive-scheduler.js";
export type {
  Tier,
  ProgressiveImageJob,
  GalleryOptions,
} from "./progressive-scheduler.js";

// Shared types
export type { SessionFactory } from "./types.js";
```

- [ ] **Step 8.2: Build the package**

```
cd packages/jxl-progressive && npm run build
```

Expected: `dist/` populated with `.js`, `.d.ts`, `.js.map` files. No errors.

- [ ] **Step 8.3: Typecheck**

```
cd packages/jxl-progressive && npm run typecheck
```

Expected: no errors.

- [ ] **Step 8.4: Run full test suite**

```
cd packages/jxl-progressive && npm test
```

Expected: all tests pass.

- [ ] **Step 8.5: Commit**

```
git add packages/jxl-progressive/src/index.ts packages/jxl-progressive/dist/
git commit -m "feat(jxl-progressive): barrel export and build output"
```

---

## Task 9: Demo Page

**Files:**
- Create: `web/jxl-progressive-gallery.html`
- Create: `web/jxl-progressive-gallery.js`

The demo wires `ProgressiveGallery` to a 12-slot canvas grid. Each slot shows tier badge (none/dc/preview/full). Real JXL URLs must be supplied by the user; the page shows a placeholder grid with a URL input to test with your own files.

- [ ] **Step 9.1: Create `web/jxl-progressive-gallery.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Progressive JXL Gallery Demo</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; background: #111; color: #eee; }
    h1 { padding: 1rem; font-size: 1.2rem; }
    #controls { display: flex; gap: 0.5rem; padding: 0 1rem 1rem; flex-wrap: wrap; align-items: center; }
    #controls input[type="text"] { flex: 1; min-width: 300px; padding: 0.4rem; background: #222; color: #eee; border: 1px solid #444; border-radius: 4px; }
    #controls button { padding: 0.4rem 0.8rem; border: 1px solid #555; background: #333; color: #eee; cursor: pointer; border-radius: 4px; }
    #gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 4px; padding: 0 1rem 1rem; }
    .slot { position: relative; background: #1a1a1a; aspect-ratio: 4/3; overflow: hidden; }
    .slot canvas { width: 100%; height: 100%; object-fit: cover; display: block; }
    .slot .badge {
      position: absolute; top: 4px; right: 4px;
      background: rgba(0,0,0,0.7); color: #0f0; font-size: 10px;
      padding: 2px 5px; border-radius: 3px; font-family: monospace;
    }
    .slot .spinner { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 1.5rem; }
    #log { margin: 1rem; background: #1a1a1a; border: 1px solid #333; padding: 0.5rem; max-height: 200px; overflow-y: auto; font-family: monospace; font-size: 11px; }
  </style>
</head>
<body>
  <h1>Progressive JXL Gallery Demo</h1>
  <div id="controls">
    <input type="text" id="jxl-url" placeholder="Enter JXL base URL, e.g. https://example.com/images/img" />
    <input type="number" id="count" value="6" min="1" max="12" style="width:60px" />
    <button id="load-btn">Load</button>
    <button id="pause-btn">Pause</button>
    <button id="reset-btn">Reset</button>
  </div>
  <div id="gallery"></div>
  <div id="log"></div>
  <script type="module" src="./jxl-progressive-gallery.js"></script>
</body>
</html>
```

- [ ] **Step 9.2: Create `web/jxl-progressive-gallery.js`**

```javascript
// web/jxl-progressive-gallery.js
// Demo: wires ProgressiveGallery to a canvas grid.
// Import jxl-progressive from built dist. Adjust path to match your setup.
// Requires a JxlContext to be available (from jxl-session).

import {
  ProgressiveCache,
  ProgressiveGallery,
} from '../packages/jxl-progressive/dist/index.js';
import { createBrowserContext } from '../packages/jxl-session/dist/index.js';
import { createJxlCache } from '../packages/jxl-cache/dist/index.js';

const galleryEl = document.getElementById('gallery');
const logEl = document.getElementById('log');
const jxlUrlInput = document.getElementById('jxl-url');
const countInput = document.getElementById('count');
const loadBtn = document.getElementById('load-btn');
const pauseBtn = document.getElementById('pause-btn');
const resetBtn = document.getElementById('reset-btn');

let ctx = null;
let currentGallery = null;
const slots = new Map(); // id → { canvas, badgeEl }

function log(msg) {
  const line = document.createElement('div');
  line.textContent = `${new Date().toISOString().slice(11, 23)} ${msg}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

async function init() {
  ctx = await createBrowserContext();
  log('JXL context ready');
}

function sessionFactory() {
  return ctx.decode({
    format: 'rgba8',
    emitEveryPass: true,
    progressionTarget: 'final',
  });
}

function buildGrid(count) {
  galleryEl.innerHTML = '';
  slots.clear();
  for (let i = 0; i < count; i++) {
    const id = `slot-${i}`;
    const slotEl = document.createElement('div');
    slotEl.className = 'slot';
    const canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 300;
    const badge = document.createElement('div');
    badge.className = 'badge';
    badge.textContent = 'none';
    const spinner = document.createElement('div');
    spinner.className = 'spinner';
    spinner.textContent = '⏳';
    slotEl.appendChild(canvas);
    slotEl.appendChild(badge);
    slotEl.appendChild(spinner);
    galleryEl.appendChild(slotEl);
    slots.set(id, { canvas, badgeEl: badge, spinnerEl: spinner, slotEl });
  }
}

function renderFrame(id, frame) {
  const slot = slots.get(id);
  if (!slot) return;
  const { canvas, spinnerEl } = slot;
  spinnerEl.style.display = 'none';
  const ctx2d = canvas.getContext('2d');
  const { width, height, pixels } = frame.info
    ? { ...frame, width: frame.info.width, height: frame.info.height }
    : { width: canvas.width, height: canvas.height, pixels: frame.pixels };
  canvas.width = width;
  canvas.height = height;
  const imageData = new ImageData(
    new Uint8ClampedArray(pixels instanceof ArrayBuffer ? pixels : frame.pixels),
    width,
    height,
  );
  ctx2d.putImageData(imageData, 0, 0);
}

function onTier(id, tier) {
  const slot = slots.get(id);
  if (!slot) return;
  slot.badgeEl.textContent = tier;
  log(`${id}: reached tier ${tier}`);
}

function onError(id, err) {
  log(`${id}: ERROR ${err.message}`);
}

async function loadGallery() {
  if (currentGallery) {
    currentGallery.destroy();
    currentGallery = null;
  }

  const baseUrl = jxlUrlInput.value.trim();
  const count = parseInt(countInput.value, 10) || 6;
  buildGrid(count);

  const innerCache = createJxlCache({ memoryLimit: 128 * 1024 * 1024, persistentLimit: 512 * 1024 * 1024, persistent: true });
  const cache = new ProgressiveCache(innerCache);

  const gallery = new ProgressiveGallery(cache, sessionFactory, {
    maxActiveDecoders: 4,
    onFrame: renderFrame,
    onTier,
    onError,
  });

  currentGallery = gallery;

  for (let i = 0; i < count; i++) {
    const id = `slot-${i}`;
    const slot = slots.get(id);
    const jxlUrl = `${baseUrl}${i}.jxl`;
    gallery.observe(slot.slotEl, id, jxlUrl);
    log(`observe ${id} → ${jxlUrl}`);
  }
}

let paused = false;
pauseBtn.addEventListener('click', () => {
  paused = !paused;
  pauseBtn.textContent = paused ? 'Resume' : 'Pause';
  log(paused ? 'Paused' : 'Resumed');
});

resetBtn.addEventListener('click', () => {
  if (currentGallery) { currentGallery.destroy(); currentGallery = null; }
  galleryEl.innerHTML = '';
  slots.clear();
  log('Reset');
});

loadBtn.addEventListener('click', loadGallery);

// Double-click a slot to select (lightbox)
galleryEl.addEventListener('dblclick', (e) => {
  if (!currentGallery) return;
  const slotEl = e.target.closest('.slot');
  if (!slotEl) return;
  for (const [id, slot] of slots.entries()) {
    if (slot.slotEl === slotEl) {
      currentGallery.select(id);
      slot.badgeEl.style.color = '#ff0';
      log(`${id}: selected (full quality)`);
      break;
    }
  }
});

init().catch(err => log(`Init error: ${err.message}`));
```

- [ ] **Step 9.3: Verify HTML loads in browser**

Serve the `web/` directory with a static server that sends COOP/COEP headers (required for SharedArrayBuffer):
```
npx serve web -p 8080 --cors
```

Open `http://localhost:8080/jxl-progressive-gallery.html`. Enter a JXL base URL and count, click Load.

Expected: canvas grid appears, tier badges update from none → dc → preview as bytes are fetched.

- [ ] **Step 9.4: Commit**

```
git add web/jxl-progressive-gallery.html web/jxl-progressive-gallery.js
git commit -m "feat(jxl-progressive): gallery demo page with round-robin scheduler wired up"
```

---

## Task 10: Register Package in Workspace + Final Verification

**Files:**
- Verify: `package.json` workspaces field already includes `packages/*`

- [ ] **Step 10.1: Install workspace dependencies**

From repo root:
```
npm install
```

Expected: `packages/jxl-progressive/node_modules` symlinks populated; `@casabio/jxl-progressive` visible in workspace.

- [ ] **Step 10.2: Full workspace typecheck**

```
npm run typecheck
```

Expected: no TypeScript errors across all packages including `jxl-progressive`.

- [ ] **Step 10.3: Full workspace test**

```
npm test
```

Expected: all packages pass, including new `jxl-progressive` tests.

- [ ] **Step 10.4: Commit**

```
git add package-lock.json
git commit -m "chore: register @casabio/jxl-progressive in workspace"
```

---

## Self-Review Checklist

| Spec Requirement | Task |
|-----------------|------|
| Manifest schema v1 with all fields | Task 2 |
| `validateManifest` throws `ManifestValidationError` | Task 2 |
| `lookupTier` by name | Task 2 |
| `checkHash` SHA-256 via SubtleCrypto + Node fallback | Task 2 |
| `migrateManifest` rejects version > 1 | Task 2 |
| `ManifestStaleError` type exported | Task 2 |
| `shouldUseSaliency` disabled types + confidence threshold | Task 3 |
| `normaliseCenter` pixel → 0–1 | Task 3 |
| `selectBestCenter` from multiple candidates | Task 3 |
| `profileJxl` dry-run decode → manifest | Task 4 |
| `profileJxlFile` Node helper writes `.jxl.json` | Task 4 |
| Tier boundary selection: dc < 25%, preview < 70% | Task 4 |
| SHA-256 in manifest matches file | Task 4 |
| `fetchTier` uses `fromRangePrefix` with `tier.byteEnd` | Task 5 |
| `fetchFull` fallback (no manifest) | Task 5 |
| `streamTierFrames` async iterator over session | Task 5 |
| `ProgressiveCache` wraps `JxlCacheBrowser` | Task 6 |
| Manifests stored as JSON ArrayBuffer | Task 6 |
| Byte ranges stored by `url#tier` key | Task 6 |
| Bitmaps in-memory only | Task 6 |
| `invalidate` removes all entries for a URL | Task 6 |
| `ProgressiveGallery` with `IntersectionObserver` | Task 7 |
| Priority table 1–7 | Task 7 |
| `fairnessScore` starvation + under-refined bonuses | Task 7 |
| Concurrency cap `maxActiveDecoders` | Task 7 |
| `select`/`deselect` priority boost | Task 7 |
| Viewport exit: grace period then cancel | Task 7 |
| `destroy` cancels all active decodes | Task 7 |
| Demo gallery page | Task 9 |
| All tests pass workspace-wide | Task 10 |

All requirements covered. No placeholders. Types consistent across tasks (`SessionFactory` from `types.ts`, `JxlCacheBrowser` from `@casabio/jxl-cache`, `Tier` exported from `progressive-scheduler.ts`).
