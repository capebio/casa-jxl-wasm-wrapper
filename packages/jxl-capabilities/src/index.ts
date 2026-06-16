export type Tier = "relaxed-simd-mt" | "simd-mt" | "simd" | "scalar";

let _cachedTier: Tier | undefined;
let _gpuAdapterPromise: Promise<boolean> | undefined;

export function _resetCache(): void {
  _cachedTier = undefined;
  _capsPromise = undefined;
  _gpuAdapterPromise = undefined;
}

function _isNode(): boolean {
  const proc = (globalThis as { process?: { versions?: { node?: string } } }).process;
  return !!proc?.versions?.node;
}

function _coi(): boolean {
  return typeof self !== "undefined" && !!(self as any).crossOriginIsolated;
}

export function canUseThreadedWasm(sharedArrayBuffer: boolean, crossOriginIsolated: boolean): boolean {
  return sharedArrayBuffer && crossOriginIsolated;
}

// Hoisted probe byte arrays (C-5): avoid re-allocation on repeated calls (even though now memoized at getCapabilities).
const PROBE_SIMD_BYTES = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b,
  0x03, 0x02, 0x01, 0x00,
  0x0a, 0x08, 0x01, 0x06, 0x00,
  0x41, 0x00, 0xfd, 0x0f, 0x0b,
]);

const PROBE_THREADS_BYTES = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
  0x03, 0x02, 0x01, 0x00,
  0x05, 0x03, 0x01, 0x03, 0x01,
  0x0a, 0x0b, 0x01, 0x09, 0x00,
  0x41, 0x00, 0xfe, 0x10, 0x02, 0x00, 0x1a, 0x0b,
]);

const PROBE_RELAXED_BYTES = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x07, 0x01, 0x60, 0x02, 0x7b, 0x7b, 0x01, 0x7b,
  0x03, 0x02, 0x01, 0x00,
  0x0a, 0x0b, 0x01, 0x09, 0x00,
  0x20, 0x00, 0x20, 0x01, 0xfd, 0x80, 0x02, 0x0b,
]);

// Legacy Wasm-EH (try/catch_all): () -> () body = try(void) catch_all end end (CAP-8)
const PROBE_EH_BYTES = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
  0x03, 0x02, 0x01, 0x00,
  0x0a, 0x08, 0x01, 0x06, 0x00,
  0x06, 0x40, 0x19, 0x0b, 0x0b,
]);

function _probeSimd(): boolean {
  try {
    return WebAssembly.validate(PROBE_SIMD_BYTES);
  } catch { return false; }
}

function _probeWasmThreads(): boolean {
  try {
    return WebAssembly.validate(PROBE_THREADS_BYTES);
  } catch { return false; }
}

function _probeRelaxedSimd(): boolean {
  try {
    return WebAssembly.validate(PROBE_RELAXED_BYTES);
  } catch { return false; }
}

function _probeWasmExceptions(): boolean {
  try {
    return WebAssembly.validate(PROBE_EH_BYTES);
  } catch { return false; }
}

/**
 * Detect the WebAssembly tier supported by the environment.
 * Note: Returns "scalar" both when WebAssembly lacks SIMD and when WebAssembly is entirely absent;
 * consumers that must distinguish should use getCapabilities().selectedWasmBuild ("none" when no WASM).
 */
export function detectTier(): Tier {
  if (_cachedTier !== undefined) return _cachedTier;
  let tier: Tier;
  if (typeof WebAssembly === "undefined") {
    tier = "scalar";
  } else {
    const hasSimd = _probeSimd();
    if (!hasSimd) {
      tier = "scalar";
    } else {
      const hasSab = typeof SharedArrayBuffer !== "undefined";
      const crossOriginIsolated = _coi();
      // Match jxl-wasm / worker tier pick: COI + SAB enable threaded builds; do not
      // require the wasm-threads validate probe (false on some Chrome builds that still run MT WASM).
      // Node has SAB unconditionally and no COI concept; browsers need COI for SAB to be usable. (CAP-2)
      const isBrowser = typeof window !== "undefined" || typeof self !== "undefined";
      const canDoMT = hasSab && (crossOriginIsolated || !isBrowser);
      if (canDoMT) {
        tier = _probeRelaxedSimd() ? "relaxed-simd-mt" : "simd-mt"; // (CAP-3 lazy check)
      } else {
        tier = "simd";
      }
    }
  }
  _cachedTier = tier;
  return tier;
}

