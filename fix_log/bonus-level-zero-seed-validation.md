# Bonus: LevelZeroSeed Validation

**Finding:** Consistency fix across validateLevel and validateLevelZeroSeed — packages/jxl-pyramid/src/manifest-validate.ts:229-248

**Status:** done

**Tests before:** 114 pass, 0 fail

**Tests after:** 114 pass, 0 fail

## Change

Applied the same input validation rigor to `validateLevelZeroSeed` that was applied to `validateLevel`:
1. Added hexadecimal format check on contenthash
2. Added positivity checks for w, h
3. Added dimension upper-bound checks
4. Added bytes positivity and upper-bound checks

This ensures GalleryIndex l0 seeds are validated with the same security constraints as full pyramid levels, preventing similar OOM or cache-key confusion attacks at the index level.

## Diff

```diff
 function validateLevelZeroSeed(v: unknown, path: string): LevelZeroSeed {
   const o = requireObject(v, path);
   const contenthash = requireString(o["contenthash"], `${path}.contenthash`);
   if (contenthash.length === 0) fail(`${path}.contenthash`, "must not be empty");
+  if (!/^[a-fA-F0-9]+$/.test(contenthash)) fail(`${path}.contenthash`, `must be hexadecimal, got "${contenthash}"`);
   const w = requireNumber(o["w"], `${path}.w`);
   const h = requireNumber(o["h"], `${path}.h`);
+  if (w <= 0) fail(`${path}.w`, `width must be positive, got ${w}`);
+  if (w > MAX_DIMENSION) fail(`${path}.w`, `width exceeds maximum ${MAX_DIMENSION}, got ${w}`);
+  if (h <= 0) fail(`${path}.h`, `height must be positive, got ${h}`);
+  if (h > MAX_DIMENSION) fail(`${path}.h`, `height exceeds maximum ${MAX_DIMENSION}, got ${h}`);
   const result: LevelZeroSeed = { contenthash, w, h };
   if (o["bytes"] !== undefined) {
-    result.bytes = requireNumber(o["bytes"], `${path}.bytes`);
+    const bytes = requireNumber(o["bytes"], `${path}.bytes`);
+    if (bytes <= 0) fail(`${path}.bytes`, `bytes must be positive, got ${bytes}`);
+    if (bytes > MAX_BYTES) fail(`${path}.bytes`, `bytes exceeds maximum ${MAX_BYTES}, got ${bytes}`);
+    result.bytes = bytes;
   }
   return result;
 }
```
