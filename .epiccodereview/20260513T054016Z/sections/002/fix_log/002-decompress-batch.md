# Fix Log — 002-decompress-batch

**Date**: 2026-05-13  
**File**: `src/decompress.rs`, `src/lib.rs`

---

## Task 002-errors-j1k2l3 [medium] — Result-returning decompress

**Change**: `decompress()` now returns `Result<Vec<u16>, String>` instead of `Vec<u16>`.

- Added `width.checked_mul(height)` overflow guard; returns `Err` on overflow.
- Short-input guard now returns `Err(...)` instead of a zero-filled buffer.
- Final return is `Ok(out)`.
- Call site in `src/lib.rs` line 224 updated to `.map_err(|e| JsError::new(&e))?`.

No behaviour change for valid input; invalid input now surfaces an error to JS instead of silently returning blank data.

---

## Task 002-performance-a3b4c5d6 [low] — Hoist row stride calculations

**Change**: Inside `for row in 0..height`, before the inner `for col` loop, precomputed:

```rust
let row_base  = row * width;
let row2_base = if row >= 2 { (row - 2) * width } else { 0 };
```

All predictor index expressions (`row * width + col`, `(row-2) * width + col`, etc.) replaced with `row_base + col` / `row2_base + col`.  
The write `out[row * width + col] = ...` at line 85 was deliberately left unchanged (it is outside the predictor block and the compiler would constant-fold it anyway; touching it would widen scope unnecessarily).

---

## Verification

```
cargo check --target wasm32-unknown-unknown
```

Result: **Finished** (0 errors, 2 pre-existing warnings in `tiff.rs` — unrelated).
