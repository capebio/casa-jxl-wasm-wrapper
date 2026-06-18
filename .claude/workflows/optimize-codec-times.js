export const meta = {
  name: 'optimize-codec-times',
  description: 'Cut JXL enc/dec + RAW-decode times across all layers; flipflop-verified, quality-gated',
  whenToUse: 'Reduce encode/decode time in raw-converter-wasm with pixel-exact/Butteraugli safety',
  phases: [
    { title: 'Crawl' },
    { title: 'Profile' },
    { title: 'Params' },
    { title: 'Rust' },
    { title: 'CPP' },
    { title: 'Synthesis' },
  ],
}

const CRAWL_SCHEMA = { type: 'object', required: ['files'], properties: { files: { type: 'array',
  items: { type: 'object', required: ['path','layer'],
    properties: { path:{type:'string'}, layer:{enum:['rust','ts','cpp','js','other']} } } } } }

// Lens sweep: what the lens agent EXAMINED (superset of files with findings) + the findings.
// `examined` powers the coverage ledger (examined-but-clean ≠ never-looked).
const SWEEP_SCHEMA = { type: 'object', required: ['examined','findings'], properties: {
  examined: { type: 'array', items: { type: 'string' } },
  findings: { type: 'array', items: { type: 'object',
    required: ['lens','layer','file','location','hypothesis','predicted_gain_pct'],
    properties: { lens:{enum:['aerial','seam','architecture','operational','tactical','mathematical']},
      layer:{type:'string'}, file:{type:'string'}, location:{type:'string'},
      hypothesis:{type:'string'}, predicted_gain_pct:{type:'number'} } } } } }

const BASELINE_SCHEMA = { type: 'object', required: ['rows'], properties: { rows: { type: 'array',
  items: { type: 'object', required: ['file','metric','median_ms','bound_class','trust'],
    properties: { file:{type:'string'}, metric:{type:'string'}, median_ms:{type:'number'},
      dominant_substage:{type:['string','null']}, bound_class:{type:'string'}, trust:{type:'string'} } } } } }

const FINDING_SCHEMA = { type: 'object', required: ['findings'], properties: { findings: { type: 'array',
  items: { type: 'object', required: ['lens','layer','file','location','hypothesis','predicted_gain_pct'],
    properties: { lens:{enum:['aerial','seam','architecture','operational','tactical','mathematical']},
      layer:{type:'string'}, file:{type:'string'}, location:{type:'string'},
      hypothesis:{type:'string'}, predicted_gain_pct:{type:'number'} } } } } }

const VERDICT_SCHEMA = { type: 'object',
  required: ['accepted','accept_reason','saved_pct','quality_ok','reason'],
  properties: { accepted:{type:'boolean'}, accept_reason:{type:['string','null']},
    saved_pct:{type:'number'}, rss_delta_mb:{type:'number'}, quality_ok:{type:'boolean'},
    pixel_exact:{type:'boolean'}, butteraugli_delta:{type:'number'}, bytes_delta:{type:'number'},
    trust:{type:'string'}, reason:{type:'string'} } }

