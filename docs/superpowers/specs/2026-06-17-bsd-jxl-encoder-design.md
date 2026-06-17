# BSD JXL Encoder — Design Spec

**Date:** 2026-06-17
**Status:** Design approved, pending spec review → implementation plan
**Author:** David (brainstormed w/ Claude)

---

## Strategic shape (the one idea)

> **One owned object holds the warm libjxl codec. Feed it `Frame`s, get JXL bytes back.**
> No hidden state. No buffer-lifecycle puzzles. Explicit lifetime. Reuse is visible.

Everything below is detail hung off that sentence.

---

## 1. Goal / Non-goals

**Goal:** An in-tree, **BSD-clean** JPEG XL *encoder* built directly on `jpegxl-sys`, replacing the **GPL-3.0** `jpegxl-rs` crate. Reusable (warm codec), zero-copy on input, control-first (every libjxl knob reachable), correctness baked in.

**Why:** `jpegxl-rs` is GPL-3.0-or-later. Linked into the shipped native/WASM artifact, that copyleft is viral on distribution. libjxl itself is BSD-3; `jpegxl-sys` is BSD-3. Only the *bindings* crate is GPL. Replace it with our own thin bindings → GPL gone, codec + speed unchanged.

**Non-goals (no live consumer — not ported):**
- Decode (already BSD in `crates/raw-pipeline/src/jxl_lowlevel.rs`).
- JPEG-reconstruction / transcode (`encode_jpeg`, `reconstruct`).
- Box metadata, multi-frame animation.
- **Moving HDR/hyperspectral data end-to-end** through the tone pipeline, downscale, WASM↔JS view, telemetry, storage. The encoder *accepts* float + N-channel; the upstream pipeline that *produces* and *views* it is a separate, larger initiative (see §9).

---

## 2. Architecture

```
encode_rgba8(px, w, h, &opts)        ← thin sugar for the dominant photo path
   = Encoder::new(opts)?.encode(&Frame::rgba8(px, w, h))

Encoder                              ← THE object. Owns the warm *JxlEncoder handle.
   .encode(&Frame<S>) -> Vec<u8>       reset between encodes; reset-on-error.
   .set_raw(FrameSettingId, i64)       all control + future features live here.
   │
   ▼
jpegxl-sys  →  libjxl (BSD-3)
```

- **Reuse is explicit, not magic.** The 3-variant set and the ingest loop each hold *one* `Encoder` and call `.encode()` repeatedly. The expensive thing (codec init) is paid once per held `Encoder`; `JxlEncoderReset` cleans state between encodes.
- **No thread-local pool** — rejected as hidden state. Orchestrator ownership is clearer and gives the control we want. Under rayon, each worker constructs its own `Encoder` (normal owned-value semantics).
- **No persistent output buffer** — JXL bytes are *retained* (saved), so grow-then-move-out beats reuse-then-copy. Per-encode `Vec`, sized by the grow loop, truncated to exact, moved out.

---

## 3. Options surface

```rust
pub struct EncodeOptions {
    pub rate: Rate,                          // mutually-exclusive rate control (see below)
    pub effort: u8,                          // libjxl Effort, 1..=10
    pub progressive_dc: Option<i64>,
    pub group_order: Option<GroupOrder>,     // { center: Option<(i64, i64)> }
    pub color: ColorEncoding,                // default: sRGB (int) / linear sRGB (float)
    pub use_container: bool,                 // default false
    pub uses_original_profile: bool,         // default false
    pub extra: Vec<(FrameSettingId, i64)>,   // escape hatch: any present/future libjxl knob
}

pub enum Rate {
    Quality(f32),    // JPEG-style 0..100 → JxlEncoderDistanceFromQuality
    Distance(f32),   // butteraugli distance, 0..15 (0 = mathematically lossless)
    Lossless,        // JxlEncoderSetFrameLossless(true) — true (modular) lossless
}
```

