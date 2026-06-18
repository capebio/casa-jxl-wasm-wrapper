# Task 010-contracts-013

**Finding:** Tiling descriptor cols/rows are not validated against w/h/tileSize — packages/jxl-pyramid/src/manifest-validate.ts:104-112

**Status:** done

**Tests before:** 114 pass, 0 fail

**Tests after:** 114 pass, 0 fail

## Change

Added cross-validation checks for tiling cols/rows. After extracting tileSize, cols, and rows, the validator now checks:
- cols === Math.ceil(w / tileSize)
- rows === Math.ceil(h / tileSize)

These checks ensure the tiling descriptor is internally consistent with the level dimensions and prevent misconfigurations where tile counts don't match actual grid requirements.

## Diff

```diff
   if (tiled) {
     if (o["tiling"] == null) fail(`${path}.tiling`, "required when tiled=true");
     const t = requireObject(o["tiling"], `${path}.tiling`);
     const tileSize = requireNumber(t["tileSize"], `${path}.tiling.tileSize`);
     const cols = requireNumber(t["cols"], `${path}.tiling.cols`);
     const rows = requireNumber(t["rows"], `${path}.tiling.rows`);
+    // ... bounds checks ...
+    if (cols !== Math.ceil(w / tileSize)) fail(`${path}.tiling.cols`, `cols ${cols} does not match ceil(${w}/${tileSize}) = ${Math.ceil(w / tileSize)}`);
+    if (rows !== Math.ceil(h / tileSize)) fail(`${path}.tiling.rows`, `rows ${rows} does not match ceil(${h}/${tileSize}) = ${Math.ceil(h / tileSize)}`);
     level.tiling = {
       tileSize,
       cols,
       rows,
     };
   }
```
