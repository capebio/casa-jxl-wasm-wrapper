# Fix Log — 002-lib-batch

**File**: `src/lib.rs`  
**cargo check**: PASS (0 errors, 2 pre-existing warnings in tiff.rs)

---

## [HIGH] 002-logic-a1b2c3d4 + 002-security-a1b2c3d4 — strip_end overflow
- Replaced usize addition with `.checked_add(...).ok_or_else(...)`.

## [HIGH] 002-contracts-a1b2c3 — take_* move-once pattern undocumented
- Added `// Transfers ownership; returns empty Vec<u8> on subsequent calls.` to
  `take_rgb`, `take_rgb16_lb`, `take_rgb16_thumb`.

## [HIGH] 002-contracts-d4e5f6 — downscale_rgb zero-dimension panic
- Added early-return guard: `if dst_w == 0 || dst_h == 0 { return Err(...) }`.
- Placed after the length check as specified.

## [MEDIUM] 002-errors-y7z8a9 + 002-security-k7l8m9n0 — downscale_rgb length overflow
- Replaced `sw * sh * 3` with `sw.checked_mul(sh).and_then(|n| n.checked_mul(3)).ok_or_else(...)`.

## [MEDIUM] 002-security-p1q2r3s4 + 002-contracts-p7q8r9 — apply_look missing length validation
- Added `expected_pixels` checked_mul guard and explicit length mismatch error.

## [MEDIUM] 002-contracts-m4n5o6 — apply_look fallback matrix undocumented
- Added `// Falls back to built-in CAM_TO_SRGB if caller passes wrong-length slice.`

## [MEDIUM] 002-contracts-j1k2l3 — wb_mode sentinel undocumented
- Added `// 0xFFFF = absent/unknown ...` comment above the field in the struct.

## [MEDIUM] 002-performance-e5f6a7b8 — downscale_rgb16_impl recomputes y bounds inside dx loop
- Hoisted `y0`/`y1` outside the `dx` loop.
- Added `row_base = y * sw` inside the `y` loop to avoid re-multiplying per `x`.
- Same optimisation applied to `downscale_rgb`.

## [MEDIUM] 002-performance-f6a7b8c9 — apply_look index-based byte unpacking
- Replaced `(0..n).map(|i| u16::from_le_bytes([...]))` with
  `rgb16_bytes.chunks_exact(2).map(|b| u16::from_le_bytes([b[0], b[1]]))`.

## [LOW] 002-contracts-e5f6g7 — rational 0/0 sentinel undocumented
- Added `// Rational fields use 0/0 as absent-sentinel ...` comment above the
  exposure/fnumber/focal_length fields in ProcessResult initialisation.

## [LOW] 002-contracts-v4w5x6 — rgb_to_rgba input contract undocumented
- Added `// Input must be a multiple of 3 bytes; trailing bytes are ignored.`

## [LOW] 002-performance-a7b8c9d0 — rgb_to_rgba per-element push
- Replaced index-based push loop with `chunks_exact(3)` +
  `extend_from_slice(&[r, g, b, 255])`.