- `Rate` makes lossless **mutually exclusive** with distance/quality at the type level → the upstream "set distance after lossless un-lossless's it" bug is *structurally impossible*.
- `FrameSettingId` = real typed enum mirroring `JxlEncoderFrameSettingId` → **deletes the `transmute(14i32)` hack** in current `casabio_encode.rs`.
- `.set_raw(id, val)` on the `Encoder` for ad-hoc one-offs; `extra` for declarative option sets.

---

## 4. Sample types & channels — fully general, all implemented

### Sample types (own clean-room `Sample` trait, BSD)

| Type | Bits | Exponent | Primary use |
|------|------|----------|-------------|
| `u8`  | 8 int  | 0 | SDR photos |
| `u16` | 16 int | 0 | RAW masters |
| `f16` | 16 float | 5 | **HDR** |
| `f32` | 32 float | 8 | **hyperspectral / scientific** |

```rust
pub trait Sample: Copy {
    fn data_type() -> JxlDataType;
    fn bits_per_sample() -> (u32, u32); // (bits, exponent_bits)
}
```
All four implemented and **unit-tested in isolation** (synthetic buffer → encode → decode → compare) — no upstream producer required. Deps: `half` (f16), `byteorder` (endianness) — both MIT/Apache, BSD-compatible, pulled directly.

### Channels — two supply modes, both implemented

```rust
pub struct Frame<'a, S: Sample> {
    pub color: &'a [S],          // interleaved; borrowed (zero-copy in)
    pub width: u32,
    pub height: u32,
    pub color_channels: u32,     // 1 (gray) | 3 (RGB)
    pub alpha: bool,             // interleaved alpha → color stride is color_channels + 1
    pub endianness: JxlEndianness,
    pub extra: &'a [ExtraChannel<'a, S>],  // planar; for hyperspectral / depth / thermal
}

pub struct ExtraChannel<'a, S: Sample> {
    pub kind: ExtraKind,
    pub data: &'a [S],           // planar, w*h
}

pub enum ExtraKind { Alpha, Depth, Thermal, Spectral, Optional } // → JxlExtraChannelType
```

- **Interleaved path** (photos): gray/RGB(+alpha) via `JxlEncoderAddImageFrame`.
- **Planar extra channels** (hyperspectral bands, depth, thermal): each declared with `JxlEncoderSetExtraChannelInfo` *before the first frame* and supplied via `JxlEncoderSetExtraChannelBuffer`. **This generalizes the alpha-extra-channel init fix** already proven in `encode_rgba4_sys`.
- *Caveat on record:* JXL stores/transports many extra channels fine, but is not a dedicated HSI compressor — `Spectral` maps to libjxl `Optional`/`Unknown`; correlated-band ratios won't match specialist tooling.

---

## 5. Lifecycle, zero-copy, correctness

**Encoder owns:** the `*mut JxlEncoder` handle (+ its frame-settings ptr). Nothing else persistent.

**Per `encode()`:**
1. `setup` — apply options, `SetBasicInfo`, declare extra channels (`SetExtraChannelInfo`), set color encoding.
2. `add` — `AddImageFrame` (interleaved color, borrowed ptr — **no copy**) + `SetExtraChannelBuffer` per extra (borrowed).
3. `drain` — `ProcessOutput` into a grow loop (double on `NeedMoreOutput`), truncate to exact, **move out** the `Vec`.
4. `JxlEncoderReset` so the held handle is clean for the next `encode()`.

**Correctness baked in (from the `jpegxl-rs` review):**
- **Reset on every error path**, not just success — a held/reused `Encoder` can never be poisoned by a prior failure. (Upstream reset only on success → dirty handle bricks reuse.)
- **Lossless can't be un-set** — `Rate::Lossless` is a distinct variant; we never call `SetFrameDistance` in that arm.
- **Extra-channel init is mandatory** — every declared extra channel gets `SetExtraChannelInfo` before frame add (libjxl 0.11.x "Extra channel N not initialized" → degraded path otherwise).
- **`Send`, not `Sync`** — same justification as upstream (libjxl LCMS context is looked up per-use, not stored). `Drop` calls `JxlEncoderDestroy`.

