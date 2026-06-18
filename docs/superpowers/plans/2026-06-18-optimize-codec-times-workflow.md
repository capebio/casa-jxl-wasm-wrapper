# optimize-codec-times Workflow — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reusable Opus-xhigh `Workflow` (`optimize-codec-times`) that cuts JXL encode/decode and RAW-decode times across all layers, banking only changes that pass a quality gate (pixel-exact lossless / Butteraugli lossy) plus an acceptance test (faster, or equal/slightly-slower with a verified memory/dedup/feature gain), verified by the `flipflop` skill.

**Architecture:** Layered escalation (profile → params → Rust → gated C++ → synthesis) with a 6-lens tournament (Seamhunter/Architecture/Aerial/Operational/Mathematical/Tactical, applied in that impact-descending ladder) as the diversity axis. Seamhunter (boundary/edge/IO auditor) runs in every phase. The Workflow runtime is pure orchestration (no fs/Node); all I/O-bearing logic lives in standalone node **helpers** that workflow agents invoke via Bash/Write. flipflop is the A/B timing oracle.

**Tech Stack:** Node `.mjs` (zero npm deps, `node --test`), the `Workflow` tool (JS orchestration script), the `flipflop` skill, existing `crates/raw-pipeline` perceptual kernel, `StandardMultifileTest.mjs`.

**Spec:** `docs/superpowers/specs/2026-06-18-optimize-codec-times-workflow-design.md`

---

## PREREQUISITE GATE

The Workflow (Tasks 6–7) cannot be **run** until the `flipflop` skill is installed and provides the codec-role capabilities (async variants, `quality()` hook, bring-your-own inputs, variant role tags — spec §3). Tasks 1–5 (helpers + harness dump + templates) have **no flipflop dependency** and are built and tested first. Task 6 assembles the workflow; Task 7 is a flipflop-gated smoke run.

## File Structure

| File | Responsibility |
|------|----------------|
| `benchmark/optimize/harness-dump.mjs` | Add deterministic `--json <path>` result dump to a bench run (consumed as baseline source). Pure serializer + thin CLI. |
| `benchmark/optimize/baseline-parse.mjs` | Read the dumped JSON → `baseline.json` (per file×metric median, dominant substage, bound_class, quality/mem baselines). Pure. |
| `benchmark/optimize/gate.mjs` | §5a quality gate + §5b acceptance decision from a verdict input → `{accepted, accept_reason, reason}`. Pure. |
| `benchmark/optimize/flipflop-testgen.mjs` | Emit a `.flipflop/tests/<name>.mjs` test file for a (metric, baselineVariant, candidateVariant) triple. Pure string builder. |
| `benchmark/optimize/manifest.mjs` | Append a banked change to a revert manifest (isolated diff + verdict). Pure. |
| `benchmark/optimize/test/*.test.mjs` | `node --test` unit tests for each helper. |
| `.claude/workflows/optimize-codec-times.js` | The Workflow script: meta, phases, lens-charter agent prompts, schemas, gating. Orchestration only. |
| `.flipflop/tests/templates/{photon,modular,raw-decode}.mjs` | Per-metric flipflop test templates the param/Rust agents clone. |

---

## Task 1: Harness JSON dump

**Files:**
- Create: `benchmark/optimize/harness-dump.mjs`
- Test: `benchmark/optimize/test/harness-dump.test.mjs`

Baseline source must be deterministic, not fragile stdout regex. `StandardMultifileTest.mjs` already builds `loadedFiles` (raw substages: `rawDecompress/rawDemosaic/rawTonemap/rawOrient`, lines 430-435) and `simdResults/mtResults` (which carry `photon_prog_enc_ms`, `mod_prog_enc_ms`, `prog_enc_ms`, `shot_dec_ms`, lines 697-728). This helper serializes those arrays to a stable JSON shape.

- [ ] **Step 1: Write the failing test**

```js
// benchmark/optimize/test/harness-dump.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDump } from '../harness-dump.mjs';

test('buildDump merges loadedFiles raw substages with results metrics', () => {
  const loadedFiles = [{ file: 'a.dng', rawDecompress: 10, rawDemosaic: 20, rawTonemap: 70, rawOrient: 1 }];
  const simdResults = [{ file: 'a.dng', prog_enc_ms: 100, shot_dec_ms: 50, photon_prog_enc_ms: 300, mod_prog_enc_ms: 280 }];
  const telemetry = { cpuModel: 'X', cpuThrottlingPct: '100.0' };
  const dump = buildDump({ loadedFiles, simdResults, mtResults: [], telemetry });
  assert.equal(dump.schema, 'optimize-baseline/v1');
  assert.equal(dump.files[0].file, 'a.dng');
  assert.equal(dump.files[0].raw.tonemap_ms, 70);
  assert.equal(dump.files[0].metrics.photon_prog_enc_ms, 300);
  assert.equal(dump.telemetry.cpuThrottlingPct, '100.0');
});

test('buildDump tolerates missing arrays', () => {
  const dump = buildDump({ loadedFiles: [], simdResults: [], mtResults: [], telemetry: {} });
  assert.deepEqual(dump.files, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test benchmark/optimize/test/harness-dump.test.mjs`
