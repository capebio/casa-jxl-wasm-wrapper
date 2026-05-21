// jxl-worker-browser/src/wasm-loader.ts
// Loads the WASM module. Stub until T-WASM-BUILD lands.
// Real implementation must wire compileStreaming + IndexedDB compiled-module
// cache per spec Section 6.8.

// Minimal surface the codec handlers need from the WASM module.
// Expand to match jxl-wasm exports once T-WASM-BUILD lands.
export interface JxlModule {
  // Placeholder. The real type comes from jxl-wasm's generated .d.ts.
  // Using `unknown` here so TypeScript lets the handlers call it via cast.
  _isStub: true;
}

// BLOCKED: actual WASM artifact not yet available (T-WASM-BUILD pending).
// This stub always rejects so that handlers emit CapabilityMissing cleanly.
// Replace with real loader once jxl-wasm is built.
export async function loadWasmModule(wasmUrl: string): Promise<JxlModule> {
  // Real path (spec Section 6.8):
  //
  // 1. compileStreaming(fetch(wasmUrl))
  // 2. Persist compiled WebAssembly.Module in IndexedDB keyed by
  //    `${buildId}:${wasmSha}` from build-manifest.json
  // 3. On cache miss, fall back to step 1 and write result.
  //
  // For now: attempt to fetch the URL and fail with a clear message.
  const resp = await fetch(wasmUrl);
  if (!resp.ok) {
    throw new Error(
      `[jxl-worker-browser] WASM not available at ${wasmUrl} (${resp.status}). ` +
        "T-WASM-BUILD artifact required.",
    );
  }
  // Real instantiation happens here once the artifact exists.
  throw new Error(
    "[jxl-worker-browser] WASM stub: real module instantiation not implemented yet. " +
      "Awaiting T-WASM-BUILD.",
  );
}
