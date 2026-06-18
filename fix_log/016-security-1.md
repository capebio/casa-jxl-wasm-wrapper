# Task 016-security-1
**Finding:** Caller-supplied workerUrl is passed to Worker() without origin or allowlist validation — packages/jxl-worker-browser/src/spawn.ts:34-38
**Status:** done
**Tests before:** pass(28/29) — 1 pre-existing failure in wasm-loader.test.ts unrelated to spawn.ts; tsc blocked by pre-existing errors in worker.ts/encode-handler.ts (in-progress working-tree changes)
**Tests after:** pass(4/4) spawn tests — same pre-existing tsc and wasm-loader failures; no new failures introduced

## Change
Added same-origin validation at the top of `spawnWorker()` before constructing the Worker. When `workerUrl` is explicitly provided and `location` is available (browser context), the URL is parsed and its origin compared to `location.origin`; a cross-origin URL rejects with a descriptive error. The check is entirely skipped when `typeof location === "undefined"` (Node.js test environment), so all existing tests pass unchanged. Invalid URLs that fail `new URL()` parsing are also rejected cleanly.

## Diff
```diff
--- a/packages/jxl-worker-browser/src/spawn.ts
+++ b/packages/jxl-worker-browser/src/spawn.ts
@@ -34,6 +34,20 @@ const DEFAULT_WORKER_URL = new URL("./worker.js", import.meta.url).href;
 export function spawnWorker(workerUrl?: string, opts: SpawnOptions = {}): Promise<WorkerHandle> {
+  if (workerUrl !== undefined && typeof location !== "undefined") {
+    try {
+      const parsed = new URL(workerUrl, location.href);
+      if (parsed.origin !== location.origin) {
+        return Promise.reject(
+          new Error(`[jxl-worker-browser] workerUrl must be same-origin (got ${parsed.origin})`),
+        );
+      }
+    } catch {
+      return Promise.reject(
+        new Error(`[jxl-worker-browser] workerUrl is not a valid URL: ${workerUrl}`),
+      );
+    }
+  }
   return new Promise<WorkerHandle>((resolve, reject) => {
     const url = workerUrl ?? DEFAULT_WORKER_URL;
     const worker = new Worker(url, { type: "module", name: opts.name ?? "jxl-worker" });
```