// Altitude (discovery) ladder, widest view first: aerial → seam → architecture → operational → mathematical → tactical.
// Separate verification fast-track: seam + tactical candidates (cheap, no rebuild, safe) bank before architecture rewrites.
const LENSES = [
  { id:'aerial',        charter:'Whole dataflow graph (all files) — widest view. Redundant pipelines; shared-artifact coupling (one RGBA frame forcing viewer reqs on all consumers); passes fusible across files; split measurement/visualization/export pipelines.' },
  { id:'seam',          charter:'Seamhunter (spans scopes — within AND across files; runs every phase). Audit every boundary: JS↔WASM, worker↔main, Rust↔JS, file↔mem, RAW→JXL, AND intra-file function↔function buffer handoffs. Classify each Copy/Transfer/View/Alias; count allocs/copies/traversals; verify transfer lists; check malloc/free reuse. Build Boundary/Buffer-lifecycle/Traversal maps. Every copy guilty until measured. Grep: _malloc _free HEAPU8.set memory.grow "new Uint8Array(" "slice(" Array.from structuredClone "postMessage(" take_rgb rgb_to_rgba toArrayBuffer toClampedTight.' },
  { id:'architecture',  charter:'Within a module/subsystem (subordinate to aerial/seam — view stops at the file). Structural + memory-model patterns INSIDE a unit: ring buffer (allocate-once/reuse-forever), arena/batching, SoA↔AoS, single-owner zero-copy, producer→queue→consumer decouple, event-centric vs object-centric, persistent runtime/pool reuse.' },
  { id:'operational',   charter:'Loops/nests/tiles. Kernel fusion (decode→transform→output, no intermediate buffer), tiling/blocking for cache, pass reduction (one-pass-many-outputs), invariant hoisting.' },
  { id:'mathematical',  charter:'A calculation — different math. Complexity/linear-algebra/numerical-methods + perceptual colour science (apply_tone_math LUT). Polynomial/rational approx, separable kernels, integral images, symmetry/invariants (compose not recompute), closed-form vs iterative. NOTE: lossy — must pass Butteraugli, never claim pixel-exact unless algebraically proven.' },
  { id:'tactical',      charter:'A statement/instruction — micro / fast-path. Specialize dominant concrete type (rgba8/stride4, bpc1), exact integer ratio / power-of-two, integer stepping vs f32, manual tight loop vs iterator chain, defer copy to uncommon path, branch removal, SIMD lane width, bounds-check elision; leave breadcrumb comment.' },
]

// Hot-files seed (Core Hot Files.md + boundary-cost-audit.md) — finders point here first.
const HOT_FILES = [
  'crates/raw-pipeline/src/lib.rs (process_*, process_rgba fused, take_rgb/rgb_to_rgba)',
  'crates/raw-pipeline/src/perceptual/* (gate kernel AND apply_tone_math cost center)',
  'packages/jxl-wasm/src/facade.ts (toArrayBuffer, takeBuffer, input marshal)',
  'packages/jxl-wasm/src/bridge.cpp (malloc, HEAPU8 views, FFI)',
  'packages/jxl-worker-browser/src/decode-handler.ts (toArrayBuffer, JXTC routing)',
  'web/jxl-decode-worker.js (toClampedTight, progressive transfers)',
]

// flipflop interface (verified flipflop.mjs 2026-06-18): variants are async closures returning
// the encode/decode output; quality(out, base, ctx) records a number, qualityDirection 'lower'
// + qualityThreshold → quality_ok; v.role primary|fallback; --inputs feeds real assets;
// saved_pct>0 = faster; per-flip rss_mb is in the journal flips table (parse for leaner deltas).
const FLIPFLOP_NOTE =
  `Verify via flipflop: author a test with benchmark/optimize/flipflop-testgen.mjs (clone the ` +
  `matching benchmark/optimize/templates/<metric>.mjs, append imports + helpers). Variant A=baseline, ` +
  `B=candidate; lossless → equal() pixel-exact, lossy → quality()=Butteraugli. Run ` +
  `node flipflop.mjs <test> --inputs <assets> --print. Read saved_pct/quality/quality_ok/trust ` +
  `from the summary; for leaner candidates parse rss_mb from the journal flips table. If trust:low ` +
  `(throttled), re-run — never bank a hot number. Then evaluate the gate:\n` +
  `  node -e "import('./benchmark/optimize/gate.mjs').then(m=>console.log(JSON.stringify(` +
  `m.evaluate(<verdict>, {butteraugliThreshold:BT,slowdownEpsilon:SE}))))"\nReturn the VERDICT.`

// PROBE: near-instant arg-binding test. `Workflow({name, args:{__probe:true, ...}})` returns
// immediately echoing what the script actually received — 0 agents, 0 cost. Diagnoses whether
// `args` binds for named workflows (both 5h runs ran the full default = args never arrived).
if (typeof args !== 'undefined' && args && args.__probe) {
  log(`PROBE: argsSeen=${JSON.stringify(args)}`)
  return { probe: true, argsSeen: args ?? null, argsType: typeof args }
}

