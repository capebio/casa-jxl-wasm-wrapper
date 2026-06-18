# Task 010-security-1
**Finding:** Unvalidated opaque metadata object passed through verbatim from untrusted manifest JSON — packages/jxl-pyramid/src/manifest-validate.ts:196
**Status:** done
**Tests before:** pass (114)
**Tests after:** pass (114)

## Change
Added `sanitizeOpaqueObject` helper that enforces depth cap (MAX_OPAQUE_DEPTH=4), key-count cap (MAX_OPAQUE_KEYS=64), and key-length cap (MAX_OPAQUE_KEY_LENGTH=128), copying values into a null-prototype object to prevent prototype pollution. Applied to `result.metadata` assignment at line 196 (now via the helper).

## Diff
```diff
+// Opaque-dict sanitization caps
+const MAX_OPAQUE_KEYS = 64;
+const MAX_OPAQUE_DEPTH = 4;
+const MAX_OPAQUE_KEY_LENGTH = 128;
+
+function sanitizeOpaqueObject(v: Record<string, unknown>, path: string, depth = 0): Record<string, unknown> {
+  if (depth > MAX_OPAQUE_DEPTH) fail(path, `opaque object exceeds maximum nesting depth ${MAX_OPAQUE_DEPTH}`);
+  const keys = Object.keys(v);
+  if (keys.length > MAX_OPAQUE_KEYS) fail(path, `opaque object exceeds maximum key count ${MAX_OPAQUE_KEYS}, got ${keys.length}`);
+  const out: Record<string, unknown> = Object.create(null);
+  for (const k of keys) {
+    if (k.length > MAX_OPAQUE_KEY_LENGTH) fail(path, `key "${k.slice(0, 32)}…" exceeds maximum length ${MAX_OPAQUE_KEY_LENGTH}`);
+    const child = v[k];
+    if (child !== null && typeof child === "object" && !Array.isArray(child)) {
+      out[k] = sanitizeOpaqueObject(child as Record<string, unknown>, `${path}.${k}`, depth + 1);
+    } else {
+      out[k] = child;
+    }
+  }
+  return out;
+}

-  if (o["metadata"] !== undefined) { requireObject(o["metadata"], "manifest.metadata"); result.metadata = o["metadata"] as Record<string, unknown>; }
+  if (o["metadata"] !== undefined) { result.metadata = sanitizeOpaqueObject(requireObject(o["metadata"], "manifest.metadata"), "manifest.metadata"); }
```
