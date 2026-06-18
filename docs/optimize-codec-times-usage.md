# optimize-codec-times — usage

Reusable optimization workflow. Oracle = flipflop. Gate = pixel-exact (lossless) /
Butteraugli ≤1.0 (lossy) + acceptance (faster OR memory/dedup/feature).

Full run:    Workflow({ name: 'optimize-codec-times' })
Params only: Workflow({ name: 'optimize-codec-times', args: { layersEnabled: ['params'] } })
One metric:  args: { targetMetrics: ['raw_decode'] }
Lens subset: args: { lenses: ['aerial','seam'] }
Cheap smoke: args: { targetMetrics: ['photon_prog_enc'], layersEnabled: ['params'], lenses: ['tactical'], rounds: 2 }

FOLDER MODE — crawl a target (DIR or single FILE), lens-tournament, flipflop-verify each change:
  Dir:          args: { targetPath: 'crates/raw-pipeline/src' }
  Single file:  args: { targetPath: 'packages/jxl-wasm/src/bridge.cpp' }   // + surrounding/related files for cross-file lenses
  Find-only:    args: { targetPath: '.../bridge.cpp', lenses: ['aerial'], findOnly: true }  // READ-ONLY: finders+coverage, NO build/mutation/git

LENS LEVEL SELECTION:
  Run only X,Y,Z:   args: { lenses: ['aerial','seam'] }
  Run all except:   args: { excludeLenses: ['mathematical','operational'] }
  Exclusively one:  args: { lenses: ['aerial'] }
(effective lenses = whitelist minus blacklist, kept in altitude-ladder order.)

When targetPath is set the metric phases are skipped; finders crawl the target (single files pull in
surrounding/related files so aerial/seam have graph context), the optimizer authors a bespoke flipflop
test wrapping the changed unit, rebuild only for rust/cpp. findOnly stops after the read-only finder
pass (no build, no edits, no git) — the safe way to scout a file. inputs = flipflop --inputs corpus glob.

args: { targetMetrics?, fileSubset?, targetPath?, inputs?, layersEnabled?, lenses?, excludeLenses?,
        findOnly?, surrounding?, butteraugliThreshold?, rounds?, slowdownEpsilon?, allowFallbacks? }

Lenses (altitude ladder, widest first): aerial, seam, architecture, operational, mathematical,
tactical. Seamhunter (seam) runs every phase. Verification fast-track banks cheap seam/tactical
wins before rebuild-heavy architecture rewrites.

Outputs: per-metric speed/quality/rss deltas, a revert manifest (patches/ + manifest.md,
cherry-pick to land), and a deferred-work list. Idempotent — re-running on optimized code banks nothing.

COVERAGE LEDGER (folder mode): docs/outputs/optimize/coverage-ledger.json records, per (file × lens),
how many times an agent EXAMINED it (examined-but-clean ≠ never-looked). The report names:
- gaps — (file,lens) pairs never examined → re-run to fill them.
- saturated — pairs examined ≥2× whose last sweep found nothing → dry, stop sweeping.
- lensStats — per-lens productivity (files_examined, total_findings, findings_per_visit, dry_files),
  sorted most-productive first → shows which lens earns its keep.
Re-running folder mode on the same path accumulates visits, so you can sweep until coverage is
complete AND the last sweep is dry. Inspect anytime:
  node -e "import('./benchmark/optimize/coverage.mjs').then(async m=>{const {readFileSync}=await import('node:fs');const L=m.loadLedger('docs/outputs/optimize/coverage-ledger.json');console.log(m.matrix(L,Object.keys(L.files),['aerial','seam','architecture','tactical']))})"

Prereqs:
- flipflop skill installed (node flipflop.mjs --help works). Verified to provide async variants,
  quality() hook, --inputs, and variant role tags.
- helper tests green: node --test benchmark/optimize/test/*.test.mjs (Node 24 needs the glob).
