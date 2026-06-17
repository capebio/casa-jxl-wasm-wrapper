# HANDOFF — BSD-clean own-FFI JXL codec (replace GPL `jpegxl-rs`/`jpegxl-sys`/`jpegxl-src`)

**Date:** 2026-06-17
**Status:** Design approved; licensing foundation corrected; ready to implement own FFI.
**Companion spec:** `docs/superpowers/specs/2026-06-17-bsd-jxl-encoder-design.md`
(spec's encoder *design* still valid; its *foundation* changed — see "Correction" below).

---

## TL;DR for whoever picks this up

We are removing GPL-3.0 from the native JXL path. The encoder **design** (one owned `Encoder`, `Frame<Sample>`, typed options + escape hatch, all sample types, planar extra channels) is approved and unchanged. What changed: we cannot reuse **any** of the vendored Rust crates — they are **all GPL**. We will hand-roll our own FFI (`bindgen`) against the **BSD libjxl C headers already in `external/libjxl`**, link BSD libjxl ourselves, and drop all three GPL crates. This covers **encode AND decode**.

**De-risk first:** before any real code, prove the link+bindgen toolchain with a one-function smoke test (`JxlDecoderVersion()`). If that links and prints, the rest is mechanical.

---

## Correction (why the foundation changed)

Earlier guidance ("`jpegxl-sys` is BSD-3, keep it") was **wrong**. Verified:

- `vendor/jpegxl-sys/Cargo.toml`: `license = "GPL-3.0-or-later"`
- `vendor/jpegxl-rs/Cargo.toml`: `license = "GPL-3.0-or-later"`
- `jpegxl-src` (libjxl build crate): GPL-3 too.
- GPL-3 headers on every source file; `COPYING` = full GPL-3; "Copyright (C) 2020 Inflation".
- No `[patch]` redirect — crates.io resolves the same GPL 0.12.1 / 0.14.

So the **entire Rust binding stack is GPL-3.0-or-later**. Only **libjxl itself (C++)** is BSD-3. Dropping `jpegxl-rs` while keeping `jpegxl-sys` removes **zero** GPL. `jxl_lowlevel.rs` (decode) and `encode_rgba4_sys` both sit on GPL `jpegxl-sys` — neither is clean.

**Decision (user, 2026-06-17):** implement our own FFI. Distribution model that makes this matter: the converter ships to users (browser/desktop) → GPL would trigger on distribution.

---

## Clean-room legal rules (do not violate)

- ✅ Derive FFI from **BSD libjxl C headers** (`external/libjxl/lib/include/jxl/*.h`). `bindgen` output from BSD headers = BSD-clean.
- ✅ Re-declare C structs/enums (`JxlBasicInfo`, `JxlPixelFormat`, …) — they are ABI/interface from the BSD headers, not copyrightable expression.
- ✅ Reimplement the API-dictated call sequences (Create→SetBasicInfo→AddFrame→ProcessOutput-drain) — dictated by libjxl, functional not creative.
- ❌ Do **not** copy `jpegxl-sys`/`jpegxl-rs` Rust source — not their module layout transcribed, not their comments, not their helper abstractions lifted verbatim. Build the safe layer fresh from the design spec.
- ❌ Do not just delete GPL headers and reuse the code — that's still GPL + a notices violation (established earlier in the conversation).

---

## Target architecture

```
crates/jxl-ffi/              ← NEW internal crate. Our license (e.g. MIT/Apache or proprietary).
  build.rs                     - locate libjxl via DEP_JXL_PATH (already in .cargo/config.toml)
                               - build OR link prebuilt BSD libjxl (+ deps)
                               - run bindgen on external/libjxl/lib/include/jxl/*.h → OUT_DIR/bindings.rs
  src/lib.rs                   - include!(concat!(env!("OUT_DIR"), "/bindings.rs"));  (raw extern "C")

crates/raw-pipeline/src/jxl_encode.rs   ← NEW safe layer (the approved spec design)
  Encoder / Frame<S> / Sample / EncodeOptions / Rate / FrameSettingId / ExtraChannel
  sits on jxl-ffi, NOT on jpegxl-sys

crates/raw-pipeline/src/jxl_decode.rs   ← decode safe layer (port jxl_lowlevel.rs onto jxl-ffi)
```

Why a separate `jxl-ffi` crate (not a module): isolates `build.rs` + `bindgen` + link config in one place; keeps `raw-pipeline` free of build-script complexity; one spot owns the libjxl link.

---

## Scope (bigger than the original spec)

1. **`jxl-ffi` crate** — build.rs + bindgen + link (the hard/unknown part — do first).
2. **Encode safe layer** — `jxl_encode.rs` per the spec design.
3. **Decode safe layer** — port `jxl_lowlevel.rs` (currently GPL `jpegxl-sys`) onto `jxl-ffi`.
4. **Rewire 3 call sites** — `casabio_encode.rs`, `jxl_lowlevel.rs`→`jxl_decode.rs`, `raw_decode_bench.rs`.
5. **Drop GPL** — remove `jpegxl-rs`/`jpegxl-sys` deps (root `Cargo.toml:39,42`; `crates/raw-pipeline/Cargo.toml:20,30`); delete `vendor/jpegxl-rs`, `vendor/jpegxl-sys`, `vendor/jpegxl-src`.
6. **Parity gate** — byte/tolerance match vs current output before declaring done.

---

## Step-by-step (start here after reboot)

### Phase 0 — Link smoke test (DE-RISK; do not skip)
1. `cargo new --lib crates/jxl-ffi`. Add `bindgen` + `cmake` (or `cc`) as build-deps.
2. `build.rs`: read `DEP_JXL_PATH` env (set in `.cargo/config.toml`), point bindgen at `$DEP_JXL_PATH/lib/include/jxl/decode.h`, emit `println!("cargo:rustc-link-lib=...")` + `cargo:rustc-link-search=...` for the built libjxl static libs.
3. Confirm whether `external/libjxl` is **already built** (look for `*.lib`/`*.a` under a build dir). If not, build it — reuse the known-good path: cmake with `/O2 /Ob2` (see memory: the 0.11 "regression" was an unoptimized build; CMakeLists needs `add_compile_options(/O2 /Ob2)` under ClangCL). Static libs needed: `jxl`, `jxl_threads`, `jxl_cms`, plus third-party `brotli*`, `hwy`, `skcms`/`lcms` — match what `jpegxl-sys` linked (inspect `crates/raw-pipeline/target/debug/build/jpegxl-sys-*/out/`).
4. Expose one fn and a test:
   ```rust
   // smoke test
   #[test] fn links() { unsafe { assert!(crate::JxlDecoderVersion() > 0); } }
   ```
5. `cargo test -p jxl-ffi`. **Green = toolchain proven.** This is the whole risk; everything after is mechanical.

### Phase 1 — Encode safe layer (`jxl_encode.rs`)
Follow the spec design exactly. TDD per type: u8 → u16 → f16 → f32, each round-trips (encode→decode→compare). Then RGB/RGBA, then ≥1 planar extra channel, then error-path-reusability, then lossless bit-exact. Bake in: reset-on-every-error, `Rate::Lossless` (no distance call), alpha XOR (interleaved vs planar), extra-channel-init before first frame.

### Phase 2 — Decode safe layer (`jxl_decode.rs`)
Port `jxl_lowlevel.rs`'s decode (one-shot + progressive/ROI if used) onto `jxl-ffi`. Keep behavior identical; it's a backend swap.

### Phase 3 — Rewire call sites
- `casabio_encode.rs`: replace `jpegxl_rs::` + `transmute(13/14/15/19)` knob hacks with `jxl_encode`. Fold in/delete dead `encode_rgba4_sys`.
- `raw_decode_bench.rs:131-143`: `decoder_builder().decode()` → `jxl_decode`.
- Keep `tests/cross_encoder.rs` as the parity gate; swap backend.

### Phase 4 — Drop GPL + verify
- Remove deps (4 Cargo.toml lines above) + the `jxl-encode`/`jxl-lowlevel` feature wiring that referenced GPL crates; refresh `Cargo.lock`.
- `rm -r vendor/jpegxl-rs vendor/jpegxl-sys vendor/jpegxl-src`.
- `cargo build` + `cargo test` green (native, relevant features).
- Parity: `cross_encoder.rs`, `raw_decode_bench.rs`, `StandardMultifileTest.mjs` match prior output (byte-identical at same settings, or stated perceptual tolerance if libjxl version differs).

---

## libjxl symbols needed (from BSD headers — bindgen will surface all; these are the ones in use)

**Encode** (`encode.h`): `JxlEncoderCreate/Destroy/Reset`, `JxlEncoderFrameSettingsCreate`, `JxlEncoderSetParallelRunner`(future), `JxlEncoderInitBasicInfo`, `JxlEncoderSetBasicInfo`, `JxlEncoderInitExtraChannelInfo`, `JxlEncoderSetExtraChannelInfo`, `JxlEncoderSetExtraChannelBuffer`, `JxlEncoderSetFrameLossless`, `JxlEncoderSetFrameDistance`, `JxlEncoderDistanceFromQuality`, `JxlEncoderFrameSettingsSetOption`, `JxlEncoderSetColorEncoding`, `JxlColorEncodingSetToSRGB/SetToLinearSRGB`, `JxlEncoderUseContainer`, `JxlEncoderAddImageFrame`, `JxlEncoderCloseInput`, `JxlEncoderProcessOutput`, `JxlEncoderGetError`. Enums/structs: `JxlEncoderStatus`, `JxlEncoderError`, `JxlEncoderFrameSettingId`, `JxlBasicInfo`, `JxlPixelFormat`, `JxlExtraChannelInfo`, `JxlExtraChannelType`, `JxlDataType`, `JxlEndianness`, `JxlBool`.

**Decode** (`decode.h`): `JxlDecoderCreate/Destroy/Reset`, `JxlDecoderVersion`, `JxlSignatureCheck`, `JxlDecoderSubscribeEvents`, `JxlDecoderSetParallelRunner`, `JxlDecoderProcessInput`, `JxlDecoderSetInput`, `JxlDecoderCloseInput`, `JxlDecoderGetBasicInfo`, `JxlDecoderImageOutBufferSize`, `JxlDecoderSetImageOutBuffer`, `JxlDecoderGetColorAsICCProfile`/`GetICCProfileSize` (if ICC needed), plus progressive/ROI (`JxlDecoderSetProgressiveDetail`, `JxlDecoderFlushImage`, `JxlDecoderSetCropEnabled`) only if `jxl_lowlevel.rs` uses them — check before porting.

**Frame-setting IDs to formalize (kills `transmute`):** `GROUP_ORDER=13`, `GROUP_ORDER_CENTER_X=14`, `GROUP_ORDER_CENTER_Y=15`, `PROGRESSIVE_DC=19`, `EFFORT`, `DECODING_SPEED`. bindgen generates the full `JxlEncoderFrameSettingId` enum — use it, don't hardcode.

---

## Build / link specifics

- `DEP_JXL_PATH = C:/Foo/raw-converter-wasm/external/libjxl` already set in `.cargo/config.toml`.
- Headers confirmed present: `external/libjxl/lib/include/jxl/` (encode.h 70KB, decode.h 70KB, types.h, codestream_header.h, color_encoding.h, thread_parallel_runner.h, …).
- Toolchain (from root CLAUDE.md): wasm-pack, cmake 4.3.2, LLVM/clang-cl at `C:\Program Files\LLVM\bin`; MSVC via `build-msvc.ps1`. Build native with MSVC toolchain for representative numbers.
- WASM note: this FFI is **native-only** (target-guard `cfg(not(target_arch="wasm32"))`, same as today). WASM JXL path stays on `web/pkg` / `bridge.cpp` (separate, already BSD over libjxl).
- Inspect `crates/raw-pipeline/target/debug/build/jpegxl-sys-*/out/` to see exactly which static libs + link flags the GPL crate used — replicate that link line.

---

## Open questions / risks

1. **Linking is the only real risk.** libjxl's static deps (highway, brotli, skcms) must all be found. Phase 0 smoke test exists to surface this immediately.
2. **Is `external/libjxl` already built?** If yes, link prebuilt. If no, build once via cmake (`/O2 /Ob2`). Decide in Phase 0.
3. **libjxl version skew.** `external/libjxl` = v0.11.2 (per memory); GPL crate built whatever 0.12.1/0.14 vendored. Parity tolerance may be needed if bytes differ across versions — `cross_encoder` should compare *decoded pixels*, not encoded bytes, if versions differ.
4. **Decode feature surface.** Confirm which progressive/ROI calls `jxl_lowlevel.rs` actually uses before porting (don't port unused).
5. **License header** to put on our new crate — pick MIT/Apache-2.0 (or proprietary). Not GPL.

---

## Pointers

- Spec (design, still valid): `docs/superpowers/specs/2026-06-17-bsd-jxl-encoder-design.md`
- Current GPL usage (replace): `crates/raw-pipeline/src/casabio_encode.rs`, `crates/raw-pipeline/src/jxl_lowlevel.rs`, `src/bin/raw_decode_bench.rs`
- BSD headers (bindgen input): `external/libjxl/lib/include/jxl/`
- Deps to drop: root `Cargo.toml:39,42`; `crates/raw-pipeline/Cargo.toml:20,30`
- Memory: `external/libjxl` /O2 build note ("libjxl 0.11 regression = unoptimized build"); reroute plan (`docs/libjxl-local-reroute-plan.md`).

**First command after reboot:** `cargo new --lib crates/jxl-ffi` → wire `build.rs` → smoke-test `JxlDecoderVersion()`.
