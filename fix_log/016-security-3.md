# Task 016-security-3
**Finding:** Raw wasmUrl (caller-supplied) reflected back in thrown error message — packages/jxl-worker-browser/src/wasm-loader.ts:227-233
**Status:** done
**Tests before:** skipped (pre-existing unrelated TypeScript errors in decode-handler.ts prevent test execution)
**Tests after:** skipped (same pre-existing errors)

## Change
Removed the raw `wasmUrl` parameter from the error message at line 236 to prevent information disclosure of potentially sensitive URLs (e.g., signed CDN URLs containing credentials). Changed message from `WASM not available at ${wasmUrl} (${probeStatus})` to `WASM not available (${probeStatus})`. The URL is only used for diagnostics; removing it from the error message prevents leakage while maintaining actionable error reporting via the status code.

## Diff
```diff
  if (probeStatus !== null && probeStatus !== 200) {
    throw new Error(
-     `[jxl-worker-browser] WASM not available at ${wasmUrl} (${probeStatus}). ` +
+     `[jxl-worker-browser] WASM not available (${probeStatus}). ` +
        "T-WASM-BUILD artifact required.",
    );
  }
```
