# Task 010-security-3

**Finding:** Level numeric fields (w, h, bytes, tileSize, cols, rows) have no upper-bound checks, enabling OOM via crafted manifest — packages/jxl-pyramid/src/manifest-validate.ts:85-101

**Status:** done

**Tests before:** 114 pass, 0 fail

**Tests after:** 114 pass, 0 fail

## Change

Added three safety constants (MAX_DIMENSION = 2^24, MAX_BYTES = 2^30, MAX_TILE_SIZE = 2^16) and applied upper-bound validation to all numeric fields in levels. Each field is now checked against the appropriate maximum after positivity validation, preventing crafted manifests from encoding OOM-causing dimensions. Also added cross-validation that cols/rows match the computed ceil(w/tileSize)/ceil(h/tileSize) values.

## Diff

```diff
 export const MANIFEST_SCHEMA_VERSION = 2;
 export const INDEX_SCHEMA_VERSION = 1;
 
+// Upper bounds for security/sanity checks
+const MAX_DIMENSION = 1 << 24; // 16777216 — matches libjxl JXTC header caps
+const MAX_BYTES = 1 << 30; // 1073741824 — 1 GiB safety cap
+const MAX_TILE_SIZE = 1 << 16; // 65536 — reasonable tile limit
+
 export class ManifestValidationError extends Error {
   ...
 }

   const w = requireNumber(o["w"], `${path}.w`);
   const h = requireNumber(o["h"], `${path}.h`);
   const bytes = requireNumber(o["bytes"], `${path}.bytes`);
   if (w <= 0) fail(`${path}.w`, `width must be positive, got ${w}`);
+  if (w > MAX_DIMENSION) fail(`${path}.w`, `width exceeds maximum ${MAX_DIMENSION}, got ${w}`);
   if (h <= 0) fail(`${path}.h`, `height must be positive, got ${h}`);
+  if (h > MAX_DIMENSION) fail(`${path}.h`, `height exceeds maximum ${MAX_DIMENSION}, got ${h}`);
   if (bytes <= 0) fail(`${path}.bytes`, `bytes must be positive, got ${bytes}`);
+  if (bytes > MAX_BYTES) fail(`${path}.bytes`, `bytes exceeds maximum ${MAX_BYTES}, got ${bytes}`);

   if (tiled) {
     if (o["tiling"] == null) fail(`${path}.tiling`, "required when tiled=true");
     const t = requireObject(o["tiling"], `${path}.tiling`);
-    level.tiling = {
-      tileSize: requireNumber(t["tileSize"], `${path}.tiling.tileSize`),
-      cols: requireNumber(t["cols"], `${path}.tiling.cols`),
-      rows: requireNumber(t["rows"], `${path}.tiling.rows`),
-    };
+    const tileSize = requireNumber(t["tileSize"], `${path}.tiling.tileSize`);
+    const cols = requireNumber(t["cols"], `${path}.tiling.cols`);
+    const rows = requireNumber(t["rows"], `${path}.tiling.rows`);
+    if (tileSize <= 0) fail(`${path}.tiling.tileSize`, `tileSize must be positive, got ${tileSize}`);
+    if (tileSize > MAX_TILE_SIZE) fail(`${path}.tiling.tileSize`, `tileSize exceeds maximum ${MAX_TILE_SIZE}, got ${tileSize}`);
+    if (cols <= 0) fail(`${path}.tiling.cols`, `cols must be positive, got ${cols}`);
+    if (cols > MAX_DIMENSION) fail(`${path}.tiling.cols`, `cols exceeds maximum ${MAX_DIMENSION}, got ${cols}`);
+    if (rows <= 0) fail(`${path}.tiling.rows`, `rows must be positive, got ${rows}`);
+    if (rows > MAX_DIMENSION) fail(`${path}.tiling.rows`, `rows exceeds maximum ${MAX_DIMENSION}, got ${rows}`);
+    if (cols !== Math.ceil(w / tileSize)) fail(`${path}.tiling.cols`, `cols ${cols} does not match ceil(${w}/${tileSize}) = ${Math.ceil(w / tileSize)}`);
+    if (rows !== Math.ceil(h / tileSize)) fail(`${path}.tiling.rows`, `rows ${rows} does not match ceil(${h}/${tileSize}) = ${Math.ceil(h / tileSize)}`);
+    level.tiling = {
+      tileSize,
+      cols,
+      rows,
+    };
   }
```
