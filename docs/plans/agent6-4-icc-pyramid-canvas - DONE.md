# Plan: Agent 6 Item 4 — ICC exposure to canvas (pyramid path) (pairs with 2.10)

**Status**: One-page plan. No source edits. Approval required before any change.

## Goal
Thread the ICC profile (already parsed and exposed by libjxl + bridge via jxl_wasm_dec_icc_size / dec_icc_ptr, and preserved by facade for the main progressive path) through the jxl-pyramid tiled / whole-level decode surfaces (DecodedLevel, region decoders, worker protocol) so that canvas / ImageBitmap / color-managed renderers downstream can attach the profile instead of silently assuming sRGB.

## Merit (pipeline context)
- Repeated findings in EpicCodeReview - jxl-pyramid.md (L7m-12, L6m-15, 1019, 1536, 1929 etc.): "ICC profile / EXIF / metadata side-channel dropped at jxl-pyramid layer", "Pixels emerge as rgba8 or rgba16. No documented color space", "Wide-gamut workflows silently flatten".
- CLAUDE.md facade contract: "facade reads `dec_icc_*`, sessions attach the profile to emitted frames."
- Bridge already surfaces the bytes for decode (symmetric to encode-with-metadata paths).
- Main progressive path (createDecoder + events()) intends preservation (preserveIcc option, internal icc state); pyramid bypasses it with direct decodeTileContainerRegionRgba8/16 + WHOLE_DECODE_OPTS {preserveIcc:false}.
- Positive for any pro / wide-gamut / photogrammetry / calibrated-display use of the tiled viewer or level cache. Matches "exposure to canvas".

## Constraints / invariants
- DecodedLevel is the pyramid return type (decode-level, tiled-decode-pool, cache). Adding optional iccProfile?: Uint8Array is the natural extension (Uint8Array to match input style and avoid extra copies).
- Worker protocol (worker-protocol.ts + tiled-decode-worker.js) must carry the profile bytes (or a bytesId-style indirection) for pooled path; structured-clone cost is acceptable once per level (load phase), not per tile.
- Direct (non-pool) path and pooled path must agree on whether ICC is present.
- WHOLE_DECODE_OPTS and region decoder wrappers currently force preserveIcc:false for pyramid — this was intentional for speed / simplicity; plan changes the default or makes it opt-in per DecodeOptions while keeping the bytes when requested.
- No pixel transform in JS (per rejected claims and fast-path principles); ICC is just a sidecar blob to be forwarded to canvas or color management layer.
- Cache keys (viewportCacheKey) may need to consider profile presence or hash if color fidelity matters for hits (or keep content-agnostic and let caller re-attach).
- rejected optimizations.md: no direct hit on ICC plumbing; the "per-pixel JS transform" class of claim is rejected, but sidecar metadata pass-through is the opposite (good).

## Files / cross-file surface
- packages/jxl-pyramid/src/decode-core.ts (DecodedLevel, REGION_DECODER_*, pickRegionDecoder, stitch paths — attach to result)
- packages/jxl-pyramid/src/tiled-decode-pool.ts (decodeTilesParallel, decodeTiledViewportPooled, worker load/reply path)
- packages/jxl-pyramid/src/worker-protocol.ts (WorkerRequest/Reply — add optional icc or profile handle for the level)
- web/lightbox/tiled-decode-worker.js (the actual worker that calls decodeTileContainerRegion* and replies; must request + forward ICC when available)
- packages/jxl-wasm/src/facade.ts (if the region decoders need an options path or separate getIcc call; main decode already has the machinery)
- Callers in web/ (lightbox, gallery, any canvas putImageData / createImageBitmap sites) to actually use the profile (e.g. new ICCProfile or ImageData colorSpace hints where supported).
- Tests: pyramid tests + any that assert DecodedLevel shape.