const ALL_LENSES = LENSES.map(l => l.id)
const cfg = {
  targetMetrics: args?.targetMetrics ?? ['photon_prog_enc','mod_prog_enc','raw_decode'],
  fileSubset: args?.fileSubset ?? null,
  targetPath: args?.targetPath ?? null,      // folder mode: a DIR or a single FILE to crawl
  inputs: args?.inputs ?? null,              // flipflop --inputs glob for the corpus (else fractal/defaults)
  layersEnabled: args?.layersEnabled ?? ['params','rust','cpp'],
  lenses: args?.lenses ?? ALL_LENSES,        // whitelist: run ONLY these levels (X,Y,Z)
  excludeLenses: args?.excludeLenses ?? [],  // blacklist: run all EXCEPT these levels
  findOnly: args?.findOnly ?? false,         // read-only: finders + coverage only, NO verify/rebuild/mutation
  surrounding: args?.surrounding ?? true,    // single-file target: also pull in neighbouring/related files for cross-file lenses
  butteraugliThreshold: args?.butteraugliThreshold ?? 1.0,
  rounds: args?.rounds ?? 10,
  slowdownEpsilon: args?.slowdownEpsilon ?? 3,
  allowFallbacks: args?.allowFallbacks ?? true,
}
// Effective lenses = whitelist minus blacklist, preserving the altitude ladder order.
const effLenses = ALL_LENSES.filter(l => cfg.lenses.includes(l) && !cfg.excludeLenses.includes(l))
const gateOpts = `{butteraugliThreshold:${cfg.butteraugliThreshold},slowdownEpsilon:${cfg.slowdownEpsilon}}`
const ffNote = FLIPFLOP_NOTE.replace('BT', cfg.butteraugliThreshold).replace('SE', cfg.slowdownEpsilon)
const inputsFlag = cfg.inputs ? `--inputs ${cfg.inputs}` : ''

// Generic flipflop-verify note for folder mode (bespoke test wrapping the changed unit).
const GENERIC_FF = (file, layer) =>
  `Verify via flipflop: author a bespoke test (benchmark/optimize/flipflop-testgen.mjs) wrapping the ` +
  `changed unit in ${file}. Variant A=current impl, B=candidate, async closures returning the output. ` +
  `If the change is behavior-preserving → equal() exact-output (pixel/byte); if it alters output → ` +
  `quality()=Butteraugli. ${layer === 'rust' || layer === 'cpp'
    ? `Build in a worktree (rust: build-parallel-wasm.ps1 -Features parallel-wasm; cpp: jxl-wasm scripts/build.mjs), flip baseline↔candidate artifact.`
    : `No rebuild — flip configs/impls in-process.`} ` +
  `Run node flipflop.mjs <test> ${inputsFlag} --print; read saved_pct/quality/quality_ok/trust ` +
  `(rss_mb from journal flips for leaner). trust:low → re-run. Then gate.mjs with ${gateOpts}. Return VERDICT.`

