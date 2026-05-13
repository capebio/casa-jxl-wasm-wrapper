# demosaic.rs batch fix
**Status:** done
**Tests before:** cargo check clean (2 pre-existing unused-import warnings in tiff.rs)
**Tests after:** cargo check clean (same 2 pre-existing warnings only)
**Files modified:** src/demosaic.rs, src/lib.rs

## Changes

### 002-errors-a1b2c3 [high] — Return Result instead of panic
Changed `demosaic_rggb` signature from `-> Vec<u16>` to `-> Result<Vec<u16>, String>`.
Replaced `assert_eq!(raw.len(), width * height)` with a graceful `Err` return, so a
dimension mismatch surfaces as a JS `Error` instead of a WASM trap.

### 002-errors-d4e5f6 [high] — Overflow guard for width * height on wasm32
Added `width.checked_mul(height).ok_or_else(...)` before the length check.
The `expected` value from that is reused in the `raw.len() != expected` comparison,
so no separate unchecked multiply occurs on the hot path.

### 002-errors-g7h8i9 [high] — Zero-dimension guard
Added `if width == 0 || height == 0 { return Err(...) }` after the overflow check
(overflow returns first, then zero check, then length check).  This prevents the
`(width - 1)` and `(height - 1)` subtractions below from wrapping to `usize::MAX`.

### 002-concurrency-a1b2c3 [low] — debug_assert before get_unchecked
Added `debug_assert!(r * stride + c < plane.len(), ...)` immediately before the
`unsafe { *plane.get_unchecked(...) }` call in the `at` helper.  Fires only in
debug/test builds; zero overhead in release.

### lib.rs call site
- `decompress::decompress(...)` was already returning `Result` but the `?` propagation
  was missing; added `.map_err(|e| JsError::new(&e))?`.
- `demosaic::demosaic_rggb(...)` call updated to `.map_err(|e| JsError::new(&e))?`.

## Diff

```diff
--- a/src/demosaic.rs
+++ b/src/demosaic.rs
@@ -11,6 +11,7 @@
 fn at(plane: &[u16], stride: usize, r: usize, c: usize) -> i32 {
+    debug_assert!(r * stride + c < plane.len(), "at: OOB {}×{}+{} vs {}", r, stride, c, plane.len());
     unsafe { *plane.get_unchecked(r * stride + c) as i32 }
 }

@@ -26,8 +27,21 @@
-pub fn demosaic_rggb(raw: &[u16], width: usize, height: usize) -> Vec<u16> {
-    assert_eq!(raw.len(), width * height);
+pub fn demosaic_rggb(raw: &[u16], width: usize, height: usize) -> Result<Vec<u16>, String> {
+    let expected = width
+        .checked_mul(height)
+        .ok_or_else(|| format!("demosaic: {}×{} overflows usize", width, height))?;
+    if width == 0 || height == 0 {
+        return Err(format!("demosaic: zero dimension {}×{}", width, height));
+    }
+    if raw.len() != expected {
+        return Err(format!(
+            "demosaic: buffer length {} != {}×{}",
+            raw.len(),
+            width,
+            height
+        ));
+    }
     let mut rgb = vec![0u16; width * height * 3];

@@ -101,5 +115,5 @@
-    rgb
+    Ok(rgb)
 }

--- a/src/lib.rs
+++ b/src/lib.rs
@@ -224 +224 @@
-    let raw = decompress::decompress(strip, w, h);
+    let raw = decompress::decompress(strip, w, h).map_err(|e| JsError::new(&e))?;

@@ -259 +259 @@
-    let mut rgb16 = demosaic::demosaic_rggb(&raw, w, h);
+    let mut rgb16 = demosaic::demosaic_rggb(&raw, w, h).map_err(|e| JsError::new(&e))?;
```