## One-page sketch (minimal steps)
1. Extend DecodedLevel { ..., iccProfile?: Uint8Array, exif?: Uint8Array, xmp?: Uint8Array } (metadata bag for parity with main path; start with ICC as required).
2. **Efficiency (once-per-source):** Add `ensureIccProfile(source: LevelSource): Uint8Array | null` (and similar for exif/xmp) that does a *minimal* createDecoder({progressionTarget:'header', preserveIcc:true}) + drain just far enough to capture color encoding, then dispose. Cache the Uint8Array on the LevelSource (or coreMemo in plan.ts) by bytes identity — exactly like headerMemo. Never re-decode for ICC.
3. For direct region/ROI path (decodeTiledViewport non-pooled + decodeWhole): after the region decode (or inside the REGION_DECODER if facade region entrypoints can surface it), stamp `result.iccProfile = ensureIccProfile(...)` (shared reference, no clone per viewport or tile).
4. For pooled path: on 'load' (bytesId), main thread (or worker if we teach the worker a cheap ICC probe) calls the ensure helper (or posts the bytes once in load-reply). Stash on pool handle or per-bytesId map. Every decode-reply result gets the same reference stamped in (before or after stitch). One structured clone of small ICC blob per level load, not per tile.
5. Update decode-level.ts (the dc-then-final tile progressive inner decoders and WHOLE_DECODE_OPTS) to respect an outer `preserveMetadata?: boolean` or explicit `wantIcc` from DecodeOptions instead of hard false. When true, pull via ensure after events.
6. In stitch / result sites and cache paths: attach the profile reference (shared). For cache hits with zeroCopy, the profile ref is also stable.
7. Worker protocol: add optional `icc?: Uint8Array` (or `iccId`) to relevant reply / load-reply shapes (once per container). tiled-decode-worker.js: after load or first decodeTileContainer..., query facade for ICC (or have a new thin `getContainerIcc(bytes)` helper) and include once.
8. Test: roundtrip ICC-tagged JXL (tiled + whole) through direct + pooled; assert same Uint8Array (or equal content) on result, and that multiple tiles from same source share the *identical* reference. Also exercise cache hit path.
9. Docs + DecodedLevel: "iccProfile (and exif/xmp) are pass-through from the container. No color transform applied by pyramid. Caller does CMS or passes to canvas/ImageBitmap."

## Efficiency & Speed deltas + features
- Zero per-tile or per-viewport ICC copies after the one minimal capture (shared ref like the pixel outBuffer pattern).
- The ensure helper is lazy and only runs if a consumer actually asks for metadata on a source that has it — no tax on 8-bit sRGB pyramid paths.
- Stretch (very cheap): also surface EXIF/XMP in the same pass (bridge already captures in full decoder state for encode parity; decode side has the getters pattern).
- Feature: DecodeOptions gains `preserveMetadata?: boolean` (or `wantIcc?: boolean`) so callers can opt-in without changing defaults for existing lightbox/gallery (keeps perf parity).
- Interacts nicely with plan 3: the index table preparse + ICC ensure both happen once at LevelSource prepare time.

## Verification (narrow first)
- Existing pyramid unit + worker integration tests (shape change is additive; old destructuring still works).
- New or extended test that exercises ICC round-trip for a tiled level (use a corpus asset or small crafted JXL with non-sRGB profile).
- Typecheck + build of jxl-pyramid + dependent web code.
- Manual: in lightbox or gallery on a wide-gamut master that went through pyramid ingest, inspect the DecodedLevel and confirm profile is present and can be used (e.g. console or a test canvas).
- If color management is later applied in web, a before/after visual on a known P3/ProPhoto asset.

## Risks / open questions
- Lifetime of the ICC bytes returned by the WASM dec_icc_ptr (is it tied to the decoder instance or the container bytes? Must copy if the underlying buffer can be freed).
- Per-tile vs per-level: for pooled path we want exactly one copy of the profile for the whole viewport decode.
- Canvas support: 2D canvas color management is limited / browser-dependent (ImageData colorSpace, OffscreenCanvas, etc.). Exposure is the deliverable; actual application can be follow-up.
- Size: profiles are small (hundreds to few KB); cloning once per level is fine.

**Approval gate**: User must say "approved, execute 4" (or all) before any search_replace or edit. Plans only.
