# tiff.rs batch fix
**Status:** done
**Tests before/after:** `cargo check --target wasm32-unknown-unknown` — 3 pre-existing errors in `src/decompress.rs` and `src/lib.rs` (unrelated to this file); 0 errors introduced by these changes. 2 pre-existing warnings for unused `bail`/`anyhow` re-exports remain.
**Files modified:** src/tiff.rs

## Changes

### 002-logic-c9d0e1f2 [high] — Fixed
Replaced `val.to_le_bytes()` + endian-branch byte slicing with direct bit-shift extraction of the already-endian-decoded `val` u32. LE: `(val & 0xFFFF, val >> 16)`; BE: `(val >> 16, val & 0xFFFF)`.

### 002-logic-a3b4c5d6 [medium] — Fixed
`IfdEntry::as_u32` dtype==3 branch: changed `self.count == 1` to `self.count <= 2` so count==2 inline SHORTs are also read from the value field rather than treated as a file pointer.

### 002-errors-p7q8r9 / 002-security-c9d0e1f2 [medium] — Fixed
`as_ascii`: replaced `(self.value_off + self.count) as usize` with `start.checked_add(self.count as usize)` plus bounds check against `r.data.len()`, returning `String::new()` on overflow or OOB.

### 002-security-g3h4i5j6 / 002-logic-e7f8a9b0 [medium/low] — Fixed
All three sub-IFD dispatch calls in `parse_olympus_makernote` (tags 0x2010, 0x2020, 0x2040) replaced `base_off as u32 + val` with `(base_off as u32).checked_add(val).unwrap_or(u32::MAX)`.

### 002-errors-m4n5o6 [medium] — Fixed
`read_ifd`: capped `count` at 512 with `.min(512)` before `Vec::with_capacity` to bound allocation from untrusted IFD entry counts.

### 002-errors-s1t2u3 [medium] — Skipped (fixed by 002-logic-c9d0e1f2)
Same bug site as logic-c9d0e1f2. Already fixed above.

### 002-errors-e5f6g7 [low] — No change (false positive)
Silent `if let Ok(exif) = read_ifd(...)` pattern is intentional; partial EXIF is acceptable per design.

### 002-security-t5u6v7w8 [low] — Fixed by 002-errors-m4n5o6
The read_ifd allocation cap covers this.

## Diff

```diff
@@ IfdEntry::as_u32 dtype==3 branch
-                if self.count == 1 {
+                if self.count <= 2 {
+                    // Inline SHORT: count==1 or count==2 both fit in the 4-byte value field.

@@ IfdEntry::as_ascii
-        let bytes = r
-            .data
-            .get(self.value_off as usize..(self.value_off + self.count) as usize)
-            .unwrap_or(&[]);
-        String::from_utf8_lossy(bytes)
+        let start = self.value_off as usize;
+        let end = match start.checked_add(self.count as usize) {
+            Some(e) if e <= r.data.len() => e,
+            _ => return String::new(),
+        };
+        String::from_utf8_lossy(&r.data[start..end])

@@ read_ifd
-    let count = r.u16(off)? as usize;
+    let count = (r.u16(off)? as usize).min(512); // cap to prevent DoS from crafted files

@@ parse_olympus_makernote 0x2010
-                let _ = parse_equipment_subifd(&sub, base_off as u32 + val, base_off, info);
+                let sub_off_abs = (base_off as u32).checked_add(val).unwrap_or(u32::MAX);
+                let _ = parse_equipment_subifd(&sub, sub_off_abs, base_off, info);

@@ parse_olympus_makernote 0x2020
-                let _ = parse_camera_settings_subifd(&sub, base_off as u32 + val, base_off, info);
+                let sub_off_abs = (base_off as u32).checked_add(val).unwrap_or(u32::MAX);
+                let _ = parse_camera_settings_subifd(&sub, sub_off_abs, base_off, info);

@@ parse_olympus_makernote 0x2040
-                let _ = parse_image_processing_subifd(&sub, base_off as u32 + val, base_off, info);
+                let sub_off_abs = (base_off as u32).checked_add(val).unwrap_or(u32::MAX);
+                let _ = parse_image_processing_subifd(&sub, sub_off_abs, base_off, info);

@@ parse_image_processing_subifd inline cnt==2
-                let bytes = val.to_le_bytes();
-                let r_v = if r.le {
-                    u16::from_le_bytes([bytes[0], bytes[1]])
-                } else {
-                    u16::from_be_bytes([bytes[0], bytes[1]])
-                };
-                let b_v = if r.le {
-                    u16::from_le_bytes([bytes[2], bytes[3]])
-                } else {
-                    u16::from_be_bytes([bytes[2], bytes[3]])
-                };
+                // Inline: val was already decoded with correct endianness.
+                // LE: first SHORT in low 16 bits, second in high 16 bits.
+                // BE: first SHORT in high 16 bits, second in low 16 bits.
+                let (r_v, b_v) = if r.le {
+                    ((val & 0xFFFF) as u16, (val >> 16) as u16)
+                } else {
+                    ((val >> 16) as u16, (val & 0xFFFF) as u16)
+                };
```
