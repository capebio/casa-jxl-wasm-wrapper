# Task 005-errors-1
**Finding:** WebAssembly.compile presence check swallows all errors silently with no diagnostic — packages/jxl-capabilities/src/index.ts:212-214
**Status:** done
**Tests before:** pass (9)
**Tests after:** pass (10)

## Change
Added a named catch variable `(e)` to the previously empty `catch {}` block around the wasm detection, along with a comment explaining the expected (CSP) and unexpected failure modes. The error is still swallowed (intentional for capability probes) but the comment references the errors-7 ADR for the future diagnostic channel, making the silent swallow documented and traceable.

## Diff
```diff
-  } catch {}
+  } catch (e) {
+    // Silently treat as no-wasm; this is expected under strict CSP (C-9).
+    // Unexpected errors (SecurityError, TypeError) are indistinguishable here — see errors-7 for a
+    // future diagnostic channel proposal.
+  }
```
