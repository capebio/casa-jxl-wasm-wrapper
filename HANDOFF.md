# Agent Handoff — raw-converter-wasm / raw-converter-tauri
**Date:** 2026-05-15  **Branch:** epiccodereview/20260515T000000Z

---

## Playwright / browser startup note

Read `PLAYWRIGHT-NOTES.md` before trying browser automation.

What was tried in this session:

- `chromium.launch()` and `chromium.launchPersistentContext()` with Playwright on Windows
- `chrome-headless-shell.exe` from `ms-playwright`
- `chrome.exe` from the installed Playwright Chromium bundle
- raw `node:child_process.spawn()` and `spawnSync()`
- `rtk proxy` with direct browser launch
- `rtk proxy` + PowerShell `Start-Process` + CDP attach
- `connectOverCDP()` to an already-running browser

What failed:

- Playwright spawn returned `EPERM` in this environment
- Chromium headless shell died with `mojo::platform_channel.cc:108` `Access is denied`
- Chrome hit Crashpad / ProcessSingleton access-denied errors under the default profile
- Creating a fresh Playwright page/context over CDP still failed because the browser closed immediately after attach

Use case status:

- Browser-driven verification remains blocked here
- Bun Test is useful for JS/Rust-adjacent unit tests and wrapper logic
- Bun Test is not a replacement for Playwright browser automation

---

## Repo layout

```
C:\foo\
  raw-converter-wasm\        # Browser WASM app (wasm-pack + worker pool)
  raw-converter-tauri\       # Native Windows app (Tauri 2)
    raw-pipeline\            # Shared Rust library (now used by BOTH projects)
    src-tauri\               # Tauri host (pipeline.rs, lib.rs, push.rs)
    vendor\                  # Fully vendored Rust crate source (DO NOT re-run cargo vendor)
```

The `web/` frontend lives in `raw-converter-wasm/web/` and is shared by both targets.

---

## What was implemented this session

### 1. raw-pipeline crate (`raw-converter-tauri/raw-pipeline/`)

| Change | File | Detail |
|--------|------|--------|
| `parallel` feature flag | `Cargo.toml` | `rayon` optional; `default = ["parallel"]`. WASM uses `default-features = false` → sequential. |
| MHC demosaic | `src/demosaic.rs` | `demosaic_rggb_mhc()` — Malvar-He-Cutler gradient-corrected Bayer interpolation. Better colour at edges vs bilinear `demosaic_rggb()`. ~2× slower per pixel. |
| ISO-gated NR | `src/pipeline.rs` | `apply_luminance_nr(rgb16, w, h, strength)` — 5-tap Gaussian blend. Strength: ISO≥6400→0.50, ≥3200→0.35, ≥1600→0.20, else 0.0. |
| 16-bit output | `src/pipeline.rs` | `process_16bit()` — same pipeline as `process()` but outputs `Vec<u16>` (for TIFF export). |
| `#[cfg(feature="parallel")]` guards | `src/demosaic.rs`, `src/pipeline.rs` | Rayon `par_chunks_mut` → `chunks_mut` when feature absent. |

### 2. Tauri backend (`raw-converter-tauri/src-tauri/`)

| Change | File | Detail |
|--------|------|--------|
| LRU cache | `src/lib.rs` | `AppState.rgb16_cache` + `AppState.lightbox_cache` → `Mutex<lru::LruCache<u64, _>>` capacity 25. Replaced DashMap clear-on-overflow-50. `lru = { version = "0.12", default-features = false }` (uses stdlib HashMap, avoids hashbrown version conflict in vendor). |
| memmap2 | `src/pipeline.rs` | `std::fs::read` → `memmap2::Mmap`. File stays mapped, OS pages in on demand. |
| MHC demosaic | `src/pipeline.rs` | `demosaic_rggb` → `demosaic_rggb_mhc`. |
| ISO NR | `src/pipeline.rs` | `apply_luminance_nr` called after demosaic, before cache inserts. |
| JXL base64 | `src/pipeline.rs` | `ProcessResult.jxl: Vec<u8>` annotated `#[serde(serialize_with = "serialize_bytes_base64")]`. Cuts IPC payload vs JSON array of u8 numbers. |
| `Rgb16State` Clone | `src/pipeline.rs` | Added `#[derive(Clone)]` — required by `lru::LruCache::get().cloned()`. |
| Vendor entries | `vendor/lru/`, `vendor/memmap2/` | Copied from bootstrap project. `libc` was already present (memmap2 dep). |