// ---- FOLDER MODE: crawl a target dir, lens-tournament, generic flipflop verify ----
if (cfg.targetPath) {
  phase('Crawl')
  log(`folder mode: target=${cfg.targetPath} lenses=[${effLenses.join(',')}]${cfg.findOnly ? ' FIND-ONLY (read-only)' : ''}`)
  const crawl = await agent(
    `READ-ONLY. The target ${cfg.targetPath} may be a single FILE or a DIRECTORY.\n` +
    `- If a directory: recursively list its source files (skip tests, dist, node_modules, target, pkg).\n` +
    `- If a single file: include that file AS THE FOCUS, and${cfg.surrounding
      ? ` ALSO its surrounding/related files (same directory siblings + the files it #includes/imports and the files that include/import it) so cross-file lenses (aerial/seam) have graph context. Mark the focus file vs context files.`
      : ` only that file.`}\n` +
    `Classify each file's layer: rust|ts|cpp|js|other. Return up to 200 most relevant files.`,
    { phase: 'Crawl', schema: CRAWL_SCHEMA }
  )
  const crawled = (crawl?.files ?? []).filter(f => f.layer !== 'other')
  log(`crawl: ${crawled.length} files in scope (focus=${cfg.targetPath})`)

  // One optimizer per lens crawls the file list applying its altitude.
  // Each returns `examined` (every file it looked at) + `findings` → feeds the coverage ledger.
  const sweeps = (await parallel(
    effLenses.map(lensId => () => {
      const lens = LENSES.find(l => l.id === lensId)
      return agent(
        `LENS=${lensId}. ${lens.charter}\n` +
        `READ-ONLY — do NOT modify, build, or run git. Apply THIS lens only across these files ` +
        `(focus on ${cfg.targetPath}): ${JSON.stringify(crawled)}.\n` +
        `Return BOTH: \`examined\` = every file path you actually looked at (even if you found nothing — ` +
        `this is the coverage record), and \`findings\` = concrete speed/memory/dedup wins (each names file + location).`,
        { label: `crawl:${lensId}`, phase: 'Crawl', schema: SWEEP_SCHEMA }
      ).then(r => r && ({ lens: lensId, examined: r.examined ?? [], findings: r.findings ?? [] }))
    })
  )).filter(Boolean)
  const findings = sweeps.flatMap(s => s.findings)
  log(`crawl findings: ${findings.length} across ${sweeps.length} lens sweeps`)

  const crawledPaths = JSON.stringify(crawled.map(f => f.path))
  const sweepData = JSON.stringify(sweeps.map(s => ({ lens: s.lens, examined: s.examined,
    findingsByFile: s.findings.reduce((m, f) => ((m[f.file] = (m[f.file] || 0) + 1), m), {}) })))
  const COVERAGE_STEP =
    `COVERAGE: update docs/outputs/optimize/coverage-ledger.json with benchmark/optimize/coverage.mjs ` +
    `(loadLedger → recordSweep once per lens with a fresh ISO-timestamp run id → saveLedger). Sweep data: ${sweepData}.\n` +
    `GAPS + PRODUCTIVITY: gaps(ledger, ${crawledPaths}, ${JSON.stringify(effLenses)}), saturated(ledger, 2), ` +
    `lensStats(ledger). Report the coverage matrix, the (file×lens) gaps never examined, saturated (dry) vs ` +
    `needs-another-sweep, and the per-lens productivity table (files_examined, total_findings, findings_per_visit, dry_files).`

  // FIND-ONLY: read-only finder pass — record coverage + report findings, NO verify/build/mutation.
  if (cfg.findOnly) {
    const findReport = await agent(
      `Read-only find pass on ${cfg.targetPath} (lenses ${effLenses.join(',')}). ${findings.length} findings: ` +
      `${JSON.stringify(findings)}.\n${COVERAGE_STEP}\nRank findings by predicted_gain_pct. Do NOT implement, build, ` +
      `or run git. Return a markdown report path + the ranked findings + the gaps/re-sweep recommendation.`,
      { phase: 'Crawl' }
    )
    return { mode: 'folder-find', target: cfg.targetPath, findings: findings.length, report: findReport }
  }

  const verdicts = await pipeline(
    findings,
    f => agent(
      `Implement candidate for finding: ${JSON.stringify(f)}.\n` +
      `SAFETY: work ONLY inside your isolated worktree; write scratch only under .work/optimize/. ` +
      `NEVER run git add/commit/stash/checkout/reset and NEVER edit the measurement harness ` +
      `(StandardMultifileTest.mjs). Edit the production caller, not the benchmark.\n` + GENERIC_FF(f.file, f.layer),
      { label: `verify:${f.lens}`, phase: 'Crawl',
        isolation: 'worktree',
        schema: VERDICT_SCHEMA }
    )
  )
  const wins = verdicts.filter(Boolean).filter(v => v.accepted)
  log(`folder banked: ${wins.length}/${verdicts.filter(Boolean).length}`)
  const folderReport = await agent(
    `Synthesize the folder optimization of ${cfg.targetPath}. Banked: ${JSON.stringify(wins)}.\n` +
    `${COVERAGE_STEP}\n` +
    `Write a revert manifest (benchmark/optimize/manifest.mjs, one isolated diff per banked change).\n` +
    `Return a markdown report path + the gaps list + the re-sweep recommendation.`,
    { phase: 'Crawl' }
  )
  return { mode: 'folder', target: cfg.targetPath, banked: wins.length, report: folderReport }
}