Expected: FAIL — `Cannot find module '../harness-dump.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```js
// benchmark/optimize/harness-dump.mjs
// Deterministic serializer for StandardMultifileTest result arrays → baseline source JSON.
import { writeFileSync } from 'node:fs';

export function buildDump({ loadedFiles = [], simdResults = [], mtResults = [], telemetry = {} }) {
  const bySim = new Map(simdResults.map(r => [r.file, r]));
  const byMt = new Map(mtResults.map(r => [r.file, r]));
  const files = loadedFiles.map(f => {
    const s = bySim.get(f.file) || {};
    const m = byMt.get(f.file) || {};
    return {
      file: f.file,
      raw: {
        decompress_ms: f.rawDecompress ?? 0,
        demosaic_ms: f.rawDemosaic ?? 0,
        tonemap_ms: f.rawTonemap ?? 0,
        orient_ms: f.rawOrient ?? 0,
      },
      metrics: {
        prog_enc_ms: s.prog_enc_ms ?? 0,
        shot_dec_ms: s.shot_dec_ms ?? 0,
        photon_prog_enc_ms: s.photon_prog_enc_ms ?? 0,
        mod_prog_enc_ms: s.mod_prog_enc_ms ?? 0,
        mt_prog_enc_ms: m.prog_enc_ms ?? 0,
        mt_shot_dec_ms: m.shot_dec_ms ?? 0,
      },
    };
  });
  return { schema: 'optimize-baseline/v1', telemetry, files };
}

