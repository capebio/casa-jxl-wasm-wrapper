# Raw Pipeline Handoffs: `decompress.rs` `demosaic.rs` `dng.rs` `exif.rs` `ljpeg.rs`

## Implementation Layers

### Layer 1: Format correctness and decode integrity
- Fix non-RGGB DNG fallback color bug in [`crates/raw-pipeline/src/dng.rs`](C:/Foo/raw-converter-wasm/crates/raw-pipeline/src/dng.rs:812) and add true phase-aware MHC entry in [`crates/raw-pipeline/src/demosaic.rs`](C:/Foo/raw-converter-wasm/crates/raw-pipeline/src/demosaic.rs:287).
- Fix uncompressed DNG endianness and bounds safety in [`decode_uncompressed`](C:/Foo/raw-converter-wasm/crates/raw-pipeline/src/dng.rs:221).
- Add entropy truncation detection to [`crates/raw-pipeline/src/ljpeg.rs`](C:/Foo/raw-converter-wasm/crates/raw-pipeline/src/ljpeg.rs:67) so corrupt tiles error early instead of zero-padding through decode.
- Add visited-offset / depth guard to [`walk`](C:/Foo/raw-converter-wasm/crates/raw-pipeline/src/dng.rs:310).

### Layer 2: Peak memory, alloc churn, streaming
- Add caller-owned output/scratch APIs to [`decompress.rs`](C:/Foo/raw-converter-wasm/crates/raw-pipeline/src/decompress.rs:12), [`demosaic.rs`](C:/Foo/raw-converter-wasm/crates/raw-pipeline/src/demosaic.rs:99), and [`ljpeg.rs`](C:/Foo/raw-converter-wasm/crates/raw-pipeline/src/ljpeg.rs:229).
- Reuse `band` and `ctx` buffers across tile rows in [`decode_bytes_demosaiced`](C:/Foo/raw-converter-wasm/crates/raw-pipeline/src/dng.rs:812).
- Replace full `Vec<DecodedTile>` gather in [`decode_tiles`](C:/Foo/raw-converter-wasm/crates/raw-pipeline/src/dng.rs:128) with bounded work queue or row-band sink.

### Layer 3: Hot kernels and cache locality
- SIMD or `std::simd` path for bilinear, half-res, matrix-fused MHC, and compact-tile blits.
- Parse LJPEG headers once, share immutable decode plan across tiles, stop reparsing DHT/SOF/SOS twice per tile.
- Early-exit corrupt Olympus bitstreams in `decompress_rows` instead of finishing whole raster after truncation flag already known.

### Layer 4: Metadata and model fidelity
- Upgrade EXIF rational model to support signed values and validated denominators.
- Preserve CFA phase and crop semantics explicitly instead of hidden row-drop alignment.
- Expose structured decode provenance: WB source, color-matrix source, crop applied, fallback path used.

### Layer 5: Product hooks for ML, AR, photogrammetry, perceptual color
- Add ROI / band / half-res entry points for fast plant-recognition and preview ranking.
- Surface saliency and CFA-aware low-res preview as first-class outputs for feature detectors and digital-twin capture scoring.
- Keep demosaic output layout compatible with later perceptual LUT / constancy engine by offering planar-or-interleaved choice and fused matrix hook.

## Agent 1 — `decompress.rs`
If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

- P1 bug/perf: [`decompress_rows`](C:/Foo/raw-converter-wasm/crates/raw-pipeline/src/decompress.rs:17) keeps decoding after `BitReader.truncated` already became true. Corrupt input pays full raster cost and emits garbage work before final `Err`. Return immediately once truncation is first observed.
- P1 perf/API: current API always allocates `Vec<u16>`. Add `decompress_rows_into(compressed, width, height, max_rows, out: &mut [u16])` and keep existing fns as wrappers. This removes repeat alloc/free in preview/full decode ladders.
- P2 feature: row-prefix decode exists, but no ROI/downsample hook. Add optional callback every decoded row pair or even/odd sensor plane block. Good for ML thumbnails, AR live preview, and photogrammetry feature scouting before full demosaic.
- P2 hygiene: error text contains mojibake `Ã—`. Normalize messages once.

Suggested shape:

```rust
pub fn decompress_rows_into(
    compressed: &[u8],
    width: usize,
    height: usize,
    max_rows: usize,
    out: &mut [u16],
) -> Result<usize, String> {
    // return rows written
}
```

## Agent 2 — `demosaic.rs`
If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