// ---- Phase 0: Profile ----
phase('Profile')
const baseline = await agent(
  `Profile the RAW→JXL pipeline. Run the benchmark with the baseline dump:\n` +
  `  node StandardMultifileTest.mjs optimize --json baseline-dump.json\n` +
  `Then parse it:\n` +
  `  node -e "import('./benchmark/optimize/baseline-parse.mjs').then(async m=>{` +
  `const {readFileSync}=await import('node:fs');` +
  `console.log(JSON.stringify({rows:m.parseBaseline(JSON.parse(readFileSync('baseline-dump.json')))}))})"\n` +
  `Return the rows object. Also capture per-file baseline Butteraugli + decoded-RGBA hash + rss ` +
  `(a short flipflop with identical A/B variants gives trust + rss). Flag any row trust:low.`,
  { phase: 'Profile', schema: BASELINE_SCHEMA }
)
const rows = baseline?.rows ?? []
log(`baseline: ${rows.length} metric rows; ${rows.filter(r=>r.trust==='low').length} low-trust`)

// ---- Phase 1: Params (no rebuild) ----
phase('Params')
// Seam first (marshalling boundaries), then math/tactical for param-space.
const paramLenses = effLenses.filter(l => ['seam','mathematical','tactical'].includes(l))
const paramFindings = (await parallel(
  cfg.targetMetrics.filter(m => m !== 'raw_decode').flatMap(metric =>
    paramLenses.map(lensId => () => {
      const lens = LENSES.find(l => l.id === lensId)
      return agent(
        `LENS=${lensId}. ${lens.charter}\n` +
        `Target metric: ${metric}. Layer: encoder params/flags (no rebuild).\n` +
        `Read packages/jxl-wasm/src/facade.ts + the encode-handler for every exposed knob ` +
        `(distance, effort, progressive flavor, photonNoiseIso, modular flags, chunk size).\n` +
        `Propose param candidates for THIS lens only. Return findings.`,
        { label: `params:${metric}:${lensId}`, phase: 'Params', schema: FINDING_SCHEMA }
      )
    })
  )
)).filter(Boolean).flatMap(r => r.findings ?? [])
log(`params findings: ${paramFindings.length}`)

const paramVerdicts = await pipeline(
  paramFindings,
  f => agent(
    `Implement param candidate (config-only, no rebuild) for finding: ${JSON.stringify(f)}.\n` + ffNote,
    { label: `verify:${f.lens}`, phase: 'Params', schema: VERDICT_SCHEMA }
  )
)
const paramWins = paramVerdicts.filter(Boolean).filter(v => v.accepted)
log(`params banked: ${paramWins.length}/${paramVerdicts.filter(Boolean).length}`)

// ---- Phase 2: Rust (one rebuild barrier) ----
phase('Rust')
let rustWins = []
if (cfg.layersEnabled.includes('rust')) {
  const rustFindings = (await parallel(
    effLenses.map(lensId => () => {
      const lens = LENSES.find(l => l.id === lensId)
      return agent(
        `LENS=${lensId}. ${lens.charter}\n` +
        `Layer: crates/raw-pipeline (RAW decode). Baseline rows: ${JSON.stringify(rows.filter(r=>r.metric==='raw_decode'))}.\n` +
        `Hot-files seed (start here): ${HOT_FILES.join('; ')}.\n` +
        `Target the dominant substage per file. Known low-hanging (tactical): wire ` +
        `tone_simd::apply_tone_bulk into process_into (exists on a branch, not wired).\n` +
        `Return findings for THIS lens only.`,
        { label: `rust:${lensId}`, phase: 'Rust', isolation: 'worktree', schema: FINDING_SCHEMA }
      )
    })
  )).filter(Boolean).flatMap(r => r.findings ?? [])
  log(`rust findings: ${rustFindings.length}`)

  const integrated = await agent(
    `Integrate Rust candidates: ${JSON.stringify(rustFindings)}.\n` +
    `For each, produce a minimal diff in an isolated worktree. Apply the non-conflicting winning set to ` +
    `one working copy, then ONE rebuild: .\\build-parallel-wasm.ps1 -Features parallel-wasm.\n` +
    `Verify: cd crates/raw-pipeline && cargo test --no-default-features --lib (must pass).\n` +
    `Then flipflop each change (variant A=baseline pkg, B=candidate pkg) over the raw-decode template; ` +
    `RAW decode is deterministic → equal() pixel-exact, zero tolerance. Run gate.mjs with ${gateOpts}.\n` +
    `Save each accepted diff to patches/<id>.diff and return one VERDICT per change.`,
    { label: 'rust:integrate', phase: 'Rust', isolation: 'worktree', schema: { type:'object',
      properties: { verdicts: { type:'array', items: VERDICT_SCHEMA } }, required:['verdicts'] } }
  )
  rustWins = (integrated?.verdicts ?? []).filter(v => v.accepted)
  log(`rust banked: ${rustWins.length}`)
}

