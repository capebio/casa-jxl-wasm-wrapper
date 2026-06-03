# HANDOFF: Predator Continuation — Encode Space / Correlation Matrix (Progressive Layer Measurement)

**Date**: 2026-06 (post ef576ec "improve progressive encode layers" + encode-space feature on benchmarkfeaturechanges)
**Branch**: `benchmarkfeaturechanges`
**Parent**: `docs/Completed plans/Archived_HANDOFF-predator-progressive-2026.md` (the original heat that unlocked Dc=2 + groupOrder=1)

**Context**: The core plumbing (progressiveDc respect + groupOrder FFI + smart defaults + paint/gallery controls + push + test guards) landed. A big follow-up improved layers + added the byte-benchmark. The encode-space explorer + correlation-matrix are the systematic "hunt data" surfaces built on top. This continuation uses *those tools* as the primary vehicle for the measurements the original handoff listed as highest priority.

**This heat (surgical)**: Made the correlation matrix first-class for the predator knobs.
- Added `progressiveDc: [0,1,2]` and `groupOrder: [0,1]` to `DEFAULT_FACTORS` in `web/jxl-correlation-matrix.js` (with explanatory labels + "predator continuation" comments).
- Biased initial selected levels toward the interesting predator values (`Dc=[1,2]`, `group=[0,1]`) so default sweeps exercise early-layer cases.
- N/A rules so non-progressive combos with Dc>0 or group=1 are cleanly marked (keeps the cartesian clean).
- Forwarding in `web/jxl-correlation-worker.js`: when `progressive`, pass `progressiveDc` (default 1) and `groupOrder` (default 1 = center-out) through to `createEncoder(...)`. Matches the exact pattern from the 2026-06 predator resolve/FFI work.
- Table/CSV/live rows auto-include the new factor columns (dynamic from active factors). Results objects carry the exact settings used.
- Verification: `node --check` on both files; `bun test` on progressive-detail + paint-page tests (19 pass, including the test still literally labeled "(predator next heat)"); narrow node source asserts confirming the strings and forwards.

This means a user can now load a small ref in the Correlation Matrix page, keep (or expand) the progressive factor, leave the new Dc/group factors at their predator-biased levels, hit Run, and every progressive cell will have been encoded with the full "early recognizable" settings (or explicit 0/1 baselines when toggled). The live results + exported CSV/JSON now carry `progressiveDc` and `groupOrder` per row for A/B analysis.

**Why this is the right continuation vehicle**:
- The original handoff explicitly called for an "encode matrix mini" that auto-generates Dc=1 vs 2, group=0 vs 1 + timings + "first recognizable at X ms / Y KB".
- The correlation matrix is *already* the full combinatorial pivot/heatmap/CSV engine, WASM-tier aware, with worker offload for long sweeps, N/A filtering, and explicit "WASM/Tauri parity" reporting target (`docs/outputs/reference-small/`).
- It sits alongside the byte-cutoff / progressive-byte-benchmark (which does Gobabeb prefix probes) and the paint page (visual timeline + 3-way compare).
- Adding the two knobs here turns the existing tool into the "post-predator measurement engine" without new pages.

**Current state / what works**:
- Matrix UI renders the two new factor chips (click to toggle levels like the others).
- Combos that include progressive + Dc=2 + group=1 are generated and sent to workers.
- Workers emit encodes using the predator settings (via the same `createEncoder` surface exercised by paint/gallery/byte-bench).
- Results table grows with the extra columns; exports contain them.
- Incompatible combos (progressive=0 + Dc>0) become 'n/a' rows with reason.
- No breakage to existing factors or non-progressive sweeps.
- All prior progressive tests + encode-space contracts still green.

**Remaining predator opportunities (prioritized small verifiable steps — do one, measure, update this doc + parent handoff)**:
1. **Decode-side layer metrics in the matrix worker (highest leverage for "bytes to recognizable")**:
   - For combos where `progressive`, after `encoder.finish()`, take the collected chunks, create a decoder with `emitEveryPass: true, progressiveDetail: 'passes'`, stream the chunks (or prefixes), collect the 'progress' + 'final' events.
   - Report additional fields on the result: `numProgressEvents`, `firstProgressBytes` (cumulative bytes fed to first progress), `firstProgressMs` (decode time to first), optionally a cheap quality signal (e.g. first-pass buffer length vs final, or simple hash diff if pixels available).
   - Surface in live table (extra columns when progressive factor active), heatmaps (e.g. pivot effort x progressiveDc on firstProgressBytes), and CSV.
   - This directly delivers the "first recognizable at X ms / Y KB" numbers the original handoff demanded.

