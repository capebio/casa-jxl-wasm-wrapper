export const meta = {
  name: 'comptroller-loop',
  description: 'Supervised find→validate→fix→report loop, ONE batch (≤3), Haiku workers + Sonnet comptroller, per-file branch in a worktree',
  whenToUse: 'Observable, bit-by-bit correctness pass on a single small file with a comptroller supervising',
  phases: [
    { title: 'Find' },
    { title: 'Validate' },
    { title: 'Fix' },
    { title: 'Report' },
  ],
}

// args arrives as a JSON STRING — parse it (see optimize-codec-times root-cause 2026-06-18).
const A = (() => { try { return typeof args === 'string' ? JSON.parse(args) : (args || {}) } catch { return {} } })()
if (A.__probe) { log(`PROBE: A=${JSON.stringify(A)}`); return { probe: true, parsed: A } }

const cfg = {
  targetPath: A.targetPath ?? 'packages/jxl-wasm/src/loader.ts',
  maxFindings: A.maxFindings ?? 3,            // cap before the finder stops + reports
  workerModel: A.workerModel ?? 'haiku',      // Haiku finders/fixers (cheap test phase)
  comptrollerModel: A.comptrollerModel ?? 'sonnet', // Sonnet supervisor (validate + decide)
}
const sanBranch = `fix/${cfg.targetPath.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '')}`

const FINDINGS = { type: 'object', required: ['findings'], properties: { findings: { type: 'array',
  items: { type: 'object', required: ['location', 'issue', 'severity'], properties: {
    location: { type: 'string' }, issue: { type: 'string' },
    severity: { enum: ['high', 'medium', 'low'] }, suggested_fix: { type: 'string' } } } } } }

const VALIDATED = { type: 'object', required: ['items'], properties: { items: { type: 'array',
  items: { type: 'object', required: ['location', 'valid', 'verdict'], properties: {
    location: { type: 'string' }, valid: { type: 'boolean' },
    verdict: { type: 'string' }, fix_instruction: { type: 'string' } } } } } }

const FIXRESULT = { type: 'object', required: ['branch', 'fixed'], properties: {
  branch: { type: 'string' }, commit: { type: 'string' }, worktree: { type: 'string' },
  files: { type: 'array', items: { type: 'string' } }, elapsed_ms: { type: 'number' },
  fixed: { type: 'array', items: { type: 'object', properties: {
    location: { type: 'string' }, change: { type: 'string' } } } },
  failed: { type: 'array', items: { type: 'string' } } } }

const REPORT = { type: 'object', required: ['issues'], properties: {
  all_landed: { type: 'boolean' }, issues: { type: 'array', items: { type: 'object', properties: {
    issue: { type: 'string' }, status: { type: 'string' }, branch: { type: 'string' },
    commit: { type: 'string' }, elapsed_ms: { type: 'number' } } } } } }

// ---- 1. FIND (Haiku, read-only, capped) ----
phase('Find')
log(`comptroller-loop: target=${cfg.targetPath} cap=${cfg.maxFindings} worker=${cfg.workerModel} comptroller=${cfg.comptrollerModel}`)
const found = await agent(
  `READ-ONLY. Examine ${cfg.targetPath}. Find AT MOST ${cfg.maxFindings} low-level CORRECTNESS / cleanup ` +
  `issues — NOT timing/perf (bugs, dead code, unsafe casts, missing null/guard checks, wrong error handling, ` +
  `leaks, type holes). STOP at ${cfg.maxFindings}. Do NOT modify anything, do NOT run git. Return findings ` +
  `(location = line/symbol, issue, severity, suggested_fix).`,
  { model: cfg.workerModel, phase: 'Find', schema: FINDINGS }
)
const findings = (found?.findings ?? []).slice(0, cfg.maxFindings)
log(`FIND (${cfg.workerModel}): ${findings.length} finding(s) on ${cfg.targetPath}`)
for (const f of findings) log(`  • [${f.severity}] ${f.location} — ${f.issue}`)
if (!findings.length) { log('No findings — nothing to do.'); return { target: cfg.targetPath, found: 0, fixed: 0 } }

// ---- 2. VALIDATE (Sonnet comptroller) ----
phase('Validate')
const validated = await agent(
  `You are the COMPTROLLER (supervisor). Validate these findings on ${cfg.targetPath}: ${JSON.stringify(findings)}.\n` +
  `For each: read the actual code, decide if it is REAL, correct, and worth fixing. Reject false positives and ` +
  `nits not worth a change. For valid ones, give a precise fix_instruction. Return the items list.`,
  { model: cfg.comptrollerModel, phase: 'Validate', schema: VALIDATED }
)
const valid = (validated?.items ?? []).filter(v => v.valid)
log(`VALIDATE (comptroller/${cfg.comptrollerModel}): ${valid.length}/${(validated?.items ?? []).length} confirmed`)
for (const v of (validated?.items ?? [])) log(`  • ${v.valid ? '✓' : '✗ rejected'} ${v.location} — ${v.verdict}`)
if (!valid.length) { log('Comptroller rejected all — no fixes this batch.'); return { target: cfg.targetPath, found: findings.length, fixed: 0 } }

// ---- 3. FIX (Haiku fixer, ONE worktree, ONE per-file branch, all valid issues) ----
phase('Fix')
const fixRes = await agent(
  `You are the FIXER. In your isolated worktree, create/checkout branch ${sanBranch}. Fix ONLY these ` +
  `comptroller-validated issues in ${cfg.targetPath}, minimal changes each: ${JSON.stringify(valid)}.\n` +
  `Do NOT run flipflop, do NOT touch other files, do NOT edit the main tree. Build/typecheck if cheap. ` +
  `Commit on ${sanBranch} with a clear message. Time your work. STOP and report: branch, commit sha, worktree ` +
  `path, files touched, per-issue change summary, elapsed_ms, and any failed issues.`,
  { model: cfg.workerModel, phase: 'Fix', isolation: 'worktree', schema: FIXRESULT }
)
log(`FIX (${cfg.workerModel}): branch=${fixRes?.branch} commit=${fixRes?.commit ?? '—'} ` +
    `fixed=${(fixRes?.fixed ?? []).length} failed=${(fixRes?.failed ?? []).length} time=${fixRes?.elapsed_ms ?? '?'}ms`)

// ---- 4. REPORT (comptroller confirms + emits terminal success report) ----
phase('Report')
const report = await agent(
  `You are the COMPTROLLER. The fixer reported: ${JSON.stringify(fixRes)} for branch ${sanBranch} on ` +
  `${cfg.targetPath}. Confirm each validated issue actually landed (inspect the branch diff/commit). ` +
  `Produce a per-issue terminal success report: issue, status (landed/failed), branch, commit, elapsed_ms. ` +
  `Flag anything not landed. Return the issues list + all_landed.`,
  { model: cfg.comptrollerModel, phase: 'Report', schema: REPORT }
)
log(`REPORT (comptroller): all_landed=${report?.all_landed}`)
for (const it of (report?.issues ?? []))
  log(`  ✔ ${it.issue} — ${it.status} | branch=${it.branch} commit=${it.commit} time=${it.elapsed_ms ?? '?'}ms`)
log(`comptroller-loop DONE — one batch on ${cfg.targetPath}. Branch ${sanBranch} ready for review (not merged).`)

return { target: cfg.targetPath, found: findings.length, validated: valid.length,
  fixed: (fixRes?.fixed ?? []).length, branch: sanBranch, commit: fixRes?.commit ?? null,
  all_landed: report?.all_landed ?? false, report: report?.issues ?? [] }
