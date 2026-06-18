# Task 005-errors-2
**Finding:** createImageBitmap JXL probe has no timeout and can hang indefinitely — packages/jxl-capabilities/src/index.ts:194-204
**Status:** done
**Tests before:** pass (10)
**Tests after:** pass (10)

## Change
Added a local `withTimeout<T>(p, ms, fallback)` helper (Promise.race against a setTimeout that resolves to a fallback, with clearTimeout cleanup) and wrapped the `createImageBitmap(blob)` JXL probe in `withTimeout(..., 500, null)`. A null result (timeout) now short-circuits the probe to `false`, so a hung createImageBitmap can no longer permanently block the memoized `_capsPromise`. errors-8 (the shared utility) was deferred to an ADR, so this is the only `withTimeout` definition in the file — no collision.

## Diff
```diff
+/**
+ * Race a promise against a timeout, resolving to `fallback` if `ms` elapses first.
+ * Used to bound async capability probes so a single stalled probe cannot permanently
+ * block the memoized getCapabilities() result (errors-2 / errors-8).
+ */
+function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
+  let timer: ReturnType<typeof setTimeout>;
+  const timeout = new Promise<T>((resolve) => {
+    timer = setTimeout(() => resolve(fallback), ms);
+  });
+  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
+}
+
 /**
  * Probe for native JXL decoder support in the browser.
  */
 async function probeNativeJxl(): Promise<boolean> {
@@
   if (typeof createImageBitmap !== 'undefined' && typeof Blob !== 'undefined') {
     try {
       const blob = new Blob([minimalJxl], { type: 'image/jxl' });
-      const bm = await createImageBitmap(blob);
+      // errors-2: bound the probe — some environments may never resolve createImageBitmap for an
+      // unrecognised MIME type. A single hung probe would otherwise permanently block _capsPromise.
+      const bm = await withTimeout(createImageBitmap(blob), 500, null);
+      if (!bm) return false;
       const ok = bm.width === 1 && bm.height === 1; // CAP-5: reject decoders that return garbage for 1x1
       bm.close();
       return ok;
     } catch {
       return false;
     }
   }
   return false;
 }
```
