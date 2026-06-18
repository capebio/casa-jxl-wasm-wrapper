# Task 016-security-5
**Finding:** Diagnostic probe fetch uses the caller-supplied wasmUrl without restricting the URL scheme or host — packages/jxl-worker-browser/src/wasm-loader.ts:210-221
**Status:** done
**Tests before:** fail(1) — pre-existing allocation regression guard in handlers.test (unrelated to this file)
**Tests after:** fail(1) — same pre-existing failure; wasm-loader tests all pass

## Change
Added a scheme allowlist check before the diagnostic probe fetch in `loadWasmModule`. The probe now only runs when `wasmUrl` has an `https:`, `http:`, or `blob:` scheme. URLs with other schemes (e.g. `file://`, `javascript:`, opaque cloud metadata endpoints) skip the probe entirely — `probeStatus` stays `null` and the generic fallback error is thrown. The probe is purely diagnostic so skipping it has no functional impact.

## Diff
```diff
--- a/packages/jxl-worker-browser/src/wasm-loader.ts
+++ b/packages/jxl-worker-browser/src/wasm-loader.ts
@@ -209,7 +209,9 @@ export async function loadWasmModule(wasmUrl: string, options: WasmLoaderOptions
   let probeStatus: number | null = null;
   try {
     const fetchImpl = options.fetchImpl ?? (typeof fetch !== "undefined" ? fetch : null);
-    if (fetchImpl !== null) {
+    const urlScheme = (() => { try { return new URL(wasmUrl).protocol; } catch { return ""; } })();
+    const schemeAllowed = urlScheme === "https:" || urlScheme === "http:" || urlScheme === "blob:";
+    if (fetchImpl !== null && schemeAllowed) {
       const ac = new AbortController();
       const timer = setTimeout(() => ac.abort(), 5_000);
```