// ---- Phase 3: C++ (gated by bound_class) ----
phase('CPP')
let cppWins = []
const codecBound = rows.some(r => cfg.targetMetrics.includes(r.metric) && r.bound_class === 'codec-kernel')
if (cfg.layersEnabled.includes('cpp') && codecBound) {
  const cppLenses = effLenses.filter(l => ['seam','architecture','operational','tactical','mathematical'].includes(l))
  const cppFindings = (await parallel(
    cppLenses.map(lensId => () => {
      const lens = LENSES.find(l => l.id === lensId)
      return agent(
        `LENS=${lensId}. ${lens.charter}\n` +
        `Layer: libjxl bridge (packages/jxl-wasm/src/bridge.cpp + external/libjxl). ` +
        `Target the codec-kernel path for ${cfg.targetMetrics.join(', ')} ` +
        `(photon-noise synth / modular encode / progressive AC). Return findings for THIS lens only.`,
        { label: `cpp:${lensId}`, phase: 'CPP', isolation: 'worktree', schema: FINDING_SCHEMA }
      )
    })
  )).filter(Boolean).flatMap(r => r.findings ?? [])

  const ranked = cppFindings.sort((a,b) => b.predicted_gain_pct - a.predicted_gain_pct)
  const taken = ranked.slice(0, 3)
  if (ranked.length > 3) log(`CPP cap: dropped ${ranked.length - 3} candidates: ${ranked.slice(3).map(f=>f.location).join('; ')}`)

  const cppVerdicts = await pipeline(
    taken,
    f => agent(
      `Implement C++ candidate ${JSON.stringify(f)} in a worktree. Emscripten rebuild ` +
      `(node packages/jxl-wasm/scripts/build.mjs). flipflop A=baseline core, B=candidate core; ` +
      `lossless paths equal() pixel-exact, lossy quality() Butteraugli ≤ ${cfg.butteraugliThreshold}. ` +
      `Run full lib test + gate.mjs with ${gateOpts}. Save accepted diff to patches/. Return VERDICT.`,
      { label: `cpp:verify`, phase: 'CPP', isolation: 'worktree', schema: VERDICT_SCHEMA }
    )
  )
  cppWins = cppVerdicts.filter(Boolean).filter(v => v.accepted)
  log(`cpp banked: ${cppWins.length}`)
} else {
  log(`CPP phase skipped (codecBound=${codecBound}, enabled=${cfg.layersEnabled.includes('cpp')})`)
}

// ---- Phase 4: Synthesis ----
phase('Synthesis')
const allWins = [...paramWins, ...rustWins, ...cppWins]
const report = await agent(
  `Synthesize the optimization run. Banked changes: ${JSON.stringify(allWins)}.\n` +
  `Re-run full benchmark (node StandardMultifileTest.mjs optimize --json after-dump.json) with all banked ` +
  `changes applied; compare to the Phase-0 baseline per metric (speed, quality, bytes, rss).\n` +
  `Write a revert manifest using benchmark/optimize/manifest.mjs (one isolated diff per change).\n` +
  `Return a markdown report path + a one-line verdict per target metric.`,
  { phase: 'Synthesis' }
)
const critic = await agent(
  `Completeness critic. Given baseline rows ${JSON.stringify(rows)} and banked ${JSON.stringify(allWins)}: ` +
  `what was NOT tried (lens×layer×metric gaps), what regressed, what is deferred? ` +
  `Return a deferred-work list (QUESTIONS-style).`,
  { phase: 'Synthesis' }
)
return { banked: allWins.length, report, deferred: critic }
