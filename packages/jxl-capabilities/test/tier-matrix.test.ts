import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// We import the module under test via dynamic reimport with query to bust module-level caches
// (_capsPromise, _cachedTier) so each matrix case sees fresh globals.

const globalAny = globalThis as typeof globalThis & {
  self?: { crossOriginIsolated?: boolean };
  WebAssembly?: any;
  SharedArrayBuffer?: any;
};

const originalWebAssembly = globalAny.WebAssembly;
const originalSelf = globalAny.self;
const originalSharedArrayBuffer = globalAny.SharedArrayBuffer;

function isThreadProbe(view: Uint8Array): boolean {
  return view.includes(0xfe) && view.includes(0x10);
}
function isRelaxedProbe(view: Uint8Array): boolean {
  return view.includes(0xfd) && view.includes(0x80) && view.includes(0x02);
}
function isSimdProbe(view: Uint8Array): boolean {
  return view.includes(0xfd) && view.includes(0x0f);
}

function installProbeStubs(options: {
  simd?: boolean;
  relaxed?: boolean;
  threads?: boolean;
}) {
  const { simd = true, relaxed = false, threads = false } = options;
  (globalAny.WebAssembly as any).validate = (bytes: BufferSource) => {
    const view = ArrayBuffer.isView(bytes)
      ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : new Uint8Array(bytes);
    if (isThreadProbe(view)) return threads;
    if (isRelaxedProbe(view)) return relaxed;
    if (isSimdProbe(view)) return simd;
    return false;
  };
}

function restoreProbes() {
  if (originalWebAssembly) {
    globalAny.WebAssembly = originalWebAssembly;
  }
}

function setCOI(value: boolean) {
  globalAny.self = { crossOriginIsolated: value } as any;
}

function setSAB(present: boolean) {
  if (present) {
    // minimal constructor stub is enough for typeof check
    (globalAny as any).SharedArrayBuffer = function () {} as any;
  } else {
    delete (globalAny as any).SharedArrayBuffer;
  }
}

function setNoWasm() {
  // Force the early scalar / no-wasm path in both detectTier and getCapabilities
  (globalAny as any).WebAssembly = undefined;
}

async function freshCapsAndTier() {
  const mod = await import(`../src/index.js?matrix=${Date.now()}`);
  if (mod && typeof mod._resetCache === "function") {
    mod._resetCache();
  }
  const tier = mod.detectTier();
  const caps = await mod.getCapabilities();
  return { mod, tier, caps };
}

describe("@casabio/jxl-capabilities tier matrix (X-1)", () => {
  beforeEach(async () => {
    // ensure clean starting point
    restoreProbes();
    globalAny.self = originalSelf;
    if (originalSharedArrayBuffer) {
      (globalAny as any).SharedArrayBuffer = originalSharedArrayBuffer;
    }
    try {
      const mod = await import("../src/index.js");
      if (mod && typeof mod._resetCache === "function") {
        mod._resetCache();
      }
    } catch {}
  });

  afterEach(() => {
    restoreProbes();
    globalAny.self = originalSelf;
    if (originalSharedArrayBuffer) {
      (globalAny as any).SharedArrayBuffer = originalSharedArrayBuffer;
    } else {
      delete (globalAny as any).SharedArrayBuffer;
    }
    // WebAssembly may have been nuked for !wasm case; restore
    if (originalWebAssembly) globalAny.WebAssembly = originalWebAssembly;
  });

  test("no WebAssembly → scalar + getCapabilities selectedWasmBuild=none + wasm=false", async () => {
    setNoWasm();
    const { tier, caps } = await freshCapsAndTier();
    assert.equal(tier, "scalar");
    assert.equal(caps.selectedWasmBuild, "none");
    assert.equal(caps.wasm, false);
    assert.equal(caps.wasmSimd, false);
    assert.equal(caps.wasmRelaxedSimd, false);
  });

  test("wasm + !simd probe → scalar (no MT even if sab+coi)", async () => {
    installProbeStubs({ simd: false, relaxed: false, threads: false });
    setSAB(true);
    setCOI(true);
    const { tier, caps } = await freshCapsAndTier();
    assert.equal(tier, "scalar");
    assert.equal(caps.selectedWasmBuild, "scalar");
    assert.equal(caps.wasm, true);
    assert.equal(caps.wasmSimd, false);
  });

  test("wasm + simd + !(sab && coi) → simd (even with relaxed probe true)", async () => {
    installProbeStubs({ simd: true, relaxed: true, threads: false });
    setSAB(true);
    setCOI(false); // missing one half of the pair
    const { tier, caps } = await freshCapsAndTier();
    assert.equal(tier, "simd");
    assert.equal(caps.selectedWasmBuild, "simd");
    assert.equal(caps.wasmSimd, true);
    assert.equal(caps.wasmRelaxedSimd, true); // raw flag reports the probe
    // but tier decision correctly refused MT
  });

  test("wasm + simd + sab + coi + !relaxed → simd-mt", async () => {
    installProbeStubs({ simd: true, relaxed: false, threads: false });
    setSAB(true);
    setCOI(true);
    const { tier, caps } = await freshCapsAndTier();
    assert.equal(tier, "simd-mt");
    assert.equal(caps.selectedWasmBuild, "simd-mt");
    assert.equal(caps.wasmRelaxedSimd, false);
    // canUseThreadedWasm (new 2-arg form) agrees with decision
    assert.equal(caps.sharedArrayBuffer && caps.crossOriginIsolated, true);
  });

  test("wasm + simd + sab + coi + relaxed → relaxed-simd-mt", async () => {
    installProbeStubs({ simd: true, relaxed: true, threads: true }); // threads probe value irrelevant to tier
    setSAB(true);
    setCOI(true);
    const { tier, caps } = await freshCapsAndTier();
    assert.equal(tier, "relaxed-simd-mt");
    assert.equal(caps.selectedWasmBuild, "relaxed-simd-mt");
    assert.equal(caps.wasmRelaxedSimd, true);
  });

  test("memoization: second getCapabilities returns same promise, no re-probe side effects", async () => {
    installProbeStubs({ simd: true, relaxed: false });
    setSAB(false);
    setCOI(false);
    const mod = (await import(`../src/index.js?memo=${Date.now()}`));
    const p1 = mod.getCapabilities();
    const p2 = mod.getCapabilities();
    assert.strictEqual(p1, p2, "memoized promise identity");
    const caps = await p1;
    assert.equal(caps.selectedWasmBuild, "simd");
  });

  test("canUseThreadedWasm (export) matches sab && coi used by tier logic", async () => {
    // after C-4: 2-arg form; exercised via fresh module to match other cases
    const mod = await import(`../src/index.js?canuse=${Date.now()}`);
    assert.equal(mod.canUseThreadedWasm(true, true), true);
    assert.equal(mod.canUseThreadedWasm(false, true), false);
    assert.equal(mod.canUseThreadedWasm(true, false), false);
  });
});
