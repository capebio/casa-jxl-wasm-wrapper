# optimize-codec-times — usage

Reusable optimization workflow. Oracle = flipflop. Gate = pixel-exact (lossless) /
Butteraugli ≤1.0 (lossy) + acceptance (faster OR memory/dedup/feature).

Full run:    Workflow({ name: 'optimize-codec-times' })
Params only: Workflow({ name: 'optimize-codec-times', args: { layersEnabled: ['params'] } })
One metric:  args: { targetMetrics: ['raw_decode'] }
Lens subset: args: { lenses: ['aerial','seam'] }
Cheap smoke: args: { targetMetrics: ['photon_prog_enc'], layersEnabled: ['params'], lenses: ['tactical'], rounds: 2 }

FOLDER MODE — crawl a target dir, lens-tournament every source file, flipflop-verify each change:
  args: { targetPath: 'crates/raw-pipeline/src' }
  args: { targetPath: 'packages/jxl-wasm/src', lenses: ['seam','tactical'], inputs: 'C:/995/**/*.ORF' }
When targetPath is set the metric phases are skipped; finders crawl the folder (classifying each
file's layer), the optimizer authors a bespoke flipflop test wrapping the changed unit, and rebuild
happens only for rust/cpp files. inputs = a flipflop --inputs glob (your own corpus); else defaults.

args: { targetMetrics?, fileSubset?, targetPath?, inputs?, layersEnabled?, lenses?,
        butteraugliThreshold?, rounds?, slowdownEpsilon?, allowFallbacks? }

Lenses (altitude ladder, widest first): aerial, seam, architecture, operational, mathematical,
tactical. Seamhunter (seam) runs every phase. Verification fast-track banks cheap seam/tactical
wins before rebuild-heavy architecture rewrites.

Outputs: per-metric speed/quality/rss deltas, a revert manifest (patches/ + manifest.md,
cherry-pick to land), and a deferred-work list. Idempotent — re-running on optimized code banks nothing.

Prereqs:
- flipflop skill installed (node flipflop.mjs --help works). Verified to provide async variants,
  quality() hook, --inputs, and variant role tags.
- helper tests green: node --test benchmark/optimize/test/*.test.mjs (Node 24 needs the glob).
