# Plan: Agent 6 Item 3 — JXTC v2 TypeScript reader (pairs with 2.9)

**Status**: One-page plan. No source edits. Approval required before any change.

## Goal
Extend the pure-TS JXTC reader (parseJxtcHeader + extract + LevelSource / manifest handling) to tolerate / support version 2 containers (per bridge.cpp header comment "version (1 or 2)"), ensure the 16-bit flag path is complete and documented, and add (or formalize) a level-table / tile-index reader for the offset table that follows the 32B header.

## Merit (pipeline context)
- bridge.cpp:1490 comment explicitly sketches JXTC header as magic | version (1 or 2) | ...
- Current TS (tiling.ts:41): `if (view.getUint32(4, true) !== 1) throw "unsupported JXTC version"` — hard gate.
- jxl-wasm/test/jxtc.test.ts already has a test expecting version=2 to be "unsupported".
- 16-bit flag (flags & 2) is already parsed in parseJxtcHeader and wired to bitsPerSample + decodeTileContainerRegionRgba16 in decode-core + tiled-decode-pool + level-source.
- manifest.ts already declares schema: 1 | 2 and V2+ additive fields (producedBy, stub, metadata, convergedByteEnd).
- pyramid-ingest produces manifests; jxl-pyramid is the reader. Drift between v1/v2 on either side will break tiled massive images.
- "level-table reader": the tile index (after 32B header: tilesX*tilesY * 8B (off,len) entries) is parsed inside extractTileBitstream. A v2 change to layout, sparse levels, or multi-level table would require an explicit typed reader instead of ad-hoc DataView math. Positive for future JXTC evolution and for any direct (non-pyramid) JXTC consumers.
- Positive contribution: forward compat so that when bridge/ingest start emitting v2 (or 16-bit tiled at scale), the TS side does not explode.

## Constraints / invariants
- Keep strict v1 behavior and errors for bad v1.
- Do not relax adversarial / OOM guards added in G4-A (dims, tile count, total bytes caps) — they must apply to v2 as well.
- extractTileBitstream is used for progressive DC-then-final (F1) and future per-tile createDecoder paths — any table reader change must preserve zero-copy subarray semantics.
- Pyramid manifest schema 2 fields are already additive; reader must tolerate unknown keys (current interfaces do via ?).
- No change to the WASM decodeTileContainerRegion* entrypoints themselves (they live in bridge + facade); this is the pure-TS container framing layer.
- rejected optimizations.md: previous broad pyramid surface expansions rejected; this is narrow (header version + table reader + 16-bit completeness).