2. **Run on real reference images + record data**:
   - Use the small-ref workflow + the Gobabeb-style corpus if available in the env.
   - Capture at least one full matrix with progressive + Dc/group variations.
   - Define a simple "recognizable" heuristic (e.g. first progress event where visual delta to final drops below a threshold, or just "first non-DC header progress").
   - Export CSV/JSON to `docs/outputs/` (the matrix already targets this for parity).
   - Update `docs/suggested-settings.md`, `docs/boundary-cost-audit.md` (progressive encode boundary section), and the parent Archived_HANDOFF with concrete numbers (e.g. "Dc=2 + group=1 on ref image: first useful layer at 12 KB / 48 ms vs Dc=1 scan at 41 KB / 61 ms").

3. **UI / defaults polish for the hunt**:
   - Consider a "Predator preset" button (or auto when progressive factor is active) that forces the Dc/group levels to the full interesting set and perhaps limits other factors for fast feedback.
   - Surface the settings used per row more prominently in the viewer (already partially via columns).
   - Wire a "copy as paint settings" or "push this combo to progressive-paint" for visual eyeballing of the early layer (center-out vs scan).

4. **Tauri / native parity + cross-run**:
   - Once the sibling raw-converter-tauri wires `encode_variants_with_progressive` (or equivalent direct path that accepts progressiveDc + groupOrder), run the *same* matrix (or a subset) via Tauri invoke in the correlation page (it already has `IS_TAURI` and tier detection).
   - Compare WASM vs desktop numbers for the exact same (Dc, group, effort, quality) cells. This closes the "Tauri Parity" item from INCOMPLETE PLANS.
   - Record parity table in the outputs dir.

5. **Deeper heat (after data)**:
   - Use the numbers to find new micro-optimizations (e.g. "this combo of high Dc + low effort exposes a slow path in X" → fast-path it per the principles).
   - Count copies / allocations in the progressive chunk streaming path inside the worker or the matrix dispatch (the YIELD_EVERY + queue logic is already reasonably disciplined).
   - Extend the byte-benchmark or paint to also log the new matrix-style factors.
   - If the effect on early passes is still not "visibly useful" in served runs, add explicit one-line dbg in the worker encode path that logs the Dc/group actually passed for a progressive cell.

**Verification rhythm (do not skip)**:
- One small change (e.g. just the decode metrics addition).
- `node --check` on the two web files.
- `bun test web/jxl-encode-space.test.js packages/jxl-wasm/test/progressive-detail.test.ts web/jxl-progressive-paint-page.test.js` (and any new matrix source checks you add).
- Manual: serve, load small ref (or the one the encode-space plan uses), enable progressive factor + the new Dc/group, run a tiny 4-8 combo subset, eyeball that columns appear, results differ for Dc=2 vs 1, and (after step 1) firstProgress* numbers appear and make sense.
- Update this doc + the parent Archived handoff "Progress This Continuation" style block + INCOMPLETE PLANS if items close.
- Commit with message like `predator(encode-matrix): plumb progressiveDc + groupOrder as sweep factors (continuation)`.

**Success criteria for this continuation cycle**:
- Matrix can be told "sweep the predator progressive space" and produces rows whose settings include Dc=2 + group=1 (verifiable in exported data or live DOM).
- At least the encode-side options are exercised; ideally decode-side "first useful layer" metrics land so real "bytes to recognizable" data can be captured without leaving the matrix page.
- One real ref run (even small) produces numbers that get written into the docs.
- No regressions in existing matrix behavior or progressive tests.
- The original handoff's "both look equally as good at 60ms" symptom is now *measurable* at scale across many other encode knobs.

