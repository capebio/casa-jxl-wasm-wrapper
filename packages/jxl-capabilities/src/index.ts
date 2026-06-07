export type Tier = "relaxed-simd-mt" | "simd-mt" | "simd" | "scalar";

let _cachedTier: Tier | undefined;

export function canUseThreadedWasm(wasmThreads: boolean, sharedArrayBuffer: boolean, crossOriginIsolated: boolean): boolean {
  return wasmThreads && sharedArrayBuffer && crossOriginIsolated;
}

function _probeSimd(): boolean {
  try {
    return WebAssembly.validate(new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b,
      0x03, 0x02, 0x01, 0x00,
      0x0a, 0x08, 0x01, 0x06, 0x00,
      0x41, 0x00, 0xfd, 0x0f, 0x0b,
    ]));
  } catch { return false; }
}

function _probeWasmThreads(): boolean {
  try {
    return WebAssembly.validate(new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
      0x03, 0x02, 0x01, 0x00,
      0x05, 0x03, 0x01, 0x03, 0x01,
      0x0a, 0x0b, 0x01, 0x09, 0x00,
      0x41, 0x00, 0xfe, 0x10, 0x02, 0x00, 0x1a, 0x0b,
    ]));
  } catch { return false; }
}

function _probeRelaxedSimd(): boolean {
  try {
    return WebAssembly.validate(new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      0x01, 0x07, 0x01, 0x60, 0x02, 0x7b, 0x7b, 0x01, 0x7b,
      0x03, 0x02, 0x01, 0x00,
      0x0a, 0x0b, 0x01, 0x09, 0x00,
      0x20, 0x00, 0x20, 0x01, 0xfd, 0x80, 0x02, 0x0b,
    ]));
  } catch { return false; }
}

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
      const crossOriginIsolated = typeof self !== "undefined" && !!(self as any).crossOriginIsolated;
      // Match jxl-wasm / worker tier pick: COI + SAB enable threaded builds; do not
      // require the wasm-threads validate probe (false on some Chrome builds that still run MT WASM).
      const canDoMT = hasSab && crossOriginIsolated;
      const hasRelaxedSimd = _probeRelaxedSimd();
      if (canDoMT && hasRelaxedSimd) tier = "relaxed-simd-mt";
      else if (canDoMT) tier = "simd-mt";
      else tier = "simd";
    }
  }
  _cachedTier = tier;
  return tier;
}

export function recommendedEffort(): 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 {
  const tier = detectTier();
  if (tier === "scalar") return 4;
  if (tier === "simd") return 6;
  return 7;
}

export interface Capabilities {
  wasm: boolean;
  wasmSimd: boolean;
  wasmRelaxedSimd: boolean;
  wasmThreads: boolean;
  crossOriginIsolated: boolean;
  sharedArrayBuffer: boolean;
  offscreenCanvas: boolean;
  imageBitmap: boolean;
  nativeJxlDecoder: boolean;
  selectedWasmBuild: "relaxed-simd-mt" | "simd-mt" | "simd" | "scalar" | "none";
  libjxlVersion: string;
}

async function probeRelaxedSimd(): Promise<boolean> {
  return _probeRelaxedSimd();
}

async function probeWasmSimd(): Promise<boolean> {
  return _probeSimd();
}

async function probeWasmThreads(): Promise<boolean> {
  return _probeWasmThreads();
}

function selectWasmBuild(
  wasm: boolean,
  wasmSimd: boolean,
  wasmThreads: boolean,
  sharedArrayBuffer: boolean,
  crossOriginIsolated: boolean,
  wasmRelaxedSimd: boolean,
): Capabilities["selectedWasmBuild"] {
  if (!wasm) return "none";
  const canDoMT = sharedArrayBuffer && crossOriginIsolated;
  if (canDoMT && wasmRelaxedSimd) return "relaxed-simd-mt";
  if (canDoMT && wasmSimd) return "simd-mt";
  if (wasmSimd) return "simd";
  return "scalar";
}

/**
 * Probe for native JXL decoder support in the browser.
 */
async function probeNativeJxl(): Promise<boolean> {
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
      bm.close();
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export async function getCapabilities(): Promise<Capabilities> {
  const isBrowser = typeof window !== 'undefined' || typeof self !== 'undefined';
  const proc = (globalThis as { process?: { versions?: { node?: string } } }).process;
  const isNode = !!proc?.versions?.node;

  let wasm = false;
  try {
    wasm = typeof WebAssembly !== 'undefined' && !!WebAssembly.compile;
  } catch {}

  const [wasmSimd, wasmThreads] = wasm
    ? await Promise.all([probeWasmSimd(), probeWasmThreads()])
    : [false, false] as const;

  const wasmRelaxedSimd = wasmSimd && await probeRelaxedSimd();

  const crossOriginIsolated = typeof self !== 'undefined' && !!(self as any).crossOriginIsolated;
  const sharedArrayBuffer = typeof SharedArrayBuffer !== 'undefined';
  const offscreenCanvas = typeof OffscreenCanvas !== 'undefined';
  const imageBitmap = typeof createImageBitmap !== 'undefined';

  let nativeJxlDecoder = false;
  if (isBrowser) {
    nativeJxlDecoder = await probeNativeJxl();
  } else if (isNode) {
    try {
      // @ts-ignore
      await import('jxl-native');
      nativeJxlDecoder = true;
    } catch {
      nativeJxlDecoder = false;
    }
  }

  const selectedWasmBuild = selectWasmBuild(wasm, wasmSimd, wasmThreads, sharedArrayBuffer, crossOriginIsolated, wasmRelaxedSimd);

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
    libjxlVersion: "0.10.2" // Placeholder, should be provided by build manifest ideally
  };
}