## Files / cross-file surface
- packages/jxl-pyramid/src/tiling.ts (parseJxtcHeader, isJxtcContainer, extractTileBitstream, JxtcHeader type, constants)
- packages/jxl-pyramid/src/level-source.ts (createLevelSource trusts header after parse; may need version exposure)
- packages/jxl-pyramid/src/manifest.ts (ensure PyramidLevel + PyramidManifest v2 fields are sufficient; possibly add jxtcVersion?: 1|2)
- packages/jxl-pyramid/src/decode-core.ts + tiled-decode-pool.ts (if they re-derive or assert version)
- Test: packages/jxl-pyramid/test/* + packages/jxl-wasm/test/jxtc.test.ts (the v2 "unsupported" test will become "supported" or version-aware)
- Consumers: web/lightbox/tiled-decode-worker.js (indirect via pool), pyramid-ingest roundtrips.
- Bridge side for the writer half (to keep in sync) — out of scope for this TS plan but noted.

## One-page sketch (minimal steps)
1. Update parseJxtcHeader (and memoParseHeader in plan.ts) to read version (u32@4), accept 1|2, throw only on >2 or bad magic. Add `version: 1|2` to JxtcHeader (plan.ts already extends it with version).
2. **Major speed win (level-table reader):** In prepareLevelSource / first prepareDecodePlan (or a new prepareJxtcIndex), parse the *entire* tile index table once after the 32B header into two Uint32Arrays (or one interleaved) on the LevelSource: `tileOffsets: Uint32Array, tileLengths: Uint32Array` (or internal symbol). Store under WeakMap or directly (like bytesId). Size = tilesX*tilesY. This is O(1) after one pass.
3. Rewrite extractTileBitstream (keep old DataView path for v1 compat or small containers) to have fast path: if source has pre-parsed index arrays, do `const off = tileOffsets[idx]; const len=...; return container.subarray(base + off, ...)` — pure arithmetic + subarray, zero DataView, zero re-read of magic/dims per tile. Update the call in decode-level.ts:177 (the dc-then-final pre-extract map) and any other.
4. In extract + tilesOverlapping etc, branch only on version for stride / extra fields if v2 adds them. v1 path remains bit-identical and fast.
5. Carry `header.version` (and the index arrays) on tiled LevelSource + DecodePlan. Update createLevelSource + plan.ts memo to use the extended header.
6. manifest.ts: add optional `jxtcVersion?: 1|2` to PyramidLevel (additive, tolerant). pyramid-ingest roundtrips continue to work.
7. Tests: parameterize jxtc.test "version 2" case to exercise tolerant parse + fast extract (synthetic header with v=2 + identical layout for now). Add test that pre-parsed index produces identical subarrays as old path for 100 random tiles. Keep the "truly bad version 102" error.
8. Update stale comments (tile size "rgba8 only in v1", etc.). Update plan.ts headerMemo to carry real version.

## Efficiency & Speed deltas (the point of the level-table reader)
- Hot path win: dc-then-final in decode-level.ts does N extracts per progressive viewport (pre-extract list for both passes). Current: N * (DataView + 5+ gets + math + bounds). After: 1x full table parse (at LevelSource prepare) + N * (array[idx] + subarray). Eliminates per-tile DataView tax during every pan/zoom frame.
- Also benefits any future per-tile createDecoder or butteraugli-per-tile paths.
- v2 support becomes the natural extension point for the table reader (different entry size, per-tile flags, 64-bit offs, sparse levels) without touching extract callers.
- Memory: two Uint32Arrays of tilesX*tilesY (for 16x16 tiles on a 8k image: ~2k entries, 16KB — trivial, lives with the container bytes). Weak lifetime tied to source.
- plan.ts already has headerMemo + coreMemo — extend the memo to also hold (or trigger) the index table parse. Zero extra allocations on repeat prepareDecodePlan for same source.

## Verification (narrow first)
- `bun test packages/jxl-pyramid/test/tiling.test.ts` + `pyramid.test.ts` (roundtrip already exists for synthetic JXTC).
- `bun test packages/jxl-wasm/test/jxtc.test.ts` (the version=102 case must not regress for truly bad versions; v2 path exercised or explicitly skipped with reason).
- `bun test packages/jxl-pyramid/test/decode-level.test.ts` etc. that use createLevelSource.
- Property or header test: feed header with version=2 + same fields as v1; assert parse succeeds and extract returns identical subarray for a tile.
- If pyramid-ingest has v2 manifest tests: run them.
- Full workspace build + typecheck.

## Risks / open questions
- Exact v2 delta is not yet in the TS tree (only the comment + "unsupported" test). Plan assumes the 32B header + index table shape stays compatible or has a known extension point. If v2 changes index entry size, magic-after-header, or adds a level directory, the table reader must be updated from the bridge side simultaneously. The pre-parsed Uint32Arrays make that change localized to one reader function.
- 16-bit flag (already implemented) may have been the main v2 motivator; if v2 is only a version bump with no layout change yet, this is mostly "tolerant parser + table helper" + the speed win from pre-parsed index.
- Unknown: when will ingest/bridge actually start emitting v2 containers with new features? The plan makes the TS side ready without blocking.

**Approval gate**: User must say "approved, execute 3" (or all) before any search_replace or edit. Plans only.
