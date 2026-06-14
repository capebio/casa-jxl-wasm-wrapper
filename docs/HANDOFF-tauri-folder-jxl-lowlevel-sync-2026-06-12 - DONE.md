# HANDOFF: Tauri Folder Sync for `jxl_lowlevel` Progressive Frame API

**Date:** 2026-06-12  
**Target repo:** `C:\Foo\raw-converter-tauri`  
**Why this handoff exists:** current writable workspace (`raw-converter-wasm`) was behind sibling Tauri repo on shared low-level progressive decode API shape. I synced that API here, but sandbox blocked writing into `C:\Foo\raw-converter-tauri`. This handoff tells you exactly what to run there.

## Outcome Wanted

Make sure Tauri repo shared crate `raw-pipeline` exposes callback-based progressive frame decode API:

- `ProgressiveFrame`
- `decode_progressive_frames(jxl_bytes, on_frame)`
- `decode_progressive_first_total(jxl_bytes)` as wrapper

Reason:

- `src-tauri/src/pipeline.rs` already uses `raw_pipeline::jxl_lowlevel::decode_progressive_frames(...)`
- if Tauri repo shared crate drifts behind, progressive lightbox prefill path breaks or becomes harder to evolve
- this is positive pipeline change only; no speculative refactor

## What I Found

In `C:\Foo\raw-converter-tauri`, much of the June handoff is already implemented:

- native progressive prefill path exists
- `jxl_metrics` emission exists
- subject crop JXL cache exists
- `decode_jxl_subject_crop_for_id` exists
- id-based JXL decode commands exist
- shared `raw-pipeline/src/jxl_lowlevel.rs` already appears richer than this repo had

So this is **not** a "build all Tauri parity from scratch" handoff. It is a **sync + verify** handoff.

## Files To Check

In `C:\Foo\raw-converter-tauri`:

- `raw-pipeline/src/jxl_lowlevel.rs`
- `src-tauri/src/pipeline.rs`
- `src-tauri/Cargo.toml`
- optional: `src-tauri/src/bench.rs`

In `C:\Foo\raw-converter-wasm` for source of truth patch shape:

- `crates/raw-pipeline/src/jxl_lowlevel.rs`
- `crates/raw-pipeline/tests/jxl_lowlevel_progressive.rs`

## Required API Shape

`raw-pipeline/src/jxl_lowlevel.rs` should expose:

```rust
#[derive(Clone, Debug)]
pub struct ProgressiveFrame {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
    pub is_final: bool,
}

pub fn decode_progressive_frames<F>(jxl_bytes: &[u8], mut on_frame: F) -> Option<(f64, f64)>
where
    F: FnMut(ProgressiveFrame)
```

Behavior:

- emits one callback per flushed partial frame
- emits final callback with `is_final: true`
- preserves existing `decode_progressive_first_total(...)` return shape by wrapping callback API

## Minimal Diff To Apply If Tauri Repo Is Missing It

If `C:\Foo\raw-converter-tauri\raw-pipeline\src\jxl_lowlevel.rs` does **not** already match:

1. Add `ProgressiveFrame` struct.
2. Extract current progressive loop into `decode_progressive_frames`.
3. Capture `image_w` / `image_h` from `JxlBasicInfo`.
4. On each `JxlDecoderFlushImage(dec) == Success`, call:

```rust
on_frame(ProgressiveFrame {
    width: image_w,
    height: image_h,
    rgba: out_buf.clone(),
    is_final: false,
});
```

5. On success exit, emit final callback:

```rust
on_frame(ProgressiveFrame {
    width: image_w,
    height: image_h,
    rgba: out_buf,
    is_final: true,
});
```

6. Re-implement timing wrapper:

```rust
pub fn decode_progressive_first_total(jxl_bytes: &[u8]) -> Option<(f64, f64)> {
    decode_progressive_frames(jxl_bytes, |_| {})
}
```

## Test To Add

Add this file in Tauri repo shared crate:

`raw-pipeline/tests/jxl_lowlevel_progressive.rs`

Use same test as writable repo now has:

```rust
#![cfg(all(feature = "jxl-lowlevel", feature = "jxl-encode", not(target_arch = "wasm32")))]

use raw_pipeline::casabio_encode::{encode_variants_with_progressive, SourceType};
use raw_pipeline::jxl_lowlevel::{decode_progressive_frames, ProgressiveFrame};

fn gradient_rgba(w: u32, h: u32) -> Vec<u8> {
    let mut rgba = vec![0u8; (w * h * 4) as usize];
    for y in 0..h {
        for x in 0..w {
            let i = ((y * w + x) * 4) as usize;
            rgba[i] = ((x * 255) / w.max(1)) as u8;
            rgba[i + 1] = ((y * 255) / h.max(1)) as u8;
            rgba[i + 2] = (((x + y) * 255) / (w + h).max(1)) as u8;
            rgba[i + 3] = 255;
        }
    }
    rgba
}

#[test]
fn progressive_decode_emits_final_frame_with_image_shape() {
    let (w, h) = (256u32, 192u32);
    let rgba = gradient_rgba(w, h);
    let variants = encode_variants_with_progressive(&rgba, w, h, SourceType::Raw, false, 2, 1)
        .expect("encode progressive test image");

    let mut frames: Vec<ProgressiveFrame> = Vec::new();
    let timings = decode_progressive_frames(&variants.full, |frame| frames.push(frame));

    assert!(timings.is_some(), "expected progressive decode timings");
    assert!(!frames.is_empty(), "expected at least final frame");

    let final_frame = frames.last().expect("final frame");
    assert!(final_frame.is_final, "last callback must be final frame");
    assert_eq!(final_frame.width, w);
    assert_eq!(final_frame.height, h);
    assert_eq!(final_frame.rgba.len(), (w * h * 4) as usize);

    if frames.len() > 1 {
        assert!(
            frames[..frames.len() - 1].iter().any(|frame| !frame.is_final),
            "expected non-final frame before final callback when multiple frames emitted"
        );
    }
}
```

## Exact Commands To Run In `C:\Foo\raw-converter-tauri`

Open shell in:

```powershell
cd C:\Foo\raw-converter-tauri
```

Check current drift:

```powershell
rtk git status --short
rtk rg -n "ProgressiveFrame|decode_progressive_frames|decode_progressive_first_total" raw-pipeline\src\jxl_lowlevel.rs src-tauri\src\pipeline.rs
```

Format after patch:

```powershell
rtk cargo fmt --manifest-path raw-pipeline\Cargo.toml
rtk cargo fmt --manifest-path src-tauri\Cargo.toml
```

Run focused shared-crate test:

```powershell
rtk cargo test --manifest-path raw-pipeline\Cargo.toml --test jxl_lowlevel_progressive --features jxl-lowlevel,jxl-encode -j 1
```

Run broader shared-crate coverage:

```powershell
rtk cargo test --manifest-path raw-pipeline\Cargo.toml --features jxl-lowlevel,jxl-encode -j 1
```

Run Tauri crate compile check:

```powershell
rtk cargo check --manifest-path src-tauri\Cargo.toml -j 1
```

If you want runtime progressive-path verification too:

```powershell
rtk cargo check --manifest-path src-tauri\Cargo.toml --bin raw-converter-tauri -j 1
```

## What To Look For In Tauri Pipeline

These should already exist in `src-tauri/src/pipeline.rs`:

- `prefill_jxl_lightbox_progressive(...)`
- `raw_pipeline::jxl_lowlevel::decode_progressive_frames(...)`
- event emits:
  - `"jxl_progressive_pass"`
  - `"jxl_metrics"`
  - `"jxl_lightbox_ready"`

If compile fails there, likely causes:

- shared crate API drift
- callback frame struct field mismatch
- import mismatch after sync

## If You Want Direct File Copy Instead Of Manual Patch

Smallest safe copy source:

- from: `C:\Foo\raw-converter-wasm\crates\raw-pipeline\src\jxl_lowlevel.rs`
- to: `C:\Foo\raw-converter-tauri\raw-pipeline\src\jxl_lowlevel.rs`

Then manually confirm Tauri repo local edits are not overwritten unintentionally.

Do **not** blind-copy whole directories. Only this file, and add the new test file.

## Non-Goals

Do not spend time on these in this slice unless compile fails there:

- reworking `SetCropEnabled`
- new JXTC container format work
- changing `src-tauri/src/pipeline.rs` behavior
- doc cleanup
- benchmark redesign

This handoff is for **shared API parity + proof test**, not broad Tauri feature work.

## Done Criteria

Done when all true:

- `raw-pipeline/src/jxl_lowlevel.rs` exposes callback progressive API
- new integration test exists
- focused test passes
- shared-crate test suite with `jxl-lowlevel,jxl-encode` passes
- `src-tauri` compile check passes
- no unintended changes outside intended files

## Notes From This Session

- I could read `C:\Foo\raw-converter-tauri` but sandbox denied writes there.
- Writable repo now contains the synced API and test, so it can serve as patch source.
- In this workspace, Cargo verification was blocked by Windows `Access is denied (os error 5)` while rustc wrote build artifacts. That looked environmental, not code-shaped.
