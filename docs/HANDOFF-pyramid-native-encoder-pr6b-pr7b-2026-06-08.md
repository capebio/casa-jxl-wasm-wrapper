# HANDOFF: Pyramid Native Sidecar Encoder (PR-6b) + Tauri Enablers (PR-7b et al)

**Date:** 2026-06-08
**Branch:** feat/fast-jpeg
**Commit:** c0254f6e775c1148c0e7539b57f1b555d21b30c0
**Context:** Continuation after prior agent stuck on "PR-6b (native sidecar encoder) or Plan B ingest CLI?". WASM M0 (sidecars_v2 + encodeRgba8Pyramid + downscaleRgba16) complete in packages/jxl-wasm. Plan B ingest CLI (packages/pyramid-ingest full + jxl-pyramid schemas) already present. This delta is the native port in the shared crate.

## Mission
Deliver the native equivalent of the WASM per-level-distance sidecar pyramid (cascade BoxDownscaleRgba8, no 1.5 floor, effort=3) so Tauri can do efficient on-device pyramid ingest + manifest for the gallery (PR-7b). Add direct rgb16 feed (like existing variants_from_rgb16) to keep Tauri cost model good. Respect numeric effort (Falcon == level 3 confirmed best by user).

References: docs/superpowers/specs/2026-06-07-pyramid-gallery-design.md (esp. §4 ingest, §10 levers, §14/15 success), TauriWasmParity.md (H40/PR-6b, PR-7b), FEATURE_PARITY_MATRIX.md, Plan A primitives doc.

## Working Files (this handoff's delta)
1. crates/raw-pipeline/src/casabio_encode.rs (primary, the implementation + tests)
   - PyramidLevel { data: Vec<u8>, width, height, bits_per_sample: 8 }
   - box_downscale_rgba8 (exact integer port of bridge.cpp BoxDownscaleRgba8: fastpath for exact 2x factors + general coverage with ceiling)
   - map_effort_to_speed(effort: u32) -> EncoderSpeed (Lightning=1, Thunder=2, Falcon=3, ..., Glacier=10)
   - jpeg_quality_for_distance (spec 0.1 + (100-q)*0.09 inverse for set_jpeg_quality)
   - encode_one_distance now accepts effort
   - pub encode_rgba8_pyramid(rgba: &[u8], w, h, full_distance, sidecar_sizes: &[u32], sidecar_distances: &[f32], effort) -> Vec<PyramidLevel>
     - Skips sizes >= master long edge
     - Cascade: process largest sidecar first (down from full), then smaller from prior result
     - Sidecars smallest-first + full last (matches WASM)
     - Each level at its exact distance
   - pub encode_rgba8_pyramid_from_rgb16(rgb16: &[u16], params: &PipelineParams, ...) (PR-7b enabler: process_rgba then pyramid; zero-copy intent for Tauri direct feed from post-demosaic RGB16, exactly like encode_variants_from_rgb16)
   - Tests: encode_rgba8_pyramid_smoke, pyramid_skips_upscale_and_produces_ascending, encode_rgba8_pyramid_from_rgb16_smoke (JXL magic, dims, 8-bit, structure, skip logic)
   - Old variants path left unchanged (still hardcodes Falcon for thumbs/preview/full)

2. docs/FEATURE_PARITY_MATRIX.md (status only)
   - Updated PR-6b rows from "open" to done (with note on effort + from_rgb16 helper)
   - PR-7b noted as unblocked
   - M0/M1 summary lines refreshed

Commit only touched these two (no node_modules, no dists, no untracked pyramid-gallery/ or timings or images were included).

## Key Code (working excerpts from current crates/raw-pipeline/src/casabio_encode.rs post-commit)
(See full file or `git show c0254f6 -- crates/raw-pipeline/src/casabio_encode.rs` for complete diff.)

```rust
fn map_effort_to_speed(effort: u32) -> jpegxl_rs::encode::EncoderSpeed {
    use jpegxl_rs::encode::EncoderSpeed::*;
    match effort {
        1 => Lightning,
        2 => Thunder,
        3 => Falcon,
        ...
        _ => Falcon,
    }
}

pub fn encode_rgba8_pyramid(...) -> Result<Vec<PyramidLevel>, EncodeError> {
    ... collect scs (skip >= longer) ...
    ... cascade loop (rev for largest first, downscale + encode_one_distance at sc.dist) ...
    let full = encode_one_distance(..., effort)?;
    ...
}

pub fn encode_rgba8_pyramid_from_rgb16(rgb16, params, ...) {
    let rgba = crate::pipeline::process_rgba(rgb16, params);
    encode_rgba8_pyramid(&rgba, ...)
}
```

Box downscale matches C++ arith exactly for pixel-perfect small levels.

## Verification
- `.\build-msvc.ps1 test --manifest-path crates/raw-pipeline/Cargo.toml --features jxl-encode -- --quiet`
  - 33 tests total, 31+ passed (2 ignored real-fixture as before).
  - New pyramid tests exercised (smoke, skip, from_rgb16).
- Effort: Falcon=3 wired and matches user's "level 3 is what works the best".
- Matches WASM M1 8-bit contract (per-level dists, cascade, contenthash later in ingest).

## Next Steps (PR-7b et al.)
- Tauri tree (not in this workspace): integrate `raw_pipeline::casabio_encode::encode_rgba8_pyramid_from_rgb16` (or rgba8 variant) into pyramid ingest path. Produce levels/ + per-image manifest.json + gallery index.json using the shared jxl-pyramid types if possible. Atomic writes, mtime resumable, shard support like WASM Plan B.
- Client grid (remaining M1 / Plan C): if the feat/pyramid-m1-gallery-grid worktree changes not landed, implement per spec §6 (index.json seed + L0 first via scheduler one-shot keyed by contenthash, DPR upgrade, monotonic crossfade, viewport+prefetch ring + cancel-before-start, reuse existing scheduler/cache/OPFS).
- M2+: 8-bit lightbox (FilterEngine parity), M3 16-bit (Rust RGB16 expose + 16-bit pyramid levels + WebGL dither).
- Docs: may want to expand TauriWasmParity.md + add m*-checklist updates.
- Full roundtrip test on spec fixtures once Tauri ingest exists.

See also: docs/superpowers/specs/2026-06-07-pyramid-gallery-design.md, the PyramidAgentHandoff.md, crates/raw-pipeline/src/pipeline.rs (for process_rgba), existing casabio_encode variants.

Handoff ready. The two files above + commit c0254f6 are the payload.