/** Heuristic; thresholds untuned — benchmark before relying on it (CLAUDE.md rule). */
export function recommendedEffort(hwConcurrency?: number): 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 {
  const tier = detectTier();
  if (tier === "scalar") return 4;
  if (tier === "simd") return 6;
  const hwc = hwConcurrency ?? (typeof navigator !== "undefined" ? navigator.hardwareConcurrency ?? 0 : 0);
  return hwc > 0 && hwc <= 2 ? 6 : 7; // MT tier on a 2-core device: don't pay effort-7 (CAP-7)
}

/** Heuristic; thresholds untuned — benchmark before relying on it (CLAUDE.md rule). */
export function recommendedQualitySearch(hwConcurrency?: number): "full" | "fast" | "none" {
  const t = detectTier();
  if (t === "scalar") return "none";
  const hwc = hwConcurrency ?? (typeof navigator !== "undefined" ? navigator.hardwareConcurrency ?? 0 : 0);
  if (t === "simd" || (hwc > 0 && hwc <= 2)) return "fast";
  return "full";
}

export interface Capabilities {
  /**
   * WebAssembly support (WebAssembly.compile present).
   * Note (C-9): under a strict CSP without 'wasm-unsafe-eval', validate/compile may succeed
   * while instantiate still fails at runtime. We document the limitation rather than add
   * a costly async instantiate probe (cost > benefit).
   */
  wasm: boolean;
  wasmSimd: boolean;
  wasmRelaxedSimd: boolean;
  wasmThreads: boolean;
  crossOriginIsolated: boolean;
  sharedArrayBuffer: boolean;
  offscreenCanvas: boolean;
  imageBitmap: boolean;
  nativeJxlDecoder: boolean;
  selectedWasmBuild: Tier | "none";
  libjxlVersion: string;
  // Additive platform features (C-7)
  webgpu: boolean;
  webnn: boolean;
  hardwareConcurrency: number;
  deviceMemory: number | null;
  // Additive platform features (CAP-6 / CAP-8)
  imageDecoder: boolean;
  wasmExceptions: boolean;
}

/**
 * Probe for native JXL decoder support in the browser.
 */
async function probeNativeJxl(): Promise<boolean> {
  // CAP-6: WebCodecs ImageDecoder fast path check
  const ID = (globalThis as any).ImageDecoder;
  if (typeof ID?.isTypeSupported === "function") {
    try {
      if (await ID.isTypeSupported("image/jxl")) return true;
    } catch { /* fall through */ }
  }

  // Real minimal 1x1 JXL (standard container/codestream)
  const minimalJxl = new Uint8Array([
    0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a,
    0x00, 0x00, 0x00, 0x14, 0x4a, 0x58, 0x4c, 0x49, 0x10, 0x47, 0x47, 0x22,
    0xc5, 0x05, 0x21, 0x49, 0xaa, 0x16, 0xd4, 0x1a, 0x02, 0x5a, 0x33, 0x39,
    0x00, 0x00, 0x00, 0x2d, 0x4a, 0x58, 0x4c, 0x43, 0xff, 0x0a, 0x04, 0x00,
    0x60, 0x02, 0x20, 0x00, 0x00, 0x38, 0x10, 0x11, 0x04, 0x44, 0x06, 0x10,
    0x12, 0x10, 0x44, 0x14, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x80, 0x01,
    0x00, 0x01, 0x00, 0x04, 0x00, 0x00, 0x00, 0x46, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00
  ]);

  if (typeof createImageBitmap !== 'undefined' && typeof Blob !== 'undefined') {
    try {
      const blob = new Blob([minimalJxl], { type: 'image/jxl' });
      const bm = await createImageBitmap(blob);
      const ok = bm.width === 1 && bm.height === 1; // CAP-5: reject decoders that return garbage for 1x1
      bm.close();
      return ok;
    } catch {
      return false;
    }
  }
  return false;
}