**Cargo.toml** (`src-tauri/Cargo.toml`) additions:
```toml
lru = { version = "0.12", default-features = false }
memmap2 = "0.9"
```
`dashmap` is still listed but `AppState` no longer uses it — it can be removed if push.rs doesn't use it either (check before removing).

### 3. WASM (`raw-converter-wasm/`)

| Change | File | Detail |
|--------|------|--------|
| Shared pipeline dep | `Cargo.toml` | `raw-pipeline = { path = "../raw-converter-tauri/raw-pipeline", default-features = false }` |
| Module imports | `src/lib.rs` | `mod decompress/demosaic/pipeline/tiff` → `use raw_pipeline::decompress/demosaic/pipeline/tiff` |
| MHC demosaic | `src/lib.rs` | `demosaic::demosaic_rggb` → `demosaic::demosaic_rggb_mhc` |
| ISO NR | `src/lib.rs` | `pipeline::apply_luminance_nr` called after demosaic, pre-downscale (both lb + thumb benefit) |

**Orphaned files** — `src/{decompress,demosaic,pipeline,tiff}.rs` are now dead (no `mod` declaration). Safe to delete; no urgency.

### 4. Frontend (`raw-converter-wasm/web/main.js`)

JXL decode guard at line 2479:
```javascript
// Before (broke with base64 string from Tauri):
const jxlBytes = result.jxl instanceof Uint8Array ? result.jxl : new Uint8Array(result.jxl);

// After (handles both Tauri base64 string and WASM Uint8Array):
const jxlBytes = typeof result.jxl === 'string'
    ? Uint8Array.from(atob(result.jxl), c => c.charCodeAt(0))
    : (result.jxl instanceof Uint8Array ? result.jxl : new Uint8Array(result.jxl));
```

---

## Build verification

```
# WASM — passes
cd C:\foo\raw-converter-wasm
cargo check --target wasm32-unknown-unknown

# Tauri — passes (exit 0)
cd C:\foo\raw-converter-tauri
cargo check
```

**DO NOT re-run `cargo vendor`** in raw-converter-tauri. The `vendor/jpegxl-sys/` has a manual Clang 22 patch that would be overwritten.

---

## Deferred (do not implement without deliberate decision)

| Item | Reason |
|------|--------|
| wasm-bindgen-rayon | Requires nightly Rust; COOP/COEP already set on serve.ts:9000 but nightly toolchain not configured |
| SIMD demosaic | Needs `target_feature = "+simd128"` wasm build; deferred |
| Bayer-level orientation | Apply orientation before demosaic to avoid interpolating across mirror boundaries; architectural change, risky |
| Dual-illuminant colour matrix | Olympus ORF has no CalibrationIlluminant TIFF tags; not applicable |
| OffscreenCanvas | Requires cross-worker canvas ownership transfer; architectural lift |
| WebGL tone mapping | Full pipeline refactor; deferred |

---

## Known state / gotchas

- **`dashmap` still in `src-tauri/Cargo.toml`** — verify `push.rs` doesn't use it before removing. If unused, remove + delete from vendor to clean up.
- **WASM orphaned files** — `src/{decompress,demosaic,pipeline,tiff}.rs` unused; can be deleted.
- **NR adds latency** — 5-tap blur on 20 MP rgb16 (~350 MB) takes ~200 ms sequential. In Tauri this runs on `spawn_blocking`. In WASM it blocks the worker thread — acceptable since NR only fires at ISO ≥ 1600.
- **MHC demosaic** — ~2× slower than bilinear. WASM single-threaded so noticeable on slow devices. Tauri parallel via Rayon so impact minimal.
- **lru without hashbrown** — uses `std::collections::HashMap`. Correct LRU semantics, slightly slower under high concurrency. Fine for this use case (Mutex-guarded, low contention).
- **vendor/hashbrown** — Tauri vendor has `hashbrown 0.17.1` (for dashmap). lru 0.12.5 needs 0.15 but we disabled that feature. No conflict.

---

## Memory rules (from prior session feedback)

- Trust camera WB_RBLevels unconditionally. Gray-world only when WB absent.
- Pipeline baselines (BASELINE_SAT/CONTRAST/EXP_EV) tuned to embedded JPEG. Raise carefully; apply globally.
- Don't claim colour fixed until user confirms on their viewer — RGB-mean parity ≠ perceptual match.
