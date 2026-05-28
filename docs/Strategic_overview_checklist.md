# Strategic Overview Checklist

Source: [`docs/Strategic_overview.md`](./Strategic_overview.md)

Status legend:
- `Done` = explicitly described as complete in the overview.
- `Mostly done` = implemented, with release or packaging risk still open.
- `Partial` = real progress exists, but the item is not production-ready.
- `Open` = called out as a remaining production task or blocker.
- `Not operational` = present in tooling/docs, but not yet proven in practice.

## Already Solid

- [x] `packages/jxl-wasm` artifacts - **Mostly done**. Real scalar, SIMD, SIMD-MT, and relaxed-SIMD-MT artifacts exist with hashes and build provenance. Remaining risk is packaging and release coherence, not core build output.
- [x] `packages/jxl-wasm/src/facade.ts` - **Mostly done**. The facade is now a functional product layer with progressive decode, metadata-preserving encode, viewport helpers, metrics, cancellation, and streaming input.
- [x] `packages/jxl-wasm/src/bridge.cpp` - **Mostly done**. ICC/EXIF/XMP preservation, progressive decode/encode knobs, crop fallback, chunked output, sidecars, and JPEG transcode exports are in place.
- [x] `packages/jxl-worker-browser` and `packages/jxl-worker-node` - **Mostly done**. Session routing, cold-start buffering, shutdown, cancellation, queue caps, and error reporting are implemented.
- [x] `packages/jxl-scheduler` - **Mostly done**. Priority lanes, dedupe, backpressure, and pause/resume preemption semantics exist.
- [x] `packages/jxl-session` - **Mostly done**. The public session shape is correct; the remaining issue is downstream type/package consistency.
- [x] `src/lib.rs` DNG metadata flow - **Done**. DNG color matrix and ISO are pulled from `raw_pipeline::dng` when present, with fallback only when metadata is absent.
- [x] Rust `cargo check` with isolated target dir - **Done**. The overview states `CARGO_TARGET_DIR=tmp/cargo-check-target cargo check` succeeds.

## Production Blockers

- [ ] Package/release hygiene - **Open**. Root workspace and scripts are missing, package-local dependency copies can diverge, `@casabio/jxl-wasm` is private, and generated `dist/` output is not reliably rebuilt before tests.
- [ ] Verification harness - **Open**. Tests exist, but CI cannot yet prove the current state cleanly because of stale dist/source splits, runner drift, and package-level typecheck failures.
- [ ] ROI story - **Partial**. Viewport helpers and an honest fallback path exist, but true tile/crop ROI is not implemented yet.
- [ ] Native Node path - **Partial**. The source shape exists, but there is no production proof for prebuilt binaries, host library strategy, or CI parity.
- [ ] Threaded WASM deployment contract - **Partial**. Threaded artifacts exist, but COOP/COEP, asset hosting, headers, and tier-detection rules still need a deployment contract.
- [ ] PGO - **Not operational**. The build scripts and corpus manifest exist, but there is no reproducible release or CI proof that PGO is actually consumed.
- [ ] Documentation - **Partial**. The repo has implementation notes, but not yet a clean production integration guide with honest v1 scope boundaries.
- [ ] Security and abuse hardening - **Open**. The overview calls for fuzzing, quota enforcement, OOM recovery, and cancellation under load, but does not describe these as complete.
- [ ] Acceptance criteria - **Open**. The overview’s suggested v1 criteria are not yet met end to end.

## Suggested V1 Scope

- [x] WASM-first browser and Node support via WASM fallback.
- [x] Metadata-preserving encode/decode.
- [x] Progressive preview support.
- [x] Viewport helpers with honest ROI fallback.
- [ ] Native acceleration guarantee.
- [ ] PGO guarantee.
- [ ] True ROI/tile-based decode guarantee.

## Short Read

The core codec/runtime work is close to finished. The open work is mostly release engineering, verification, deployment detail, and scope honesty.
