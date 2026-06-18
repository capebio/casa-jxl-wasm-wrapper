# Task 005-errors-4
**Finding:** Dynamic import of @casabio/jxl-native swallows all errors including non-ModuleNotFound ones — packages/jxl-capabilities/src/index.ts:241-248
**Status:** done
**Tests before:** pass (9)
**Tests after:** pass (10)

## Change
Changed the bare `catch {}` to a typed `catch (e: any)` that checks the error code. Only `ERR_MODULE_NOT_FOUND` (Node ESM) and `MODULE_NOT_FOUND` (CommonJS) are swallowed as expected "package not installed" failures. All other errors (SyntaxError, ABI mismatch, I/O failure) are re-thrown so they surface to the caller rather than silently setting `nativeJxlDecoder = false`.

## Diff
```diff
-    } catch { /* fall through to browser probe if also browser-ish */ }
+    } catch (e: any) {
+      // Only swallow "package not installed" errors. Other failures (SyntaxError, ABI mismatch, I/O)
+      // indicate a broken installation and should surface — re-throw them.
+      const code = e?.code ?? "";
+      if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") throw e;
+      /* fall through to browser probe if also browser-ish */
+    }
```
