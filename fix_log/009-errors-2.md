# Task 009-errors-2
**Finding:** fetchAndCacheManifest bare catch swallows all errors including ManifestValidationError, returns null instead of propagating — packages/jxl-progressive/src/progressive-scheduler.ts:727-740
**Status:** done
**Tests before:** fail(pre-existing)
**Tests after:** fail(2 pre-existing TS2412 only)
## Change
Changed the bare `catch { return null; }` to `catch (e) { if (aborted) return null; throw e; }`. Abort and timeout errors return null (non-fatal); all other errors (ManifestValidationError, network errors, JSON parse failures) are rethrown so callers can distinguish permanent from transient failures and dispatch onError.
## Diff
```diff
-    } catch {
-      return null;
-    }
+    } catch (e) {
+      if (signal?.aborted || timeoutController.signal.aborted) return null;
+      throw e;
+    }
```