- P1 bug/product: file has phased bilinear [`demosaic_bayer`](C:/Foo/raw-converter-wasm/crates/raw-pipeline/src/demosaic.rs:238) but no phased MHC. Downstream DNG code therefore falls back to RGGB-only MHC and miscolors GRBG/BGGR, with crop side effects for GBRG. Add `demosaic_bayer_mhc(raw, width, height, phase)` and band variant.
- P1 perf: [`demosaic_rggb_mhc_matrix`](C:/Foo/raw-converter-wasm/crates/raw-pipeline/src/demosaic.rs:779) duplicates scalar MHC work per pixel, then does 3 i64 dot-products. This is correct but not telescope-fast. Fuse matrix into unrolled row kernels, then add SIMD path for 8–16 pixels at a time.
- P2 perf/memory: public APIs always allocate interleaved RGB. Add `_into` variants and optional planar output. Planar helps later perceptual LUTs, feature detectors, and any Butteraugli prefilter that wants luma/chroma separation with fewer shuffles.
- P2 bug/clarity: [`demosaic_rggb_half`](C:/Foo/raw-converter-wasm/crates/raw-pipeline/src/demosaic.rs:209) silently floors odd width/height. Either return applied crop metadata or add `half_ceil` policy.
- P2 feature: promote saliency result from [`demosaic_rggb_mhc_with_saliency`](C:/Foo/raw-converter-wasm/crates/raw-pipeline/src/demosaic.rs:643) into stable API contract. It is best current hook for game-style LOD, AR focus guidance, and digital-twin capture scoring.

Suggested phase-aware MHC entry:

```rust
pub fn demosaic_bayer_mhc(
    raw: &[u16],
    width: usize,
    height: usize,
    phase: (u8, u8),
) -> Result<Vec<u16>, String>;
```

## Agent 3 — `dng.rs`
If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

- P1 bug: [`decode_bytes_demosaiced`](C:/Foo/raw-converter-wasm/crates/raw-pipeline/src/dng.rs:812) claims non-RGGB fallback is correct, but it calls [`align_to_rggb`](C:/Foo/raw-converter-wasm/crates/raw-pipeline/src/dng.rs:262) then RGGB-only MHC. `GRBG` and `BGGR` remain wrong; `GBRG` loses top row. Replace fallback with phase-aware MHC. Remove hidden crop unless explicitly returned.
- P1 bug: [`decode_uncompressed`](C:/Foo/raw-converter-wasm/crates/raw-pipeline/src/dng.rs:221) always uses `u16::from_le_bytes`, ignoring TIFF endianness. Big-endian uncompressed DNG decodes wrong. Thread `le` through and bound-check `off + bc`.
- P1 bug: [`walk`](C:/Foo/raw-converter-wasm/crates/raw-pipeline/src/dng.rs:310) recurses with no visited set or depth cap. Corrupt/cyclic IFD graph can loop or stack overflow.
- P1 feature gap: raw selection requires tiles and `width > 1000`. Small sensors, cropped raws, strip-organized DNGs, and some ML capture assets can be skipped entirely. Support strips, drop magic threshold, prefer largest supported CFA/raw candidate.
- P2 perf: [`decode_tiles`](C:/Foo/raw-converter-wasm/crates/raw-pipeline/src/dng.rs:128) probes then decodes each LJPEG tile, parsing headers twice and keeping all decoded tiles resident before blit. Move to parsed `LjpegPlan`, decode into bounded row-band buffers, blit immediately.
- P2 perf: [`decode_bytes_demosaiced`](C:/Foo/raw-converter-wasm/crates/raw-pipeline/src/dng.rs:812) reallocates `band` and `ctx` every tile row. Hoist and reuse scratch.
- P2 color fidelity: WB fallback defaults `(0.5, 1.0, 0.6)` create strong synthetic cast when metadata missing. Use unity WB plus provenance flag, or derive from black/white-balanced histogram later.
- P3 future: expose `DngDecodePlan { cfa, black, white, wb_source, matrix_source, crop }`. This becomes handoff seam for perceptual constancy engine and photogrammetry ingest.

Suggested non-RGGB fix:

```rust
let phase = match cfa {
    Cfa::Rggb => (0, 0),
    Cfa::Grbg => (0, 1),
    Cfa::Gbrg => (1, 0),
    Cfa::Bggr => (1, 1),
};
let rgb = demosaic::demosaic_bayer_mhc(&img.raw, img.width, img.height, phase)?;
```

Suggested endian fix:

```rust
out[r * width + c] = if le {
    u16::from_le_bytes([src[sp], src[sp + 1]])
} else {
    u16::from_be_bytes([src[sp], src[sp + 1]])
};
```

## Agent 4 — `exif.rs`
If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

- P1 model gap: [`Rational`](C:/Foo/raw-converter-wasm/crates/raw-pipeline/src/exif.rs:4) is unsigned only. Future EXIF and maker-note work will need signed rationals for exposure bias, lens shifts, some GPS refs, and calibration terms. Introduce signed variant or enum now before API freezes.
- P1 data integrity: `from_orf_info` trusts denominators and external `image_w` / `image_h`. Validate `den != 0`; keep raw dimensions from `OrfInfo` alongside rendered dimensions so downstream geometry and photogrammetry do not confuse sensor size with output crop.
- P2 feature: add fields for provenance and capture geometry that help ML/AR/digital twins: `wb_source`, `raw_width/raw_height`, `crop_origin`, `timestamp_subsec`, optional `camera_serial`, optional pose-ish tags when present upstream.
- P3 perf/API: if this struct stays hot on WASM boundary, consider `Cow<'a, str>` or compact shared string pool upstream. Not urgent unless profiling shows metadata serialization hot.

Suggested model:

```rust
pub enum ExifRatio {
    Unsigned { num: u32, den: u32 },
    Signed { num: i32, den: i32 },
}
```

## Agent 5 — `ljpeg.rs`
If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

- P1 bug: [`BitReader`](C:/Foo/raw-converter-wasm/crates/raw-pipeline/src/ljpeg.rs:67) zero-pads on short entropy stream and decode continues. Corrupt/truncated tiles can silently become plausible pixels. Mirror `decompress.rs` strategy: track real bits vs padded bits and fail on first over-consume.
- P1 perf: [`decode_tile`](C:/Foo/raw-converter-wasm/crates/raw-pipeline/src/ljpeg.rs:229) reparses markers/DHT/SOF/SOS on every tile, while [`probe_tile`](C:/Foo/raw-converter-wasm/crates/raw-pipeline/src/ljpeg.rs:468) does another scan. Build `LjpegPlan` once, share immutable huffman tables, decode many tiles with one parsed header.
- P2 perf: thread-local DHT cache uses linear `Vec` lookup, allocates full key every DHT, and `remove(0)` shifts whole cache. Replace with tiny hash/FxHash + bounded LRU or avoid cache entirely once plan parsing exists.
- P2 perf/API: current decode writes direct to destination layout only. Add `decode_tile_into_planar` or `decode_entropy_into_compact` so DNG band decoder can pick copy shape that minimizes shuffles.
- P2 robustness: validate Huffman symbol category against precision/component constraints before reading bits. Corrupt tables should bail fast, not drive undefined image math.
- P3 feature: parsed-plan hook is best place to add optional restart-marker support later if corpus expands beyond Olympus-primary assets.

Suggested plan split:

```rust
pub struct LjpegPlan {
    sof: Sof,
    sos: Sos,
    dhts: [Option<Arc<HuffTable>>; 4],
    entropy_offset: usize,
}

pub fn parse_plan(src: &[u8]) -> Result<LjpegPlan>;
pub fn decode_with_plan(src: &[u8], plan: &LjpegPlan, out: &mut [u16], ...) -> Result<()>;
```

## Unlit Rooms
- No cancellation/progress channel anywhere in these five files. Pipeline can decode/demosaic long work with no cooperative stop.
- No shared scratch/arena story. Every stage allocates fresh large `Vec`s, then next stage allocates again.
- No first-class preview/ROI contract spanning decompress → demosaic → DNG → metadata. That blocks fast AR, ML triage, and Butteraugli-pruning strategies.

## Overview
Implementing Layer 1 and Layer 2 turns pipeline from “usually correct on happy Olympus path” into “correct across more CFA/endian/corrupt-input cases, with lower peak memory and fewer surprise colors.” Biggest concrete wins: non-RGGB DNGs stop misrendering, uncompressed big-endian DNGs stop decoding wrong, truncated LJPEG tiles stop silently fabricating pixels, and repeated preview/full passes stop paying avoidable alloc churn.

Layer 3 through Layer 5 turn same code into better platform substrate. Parsed LJPEG plans, `_into` APIs, SIMD-friendly demosaic, saliency/ROI outputs, and explicit metadata provenance create seams for ML recognition, AR live view, photogrammetry capture scoring, and later perceptual-color engine work without rebreaking hot loops.

Last agent instruction: after all accepted work lands, append `- DONE` to this filename.
