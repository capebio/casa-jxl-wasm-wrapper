# HANDOFF — jxl-test-corpus 22-Lens Review
## Files: `src/loader.ts`, `src/manifest.ts`, `src/types.ts`, `scripts/generate-pgo-fixtures.mjs`, `pgo-manifest.json`, `DECISIONS.md`

Review date: 2026-06-12. Six Grok agent handoffs, one file each. Findings amalgamated across 22 lenses (strategic, API surface, pipeline stages, state, data structures, hot kernels, boundaries, support code, owl, reversal, astronomy, LLM/recognition, gaming, photogrammetry, Butteraugli, AR, non-Riemannian colour, pure math, hacker, re-perspective, gaps, birds-eye).

### Package context (read before any handoff)

`@casabio/jxl-test-corpus` is two packages in one:

- **Runtime fixture corpus** (`loader.ts`, `manifest.ts`, `types.ts`): platform-agnostic loader returning `Uint8Array` + per-fixture metadata for decode tests. Consumed via `exports` map (`./dist/index.js`, `./dist/loader.js`).
- **PGO training corpus** (`scripts/generate-pgo-fixtures.mjs`, `pgo-manifest.json`): decodes ORF sources via the RAW WASM pipeline, writes PPM fixtures into `tiles/256/`, `full/`, `full/withmeta/`, and regenerates `pgo-manifest.json`. Consumed by `packages/jxl-wasm/scripts/build-pgo.mjs`.

The two halves share no types and no code. The PGO manifest schema is untyped. The generator imports `decodeRawToRgba`/`initRawWasm` from `../../../benchmark/optimal-settings-timing-utils.mjs` — a reach outside the package boundary.

### Verified ground truth (do not re-derive)

- **There are NO `.jxl` fixture files anywhere in the package.** No `src/fixtures/`, no `dist/fixtures/`, no root `fixtures/`. `manifest.ts` lists four files (`srgb-8bit.jxl`, `srgb-alpha-8bit.jxl`, `adobe-rgb-16bit.jxl`, `truncated-header.jxl`) that do not exist. The `build` script is bare `tsc`, which never copies assets. `package.json` `files: ["dist", "fixtures"]` references a nonexistent directory.
- Compiled `loader.js` lives flat in `dist/` (tsconfig flattens `src/`), so its `__dirname/fixtures` resolves to `dist/fixtures/` at runtime.
- An orphan `pgo/` tree (`pgo/tiles/256/`, `pgo/full/`, `pgo/full/withmeta/`) duplicates the nine current PPM outputs — leftover from an earlier output-dir layout. Current script writes to package root.
- `pgo-manifest.json` checked-in content is byte-identical in structure to what `makePgoScenarioManifest()` emits (version 2, four scenarios, weights 0.6/0.25/0.1/0.05 summing to 1.0).

---

## Agent 1 — `packages/jxl-test-corpus/src/loader.ts`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article. 

### L1-1 (P0) Loader is non-functional: fixtures do not exist
Every `loadFixture()` call throws ENOENT (Node) or fetch-404 (browser) because no `.jxl` files exist in the repo and the build copies nothing. Fix in three parts:

1. Resolve fixtures from a stable location: `dist/fixtures/` (Node) and `new URL('./fixtures/…', import.meta.url)` (browser) — current code already does this; keep it, but the directory must be populated.
2. The fixture *creation* belongs to a new script (see Agent 4's L4-7 cross-reference; generation script is a new file — request approval at the end). Loader-side work: fail with an actionable error when the directory is missing:
```ts
try {
  const buffer = await fs.readFile(filePath);
  bytes = new Uint8Array(buffer);
} catch (e) {
  if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
    throw new Error(
      `Fixture file missing: ${filePath}. Run "npm run generate:fixtures" in packages/jxl-test-corpus (corpus binaries are generated, not checked in).`
    );
  }
  throw e;
}
```
3. Coordinate with `package.json` (outside ambit — request at end): build script becomes `tsc && node scripts/copy-fixtures.mjs` (or generate-in-place into `dist/fixtures/`).

### L1-2 (P1) Local fixtures never SHA-verified; only remote ones are
`fetchLargeFixture` verifies `sha256`; `loadFixture` ignores it. Corrupt local fixture (or a dev server's SPA-fallback HTML 404 served as 200) silently feeds garbage to decode tests, producing phantom decoder bugs. Extract one helper and call it on both paths whenever `fixture.sha256` is present:
```ts
async function verifySha256(bytes: Uint8Array, expected: string, id: string): Promise<void> {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error(`crypto.subtle unavailable (insecure context?) — cannot verify fixture ${id}`);
  }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let hex = '';
  for (let i = 0; i < digest.length; i++) hex += digest[i].toString(16).padStart(2, '0');
  if (hex !== expected) throw new Error(`SHA-256 mismatch for fixture ${id}`);
}
```
Note the `crypto.subtle` guard: on plain-http test servers it is `undefined` in browsers and currently dies with an opaque TypeError at `loader.ts:44`.

### L1-3 (P2) Index + memo cache
`manifest.fixtures.find` is O(n) per call and repeated loads re-read/re-fetch immutable bytes. Build once at module scope:
```ts
const byId = new Map(manifest.fixtures.map(f => [f.id, f]));
const cache = new Map<string, Promise<{ bytes: Uint8Array, manifest: FixtureManifest }>>();
```
Wrap the body of `loadFixture` in a `cache.get(id) ?? set` memo. Fixtures are immutable test assets; cache the promise (not the result) so concurrent callers share one I/O. Keep `fetchLargeFixture` uncached (large by definition; caller decides retention).

### L1-4 (P2) Filtered enumeration API
Tests want "all expectedPass fixtures", "all alpha fixtures". Export:
```ts
export function getFixtures(filter?: { tag?: string; expectedPass?: boolean }): FixtureManifest[] {
  let out = manifest.fixtures;
  if (filter?.tag) out = out.filter(f => f.tags.includes(filter.tag!));
  if (filter?.expectedPass !== undefined) out = out.filter(f => f.expectedPass === filter.expectedPass);
  return out;
}
```

### L1-5 (P3) Naming: returned field `manifest` shadows module-level `manifest`
`return { bytes, manifest: fixture }` — the per-fixture record is a `FixtureManifest` while the module import `manifest` is the `CorpusManifest`. Confusing at call sites. Add `fixture` as the canonical field, keep `manifest` as a deprecated alias for compatibility (check call sites across `packages/*/test/` first; if zero external usages, rename outright).

### L1-6 (P3) `onProgress` for `fetchLargeFixture`
Large remote fixtures download with no progress signal. Optional `onProgress?: (loaded: number, total: number) => void` via `response.body.getReader()` accumulation (falls back to `arrayBuffer()` when `body` is null). Streaming the hash is NOT possible with WebCrypto (no incremental digest) — do not attempt; hash after accumulation as now.

---

## Agent 2 — `packages/jxl-test-corpus/src/manifest.ts`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article. 

### L2-1 (P1) Manifest describes phantom files; add `sha256` once fixtures exist
All four entries lack `sha256`, so even after fixtures are generated, integrity checking (Agent 1 L1-2) is inert. After fixture generation lands (Agent 4 L4-7), populate `sha256` for every entry. Until then, add a comment at the top of the file stating fixtures are generated artifacts and the manifest is authoritative for expectations only.

### L2-2 (P2) Truncated fixture claims confident 100×100 dimensions
`truncated-header` has `expectedPass: false` yet asserts `width: 100, height: 100` — dimensions of a file whose header is truncated are unknowable to a consumer. After Agent 3 makes dims optional (L3-2), drop them here or keep them documented as "nominal pre-truncation dims". Misleading metadata in a malformed-input fixture is a trap for assertion-writing tests.

### L2-3 (P2) Corpus coverage gaps (add entries as fixtures become generatable)
Current four fixtures leave major decode paths untested. Add manifest entries (tags shown) in priority order:
- `gray-ramp-16bit` — neutral-gray axis ramp, `['gray-ramp', 'colour-engine']`. Directly exercises the non-Riemannian colour engine's gray-axis hybrid correction (the "spring force" stabilization) and white-balance invariance.
- `saturated-green-16bit` — `['gamut-green', 'colour-engine']`. Molchanov residual density concentrates around saturated greens; the corpus should own the canonical test patch.
- `progressive-dc-truncated` — a valid JXL truncated at the DC frame boundary, `expectedPass: true` (partial frame), `['progressive', 'dc-only', 'ar-latency']`. Tests the graceful `decode_budget_exceeded` contract and AR low-latency paths.
- `lossless-16bit` — `['lossless', 'archival', 'digital-twin']`. Photogrammetry/digital-twin work needs metrically faithful pixels; no lossless fixture exists.
- `multiview-a` / `multiview-b` — same synthetic specimen from two viewpoints, sharing `groupId` (L3-3), `['multiview', 'photogrammetry']`.

These are manifest entries plus generation-recipe notes; the binary generation itself is Agent 4's script (L4-7).

### L2-4 (P3) Provenance/attribution fields for biodiversity platform
Entries carry `license` but no `attribution` or occurrence linkage. When Agent 3 adds optional `attribution?: string` and `occurrenceId?: string` (Darwin Core hook, L3-4), populate `adobe-rgb-16bit` (`Casabio-Internal`) accordingly.

---

## Agent 3 — `packages/jxl-test-corpus/src/types.ts`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article. 

### L3-1 (P2) Tighten string fields into unions; version the corpus
```ts
export type FixtureColorSpace = 'srgb' | 'adobe-rgb' | 'display-p3' | 'gray' | 'xyb';
export type FixtureTag =
  | 'basic' | 'srgb' | 'alpha' | 'scientific' | '16bit' | 'icc' | 'exif'
  | 'truncated' | 'malformed' | 'lossless' | 'archival' | 'progressive'
  | 'dc-only' | 'ar-latency' | 'gray-ramp' | 'gamut-green' | 'colour-engine'
  | 'multiview' | 'photogrammetry' | 'digital-twin';
```
Use `colorSpace: FixtureColorSpace` and `tags: FixtureTag[]`. Note `manifest.ts` currently has the tag `'exif'` but not `'xmp'` despite `hasXmp: true` on `adobe-rgb-16bit` — the union will surface such drift at compile time. Add `version: number` to `CorpusManifest` (the PGO manifest is versioned; the runtime corpus is not — asymmetric for no reason).

### L3-2 (P2) Expected-failure semantics richer than boolean
`expectedPass: false` cannot express *which* error. Add:
```ts
expectedError?: string;   // substring or error code expected from libjxl's "error" decode event
```
Make `width`/`height` optional (`width?: number`) so malformed fixtures need not assert unknowable dims (see Agent 2 L2-2). Check compile impact on `manifest.ts` and any consumer destructuring dims.

### L3-3 (P2) Multi-view grouping for photogrammetry test sets
```ts
groupId?: string;     // fixtures sharing a groupId depict the same subject
viewIndex?: number;   // ordering within the group
```
Cheap now, expensive to retrofit after tests start hardcoding filename-pair conventions.

### L3-4 (P3) Biodiversity/recognition metadata hooks
```ts
attribution?: string;      // creator credit, alongside license
occurrenceId?: string;     // Darwin Core occurrence linkage
description?: string;      // human/LLM-readable content summary for semantic fixture selection
expectedPixelsSha256?: string;  // SHA-256 of the canonical decoded RGBA8 buffer — golden-image hash
```
`expectedPixelsSha256` is the highest-value item here: it upgrades the corpus from pass/fail smoke testing to bit-exact decoder correctness ("calibration frames" — known-answer fixtures). A decode test hashes its output RGBA and compares; any silent decoder regression (colour transform drift, stride bug, alpha premultiply change) becomes a one-line assertion. Consider this for Headline Features.

### L3-5 (P2) Type the PGO manifest — currently a schema-less contract
`pgo-manifest.json` is produced by an untyped `.mjs` and consumed by `build-pgo.mjs` with zero shared schema. Add to this file:
```ts
export interface PgoScenario {
  name: string;
  weight: number;            // fraction of training mix; all weights must sum to 1.0
  op: 'encode-tiles' | 'encode-pyramid' | 'encode-container' | 'encode' | 'decode';
  files: string[];           // globs relative to the package root
  effort: number;
  levels?: number;
  note?: string;
}
export interface PgoScenarioManifest {
  version: 2;
  scenarios: PgoScenario[];
}
```
Agent 4 then annotates `makePgoScenarioManifest` with `/** @returns {import('../src/types.js').PgoScenarioManifest} */` so `tsc`/editors check the literal. This is the one place the package's two halves should touch.

---

## Agent 4 — `packages/jxl-test-corpus/scripts/generate-pgo-fixtures.mjs`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article. 

### L4-1 (P0) Machine-specific hardcoded sources
`DEFAULT_SOURCES` are absolute paths under `C:\995\…` — the script fails on every machine except the author's, including CI and Docker PGO builds. Fix: env-var override plus directory scan plus actionable error:
```js
const sourceDirEnv = process.env.PGO_SOURCE_DIR;
async function resolveSources(explicit) {
  if (explicit.length > 0) return explicit;
  if (sourceDirEnv) {
    const entries = await readdir(sourceDirEnv);
    const raws = entries.filter(f => /\.(orf|dng)$/i.test(f)).map(f => join(sourceDirEnv, f));
    if (raws.length > 0) return raws.slice(0, 3);
  }
  const existing = [];
  for (const s of DEFAULT_SOURCES) {
    try { await access(s); existing.push(s); } catch {}
  }
  if (existing.length === 0) {
    throw new Error('No PGO source RAWs found. Pass paths as args or set PGO_SOURCE_DIR.');
  }
  return existing;
}
```
Keep `DEFAULT_SOURCES` as last-resort fallback for the author's machine. Generated PPMs are already checked in, so most consumers never run this — but when they do, it must not explode on `C:\995`.

### L4-2 (P1) Double RAW decode per source — halve generator runtime
`decodeRawToRgba(source, 256)` and `decodeRawToRgba(source, Number.MAX_SAFE_INTEGER)` each pay the full RAW decode (~2.5 s per file; RAW decode is the pipeline's known cost center). Decode full once, then downscale the RGBA in-process. The WASM module already exports `downscale_rgba` (see `src/lib.rs` via `benchmark/optimal-settings-timing-utils.mjs` — check what the helper re-exports; if not exposed, a simple area-average JS downscale of an already-decoded buffer is milliseconds and exact enough for PGO training pixels):
```js
const full = decodeRawToRgba(source, Number.MAX_SAFE_INTEGER);
const tile = downscaleRgba(full.rgba, full.width, full.height, 256); // longest edge → 256
```
This is the script's only hot-path win that matters; the RGBA→RGB loop in `writePpm` is noise by comparison (do not micro-optimize it beyond L4-4).

### L4-3 (P1) Stale-output orphans poison the PGO globs
The script writes per-stem files but never cleans `tiles/256/`, `full/`, `full/withmeta/`. Removing a source from the list leaves orphan PPMs that `pgo-manifest.json`'s globs (`tiles/256/*.ppm` etc.) happily feed to the trainer — silently training on a corpus that no longer matches intent. Before the write loop:
```js
await rm(tilesDir, { recursive: true, force: true });
await rm(fullDir, { recursive: true, force: true });  // also removes withmeta
```
then the existing `mkdir` calls recreate them. Separately: an orphan `pgo/` tree (`pgo/tiles`, `pgo/full`) from an earlier output layout still exists in the package and duplicates all nine PPMs — request approval at the end to delete it.

### L4-4 (P2) `writePpm` hardening + single allocation
1. **Guard the stride invariant**: the loop bound comes from `rgba.byteLength` but `rgb` is sized from `width*height*3`. If a decoder ever returns padded rows (`byteLength > w*h*4`), Buffer index assignment past the end is *silently dropped* in Node — corrupt PPM, no error. Add: `if (rgba.byteLength !== width * height * 4) throw new Error('rgba stride mismatch');`
2. **One allocation instead of three**: skip `Buffer.concat`:
```js
const headerStr = `P6\n${width} ${height}\n255\n`;
const out = Buffer.allocUnsafe(headerStr.length + width * height * 3);
out.write(headerStr, 0, 'ascii');
for (let src = 0, dst = headerStr.length; src < rgba.byteLength; src += 4, dst += 3) {
  out[dst] = rgba[src]; out[dst + 1] = rgba[src + 1]; out[dst + 2] = rgba[src + 2];
}
await writeFile(path, out);
```

### L4-5 (P2) PGO coverage: 16-bit and decode scenarios are cold
The generator emits only 8-bit P6 PPMs (maxval 255), and the manifest trains only encode ops. Consequences: the encoder's 16-bit input paths and the *entire decoder* receive no profile, so PGO may deoptimize them relative to an unprofiled build (cold-function placement). Two additions:
1. Emit a 16-bit PPM variant (P6 maxval 65535, big-endian samples) for one source into `full/16bit/` — requires the decode helper to expose 16-bit output; if it cannot, document the gap instead of faking it by widening 8-bit data.
2. Add a `decode` scenario to `makePgoScenarioManifest()` (op `"decode"`, files pointing at JXLs the trainer produces from the tiles, small weight ~0.1 with others rebalanced) — coordinate semantics with `build-pgo.mjs` (outside ambit; request at end if the trainer needs a matching change).

### L4-6 (P2) Provenance block + weight invariant
`makePgoScenarioManifest()` is static config; the written manifest records nothing about what was generated. Reproducibility fix — extend `generatePgoFixtures` to merge a provenance block before writing:
```js
const manifest = { ...makePgoScenarioManifest(), generated: {
  at: new Date().toISOString(),
  sources: generated.map(g => ({ source: basename(g.source), full: g.full, tile: g.tile })),
} };
```
Also assert `Math.abs(scenarios.reduce((s, x) => s + x.weight, 0) - 1) < 1e-9` after construction. Annotate the function with the `PgoScenarioManifest` JSDoc type from Agent 3 L3-5.

### L4-7 (P1) New sibling script: generate the runtime `.jxl` fixtures (cross-cutting, new file — request approval)
The runtime corpus's four `.jxl` files do not exist (see Agent 1 L1-1). This package already proves the generation pattern works (synthetic, deterministic, generated-not-checked-in). Propose `scripts/generate-fixtures.mjs`: render four deterministic 100×100 RGBA patterns (gradient, gradient+alpha, 16-bit wide-gamut ramp, then truncate a copy at byte 32 for `truncated-header`), encode via the project's encoder (`cjxl` if on PATH, else the jxl-native/encode facade), write into `dist/fixtures/`, and print per-file SHA-256 for Agent 2 to paste into `manifest.ts`. Wire as `"generate:fixtures"` in `package.json` and chain into `build`. This is a new file plus a `package.json` edit — request both at the end. Deterministic procedural fixtures (zero binary blobs in git, infinite extensibility for the colour-engine patches in Agent 2 L2-3) is a Headline Features candidate.

### L4-8 (P3) Boundary fragility: import from `benchmark/`
`import { decodeRawToRgba, initRawWasm } from "../../../benchmark/optimal-settings-timing-utils.mjs"` couples the package to a sibling top-level dir with no package boundary. Minimum fix: a comment documenting the contract (what the helper returns, that it must stay ESM); better fix (request at end if pursued): move the two functions into a small shared module under `packages/`. Do not silently vendor a copy — drift risk.

---

## Agent 5 — `packages/jxl-test-corpus/pgo-manifest.json`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article. 

### L5-1 (P1) Weight semantics are undefined — time-based vs invocation-based skew
`weight: 0.6/0.25/0.1/0.05` is meaningless without a unit. If `build-pgo.mjs` interprets weights as *invocation share*, wall-clock is dominated by `hiquality-archival` (effort 7 on full frames is easily 10–50× the cost of an effort-3 256px tile), so the *time-weighted sample profile* the PGO instrumentation actually collects inverts the intent: the rarest production op (5%) contributes the most samples, and the dominant op (gallery-scroll tiles, 60%) is undertrained. Read `build-pgo.mjs` (outside ambit) to determine actual semantics, then either:
- document the unit in a `"weightSemantics": "training-time-fraction"` top-level field and have the trainer enforce it by time budget, or
- rebalance weights to compensate for per-invocation cost so sample counts land at the intended mix.
This matters specifically for Butteraugli: effort-7 VarDCT engages the heaviest Butteraugli-adjacent heuristics, and PGO is the one lever in *these files* that decides whether the 95%-case effort-3 fast paths or the 5%-case heavy paths get the branch-layout favors. Production decision (from project history): effort=3 chosen on measured speed+filesize — the profile should overwhelmingly favor it.

### L5-2 (P2) Missing scenarios: decode and 16-bit
Mirror of Agent 4 L4-5 on the data side. The manifest trains zero decode paths and zero 16-bit paths while the shipped WASM binary contains both. If Agent 4's script changes land, this file is regenerated — coordinate rather than hand-edit (the script overwrites this file on every run; hand edits are doomed — note this prominently in DECISIONS via Agent 6).

### L5-3 (P3) Per-scenario quality knob
Scenarios pin `effort` but not `distance`/quality. Butteraugli-driven adaptive quantization paths vary with distance; production uses a known quality ladder (Q8 for 256px tiles per ratified decisions). Add `"distance"` (or the project's quality unit) per scenario so the trainer exercises production-matching quantization paths, not encoder defaults. Requires `makePgoScenarioManifest()` change (Agent 4 owns the generator; coordinate — this file is generated output).

---

## Agent 6 — `packages/jxl-test-corpus/DECISIONS.md`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article. 

### L6-1 (P1) The file's second decision is false — fix the record
"Fixtures will be stored in `src/fixtures` and included in the build" was never implemented: no fixtures exist, and `tsc` cannot include them. Replace with the actual decision once Agents 1/4 land (generated into `dist/fixtures/` by `generate:fixtures`, never checked in, SHA-256-pinned in `manifest.ts`). A DECISIONS file that contradicts reality is worse than none.

### L6-2 (P2) Record the undocumented decisions this review surfaced
Add entries (each one or two lines, matching existing style):
- **PGO scenario weights** (0.6/0.25/0.1/0.05): model production op mix — gallery tile ingest dominant; state the weight unit once Agent 5 resolves it.
- **effort=3 as training default**: from prior measurements, effort=3 won on speed+filesize; PGO profile must favor it.
- **`pgo-manifest.json` is generated output**: `generate-pgo-fixtures.mjs` overwrites it; never hand-edit.
- **Dual corpus**: one package hosts both the runtime decode corpus and the PGO encode corpus; shared types live in `types.ts` (PgoScenarioManifest).
- **PPM as PGO interchange**: header-trivial, dependency-free, lossless RGB8 — chosen over PNG to avoid a codec dependency inside the trainer.
- **Checked-in PPMs**: generated PPM outputs are committed so PGO builds run without the author's RAW sources; regeneration requires `PGO_SOURCE_DIR` or explicit args.
- **No magic-byte validation in the loader**: format validation belongs to libjxl (project invariant); the corpus integrity tool is SHA-256, not sniffing.

---

## Cross-cutting notes for all agents

- **Rejected-by-default** (do not implement; pre-empting re-proposal): parallelizing the 3-source generator across workers (complexity ≫ benefit at n=3); streaming SHA-256 in the browser (WebCrypto has no incremental digest); magic-byte checks in the loader (project invariant: format validation is libjxl's job); converting PPM writes to PNG (adds codec dependency to trainer).
- The `pgo/` orphan tree deletion (Agent 4 L4-3) is destructive — request approval, do not delete unilaterally.
- `package.json` edits (build chain, `files` array fix from `"fixtures"` to whatever lands) are shared territory — last agent to land requests them, referencing this doc.

---

## Overview — what implementing this achieves

The headline outcome is that the package starts doing its job at all. Today the runtime corpus is a façade: a typed manifest describing four fixture files that have never existed, behind a loader that throws on first use. Implementing the fixture-generation script, the build wiring, and the SHA-256 pinning turns it into a real, deterministic, zero-binary-blob test corpus — fixtures are procedurally generated at build time, integrity-pinned in the manifest, and verified identically on Node and browser paths. The `expectedPixelsSha256` golden-image hash then upgrades the corpus from "does it decode without throwing" to bit-exact decoder regression detection, which is the cheapest correctness harness the JXL pipeline can own: one hash comparison catches colour-transform drift, stride bugs, and alpha-handling regressions that currently require eyeballs.

On the PGO side, the changes protect the single most leveraged performance artifact in the build: the profile that decides which encoder branches get fast layout. Resolving the weight-semantics ambiguity (time-share vs invocation-share) ensures the profile actually reflects the production mix — overwhelmingly effort-3 tile encodes — rather than being silently dominated by the 5%-weight effort-7 archival scenario that costs 10–50× per invocation. Adding decode and 16-bit scenarios closes profile blind spots where PGO can actively *deoptimize* shipped code paths. The generator itself gets portable (no more `C:\995` hardcodes), twice as fast (one RAW decode per source instead of two), and trustworthy (clean-before-write kills the stale-orphan-PPM failure mode where the trainer silently consumes corpus files that no longer correspond to any intended source).

Structurally, the package's two halves — runtime corpus and PGO corpus — stop being strangers. A shared `PgoScenarioManifest` type makes the generated JSON a checked contract instead of a schema-less handshake with `build-pgo.mjs`, and the DECISIONS file stops asserting things that never happened. The new metadata fields (`groupId`/`viewIndex`, `attribution`/`occurrenceId`, colour-engine tags, `expectedError`) are cheap now and expensive later: they let the corpus grow along the project's actual roadmap — multi-view photogrammetry sets for digital twins, Darwin Core-linked specimen fixtures for the biodiversity platform, gray-ramp and saturated-green patches that give the non-Riemannian colour engine its canonical test targets, and DC-truncated progressive fixtures that pin the AR latency contract.

Net effect: a package that currently contributes nothing to test coverage and quietly under-trains the encoder becomes the project's calibration bench — the fixed stars against which every decoder build, every PGO profile, and eventually every colour-engine change is measured.
