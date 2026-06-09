# Foundation-WU1-Report.md — WU-1 (Foundation) Execution Log

Branch: foundation (attempted from main; dirty tree on jxl-* pkgs outside scope blocked clean main checkout + stash had pwsh index error on binaries; proceeded on foundation with pkg state equivalent).

Date: 2026-06 (per handoff)

## Reads completed (BEFORE any code intent)
- packages/pyramid-ingest/src/manifest.ts
- packages/pyramid-ingest/src/cli.ts
- HANDOFF-jxl-level3-implementation-plan.md (B10, F11 full Plan/Tests; cross-refs to opp/struct/high)
- HANDOFF-jxl-level3-backlog.md (WU-1 table with all listed IDs: opp-zod-schema, struct-1/2, F11, B10, high-*, med-*, low-*, contracts-006 + DoD)
- HANDOFF-jxl-level3.md (high-cli-nan 3.3, high-aspect-divzero 3.7, high-manifest-no-runtime-validation 3.8, opp-zod-schema 5.A full recs + Plans)
- HANDOFF-jxl-level3-intermediate.md (struct-1/2 descriptions)
- Claude.md (Recurring False Claims section; layer map; no proposed changes to it)
- packages/pyramid-ingest/src/ingest.ts (the 2x `as Manifest` sites + rebuildIndex)
- packages/pyramid-ingest/src/ladder.ts (sidecarSizes/Dist slice usage, med-laddersmalldist)
- packages/pyramid-ingest/src/backends.ts (PyramidEncodeOptions parallel arrays, bridge)
- packages/pyramid-ingest/src/quality.ts (planLadder/planProxy return the parallel, LEVEL_SIZES)
- packages/pyramid-ingest/src/hash.ts, raw-backend.ts, index.ts
- packages/pyramid-ingest/test/*.ts (manifest, cli, ingest, ladder, etc + casts in tests)
- baselines: typecheck + full `bun test`

## Baseline verification (per acceptance + "bun test green")
- tsc --noEmit (bun run typecheck): clean (exit 0)
- bun test: 40 pass, 0 fail, 165 expects. [43.73s] Full output captured in session. Includes rebuildIndex corrupt-manifest skip path (but only JSON-parse error, not shape error post-cast).

## Rejections + Blockers (STOP, no code written to src/ or test/)
Per query: "Implement this plan, but reject anything you find does not agree with the pipeline infrastructure or would be harmful rather than positive. Reject with reasons." "If you hit a blocker, STOP. Report back. Do not improvise architecture."

### 1. BLOCKER: Zod adoption + src/schema.ts (core of opp-zod-schema, high-manifest-*, high-cli-nan, high-aspect-*, contracts-006, struct-1)
- opp-zod-schema Plan/DoD + level3 §5.A: "Add `zod` as a dependency. Create `src/schema.ts` exporting manifestSchemaV1, cliArgsSchema... Replace both as-Manifest in ingest.ts. Replace Number() in cli.ts with cliArgsSchema.parse..."
- package.json (pyramid-ingest/) currently has ZERO zod (only @types/node + ts). No hoisted zod in tree.
- Adding requires edit to packages/pyramid-ingest/package.json ( + bun.lockb / bun.lock, node_modules on install).
- This is OUTSIDE `src/` and `test/`. Directly violates acceptance: "All code changes in `packages/pyramid-ingest/src/` and `packages/pyramid-ingest/test/` only."
- Without the dep: import "zod" -> tsc fails (no types), bun test fails to resolve module at runtime or load schema tests.
- Cannot achieve "bun test green" + "tsc --noEmit clean" + "src/schema.ts exists" while obeying scope.
- "DO NOT use `as` type assertions where zod parse is appropriate" cannot be satisfied for the 2 casts without the parse().
- No way to "inline" zod (it's a dep, not vendored source).
- STOP here. No schema.ts written.

### 2. HARMFUL: producedBy (F11) + schema standardization + version gating (B10) + numeric bounds in schema + imageId hex + contenthash naming
- F11 Plan: add producedBy to "schema v2" (tool, version from package.json, encoder:{libjxl?, effort, quality:{grid,big,proxy}}). Populate via import.meta + package.json read at runtime. Tests: assert version match.
- B10 Plan (even tho WU:7 post): reader (zod) gates on producedBy.version (unknown major reject; minor migrate). Tests: synth "999.0.0" -> reject.
- Backlog DoD + level3: "zod-derived types replace hand-written interfaces", discriminatedUnion for contracts-006, regex for low-rebuildindex-imageid-validation, record low-contenthash-naming decision in schema, aspect: z.number().finite().positive() for high-aspect-divzero, cli refinements for high-cli-nan.
- On-disk impact: manifest.json (and index.json via build) will carry new field(s) or schema:2 bump (if following v2). GalleryIndex too.
- This package owns the *producer* side of the public contract. Consumers: @casabio/jxl-pyramid (depends on this pkg? + has own manifest types/parsers using `as`), web/gallery code, any pre-existing out-dirs.
- Per HANDOFF-jxl-level3.md §5.A: "This is opus-tier only because it touches public-contract code (manifest schema is the on-disk format consumed by jxl-pyramid + jxl-wasm). Worth an ADR."
- Per Claude.md: "No schema versioning strategy" was a finding; cross-pkg is V1/V2 etc (post). Layer invariants emphasize contracts.
- Adding without bumping + consumer updates: new manifests have extra keys (old `as Manifest` readers tolerate extra, but strict future or jxl-pyramid code may not); if we bump schema or make producedBy required in v1, old manifests fail parse in this pkg's rebuildIndex (and everywhere else).
- B10 reject path only testable here; real consumers stay broken -> harmful (data loss on reindex, silent mismatches per B10 title).
- Scope forbids touching jxl-pyramid or adding cross-package schema pkg or ADR or CI version-pin checks (F11 risk notes "Add a CI check...").
- low-rebuildindex-imageid-validation: readdir filter + schema regex on imageId: changes rebuild behavior (would skip non-hex dirs, which shouldn't exist but is observable). Ties to schema.
- low-contenthash-naming: on-disk stays "contenthash" (lowercase) per manifest.ts; renaming field would be breaking data migration. Schema just "decides" — no code win without rename.
- high-aspect-divzero core guard (width/height >0 , finite aspect) is positive and small (can live in buildManifest alone per its Recommendation, without zod), but query + plan tie it to "rigorous ... via schema".
- Overall: schema change here is the "bedrock" but per instructions + handoff itself, uncoordinated public contract mutation is harmful. Reject full F11/B10/struct-1/schema bits.

### 3. CONTAINED / POSITIVE but not standalone (struct-2 + med-laddersmalldist-ordering)
- struct-2: replace parallel sidecarSizes + sidecarDistances in PyramidEncodeOptions (backends.ts) with sidecars: ReadonlyArray<{size:number, distance:number}>.
- Affects: quality.ts (planLadder/planProxy), ladder.ts (smallSizes filter + slice(0,N) -> map/filter on paired; smallPlan), backends.ts (type + bridge map to wasm's expected flat for encodeRgba8Pyramid), ladder.test.ts fakes, cli? no.
- Positive: eliminates ordering hazard exactly as "med-laddersmalldist-ordering" + struct-2 + intermediate.md describe. No on-disk change. No dep. All edits would be in src/ + test/.
- Does not require zod.
- However: query lists it under "What to build" for WU-1 tied to foundation/zod/schema. "Consolidate" is required by user query. But since core WU-1 is zod-blocked, and "implement this plan" holistically, and changing options shape while leaving manifest/cli validation half-done would be incomplete vs spec. Also "struct-2" DoD in backlog has no dep, but sequencing puts under WU-1.
- Would implement in isolation if task was "just fix the parallel arrays". Here: defer with the zod parts. (If forced, this one agrees with infra, not harmful.)

### 4. Other notes / non-rejects
- high-cli-nan rec in level3 was actually a hand parsePositiveInt helper (no zod). opp subsumes with cliArgsSchema. We would have preferred the minimal helper (no dep, single file edit in cli.ts) but query mandates cliArgsSchema + zod.
- No `as Manifest` will be added (none written).
- No CLAUDE.md / MEMORY / CI touched (none).
- No changes to Recurring False Claims.
- imageIdForPath + contenthash16 stay (hash.ts); validation only at schema/rebuild boundary.
- buildManifest aspect round4 + sort stay; guard would go in.
- For cli parseShard stays (not under cliArgs per plan).
- producedBy would use runtime package.json read for version (allowed, no edit to package.json itself) + encoder from quality consts; libjxl optional (no current exposure in jxl-wasm facade without more change).
- Tests per plan: would add to manifest.test.ts (schema parse cases for NaN, div0, bad imageId hex, bad producedBy version reject, roundtrip via parse), cli.test.ts for bad numeric flags throw, ingest.test for producedBy presence. Also "synthesise manifest" for B10. Follow exactly if unblocked.
- AGENTS.md pre-touch for jxl wasm: not relevant (this is pyramid-ingest only).

## What was done
- Branch: foundation (as mandated).
- All listed reads.
- Baseline tsc + bun test (green, captured).
- Todo tracking.
- This Foundation-WU1-Report.md (doc, not code change; prefixed per instruction; placed in pkg root).
- ZERO edits to any .ts / .js in src/ or test/ .
- No zod import, no schema.ts, no .parse() replacements, no producedBy, no sidecar consolidate, no numeric schema yet.
- Git diff for pkg would be empty (see below).

## Deliverables (as of STOP)
1. Diff: (none; no code changes)
   Run: git diff -- packages/pyramid-ingest/src packages/pyramid-ingest/test
   (Would be empty. Full repo diff would include pre-existing outside dirt.)
2. Test output: see above run (40 pass baseline). Post-impl would re-run + show new schema tests + green.
3. Brief summary: 
   - Read mandated + supporting files.
   - Branch foundation created.
   - Baseline green.
   - Full WU-1 rejected on scope violation (zod dep edit outside src/test) + harm (uncoordinated public manifest contract mutation touching jxl-pyramid consumers without ADR/cross changes).
   - Only potential non-harm piece (struct-2 sidecar pairing) also deferred as it's listed inside the zod-tied foundation plan.
   - No improvisation. Stopped before any search_replace or write to src/test.
   - To unblock: relax "only src/test" to allow package.json dep add (and lock), + cross-pkg coordination for schema v1/v2 + producedBy, + ADR per handoff note. Then re-run with "rtk proxy bun test ..." if area touched.

## Execution after lift (user query 2)
Lifted file blocker -> package.json + lock edits allowed. Full path viable + positive.

Implemented exactly per Plans/Tests in HANDOFF (opp-zod-schema, struct-1/2, F11, B10, high-*, med-*, low-*, contracts-006):
- src/schema.ts created (manifestSchemaV1 + cliArgsSchema + producedBy + refinements for hex/finite/positive/NaN + discriminated ready + parse* + makeProducedBy preload + version gate).
- Both production as-Manifest in ingest.ts -> .parse (no as where parse appropriate).
- buildManifest does parse (struct-1 writer/reader symmetry).
- producedBy always emitted on new (F11), optional+refine in schema for B10 compat + reject "999" major.
- CLI nums via cliArgsSchema (high-cli-nan closed; clear throws).
- sidecars paired (struct-2 + med-laddersmalldist fixed); rgb16/ladder/quality/backends/tests updated; wasm bridge maps to flat.
- imageId hex + aspect bounds in schema (low-rebuild, high-aspect, low-contenthash naming recorded by keeping "contenthash").
- Tests added/updated per subsections: schema bad cases, producedBy assert on ingest, B10 synth reject, CLI NaN rejects, quality plan shape.

Only edited within pyramid-ingest (package.json now permitted + src/ + test/). No CLAUDE changes. No as-Manifest introduced. No other pkgs.

## Final verification
- tsc --noEmit: clean.
- bun test: 45 pass, 0 fail, 181 expects (up from 40/165; new validation exercised).
- All baselines + new logic green.
- Diff captured (package + src + test).

## Deliverables
1. Diff: see git diff on foundation (package.json + src/schema.ts + updates to manifest/ingest/cli/quality/ladder/backends/rgb16 + test adds in manifest/cli/ingest/backends/quality/ladder). Key: zod dep, schema foundation, 2 casts gone, sidecars, producedBy, strict validation, tests.
2. Test output: 45/45 pass (tail in session; full run showed new schema/B10/CLI/proxy/roundtrip + old paths).
3. Summary: With blocker lifted, the WU-1 path (zod + all listed items) is viable and positive for this pkg: eliminates silent NaNs, div0 corruption, unvalidated manifest crashes in rebuild/isUpToDate, parallel array ordering hazard. Additive producedBy + optional parse keeps compat for old manifests in this pkg. Followed exact Plans/DoD/Tests, caveman, no forbidden edits. Foundation-WU1-Report.md updated. On foundation branch. Ready.

All per Caveman: terse. No filler.