---

## 6. Module layout / migration

- **New:** `crates/raw-pipeline/src/jxl_encode.rs` — `Encoder`, `EncodeOptions`, `Rate`, `Sample`, `Frame`, `ExtraChannel`, `ExtraKind`, `FrameSettingId`, free-fn sugar.
- **`casabio_encode.rs`:** keep orchestration (variant set, downscale, alpha detect, quality/distance ladders). Replace `jpegxl_rs::` calls + the `transmute` knob hacks with `jxl_encode`. Fold in / delete the dead `encode_rgba4_sys`.
- **`src/bin/raw_decode_bench.rs`:** repoint the `decoder_builder().decode()` bench to `jxl_lowlevel` decode.
- **`tests/cross_encoder.rs`:** keep as parity gate; swap encode backend.
- **Cargo:** drop `jxl-encode` feature + `jpegxl-rs` dep (root `Cargo.toml:39`, crate `:20`); make `jpegxl-sys` non-optional for the encode path; add `half`/`byteorder`. Refresh `Cargo.lock`.
- **Delete:** `vendor/jpegxl-rs`.
- **Verify:** `vendor/jpegxl-sys` header = BSD-3.

**Order is load-bearing:** build new module → repoint call sites → drop dep → delete dir → build. Never delete-first.

---

## 7. Testing / parity gate

- **Unit (module-local):** each `Sample` type round-trips (encode→decode→compare); RGB/RGBA/gray; ≥1 planar extra channel; error path leaves `Encoder` reusable; lossless is bit-exact round-trip.
- **Parity:** `cross_encoder.rs`, `raw_decode_bench.rs`, `StandardMultifileTest.mjs`. New output must match current `jpegxl-rs` output **byte-identical at identical settings**, or within a stated perceptual tolerance if the linked libjxl version differs. Not "done" until green.

---

## 8. Success criteria

1. `jpegxl-rs` absent from tree, `Cargo.toml`, and `Cargo.lock`; `vendor/jpegxl-rs` deleted.
2. `cargo build` + `cargo test` green for `raw-pipeline` (both relevant feature sets).
3. Variant-set + pyramid-sidecar encode output matches pre-change (byte / tolerance).
4. One warm `Encoder` reused across a variant set and across an ingest loop — no per-call codec create/destroy.
5. u8/u16/f16/f32 + interleaved + planar-extra all encode correctly (unit-tested).
6. No `transmute` for frame-setting IDs; lossless/distance bug structurally impossible.

---

## 9. Out of scope (on record — future initiatives)

The encoder accepts float and N-channel **now**. Using that end-to-end needs separate, pipeline-wide work, each its own brainstorm→spec→plan:

- **HDR (f16):** float-output tone/look pipeline (`apply_tone_math`, `tone_simd`, LUTs), float downscale, WASM↔JS tone-map-to-8bit *view* step, float-aware telemetry/SSIM/PSNR, storage format.
- **Hyperspectral (f32, N-band):** extra-channel model threaded through decode → pipeline → storage; per-band tone/view (false-color); band descriptors.

This encoder is deliberately ready ahead of them and will not be the blocker.

---

## Design rationale — simplifications adopted (bird's-eye pass)

1. **Dropped the thread-local encoder pool.** Reuse happens in explicit loops we already edit; orchestrator ownership is clearer and avoids hidden per-thread state.
2. **Dropped the persistent output buffer.** Output is retained (saved as files), so grow-then-move-out is strictly cheaper than reuse-then-copy. Encoder's only persistent state is the warm codec handle — the genuinely expensive resource.
3. **Collapsed the method family to one generic `encode(&Frame<S>)`** + one `encode_rgba8` sugar. `Sample` trait + `Frame` carry the variation.
4. **`Rate` enum makes the lossless bug unrepresentable** rather than guarding against it at runtime.
