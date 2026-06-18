# Task 016-errors-17
**Finding:** Diagnostic probe in loadWasmModule reads response on HEAD 405 but does not cancel or consume the body if cancel() itself throws — packages/jxl-worker-browser/src/wasm-loader.ts:215-218
**Status:** done
**Tests before:** skipped (pre-existing unrelated TypeScript errors in decode-handler.ts prevent test execution)
**Tests after:** skipped (same pre-existing errors)

## Change
Added try/catch error boundary around `resp.body?.cancel()` at lines 219-223 to prevent uncaught exceptions from the cancellation attempt. When HEAD returns 405, a fallback GET is issued. If cancellation of that response body throws an error, it is now caught and ignored rather than propagating. The probe is non-fatal per design (line 231), and ignoring cancellation errors keeps it that way.

## Diff
```diff
        if (resp.status === 405) {
+         resp = await fetchImpl(wasmUrl, { signal: ac.signal });
+         try {
+           await resp.body?.cancel();
+         } catch {
+           // Ignore cancellation errors on the fallback GET response body.
+         }
-         resp = await fetchImpl(wasmUrl, { signal: ac.signal }); await resp.body?.cancel();
        }
```