let _capsPromise: Promise<Capabilities> | undefined;

export function getCapabilities(): Promise<Capabilities> {
  return (_capsPromise ??= computeCapabilities());
}

async function computeCapabilities(): Promise<Capabilities> {
  const isBrowser = typeof window !== 'undefined' || typeof self !== 'undefined';
  const isNode = _isNode();

  let wasm = false;
  try {
    wasm = typeof WebAssembly !== 'undefined' && !!WebAssembly.compile;
  } catch {}

  let wasmSimd = false;
  let wasmThreads = false;
  let wasmRelaxedSimd = false;
  let wasmExceptions = false;
  if (wasm) {
    // C-5: call the direct _probe* sync functions (wrappers deleted).
    wasmSimd = _probeSimd();
    wasmThreads = _probeWasmThreads();
    wasmRelaxedSimd = wasmSimd && _probeRelaxedSimd();
    wasmExceptions = _probeWasmExceptions();
  }

  const crossOriginIsolated = _coi();
  const sharedArrayBuffer = typeof SharedArrayBuffer !== 'undefined';
  const offscreenCanvas = typeof OffscreenCanvas !== 'undefined';
  const imageBitmap = typeof createImageBitmap !== 'undefined';
  const imageDecoder = typeof (globalThis as any).ImageDecoder !== "undefined";

  // C-7: cheap additive platform probes; every navigator access guarded
  const webgpu = typeof navigator !== "undefined" && !!(navigator as any)?.gpu;
  const webnn = typeof navigator !== "undefined" && !!(navigator as any)?.ml;
  const hardwareConcurrency = typeof navigator !== "undefined" ? (navigator.hardwareConcurrency ?? 0) : 0;
  const deviceMemory = typeof navigator !== "undefined" ? ((navigator as any).deviceMemory ?? null) : null;

  let nativeJxlDecoder = false;
  if (isNode) {
    try {
      // C-1: real name from packages/jxl-native/package.json
      // @ts-ignore
      await import('@casabio/jxl-native');
      nativeJxlDecoder = true;
    } catch { /* fall through to browser probe if also browser-ish */ }
  }
  if (!nativeJxlDecoder && isBrowser) {
    nativeJxlDecoder = await probeNativeJxl();
  }

  // C-3: derive selectedWasmBuild from detectTier (central policy).
  // detectTier() uses identical COI+SAB predicate for MT tiers. Matches old selectWasmBuild behavior for
  // all combos when wasm=true. "none" only when !wasm.
  const selectedWasmBuild: Capabilities["selectedWasmBuild"] = wasm ? detectTier() : "none";

  return {
    wasm,
    wasmSimd,
    wasmRelaxedSimd,
    wasmThreads,
    crossOriginIsolated,
    sharedArrayBuffer,
    offscreenCanvas,
    imageBitmap,
    nativeJxlDecoder,
    selectedWasmBuild,
    libjxlVersion: "unknown", // TODO(packages/jxl-wasm/scripts/build.mjs): emit consumable libjxl version const (build-manifest has commit/tag but no generated version.ts / export; C-6 requires build-script edit + approval)
    webgpu,
    webnn,
    hardwareConcurrency,
    deviceMemory,
    imageDecoder,
    wasmExceptions
  };
}

/** Lazy: navigator.gpu presence (caps.webgpu) ≠ usable adapter. Memoized. */
export function probeWebGpuAdapter(): Promise<boolean> {
  return (_gpuAdapterPromise ??= (async () => {
    try {
      const gpu = (navigator as any)?.gpu;
      if (!gpu) return false;
      return (await gpu.requestAdapter()) !== null;
    } catch { return false; }
  })());
}
