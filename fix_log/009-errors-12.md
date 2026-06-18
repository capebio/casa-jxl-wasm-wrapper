# Task 009-errors-12
**Finding:** pushTask and framesTask run in parallel but a push() rejection only rejects pushTask — framesTask continues iterating a dead session causing a hang — packages/jxl-progressive/src/progressive-profile.ts:150-167
**Status:** done
**Tests before:** fail(pre-existing TS errors in other files)
**Tests after:** fail(same pre-existing TS errors; no new errors)

## Change
Wrapped the push loop in a try/catch inside pushTask. On any push error, `session.cancel()` is called (errors from cancel are swallowed) to terminate the session's frames() async generator so framesTask exits its loop and Promise.all resolves (or rejects) cleanly. Without this, a dead session that never closes its generator would cause framesTask to hang indefinitely after pushTask rejects.

## Diff
```diff
   const pushTask = (async () => {
     const total = jxlBytes.byteLength;
     let offset = 0;
+    try {
       while (offset < total) {
         if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
         const end = Math.min(offset + chunkSize, total);
         bytesPushed = end;
         await session.push(jxlBytes.slice(offset, end));
         onProgress?.(end, total);
         offset = end;
       }
       await session.close();
+    } catch (e) {
+      // Cancel the session so framesTask's frames() generator terminates
+      // rather than hanging indefinitely waiting for more frames.
+      await session.cancel().catch(() => { /* ignore cancel errors */ });
+      throw e;
+    }
   })();
```