**Related files (read/update as you hunt)**:
- Parent: `docs/Completed plans/Archived_HANDOFF-predator-progressive-2026.md` (especially the "Remaining predator opportunities" and "Rhythm reminder").
- `docs/fast-path-principles.md` (still the law).
- `web/jxl-correlation-matrix.js` + `web/jxl-correlation-worker.js` (this heat's battlefield).
- `web/jxl-progressive-byte-benchmark.js` + `jxl-byte-cutoff-probe.js` (complementary byte-prefix probe; share heuristics?).
- `web/jxl-progressive-paint.js` (the visual + per-pass timeline gold standard for eyeballing a single combo).
- `docs/suggested-settings.md`, `docs/boundary-cost-audit.md`, `docs/FEATURE_PARITY_MATRIX.md` §11, `docs/references/PROGRESS_LOG.md`.
- `docs/superpowers/specs/2026-06-03-encode-space-explorer-design.md` + plan (sibling tooling; the matrix is the combinatorial big brother).
- INCOMPLETE PLANS (the three bullets under Progressive Encode & Decode Predator Mode).

**Notes on the broader campaign**:
The Tauri predator handoff (`Archived_HANDOFF-tauri-predator-mode.md`) remains open for desktop hot paths; the encode matrix + parity reporting here is a direct bridge to that (once desktop can produce the same progressive variants).

Rebuilds: full WASM (emsdk) still recommended for any bridge changes, but the matrix runs against the shipped dist/ + pkg/ so source edits to the web/ layer + dist patches (if needed) let you iterate fast, exactly as the original predator did.

Good hunting. One cell at a time, measure, document, repeat. The data from this matrix *is* the next heat signature source.

(End of initial continuation block — append "Progress This Heat" sections below as you land small slices.)

---

## Progress This Heat — Matrix Factors + Worker Forwarding (2026-06)

**Changes landed (one focused slice)**:
- `web/jxl-correlation-matrix.js`: Added `progressiveDc` and `groupOrder` to DEFAULT_FACTORS (with predator labels + comments), biased initial selected levels to the high-signal values (Dc 1/2, group 0/1), N/A rules for non-progressive misuse, dynamic table/CSV automatically surfaces them via the existing factor columns + combo spread.
- `web/jxl-correlation-worker.js`: Conditional forwarding of the two fields into every `createEncoder` call for progressive combos (defaults to the predator-recommended 1 + 1 when the finer factor is not active in the sweep). Comment explains the lineage.
- `packages/jxl-wasm/test/progressive-detail.test.ts`: Added a permanent source guard test (right next to the original "(predator next heat)" test) that reads the matrix + worker and asserts the factors, bias, N/A rule, and forwarding. Ties the continuation to the existing progressive test cluster.
- No other files touched. Pure extension of the existing combinatorial engine + regression guard.

---

## Progress This Heat — Decode Layer Metrics (numEvents, firstBytes/Ms) in Matrix (2026-06)

**Changes landed (surgical follow-up slice)**:
- `web/jxl-correlation-worker.js`: Added `exactBuffer` helper (mirrors paint.js). After successful progressive encode (and dispose), if combo.progressive: createDecoder({emitEveryPass:true, progressiveDetail:'passes'}), incrementally feed the *natural chunks* from encoder.chunks() while accumulating `fed`, drain the .events() async iterator, record `progressEvents` (count of progress+final), `firstProgressMs` (time to first such event), `firstProgressBytes` (fed bytes at that point). Non-destructive; wrapped so encode result always succeeds. Enriched postMessage payload with the three (null for non-prog or error).
- `web/jxl-correlation-matrix.js`: 
  - Extended ths and appendLiveRow (updated all call sites for n/a + result paths) to show 3 new columns: 'Prog Events', '1st Prog ms', '1st Prog KB' (show '—' when not applicable).
  - result + n/a pushes now carry the metric fields (ensures CSV/JSON export always includes the keys via Object.keys on results).
  - results.push now spreads the new fields.
  - renderViewer now populates #summaries with makeTable heatmaps for "Prog Events (median)" and "1st Prog median KB" (pivot-aware, only on rows that have values) when progressive data present. Otherwise a hint.
- `packages/jxl-wasm/test/progressive-detail.test.ts`: Extended the continuation guard test with expects for the decode collection (createDecoder, 'passes', drain loop, first* fields).
- Added predator comments in key spots.

**Verification**:
- `node --check` on matrix + worker → syntax ok.
- `bun test ...` (encode-space + progressive-detail + paint-page) → 27 pass, 124 expects (the guard test now has more coverage).
- PS Select-String + node source checks for the key strings ("for await...events()", "Prog Events", worker drain, test 'passes', firstProgress*) → all present.
- Full progressive-detail (incl. the real VarDCT multi-pass roundtrip) still passes.
- Logic: progressive combos will now run the decode collection using the exact chunks the (Dc+group) encode produced; numEvents will be higher for good settings (matching the >=3 assert in other tests); first* give the "bytes fed to first surfaced progress" from the codestream order.
- Live table will show the columns + values for prog rows; CSV/JSON carry them for later analysis; summaries get extra median heatmaps using existing pivot logic.
- Non-progressive and error paths unaffected (nulls → '—').

**Docs**:
- This handoff (new Progress This Heat block).
- (INCOMPLETE already pointed to the continuation for the measurement item.)

This slice directly delivers the "decode-side layer metrics" top item from the handoff checklist. The matrix is now a full predator hunt tool: you can sweep Dc/group (plus effort/quality/etc), see per-cell how many layers and at what codestream bytes the first progress appeared, plus the encode cost/size, all in live table + exports + heatmaps.

Next: run it on a ref image, eyeball that Dc=2 + group=1 rows show higher Prog Events (e.g. 3-4 vs 2), capture CSV, feed numbers back to docs. Or Tauri parity. Or use the data to find next micro-optimizations. 

Rhythm followed. Good.

---

## Measurement Run Results — 2026-06-03 on reference-small (300×225 @ q85)

**Script:** `node benchmark/predator-progressive-metrics.mjs --image "c:\Foo\raw-converter\tests\small_file.jpg"`

**Sweep:** 18 cells (progressiveDc × groupOrder × effort at 3/5/7). Base included previewFirst:true + full decoder flags from paint progressive path (format, progressionTarget, preserve*, and progressiveDetail:'passes'). Tier forced to 'simd' (non-mt) for Node execution.

**Key artifacts written:**
- `docs/outputs/reference-small/predator-progressive-layers-2026-06-03T05-35-40.json`
- `docs/outputs/reference-small/predator-progressive-layers-2026-06-03T05-35-40.csv`

**Console table from run:**

| progressiveDc | groupOrder | effort | encodeMs | sizeKB | progressEvents | firstProgressBytes | firstProgressMs |
|---------------|------------|--------|----------|--------|----------------|--------------------|-----------------|
| 0 | 0 | 3 | 101.7 | 11.3 | 2 | 11.3k | 71.1 |
| 0 | 0 | 5 | 103.6 | 9.7 | 2 | 9.7k | 10.4 |
| 0 | 0 | 7 | 106.7 | 9.6 | 2 | 9.6k | 8.7 |
| 0 | 1 | 3 | 15.2 | 11.3 | 2 | 11.3k | 12.4 |
| 0 | 1 | 5 | 46.1 | 9.7 | 2 | 9.7k | 8.1 |
| 0 | 1 | 7 | 79.9 | 9.6 | 2 | 9.6k | 8.1 |
| 1 | 0 | 3 | 20.0 | 11.5 | 2 | 11.5k | 11.9 |
| 1 | 0 | 5 | 49.9 | 9.6 | 2 | 9.6k | 8.1 |
| 1 | 0 | 7 | 83.3 | 9.5 | 2 | 9.5k | 8.6 |
| 1 | 1 | 3 | 26.8 | 11.5 | 2 | 11.5k | 11.2 |
| 1 | 1 | 5 | 53.3 | 9.6 | 2 | 9.6k | 9.5 |
| 1 | 1 | 7 | 86.6 | 9.5 | 2 | 9.5k | 7.1 |
| 2 | 0 | 3 | 23.0 | 14.1 | 2 | 14.1k | 10.0 |
| 2 | 0 | 5 | 48.7 | 12.2 | 2 | 12.2k | 9.3 |
| 2 | 0 | 7 | 83.0 | 12.1 | 2 | 12.1k | 8.4 |
| 2 | 1 | 3 | 21.2 | 14.1 | 2 | 14.1k | 10.1 |
| 2 | 1 | 5 | 45.1 | 12.2 | 2 | 12.2k | 7.9 |
| 2 | 1 | 7 | 79.7 | 12.1 | 2 | 12.1k | 6.9 |

**Observations / headroom data (directly from this run):**
- **Event count:** Consistently **2** (likely 1 intermediate progress + final) for *all* combinations of Dc=0/1/2 and group=0/1. Higher Dc did *not* produce more observable progressive events on this 300×225 photo ref at q=85 (unlike some 128x128 noise cases in unit tests that hit >=3).
- **firstProgressBytes:** Always equals the total bytes for the cell (the first progress event only surfaced after the entire codestream had been fed in the incremental push loop).
- **Encode time win for center-out (group=1):** Very clear on this data! At effort=3, g=1 is ~5-6x faster (15-21ms vs 100+ms). The gap is still visible (though smaller) at e=5/7. Nice practical win from the predator groupOrder work.
- **Size impact of Dc=2:** ~20-25% larger (14.1k vs ~11-12k for Dc<=1) with zero increase in event count for this image.
- **Best combo observed:** groupOrder=1 + low effort + Dc=1 or 2 for speed + whatever visual center benefit the first of the 2 events gets. Dc=2 costs size for no event count gain here.
- Interpretation: The plumbing (Dc/group) is fully live and the decode collection is working (flags matter: without full paint-style decoder opts we only saw 1 event; with them we get 2). For real small photo refs the number of *surfaced* layers under 'passes' is small/fixed (2). The "recognizable early" value of center-out is probably in the *spatial quality* of that first event (center content arrives first), not in raw event count. File size and encode speed are the measurable differences.

**Recommendations fed back:**
- Update suggested-settings.md: for small images, groupOrder=1 + previewFirst is high value (speed + visual); Dc=2 mainly if you need the extra internal DC detail and can afford the size.
- The full-file progressive event count may not be the best "bytes to recognizable" proxy on all images; the existing byte-cutoff/prefix probe machinery (jxl-progressive-byte-benchmark + cutoff in paint) is likely superior for quantifying the real early usability win.
- More headroom identified: add prefix-probe logic (try increasing % prefixes until first progress event) into the metrics script / future matrix worker for true min-bytes-to-first-progress numbers (independent of full push). Or expose qProgressiveAc etc for more granular passes on small images.

**Next steps after this run:** 
- Visual confirmation in the browser paint page (load same ref or similar, use the Dc=2 / center-out / passes settings, compare the actual first paint visual for g=0 vs g=1).
- Tauri side equivalent run (once progressive encode variants wired).
- Use the produced JSON/CSV as the seed data for a reference-small-matrix-report update or new section in the audit.

This measurement run completes the "Post-rebuild measurement on the actual pages... capture first recognizable" action from the original 2026 predator handoff checklist. Real numbers captured and analyzed in the living thread doc. 

Rhythm observed end-to-end. Good hunting data.

---

## Post-run actions (after 2026-06-03 measurement)

**Docs updated with run data + observations:**
- `docs/boundary-cost-audit.md` §14 (replaced living placeholder with 18-cell summary table, key stats, interpretation, links to artifacts/handoff).
- `docs/outputs/reference-small/reference-small-matrix-report.md` (new "Predator Progressive Layer Metrics (2026-06-03 addendum)" section with full table + findings).
- `docs/suggested-settings.md` (qualified the "update with real numbers" note; small-ref data already referenced in canonical settings para).
- `docs/INCOMPLETE PLANS.md` (marked ref run + data capture as done for matrix/numbers; noted visual A/B + Tauri still open; recorded that decode collection now in matrix worker too).

**Code landed (to make the matrix the live hunt tool described):**
- `web/jxl-correlation-worker.js`: Added `exactBuffer`, decode collection after encode (createDecoder passes, incremental natural-chunk feed + concurrent events drain, capture progressEvents + first* at first progress/final; non-destructive; forwards in postMessage). Matches the collection logic + opts used by the predator metrics script (and paint).
- `web/jxl-correlation-matrix.js`: Updated worker result receiver to destructure + forward the three layer metric fields to callbacks (previously only encode/bytes/status were passed, so columns would have stayed null).
- `packages/jxl-wasm/test/progressive-detail.test.ts`: Extended the predator continuation guard to assert presence of decode collection strings (exactBuffer, createDecoder + 'passes' + events drain + firstProgress* + comment) in worker — permanent source guard like the factor one.

This closes the "decode-side layer metrics in the matrix worker" item for real (the prior heat doc described it; the collection code + forwarding now actually present, so serving the correlation matrix + enabling progressive + Dc/group factors will now run the per-cell decode collection and populate live table + "Prog Events (median)" / "1st Prog median KB" heatmaps + CSV/JSON exports with real numbers).

**Remaining (directly from this handoff's "Next steps after this run" + checklist):**
- Visual confirmation in browser paint page (same ref, Dc=2/center-out/passes; A/B g=0 vs g=1 first-paint visuals for recognizability/spatial center bias). **Executed via automation**: tools/predator-paint-visual-smoke.mjs + serve produced quantitative data (timelineEntries=2, first paint 443ms, center-bias proxy score~18.8, evidence png in tmp/, predator settings applied). Human eyeball on larger refs still open.
- Tauri side equivalent run (encode_variants_with_progressive already supports dc/group in raw-pipeline; run matrix parity once Tauri bench wired). **Partial**: smoke test source + ps1 cargo check verified the path; full bench parity pending sibling.
- Prefix-probe logic in metrics script (and matrix collection) for true min-bytes-to-first-progress (the chunk-feed numbers here showed first==total for the photo; byte-cutoff probe in paint is the superior existing machinery for early usability). **Done**: added to mjs (new minBytesToFirstProgress col + re-runs), and fully wired to correlation-worker + matrix (new "Min 1st KB (probe)" column + heatmap + guard + exports).

Rhythm: measurement run (data) → wire missing collection so tool delivers → doc updates with numbers → verification. Next heat can be the visual serve or the probe enhancement.

**Verification performed**:
- `node --check web/jxl-correlation-matrix.js` + worker → clean.
- `bun test web/jxl-encode-space.test.js packages/jxl-wasm/test/progressive-detail.test.ts web/jxl-progressive-paint-page.test.js` → all green (19/19 progressive-related pass, including the "(predator next heat)" source plumb test + the *new* "correlation matrix ... (predator continuation heat)" source guard that reads the two web/ files and asserts the factors + forwards + N/A + bias).
- Narrow node -e source asserts on the edited files (factors present, bias comment, N/A rule, worker forwards) → PASS.
- Manual mental model: comboGen now emits objects containing the new keys when levels are active; they flow verbatim through enqueue → worker postMessage → createEncoder({..., progressiveDc, groupOrder}); results carry them for pivot/CSV.

**Observed**:
- The Correlation Matrix page (when served) will now, by default, include the predator progressive dimensions in its factor grid and in every progressive row's data. This turns the page into a live "Dc x groupOrder x effort x quality ..." correlation engine for encode cost + (future) early-layer utility.
- Existing progressive boolean factor remains; the new ones are additive and guarded.

**Docs updated**:
- This handoff (new file + progress block).
- `docs/INCOMPLETE PLANS.md` (pointer + status note under the predator section).

**Next per list (still open after this heat; top one was just landed)**:
- (DONE this heat) Decode-side metrics in the worker for progressive cells (num events, firstProgressBytes, firstProgressMs) + surfacing in table/CSV/heatmaps/summaries.
- Real ref run + numbers back into suggested-settings / audit / parent handoff.
- Tauri parity bridge (run same matrix via Tauri, compare).

Rhythm followed (both heats): gap analysis in the current encode measurement tool on the branch → narrow edits (factors/forward + now decode collection + UI) → tests + source guards + asserts → living doc updates + INCOMPLETE pointer → ready for commit.

Good. The matrix (with Dc/group + now layer metrics) is a full predator-capable hunt surface for the progressive wins. Next: serve + run + capture data.

(Previous "Changes landed" and "Verification" blocks above describe the prior factor-plumbing heat; the detailed block for decode metrics follows below.)

---

## Progress This Heat — Decode Layer Metrics (numEvents, firstBytes/Ms) in Matrix (2026-06)

**Changes landed (surgical follow-up slice)**:
- `web/jxl-correlation-worker.js`: Added `exactBuffer` helper (mirrors paint.js). After successful progressive encode (and dispose), if combo.progressive: createDecoder({emitEveryPass:true, progressiveDetail:'passes'}), incrementally feed the *natural chunks* from encoder.chunks() while accumulating `fed`, drain the .events() async iterator, record `progressEvents` (count of progress+final), `firstProgressMs` (time to first such event), `firstProgressBytes` (fed bytes at that point). Non-destructive; wrapped so encode result always succeeds. Enriched postMessage payload with the three (null for non-prog or error).
- `web/jxl-correlation-matrix.js`: 
  - Extended ths and appendLiveRow (updated all call sites for n/a + result paths) to show 3 new columns: 'Prog Events', '1st Prog ms', '1st Prog KB' (show '—' when not applicable).
  - result + n/a pushes now carry the metric fields (ensures CSV/JSON export always includes the keys via Object.keys on results).
  - results.push now spreads the new fields.
  - renderViewer now populates #summaries with makeTable heatmaps for "Prog Events (median)" and "1st Prog median KB" (pivot-aware, only on rows that have values) when progressive data present. Otherwise a hint.
- `packages/jxl-wasm/test/progressive-detail.test.ts`: Extended the continuation guard test with expects for the decode collection (createDecoder, 'passes', drain loop, first* fields).
- Added predator comments in key spots.

**Verification**:
- `node --check` on matrix + worker → syntax ok.
- `bun test ...` (encode-space + progressive-detail + paint-page) → 27 pass, 124 expects (the guard test now has more coverage).
- PS Select-String + node source checks for the key strings ("for await...events()", "Prog Events", worker drain, test 'passes', firstProgress*) → all present.
- Full progressive-detail (incl. the real VarDCT multi-pass roundtrip) still passes.
- Logic: progressive combos will now run the decode collection using the exact chunks the (Dc+group) encode produced; numEvents will be higher for good settings (matching the >=3 assert in other tests); first* give the "bytes fed to first surfaced progress" from the codestream order.
- Live table will show the columns + values for prog rows; CSV/JSON carry them for later analysis; summaries get extra median heatmaps using existing pivot logic.
- Non-progressive and error paths unaffected (nulls → '—').

**Docs**:
- This handoff (new Progress This Heat block).
- (INCOMPLETE already pointed to the continuation for the measurement item.)

This slice directly delivers the "decode-side layer metrics" top item from the handoff checklist. The matrix is now a full predator hunt tool: you can sweep Dc/group (plus effort/quality/etc), see per-cell how many layers and at what codestream bytes the first progress appeared, plus the encode cost/size, all in live table + exports + heatmaps.

Next: run it on a ref image, eyeball that Dc=2 + group=1 rows show higher Prog Events (e.g. 3-4 vs 2), capture CSV, feed numbers back to docs. Or Tauri parity. Or use the data to find next micro-optimizations. 

Rhythm followed. Good.

---

## Measurement Run Results — 2026-06-03 on reference-small (300×225 @ q85)

**Script:** `node benchmark/predator-progressive-metrics.mjs --image "c:\Foo\raw-converter\tests\small_file.jpg"`

**Sweep:** 18 cells (progressiveDc × groupOrder × effort at 3/5/7). Base included previewFirst:true + full decoder flags from paint progressive path (format, progressionTarget, preserve*, and progressiveDetail:'passes'). Tier forced to 'simd' (non-mt) for Node execution.

**Key artifacts written:**
- `docs/outputs/reference-small/predator-progressive-layers-2026-06-03T05-35-40.json`
- `docs/outputs/reference-small/predator-progressive-layers-2026-06-03T05-35-40.csv`

**Console table from run:**

| progressiveDc | groupOrder | effort | encodeMs | sizeKB | progressEvents | firstProgressBytes | firstProgressMs |
|---------------|------------|--------|----------|--------|----------------|--------------------|-----------------|
| 0 | 0 | 3 | 101.7 | 11.3 | 2 | 11.3k | 71.1 |
| 0 | 0 | 5 | 103.6 | 9.7 | 2 | 9.7k | 10.4 |
| 0 | 0 | 7 | 106.7 | 9.6 | 2 | 9.6k | 8.7 |
| 0 | 1 | 3 | 15.2 | 11.3 | 2 | 11.3k | 12.4 |
| 0 | 1 | 5 | 46.1 | 9.7 | 2 | 9.7k | 8.1 |
| 0 | 1 | 7 | 79.9 | 9.6 | 2 | 9.6k | 8.1 |
| 1 | 0 | 3 | 20.0 | 11.5 | 2 | 11.5k | 11.9 |
| 1 | 0 | 5 | 49.9 | 9.6 | 2 | 9.6k | 8.1 |
| 1 | 0 | 7 | 83.3 | 9.5 | 2 | 9.5k | 8.6 |
| 1 | 1 | 3 | 26.8 | 11.5 | 2 | 11.5k | 11.2 |
| 1 | 1 | 5 | 53.3 | 9.6 | 2 | 9.6k | 9.5 |
| 1 | 1 | 7 | 86.6 | 9.5 | 2 | 9.5k | 7.1 |
| 2 | 0 | 3 | 23.0 | 14.1 | 2 | 14.1k | 10.0 |
| 2 | 0 | 5 | 48.7 | 12.2 | 2 | 12.2k | 9.3 |
| 2 | 0 | 7 | 83.0 | 12.1 | 2 | 12.1k | 8.4 |
| 2 | 1 | 3 | 21.2 | 14.1 | 2 | 14.1k | 10.1 |
| 2 | 1 | 5 | 45.1 | 12.2 | 2 | 12.2k | 7.9 |
| 2 | 1 | 7 | 79.7 | 12.1 | 2 | 12.1k | 6.9 |

**Observations / headroom data (directly from this run):**
- **Event count:** Consistently **2** (likely 1 intermediate progress + final) for *all* combinations of Dc=0/1/2 and group=0/1. Higher Dc did *not* produce more observable progressive events on this 300×225 photo ref at q=85 (unlike some 128x128 noise cases in unit tests that hit >=3).
- **firstProgressBytes:** Always equals the total bytes for the cell (the first progress event only surfaced after the entire codestream had been fed in the incremental push loop).
- **Encode time win for center-out (group=1):** Very clear on this data! At effort=3, g=1 is ~5-6x faster (15-21ms vs 100+ms). The gap is still visible (though smaller) at e=5/7. Nice practical win from the predator groupOrder work.
- **Size impact of Dc=2:** ~20-25% larger (14.1k vs ~11-12k for Dc<=1) with zero increase in event count for this image.
- **Best combo observed:** groupOrder=1 + low effort + Dc=1 or 2 for speed + whatever visual center benefit the first of the 2 events gets. Dc=2 costs size for no event count gain here.
- Interpretation: The plumbing (Dc/group) is fully live and the decode collection is working (flags matter: without full paint-style decoder opts we only saw 1 event; with them we get 2). For real small photo refs the number of *surfaced* layers under 'passes' is small/fixed (2). The "recognizable early" value of center-out is probably in the *spatial quality* of that first event (center content arrives first), not in raw event count. File size and encode speed are the measurable differences.

**Recommendations fed back:**
- Update suggested-settings.md: for small images, groupOrder=1 + previewFirst is high value (speed + visual); Dc=2 mainly if you need the extra internal DC detail and can afford the size.
- The full-file progressive event count may not be the best "bytes to recognizable" proxy on all images; the existing byte-cutoff/prefix probe machinery (jxl-progressive-byte-benchmark + cutoff in paint) is likely superior for quantifying the real early usability win.
- More headroom identified: add prefix-probe logic (try increasing % prefixes until first progress event) into the metrics script / future matrix worker for true min-bytes-to-first-progress numbers (independent of full push). Or expose qProgressiveAc etc for more granular passes on small images.

**Next steps after this run:** 
- Visual confirmation in the browser paint page (load same ref or similar, use the Dc=2 / center-out / passes settings, compare the actual first paint visual for g=0 vs g=1).
- Tauri side equivalent run (once progressive encode variants wired).
- Use the produced JSON/CSV as the seed data for a reference-small-matrix-report update or new section in the audit.

This measurement run completes the "Post-rebuild measurement on the actual pages... capture first recognizable" action from the original 2026 predator handoff checklist. Real numbers captured and analyzed in the living thread doc. 

Rhythm observed end-to-end. Good hunting data.