export function writeDump(path, payload) {
  writeFileSync(path, JSON.stringify(buildDump(payload), null, 2));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test benchmark/optimize/test/harness-dump.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire the dump into StandardMultifileTest.mjs (opt-in, no behavior change)**

In `StandardMultifileTest.mjs`, after `mtResults` is computed (after line 746), add:

```js
  // Optional baseline dump for optimize-codec-times workflow (opt-in via --json).
  const jsonIdx = process.argv.indexOf('--json');
  if (jsonIdx !== -1 && process.argv[jsonIdx + 1]) {
    const { writeDump } = await import('./benchmark/optimize/harness-dump.mjs');
    writeDump(process.argv[jsonIdx + 1], { loadedFiles, simdResults, mtResults, telemetry: globalThis.systemTelemetry });
    console.log(`  baseline dump → ${process.argv[jsonIdx + 1]}`);
  }
```

- [ ] **Step 6: Commit**

```bash
git add benchmark/optimize/harness-dump.mjs benchmark/optimize/test/harness-dump.test.mjs StandardMultifileTest.mjs
git commit -m "feat(optimize): deterministic baseline JSON dump from bench results"
```

---

## Task 2: Baseline parser

**Files:**
- Create: `benchmark/optimize/baseline-parse.mjs`
- Test: `benchmark/optimize/test/baseline-parse.test.mjs`

Converts a dump (Task 1) into `baseline.json`: per metric the value, dominant RAW substage, and `bound_class` (`codec-kernel` | `pipeline` | `marshalling`) that gates Phase 3.

- [ ] **Step 1: Write the failing test**

```js
// benchmark/optimize/test/baseline-parse.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBaseline } from '../baseline-parse.mjs';

const dump = {
  schema: 'optimize-baseline/v1',
  telemetry: { cpuThrottlingPct: '100.0' },
  files: [{
    file: 'a.dng',
    raw: { decompress_ms: 10, demosaic_ms: 20, tonemap_ms: 70, orient_ms: 1 },
    metrics: { prog_enc_ms: 100, shot_dec_ms: 50, photon_prog_enc_ms: 300, mod_prog_enc_ms: 280, mt_prog_enc_ms: 90, mt_shot_dec_ms: 48 },
  }],
};

test('raw decode dominant substage is tonemap', () => {
  const b = parseBaseline(dump);
  const raw = b.find(x => x.file === 'a.dng' && x.metric === 'raw_decode');
  assert.equal(raw.dominant_substage, 'tonemap');
  assert.equal(raw.bound_class, 'pipeline'); // raw decode is Rust pipeline, never codec-kernel
});

test('photon/modular metrics marked codec-kernel (encode dominated by libjxl)', () => {
  const b = parseBaseline(dump);
  const ph = b.find(x => x.metric === 'photon_prog_enc');
  assert.equal(ph.median_ms, 300);
  assert.equal(ph.bound_class, 'codec-kernel');
});

test('throttled telemetry flags low trust on the baseline', () => {
  const b = parseBaseline({ ...dump, telemetry: { cpuThrottlingPct: '82.0' } });
  assert.equal(b[0].trust, 'low');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test benchmark/optimize/test/baseline-parse.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```js
// benchmark/optimize/baseline-parse.mjs
// Dump (harness-dump/v1) → flat baseline rows the workflow agents read.

const RAW_SUBSTAGES = ['decompress', 'demosaic', 'tonemap', 'orient'];

// Which metric is dominated by the libjxl codec kernel (gates Phase 3 C++).
const CODEC_KERNEL = new Set(['photon_prog_enc', 'mod_prog_enc', 'prog_enc', 'shot_dec']);

export function parseBaseline(dump) {
  const throttle = parseFloat(dump?.telemetry?.cpuThrottlingPct ?? '100');
  const trust = throttle < 95 ? 'low' : 'high';
  const rows = [];
  for (const f of dump.files || []) {
    // RAW decode: one row, dominant substage = max of the four.
    let domStage = RAW_SUBSTAGES[0], domVal = -1, rawTotal = 0;
    for (const s of RAW_SUBSTAGES) {
      const v = f.raw?.[`${s}_ms`] ?? 0;
      rawTotal += v;
      if (v > domVal) { domVal = v; domStage = s; }
    }
    rows.push({
      file: f.file, metric: 'raw_decode', median_ms: rawTotal,
      dominant_substage: domStage, bound_class: 'pipeline', trust,
    });
    // Encode/decode metrics from results.
    const map = {
      photon_prog_enc: f.metrics?.photon_prog_enc_ms ?? 0,
      mod_prog_enc: f.metrics?.mod_prog_enc_ms ?? 0,
      prog_enc: f.metrics?.prog_enc_ms ?? 0,
      shot_dec: f.metrics?.shot_dec_ms ?? 0,
    };
    for (const [metric, median_ms] of Object.entries(map)) {
      rows.push({
        file: f.file, metric, median_ms,
        dominant_substage: null,
        bound_class: CODEC_KERNEL.has(metric) ? 'codec-kernel' : 'marshalling',
        trust,
      });
    }
  }
  return rows;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test benchmark/optimize/test/baseline-parse.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add benchmark/optimize/baseline-parse.mjs benchmark/optimize/test/baseline-parse.test.mjs
git commit -m "feat(optimize): baseline parser with bound_class + dominant substage"
```

---

## Task 3: Gate evaluator (§5a quality + §5b acceptance)

**Files:**
- Create: `benchmark/optimize/gate.mjs`
- Test: `benchmark/optimize/test/gate.test.mjs`

Pure decision from a verdict input. §5a (hard) then §5b (faster OR memory/dedup/feature).

- [ ] **Step 1: Write the failing test**

```js
// benchmark/optimize/test/gate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../gate.mjs';

const base = { lossless: false, butteraugli_delta: 0.4, pixel_exact: false, saved_pct: 12, rss_delta_mb: 0, removes_dup: false, role: 'primary' };

test('lossy faster within butteraugli threshold → accepted/faster', () => {
  const v = evaluate(base, { butteraugliThreshold: 1.0, slowdownEpsilon: 3 });
  assert.equal(v.accepted, true);
  assert.equal(v.accept_reason, 'faster');
});

test('lossy quality regression → rejected even if faster', () => {
  const v = evaluate({ ...base, butteraugli_delta: 1.6, saved_pct: 40 }, { butteraugliThreshold: 1.0, slowdownEpsilon: 3 });
  assert.equal(v.accepted, false);
  assert.match(v.reason, /butteraugli/i);
});

test('lossless must be pixel_exact', () => {
  const v = evaluate({ ...base, lossless: true, pixel_exact: false, saved_pct: 50 }, { butteraugliThreshold: 1.0, slowdownEpsilon: 3 });
  assert.equal(v.accepted, false);
  assert.match(v.reason, /pixel/i);
});

test('equal speed but memory saved → accepted/leaner', () => {
  const v = evaluate({ ...base, saved_pct: -1, rss_delta_mb: -40 }, { butteraugliThreshold: 1.0, slowdownEpsilon: 3 });
  assert.equal(v.accepted, true);
  assert.equal(v.accept_reason, 'leaner');
});

test('slightly slower but removes duplication → accepted/simpler', () => {
  const v = evaluate({ ...base, saved_pct: -2, removes_dup: true }, { butteraugliThreshold: 1.0, slowdownEpsilon: 3 });
  assert.equal(v.accepted, true);
  assert.equal(v.accept_reason, 'simpler');
});

test('added fallback pathway, primary unchanged → accepted/feature', () => {
  const v = evaluate({ ...base, saved_pct: -1, role: 'fallback' }, { butteraugliThreshold: 1.0, slowdownEpsilon: 3 });
  assert.equal(v.accepted, true);
  assert.equal(v.accept_reason, 'feature');
});

test('pure regression rejected', () => {
  const v = evaluate({ ...base, saved_pct: -20 }, { butteraugliThreshold: 1.0, slowdownEpsilon: 3 });
  assert.equal(v.accepted, false);
  assert.match(v.reason, /regression/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test benchmark/optimize/test/gate.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```js
// benchmark/optimize/gate.mjs
// §5a hard quality gate, then §5b acceptance (faster OR offsetting gain).

export function evaluate(v, opts) {
  const eps = opts.slowdownEpsilon ?? 3;
  const thr = opts.butteraugliThreshold ?? 1.0;

  // --- §5a quality gate (hard) ---
  if (v.lossless) {
    if (!v.pixel_exact) return reject('lossless path not pixel-exact');
  } else {
    if ((v.butteraugli_delta ?? Infinity) > thr) {
      return reject(`butteraugli Δ ${v.butteraugli_delta} > ${thr}`);
    }
  }

  // --- §5b acceptance ---
  const saved = v.saved_pct ?? 0;
  if (saved > 0) return accept('faster');
  // equal-or-slightly-slower band: saved >= -eps
  if (saved >= -eps) {
    if ((v.rss_delta_mb ?? 0) < 0) return accept('leaner');
    if (v.removes_dup) return accept('simpler');
    if (v.role === 'fallback') return accept('feature');
  }
  return reject(`pure regression (saved_pct ${saved}, no memory/dedup/feature gain)`);

  function accept(reason) { return { accepted: true, accept_reason: reason, reason: `accepted: ${reason}` }; }
  function reject(reason) { return { accepted: false, accept_reason: null, reason: `rejected: ${reason}` }; }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test benchmark/optimize/test/gate.test.mjs`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add benchmark/optimize/gate.mjs benchmark/optimize/test/gate.test.mjs
git commit -m "feat(optimize): gate evaluator (quality + acceptance per spec 5a/5b)"
```

---

## Task 4: flipflop test-file generator

**Files:**
- Create: `benchmark/optimize/flipflop-testgen.mjs`
- Test: `benchmark/optimize/test/flipflop-testgen.test.mjs`

Emits a `.flipflop/tests/<name>.mjs` source string for a (metric, baselineVariant, candidateVariant). Variants are async closures (flipflop async mode, spec §3 cap.1); a `quality()` hook is emitted for lossy metrics. The generator does NOT run flipflop — agents write the file then `node flipflop.mjs`.

- [ ] **Step 1: Write the failing test**

```js
// benchmark/optimize/test/flipflop-testgen.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { genTest } from '../flipflop-testgen.mjs';

test('emits async variants + quality hook for lossy photon metric', () => {
  const src = genTest({
    name: 'photon-iso-sweep',
    description: 'photonNoiseIso baseline vs candidate',
    lossless: false,
    baseline: { label: 'iso800', expr: 'encodePhoton(input, 800)' },
    candidate: { label: 'iso400', expr: 'encodePhoton(input, 400)' },
  });
  assert.match(src, /export const name = 'photon-iso-sweep'/);
  assert.match(src, /baseline: true/);
  assert.match(src, /async \(input, ctx\) =>/);          // async variant
  assert.match(src, /export function quality/);          // lossy → quality hook
  assert.doesNotMatch(src, /export function equal/);     // lossy → no pixel-exact equal
});

test('emits equal() (pixel-exact) and no quality for lossless metric', () => {
  const src = genTest({
    name: 'raw-tone-simd',
    description: 'scalar vs simd tone',
    lossless: true,
    baseline: { label: 'scalar', expr: 'decodeRawScalar(input)' },
    candidate: { label: 'simd', expr: 'decodeRawSimd(input)' },
  });
  assert.match(src, /export function equal/);
  assert.doesNotMatch(src, /export function quality/);
  assert.match(src, /role: 'primary'/);
});

test('candidate role overridable to fallback', () => {
  const src = genTest({
    name: 'x', description: 'y', lossless: true,
    baseline: { label: 'a', expr: 'f(input)' },
    candidate: { label: 'b', expr: 'g(input)', role: 'fallback' },
  });
  assert.match(src, /role: 'fallback'/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test benchmark/optimize/test/flipflop-testgen.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```js
// benchmark/optimize/flipflop-testgen.mjs
// Build a flipflop test-file source string (spec §3 capabilities assumed).

export function genTest({ name, description, lossless, baseline, candidate }) {
  const candRole = candidate.role ?? 'primary';
  const qualityBlock = lossless
    ? `export function equal(a, b) { return pixelExact(a, b); }`
    : `export function quality(out, baselineOut) { return butteraugli(out, baselineOut); }`;
  return `// AUTO-GENERATED flipflop test — optimize-codec-times
export const name = '${name}';
export const description = ${JSON.stringify(description)};

export const variants = [
  { name: '${baseline.label}', baseline: true, role: 'primary',
    run: async (input, ctx) => ${baseline.expr} },
  { name: '${candidate.label}', role: '${candRole}',
    run: async (input, ctx) => ${candidate.expr} },
];

${qualityBlock}
`;
}
```

> Note: `encodePhoton`, `pixelExact`, `butteraugli`, `decodeRaw*` are bound by the test file's
> own imports, which the authoring agent appends per metric from the templates in Task 5.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test benchmark/optimize/test/flipflop-testgen.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add benchmark/optimize/flipflop-testgen.mjs benchmark/optimize/test/flipflop-testgen.test.mjs
git commit -m "feat(optimize): flipflop test-file generator (async variants + quality/equal)"
```

---

## Task 5: Revert manifest + per-metric flipflop templates

**Files:**
- Create: `benchmark/optimize/manifest.mjs`
- Create: `.flipflop/tests/templates/photon.mjs`
- Create: `.flipflop/tests/templates/modular.mjs`
- Create: `.flipflop/tests/templates/raw-decode.mjs`
- Test: `benchmark/optimize/test/manifest.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// benchmark/optimize/test/manifest.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addEntry, renderManifest } from '../manifest.mjs';

test('addEntry then render produces a markdown row with verdict + diff ref', () => {
  let m = [];
  m = addEntry(m, { id: 'opt-1', layer: 'rust', lens: 'tactical', file: 'crates/raw-pipeline/src/tone.rs',
    accept_reason: 'faster', saved_pct: 33, diffPath: 'patches/opt-1.diff' });
  const md = renderManifest(m);
  assert.match(md, /opt-1/);
  assert.match(md, /tactical/);
  assert.match(md, /33/);
  assert.match(md, /patches\/opt-1\.diff/);
});

test('render is stable/idempotent for same input', () => {
  const m = [{ id: 'a', layer: 'params', lens: 'mathematical', file: 'x', accept_reason: 'leaner', saved_pct: -1, diffPath: 'p' }];
  assert.equal(renderManifest(m), renderManifest(m));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test benchmark/optimize/test/manifest.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```js
// benchmark/optimize/manifest.mjs
// Append-only revert manifest: each banked change isolated for cherry-pick.

export function addEntry(list, e) {
  return [...list, {
    id: e.id, layer: e.layer, lens: e.lens, file: e.file,
    accept_reason: e.accept_reason, saved_pct: e.saved_pct, diffPath: e.diffPath,
  }];
}

export function renderManifest(list) {
  const head = `# optimize-codec-times — revert manifest\n\n| id | layer | lens | file | reason | saved% | diff |\n|----|-------|------|------|--------|--------|------|\n`;
  const rows = list.map(e =>
    `| ${e.id} | ${e.layer} | ${e.lens} | ${e.file} | ${e.accept_reason} | ${e.saved_pct} | ${e.diffPath} |`
  ).join('\n');
  return head + rows + '\n';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test benchmark/optimize/test/manifest.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the three metric templates**

```js
// .flipflop/tests/templates/photon.mjs
// Photon-noise progressive encode. Lossy → quality() = Butteraugli.
// Agent appends: import { createEncoder } from the jxl-wasm dist; an encodePhoton(input, iso)
// async helper wrapping encodeJxlVariant({progressive:true, photonNoiseIso:iso}); a butteraugli(a,b).
// corpus: bring-your-own = the 8 StandardMultifileTest rgba assets (flipflop --inputs).
export const photonNotes = 'baseline iso800; candidate = optimizer-proposed iso/effort/distance';
```

```js
// .flipflop/tests/templates/modular.mjs
// Modular progressive encode. modular:1 lossless variant → equal() pixel-exact;
// modular lossy (distance>0) → quality() Butteraugli. Agent picks per candidate config.
export const modularNotes = 'classify lossless via distance===0 / modular-lossless flag (spec §5a)';
```

```js
// .flipflop/tests/templates/raw-decode.mjs
// RAW decode (process_{orf,cr2,dng}_with_flags). Deterministic → equal() pixel-exact, zero tol.
// Input = raw camera bytes (flipflop --inputs over the ORF/CR2/DNG assets), NOT fractal corpus.
export const rawNotes = 'pixel-exact mandatory; substage targeted per baseline.dominant_substage';
```

- [ ] **Step 6: Commit**

```bash
git add benchmark/optimize/manifest.mjs benchmark/optimize/test/manifest.test.mjs ".flipflop/tests/templates"
git commit -m "feat(optimize): revert manifest + per-metric flipflop templates"
```

---

## Task 6: The Workflow script

**Files:**
- Create: `.claude/workflows/optimize-codec-times.js`

Orchestration only (no fs/Node in the runtime). Agents do the I/O via Bash/Write using Tasks 1–5 helpers. This task assembles meta, schemas, lens charters, phases, and gating. It is **authored now** but a full run is gated on flipflop (Task 7).

- [ ] **Step 1: Write the workflow skeleton with meta + schemas + lens charters**

```js
// .claude/workflows/optimize-codec-times.js
export const meta = {
  name: 'optimize-codec-times',
  description: 'Cut JXL enc/dec + RAW-decode times across all layers; flipflop-verified, quality-gated',
  whenToUse: 'Reduce encode/decode time in raw-converter-wasm with pixel-exact/Butteraugli safety',
  phases: [
    { title: 'Profile' },
    { title: 'Params' },
    { title: 'Rust' },
    { title: 'CPP' },
    { title: 'Synthesis' },
  ],
}

const BASELINE_SCHEMA = { type: 'object', required: ['rows'], properties: { rows: { type: 'array',
  items: { type: 'object', required: ['file','metric','median_ms','bound_class','trust'],
    properties: { file:{type:'string'}, metric:{type:'string'}, median_ms:{type:'number'},
      dominant_substage:{type:['string','null']}, bound_class:{type:'string'}, trust:{type:'string'} } } } } }

const FINDING_SCHEMA = { type: 'object', required: ['findings'], properties: { findings: { type: 'array',
  items: { type: 'object', required: ['lens','layer','file','location','hypothesis','predicted_gain_pct'],
    properties: { lens:{enum:['seam','aerial','architecture','operational','tactical','mathematical']},
      layer:{type:'string'}, file:{type:'string'}, location:{type:'string'},
      hypothesis:{type:'string'}, predicted_gain_pct:{type:'number'} } } } } }

const VERDICT_SCHEMA = { type: 'object',
  required: ['accepted','accept_reason','saved_pct','quality_ok','reason'],
  properties: { accepted:{type:'boolean'}, accept_reason:{type:['string','null']},
    saved_pct:{type:'number'}, rss_delta_mb:{type:'number'}, quality_ok:{type:'boolean'},
    pixel_exact:{type:'boolean'}, butteraugli_delta:{type:'number'}, bytes_delta:{type:'number'},
    trust:{type:'string'}, reason:{type:'string'} } }

// Ordering ladder (impact-descending): seam → architecture → aerial → operational → mathematical → tactical.
// Seam findings verify FIRST (cheapest, safest, often bank via §5b memory/dedup).
const LENSES = [
  { id:'seam',          charter:'Seamhunter (cross-cutting, runs every phase). Audit every crossing JS↔WASM, worker↔main, Rust↔JS, file↔mem, RAW→JXL. Classify each Copy/Transfer/View/Alias; count allocs/copies/traversals; verify transfer lists; check malloc/free reuse. Build Boundary/Buffer-lifecycle/Traversal maps. Every copy guilty until measured. Grep: _malloc _free HEAPU8.set memory.grow "new Uint8Array(" "slice(" Array.from structuredClone "postMessage(" take_rgb rgb_to_rgba toArrayBuffer toClampedTight.' },
  { id:'architecture',  charter:'Radical surgery / memory model. Propose a STRUCTURALLY different solution: ring buffer (allocate-once/reuse-forever), arena/batching, SoA↔AoS, single-owner zero-copy, producer→queue→consumer decouple, event-centric vs object-centric, persistent runtime/pool reuse.' },
  { id:'aerial',        charter:'Whole dataflow graph. Redundant pipelines; shared-artifact coupling (one RGBA frame forcing viewer reqs on all consumers); passes fusible across files; split measurement/visualization/export pipelines.' },
  { id:'operational',   charter:'Loops/nests/tiles. Kernel fusion (decode→transform→output, no intermediate buffer), tiling/blocking for cache, pass reduction (one-pass-many-outputs), invariant hoisting.' },
  { id:'mathematical',  charter:'Different math. Complexity/linear-algebra/numerical-methods + perceptual colour science (apply_tone_math LUT). Polynomial/rational approx, separable kernels, integral images, symmetry/invariants (compose not recompute), closed-form vs iterative. NOTE: lossy — must pass Butteraugli, never claim pixel-exact unless algebraically proven.' },
  { id:'tactical',      charter:'Micro / fast-path. Specialize dominant concrete type (rgba8/stride4, bpc1), exact integer ratio / power-of-two, integer stepping vs f32, manual tight loop vs iterator chain, defer copy to uncommon path, branch removal, SIMD lane width, bounds-check elision; leave breadcrumb comment.' },
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
```

- [ ] **Step 2: Add Phase 0 (Profile) + the args contract**

Append to `.claude/workflows/optimize-codec-times.js`:

```js
const cfg = {
  targetMetrics: args?.targetMetrics ?? ['photon_prog_enc','mod_prog_enc','raw_decode'],
  fileSubset: args?.fileSubset ?? null,
  layersEnabled: args?.layersEnabled ?? ['params','rust','cpp'],
  lenses: args?.lenses ?? LENSES.map(l => l.id),
  butteraugliThreshold: args?.butteraugliThreshold ?? 1.0,
  rounds: args?.rounds ?? 10,
  slowdownEpsilon: args?.slowdownEpsilon ?? 3,
  allowFallbacks: args?.allowFallbacks ?? true,
}

phase('Profile')
const baseline = await agent(
  `Profile the RAW→JXL pipeline. Run the benchmark with the baseline dump:\n` +
  `  node StandardMultifileTest.mjs optimize --json baseline-dump.json\n` +
  `Then: node -e "import('./benchmark/optimize/baseline-parse.mjs').then(async m=>{` +
  `const {readFileSync}=await import('node:fs');` +
  `console.log(JSON.stringify({rows:m.parseBaseline(JSON.parse(readFileSync('baseline-dump.json')))}))})"\n` +
  `Return the rows object. Also record, per file, the baseline Butteraugli, decoded-RGBA hash and rss ` +
  `(run a short flipflop with identical A/B variants to capture trust + rss). Flag any row trust:low.`,
  { phase: 'Profile', schema: BASELINE_SCHEMA }
)
const rows = baseline?.rows ?? []
log(`baseline: ${rows.length} metric rows; ${rows.filter(r=>r.trust==='low').length} low-trust`)
```

- [ ] **Step 3: Add Phase 1 (Params) — lens tournament, no rebuild**

```js
phase('Params')
// Seam first (marshalling boundaries), then math/tactical for param-space.
const paramLenses = cfg.lenses.filter(l => ['seam','mathematical','tactical'].includes(l))
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

// Verify each candidate via flipflop (author test from template, run, gate).
const paramVerdicts = await pipeline(
  paramFindings,
  f => agent(
    `Implement param candidate (config-only, no rebuild) for finding: ${JSON.stringify(f)}.\n` +
    `Author a flipflop test using benchmark/optimize/flipflop-testgen.mjs (clone .flipflop/tests/templates/` +
    `${f.file.includes('modular')?'modular':'photon'}.mjs), variant A=baseline config, B=candidate.\n` +
    `Run: node flipflop.mjs .flipflop/tests/<name>.mjs --inputs <8 assets>.\n` +
    `Read the journal. Then run the gate:\n` +
    `  node -e "import('./benchmark/optimize/gate.mjs').then(m=>console.log(JSON.stringify(` +
    `m.evaluate(<verdict-from-journal>, {butteraugliThreshold:${cfg.butteraugliThreshold},slowdownEpsilon:${cfg.slowdownEpsilon}}))))"\n` +
    `Return the VERDICT.`,
    { label: `verify:${f.lens}`, phase: 'Params', schema: VERDICT_SCHEMA }
  )
)
const paramWins = paramVerdicts.filter(Boolean).filter(v => v.accepted)
log(`params banked: ${paramWins.length}/${paramVerdicts.filter(Boolean).length}`)
```

- [ ] **Step 4: Add Phase 2 (Rust) — worktree tournament + integrator (one rebuild)**

```js
phase('Rust')
let rustWins = []
if (cfg.layersEnabled.includes('rust')) {
  const rustFindings = (await parallel(
    cfg.lenses.map(lensId => () => {
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

  // Optimizers produce diffs in worktrees; integrator applies non-conflicting set, ONE rebuild, verify.
  const integrated = await agent(
    `Integrate Rust candidates: ${JSON.stringify(rustFindings)}.\n` +
    `For each, produce a minimal diff in an isolated worktree. Apply the non-conflicting winning set to ` +
    `one working copy, then ONE rebuild: .\\build-parallel-wasm.ps1 -Features parallel-wasm.\n` +
    `Verify: cd crates/raw-pipeline && cargo test --no-default-features --lib (must pass).\n` +
    `Then flipflop each change (variant A=baseline pkg, B=candidate pkg) over the raw-decode template; ` +
    `RAW decode is deterministic → equal() pixel-exact, zero tolerance. Run the gate (Task 3).\n` +
    `Save each accepted diff to patches/<id>.diff and return one VERDICT per change.`,
    { label: 'rust:integrate', phase: 'Rust', isolation: 'worktree', schema: { type:'object',
      properties: { verdicts: { type:'array', items: VERDICT_SCHEMA } }, required:['verdicts'] } }
  )
  rustWins = (integrated?.verdicts ?? []).filter(v => v.accepted)
  log(`rust banked: ${rustWins.length}`)
}
```

- [ ] **Step 5: Add Phase 3 (C++) — gated by bound_class**

```js
phase('CPP')
let cppWins = []
const codecBound = rows.some(r => cfg.targetMetrics.includes(r.metric) && r.bound_class === 'codec-kernel')
if (cfg.layersEnabled.includes('cpp') && codecBound) {
  const cppLenses = cfg.lenses.filter(l => ['seam','architecture','operational','tactical','mathematical'].includes(l))
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

  // CAP ≤3 candidates; log every dropped one (spec §Phase 3 risk control).
  const ranked = cppFindings.sort((a,b) => b.predicted_gain_pct - a.predicted_gain_pct)
  const taken = ranked.slice(0, 3)
  if (ranked.length > 3) log(`CPP cap: dropped ${ranked.length - 3} candidates: ${ranked.slice(3).map(f=>f.location).join('; ')}`)

  const cppVerdicts = await pipeline(
    taken,
    f => agent(
      `Implement C++ candidate ${JSON.stringify(f)} in a worktree. Emscripten rebuild ` +
      `(node packages/jxl-wasm/scripts/build.mjs). flipflop A=baseline core, B=candidate core; ` +
      `lossless paths equal() pixel-exact, lossy quality() Butteraugli ≤ ${cfg.butteraugliThreshold}. ` +
      `Run full lib test + the gate. Save accepted diff to patches/. Return VERDICT.`,
      { label: `cpp:verify`, phase: 'CPP', isolation: 'worktree', schema: VERDICT_SCHEMA }
    )
  )
  cppWins = cppVerdicts.filter(Boolean).filter(v => v.accepted)
  log(`cpp banked: ${cppWins.length}`)
} else {
  log(`CPP phase skipped (codecBound=${codecBound}, enabled=${cfg.layersEnabled.includes('cpp')})`)
}
```

- [ ] **Step 6: Add Phase 4 (Synthesis) + completeness critic + return**

```js
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
```

- [ ] **Step 7: Commit**

```bash
git add .claude/workflows/optimize-codec-times.js
git commit -m "feat(optimize): optimize-codec-times Workflow (6-lens tournament + seamhunter, flipflop-gated)"
```

---

## Task 7: flipflop-gated smoke run + docs

**Files:**
- Create: `docs/optimize-codec-times-usage.md`

- [ ] **Step 1: Verify prerequisite — flipflop present**

Run: `node flipflop.mjs --help`
Expected: prints usage. If "Cannot find module", STOP — flipflop skill not yet installed; Tasks 1–6 stand complete, Task 7 resumes when flipflop lands.

- [ ] **Step 2: Helper self-check (all green)**

Run: `node --test benchmark/optimize/test/`
Expected: PASS — all unit suites (harness-dump, baseline-parse, gate, flipflop-testgen, manifest).

- [ ] **Step 3: Single-lens dry run**

Run the workflow with the cheapest config to validate orchestration end-to-end (params layer, one metric, tactical lens, 2 rounds):

Invoke `Workflow({ name: 'optimize-codec-times', args: { targetMetrics: ['photon_prog_enc'], layersEnabled: ['params'], lenses: ['tactical'], rounds: 2 } })`.
Expected: Profile→Params→Synthesis phases complete; ≥1 VERDICT produced; no Rust/C++ rebuild attempted; report path returned.

- [ ] **Step 4: Write usage doc**

```markdown
# optimize-codec-times — usage

Reusable optimization workflow. Oracle = flipflop. Gate = pixel-exact (lossless) /
Butteraugli ≤1.0 (lossy) + acceptance (faster OR memory/dedup/feature).

Full run:    Workflow({ name: 'optimize-codec-times' })
Params only: Workflow({ name: 'optimize-codec-times', args: { layersEnabled: ['params'] } })
One metric:  args: { targetMetrics: ['raw_decode'] }
Lens subset: args: { lenses: ['architecture','mathematical'] }

Outputs: per-metric speed/quality/rss deltas, a revert manifest (patches/ + manifest.md,
cherry-pick to land), and a deferred-work list. Idempotent — re-running on optimized code banks nothing.

Prereq: flipflop skill installed (node flipflop.mjs --help works).
```

- [ ] **Step 5: Commit**

```bash
git add docs/optimize-codec-times-usage.md
git commit -m "docs(optimize): usage + flipflop-gated smoke checklist"
```

---

## Self-Review

**Spec coverage:**
- §3 oracle (flipflop, async/quality/byo-input/role) → Tasks 4,5 templates + Task 6 agent prompts. ✓
- §4.5 lenses (6 incl. seamhunter, one per optimizer, ordering ladder) → Task 6 LENSES + per-lens fan-out (Steps 3,4,5). ✓
- §4.6 hot-files seed → Task 6 HOT_FILES const + finder prompts. ✓
- Seamhunter every phase → paramLenses/cppLenses include 'seam', Rust uses all cfg.lenses. ✓
- §5a/§5b gate → Task 3 `gate.mjs` (7 tests). ✓
- Phase 0 baseline + bound_class → Tasks 1,2. ✓
- Phase 1 params no-rebuild → Task 6 Step 3. ✓
- Phase 2 Rust one-rebuild integrator + pixel-exact → Task 6 Step 4. ✓
- Phase 3 C++ gated by bound_class + ≤3 cap + log drops → Task 6 Step 5. ✓
- Phase 4 synthesis + completeness critic + revert manifest → Task 6 Step 6 + Task 5. ✓
- args (lenses, slowdownEpsilon, allowFallbacks, …) → Task 6 Step 2. ✓
- Known low-hanging win (wire tone_simd) → Task 6 Step 4 prompt. ✓

**Placeholder scan:** no TBD/TODO; every code step has full source. Template `.mjs` files intentionally carry agent-append notes (the per-metric imports differ by candidate) — documented, not a placeholder.

**Type consistency:** `parseBaseline` returns rows used as `{file,metric,median_ms,bound_class,trust,dominant_substage}` everywhere; `evaluate(v, opts)` verdict fields match VERDICT_SCHEMA and Task 3 tests; `genTest` field names (`baseline.label/expr`, `candidate.role`) consistent; `addEntry/renderManifest` columns consistent.

**Known limitation:** Task 7 is gated on the external `flipflop` skill (PREREQUISITE GATE). Tasks 1–6 are independently buildable and testable now.
