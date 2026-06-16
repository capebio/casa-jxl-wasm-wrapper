# HANDOFF — Build Pipeline Lens Review
## Files: `packages/jxl-wasm/scripts/build.mjs` · `packages/jxl-wasm/scripts/build-pgo.mjs` · `packages/jxl-wasm/Dockerfile` · `build-parallel-wasm.ps1`

Date: 2026-06-11. Branch: `wasm-loader-spawn-lens`. Method: 22-lens in-memory review (strategy, API surface, pipeline stages, state, data structures, hot kernels, boundaries, support code, owl, reversal, astronomy, LLM/recognition, gaming, photogrammetry, butteraugli, AR, perceptual-color, pure math, hacker, re-pass, gap analysis, birds-eye). Duplicates amalgamated. Five agents, one file each (Agents 1+2 share build.mjs — run **sequentially**, Agent 1 first).

**Rules for every agent:**
- You handle ONE file. You may read any other file in the repo for context, but defer edits to other files until the end and only after requesting approval (list them in your final summary).
- Check `docs/rejected optimizations.md` before implementing anything that smells previously litigated. Nothing below collides with the CLAUDE.md reject-on-sight table (those are runtime-layer; this is build-layer).
- Perf/heuristic claims require benchmark or measurement evidence before merge (CLAUDE.md rule). Each item below states its verification.

---

## Strategic picture (Lens 1 / 22 condensed)

Two artifact families, asymmetric rigor. **libjxl side** (`build.mjs` + `Dockerfile`): hermetic-ish — pinned commit, Docker, sha256 manifest, size budgets, tier matrix (kind `dec|enc` × tier `relaxed-simd-mt|simd-mt|simd`). **RAW side** (`build-parallel-wasm.ps1`): host-dependent, floating nightly, no manifest, silent fallbacks. Data flows: `build.mjs ↔ Dockerfile` via build-args + `JXL_WASM_EMSDK_IMAGE` env; `build-pgo.mjs → build.mjs` via `dist/pgo-manifest.lock.json`; `dist/build-manifest.json → wasm-loader/capabilities` (tier selection downstream). Consequence: manifest bugs (B2) are loader-correctness bugs, not cosmetics. Biggest structural finding: **the build is broken today (B1)** — TS syntax in a `.mjs` executed by plain Node — so everything else here is unreachable until B1 lands.

Priorities: **P0** broken build (B1). **P1** correctness + future-breaking (B2, B3, B4, W1, W2, W3, D1, D2). **P2** size/speed wins (B5–B7, B11–B14, D3, W4, W5, PGO redesign). **P3** polish/provenance.

---

# Agent 1 — `packages/jxl-wasm/scripts/build.mjs` (correctness pass)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

**Context:** Node ESM script, run as `node scripts/build.mjs` (host: `--host-toolchain` via emsdk .bat wrappers; default: Docker round-trip via `runDockerBuild()`). Builds (kind × tier) matrix of libjxl + `src/bridge.cpp` into `dist/jxl-core.{kind}.{tier}.js/.wasm`, writes `dist/build-manifest.json` consumed by the wasm loader. Run Agent 1 before Agent 2 (same file).

### B1 — P0 — TypeScript syntax in `.mjs`: script cannot parse
Lines 54–55 and 317:
```js
const moduleKinds = ["dec", "enc"] as const;          // line 54
type ModuleKind = (typeof moduleKinds)[number];       // line 55
async function linkBridge(buildDir, outJs, tierFlags, env, kind: ModuleKind, exportsFile: string, initialMem: number) {  // line 317
```
`as const`, `type`, and parameter annotations are TypeScript. Node does not strip types from `.mjs` (only `.ts` under newer experimental flags). `node scripts/build.mjs` throws `SyntaxError` before `main()` runs. Fix:
```js
const moduleKinds = ["dec", "enc"];
// (delete the `type ModuleKind` line)
async function linkBridge(buildDir, outJs, tierFlags, env, kind, exportsFile, initialMem) {
```
Verify: `node --check packages/jxl-wasm/scripts/build.mjs` exits 0. This is the gate for every other item.

### B2 — P1 — `skippedTiers` key-space mismatch: hygiene logic is dead code
Line 133 builds `skippedTiers` from **tier names** (`"relaxed-simd-mt"`). Lines 432–442 merge: `builtNames` is keys of `manifest.tiers`, which are **`kind:tier`** (`"dec:simd"`). So `skippedTiers.filter((name) => !builtNames.has(name))` never filters, and `delete mergedTiers[s]` never deletes (no bare-tier keys exist). Stale MT entries from a prior `--include-mt` run persist in the manifest even when the current build skipped MT — downstream loader can select a tier whose artifact is stale or absent. Fix — qualify by kind at the source:
```js
skippedTiers: (hostToolchain && !process.argv.includes("--include-mt"))
  ? config.tiers.filter((t) => t.threads)
      .flatMap((t) => moduleKinds.map((k) => `${k}:${t.name}`))
  : [],
```
Merge logic then works unchanged. Verify: run host build twice (once with `--include-mt`, once without); second manifest must not contain `dec:simd-mt` / `enc:simd-mt` under `tiers`, and they must appear in `skippedTiers`.

### B3 — P1 — `osCpusMinusOne()` ignores the machine
Lines 452–455: `Number(process.env.CPU_COUNT ?? 8)` — `os` is imported but never consulted. On a 24-core box ninja gets `-j 7` (≈3× underutilized); on 4 cores it oversubscribes. Fix:
```js
function osCpusMinusOne() {
  const count = process.env.CPU_COUNT
    ? Number(process.env.CPU_COUNT)
    : (os.availableParallelism?.() ?? os.cpus().length);
  return Math.max(1, count - 1);
}
```
Verify: log the `-j` value; time one tier build before/after on the dev box.

### B4 — P1 — Loop-invariant work inside the (kind × tier) loop
Lines 210–211: `ensureLibjxlSource()` + `ensureLibjxlDeps(hostToolchain)` run **per matrix cell** (6×). `deps.sh` re-walks/fetches third_party every iteration — pure waste after the first (Lens 19: hoist invariants). Move both calls above the `for (const kind of moduleKinds)` loop (after manifest init). Verify: host build logs show one `deps.sh` run total.

### B5 — P2 — Size budget violations don't fail the build, and reference a helper that doesn't exist
Lines 236–246: over-budget writes `size-report.txt` and continues; exit code stays 0, so CI ships an oversized tier silently. The report says "Run the linked map/size-report helper" — no such helper or map is generated (Agent 2's B17 makes it real). Fix: collect violations during the matrix, after `writeManifest(manifest)` throw if any (so all tiers/reports still get written first):
```js
const budgetViolations = [];
// in loop: if (budget && wasmStats.size > budget) { ...writeFile...; budgetViolations.push(`${tierKey}: ${wasmStats.size} > ${budget}`); }
// after writeManifest:
if (budgetViolations.length) throw new Error(`Size budgets exceeded:\n${budgetViolations.join("\n")}`);
```
Also: `sizeBudgets` has a `"scalar"` entry (line 35) but no scalar tier exists in `config.tiers` — delete or comment it; and the budgets are floats (`1_677_721.6`) — round to integers. Verify: temporarily set a tiny budget, confirm nonzero exit + report present.

### B6 — P2 — Docker path drops CLI flags
`runDockerBuild()` (lines 274–287) hardcodes `["node","scripts/build.mjs","--inside-docker"]`. `--only-mt`, `--include-mt`, `--pgo` are silently ignored when the Docker path is taken — surprising behavior divergence. Fix: forward user flags:
```js
const passthrough = process.argv.slice(2).filter((a) => a !== "--inside-docker");
... image, "node", "scripts/build.mjs", "--inside-docker", ...passthrough
```
Verify: `node scripts/build.mjs --only-mt` (with Docker) builds only MT tiers.

### B7 — P2 — Fail-fast exports↔bridge preflight (Lens 10 reversal: catch the 40-minute error in second 1)
A typo'd or stale symbol in `exports-dec.txt`/`exports-enc.txt` only surfaces at link time, after a full libjxl compile. Before the matrix loop: read both exports files, read `src/bridge.cpp`, and for every exported `_name` (excluding Emscripten built-ins `_malloc`, `_free`) assert `name` appears in bridge.cpp (e.g. regex `\bname\s*\(`, or presence of `EMSCRIPTEN_KEEPALIVE`-adjacent declaration). Also `access()` both exports files up front — a missing `@file` gives emcc a cryptic error today. Warn-or-throw is your call; recommend throw with the list of unmatched symbols. Verify: add a fake symbol to a copy of exports-dec.txt, confirm immediate failure.

### B8 — P3 — Work-dir disk lifecycle
Each cell `rmDir(buildDir)` **before** building (line 158) but never after success: 6 build trees (~1 GB+ each of ninja objects + archives) persist in `os.tmpdir()/jxl-wasm-work`. Add post-link cleanup of `buildDir` after the manifest entry is recorded, behind `--keep-work` opt-out for debugging. Verify: dir absent after successful tier, present with `--keep-work`.

### B9 — P3 — Link flag single-source-of-truth
`linkBridge` re-specifies `-sMODULARIZE/-sEXPORT_ES6/-sEXPORT_NAME/-sALLOW_MEMORY_GROWTH/-sMAXIMUM_MEMORY/-sFILESYSTEM/-sASSERTIONS/-sINVOKE_RUN/-sEXPORTED_RUNTIME_METHODS/-sWASM_BIGINT/-flto/-fno-rtti/-fno-exceptions` — all already inside `tierFlags` (lines 326–352). Duplication invites drift, and the manifest `flags` array (line 231: `[...tierFlags, ...linkExtras]`) is only approximately what the linker saw. Refactor: `linkBridge` consumes exactly `[...tierFlags, ...linkOnlyExtras]` where `linkOnlyExtras = ["--closure","1", maybe "-sEVAL_CTORS=2", "-sEXPORTED_FUNCTIONS=@..."]`, and the manifest records that same array. Note: the existing `isMt`-vs-regex condition on lines 220 and 349 are the same predicate — keep one. Behavior must stay byte-identical (compare wasm sha before/after refactor on one tier).

### B10 — P3 — Manifest `pgo.enabled: true` is a lie today
Lines 139–143 set `pgo: { enabled: true, ... }` whenever a lock file exists — but no `-fprofile-generate/use` flag exists anywhere; staging ≠ PGO. Until Agent 3's pipeline lands, record `{ staged: true, applied: false, corpusHash, source }`. Coordinate with Agent 3 (who owns the real definition); if Agent 3 lands first, adopt their schema. Verify: manifest reflects reality.

---

# Agent 2 — `packages/jxl-wasm/scripts/build.mjs` (size & speed pass — run AFTER Agent 1)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

**Context:** same file as Agent 1; rebase on their result. These items target the user's stated ROI: wasm-opt pass tuning for footprint/load-time, plus artifact validation and provenance. Key fact: `dec` module is the viewer's first fetch (latency-critical, AR/lightbox first paint — Lens 16); `enc` is lazy-loaded at ingest (throughput-critical, photogrammetry batch — Lens 14). One-size `-O3` is wrong across that split.

### B11 — P1 — Explicit per-role wasm-opt post-pass (`-Oz` dec / `-O3` enc)
Emscripten already runs binaryen internally at `-O3`, but an explicit converging size pass on the decode module typically shaves a further 3–8%, and role-splitting is free. After `linkBridge` (or after the matrix), run emsdk's own binaryen (`<EMSDK>/upstream/bin/wasm-opt`, mirror `resolveEmscriptenBinary` but for `upstream/bin`; inside Docker it's on PATH):
```js
const featureFlags = [
  "--enable-bulk-memory", "--enable-sign-ext", "--enable-nontrapping-float-to-int",
  "--enable-mutable-globals",
  ...(tier.simd ? ["--enable-simd"] : []),
  ...(tier.relaxedSimd ? ["--enable-relaxed-simd"] : []),
  ...(isMt ? ["--enable-threads"] : [])
];
const level = isDec ? "-Oz" : "-O3";
await run(wasmOptBinary, [outWasm, level, "--converge", ...featureFlags, "-o", tmpOut]);
// keep result only if valid AND (dec: smaller; enc: not larger) — then rename over outWasm
```
Write to a temp path and atomically replace; record `{ wasmOpt: { level, beforeBytes, afterBytes } }` in the tier manifest entry. **Measure before merge:** size delta per tier AND a decode-throughput spot-check on dec `-Oz` (size passes can cost a few % speed; if dec decode regresses >2% on the tile bench, fall back to `-O3 --converge` for dec and note it). Alternative/simpler lever to A/B at the same time: leave compile at `-O3` and link dec with `-Oz` (classic emcc split) — pick whichever wins; document the loser in `docs/rejected optimizations.md`.

### B12 — P2 — `-sINCOMING_MODULE_JS_API` minimal list (glue-size win)
Default keeps every incoming-Module hook alive through closure. First grep `packages/jxl-wasm/src/facade.ts`, the loader (`packages/jxl-worker-browser/src/wasm-loader.ts`), and worker spawn code for properties passed into `createJxlModule({...})` — expect some of `locateFile`, `instantiateWasm`, `wasmMemory`, `mainScriptUrlOrBlob` (MT builds need `mainScriptUrlOrBlob`/`wasmMemory`; verify, don't guess). Then add to `baseFlags`:
```js
"-sINCOMING_MODULE_JS_API=locateFile,instantiateWasm,wasmMemory,mainScriptUrlOrBlob"  // trim to what's actually used
```
Closure then DCEs the unused glue — typically 5–15% of the JS. Verify: every tier still loads in the existing wasm-loader tests (`packages/jxl-worker-browser/dist-test/test/wasm-loader.test.js` exercises load paths); record js size delta in manifest. If the loader API set differs per MT/non-MT, compute the flag per tier.

### B13 — P2 — Brotli (wire) sizes in the manifest — zero new deps
Budgets and `jsBytes/wasmBytes` track raw bytes; users download Brotli. Node ships it:
```js
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";
const wasmBr = brotliCompressSync(await readFile(outWasm),
  { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: wasmStats.size } }).length;
```
Add `wasmBrotliBytes`/`jsBrotliBytes` per tier. Optional: secondary budget on compressed size (what AR/field clients on poor links actually feel — Lens 16, and the field-scientist resume work in jxl-stream shows wire bytes are the project's currency). Verify: fields present, plausible (~⅓ of raw).

### B14 — P2 — Post-build smoke: compile + export-surface check
Nothing today proves an artifact is loadable or that `wasm-metadce`/closure didn't strip a needed export (the dec/enc split exists precisely to let metadce cut call trees — over-cut is the failure mode, and `assertDistinctRelaxedSimdMt` only proves hash distinctness). After each cell:
```js
const mod = await WebAssembly.compile(await readFile(outWasm));   // validates bytes incl. simd/relaxed/threads in modern Node
const have = new Set(WebAssembly.Module.exports(mod).map((e) => e.name));
const want = (await readFile(join(packageRoot, exportsFile), "utf8"))
  .split("\n").map((s) => s.trim().replace(/^_/, "")).filter(Boolean);
const missing = want.filter((n) => !have.has(n));
if (missing.length) throw new Error(`${tierKey}: exports missing from wasm: ${missing.join(", ")}`);
```
(If Node's relaxed-SIMD flag situation bites on the relaxed tier, guard that tier's compile in try/catch and fall back to `WebAssembly.validate` — but try plain compile first.) Verify: corrupt a byte in a scratch copy → throws; remove an export from a scratch exports file → reports it.

### B15 — P3 — SRI integrity fields
Manifest already carries sha256 hex. Add web-ready Subresource Integrity per artifact: `integrity: "sha384-" + createHash("sha384").update(data).digest("base64")`. Lets the loader/CDN pin artifacts without recomputing. One-liner next to `sha256File` usage; reuse the file bytes you already read for B13 to avoid triple reads (read once, hash twice + brotli).

### B16 — P3 — Reproducibility check (photogrammetry/scientific provenance, Lens 14)
Digital-twin pipelines want byte-identical rebuilds from pinned inputs. emcc with `-sEMIT_PRODUCERS_SECTION` default-off should already be deterministic; prove it: add `--verify-repro` mode (or a docs note + CI job) that builds one cell twice into different build dirs and diffs wasm sha256. If nondeterminism appears, hunt `__DATE__`-style embeds or archive ordering (the `sortArchivesForLink` comparator already stabilizes link order — good). Cheap insurance; document result either way.

### B17 — P3 — Make the size-report actionable
B5's report tells the user to run a helper that doesn't exist. Behind `--size-report`, link the offending tier with `--emit-symbol-map` (or run `wasm-opt --func-metrics`) and write the top-N functions by size into the report. Defer if time-boxed; at minimum reword the report text to name the real command.

### B18 — Deferred idea (do NOT implement; record for the roadmap)
`wasm-split` profile-guided code splitting for the dec module (binaryen ships it in emsdk): split cold paths (error formatting, rare metadata branches, gain-map) into a deferred secondary wasm fetched on demand — gaming-style streaming LOD for code (Lens 13/16). Needs runtime profiling + loader changes; pairs naturally with Agent 3's PGO corpus. Write it into the handoff doc's "future" note in your summary, nothing more.

---

# Agent 3 — `packages/jxl-wasm/scripts/build-pgo.mjs` (PGO made real — the headline ask)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

**Context:** Today this file is vestigial: it hashes the **JSON text** of `packages/jxl-test-corpus/pgo-manifest.json` and writes `dist/pgo-manifest.lock.json`. No `-fprofile-generate`, no training run, no `-fprofile-use` exist anywhere in the pipeline, yet build.mjs stamps `pgo.enabled: true` (Agent 1's B10 fixes the stamp). Your job: design and implement the real two-pass flow, **enc module first** (the file's own P5-4 note and the project's economics agree: encoder hot loops — libjxl modular/entropy/var-DCT, bridge enc paths — are where PGO pays; pyramid ingest is the cost center). You own this file; build.mjs/Dockerfile edits are coordinated with Agents 1/2/4 — implement here, list the ≤2 integration-point edits you need at the end and request approval (consistent with scope rules).

### P1 — Two-pass PGO pipeline (emc​c/LLVM IR-level instrumentation)
Architecture (all orchestrated from this file, exported as functions build.mjs can call under `--pgo`):

1. **Train build (pass 1):** build `enc` × `simd` tier with extra flags
   `-fprofile-generate=/profiles -sENVIRONMENT=node -sFILESYSTEM=1 -sNODERAWFS=1` (instrumented runtime writes `.profraw` via the FS; `ENVIRONMENT=node` so the trainer runs headless inside the emsdk container). Train/ship flag delta must stay minimal — keep `-O3`, SIMD, exports identical; only env/FS/profiling differ. Known risk: `-flto` + profile-generate interplay — if the instrumented link fails, drop `-flto` for pass 1 only (profiles remain valid for the LTO'd pass 2).
2. **Training run:** new sibling script `pgo-train.mjs` (yours to create, same directory) that imports the instrumented module under Node and replays the corpus **scenarios** (below), then exits so profraw flushes.
3. **Merge:** `llvm-profdata merge -output=jxl.profdata /profiles/*.profraw` — `llvm-profdata` ships in emsdk at `upstream/bin/` (on PATH inside the Docker image).
4. **Use build (pass 2):** normal tier flags + `-fprofile-use=jxl.profdata -Wno-profile-instr-unprofiled -Wno-profile-instr-out-of-date` for all `enc` cells (profiles transfer across tiers at IR level; highway's runtime dispatch means SIMD-tier deltas are tolerable — suppressed-warning territory, document it).
5. **Manifest truth:** lock + manifest record `pgo: { enabled: true, applied: ["enc:simd", ...], corpusHash, profdataSha256, scenarios: [...] }`. `enabled` only when pass 2 actually consumed profdata.

### P1 — Targeted corpus: train on what the app actually does (user's stated ROI)
Upgrade `pgo-manifest.json` schema from a flat file list to weighted **scenarios mirroring real gallery behavior** (multi-resolution progressive RAW-derived tiles, scroll patterns):
```json
{
  "version": 2,
  "scenarios": [
    { "name": "gallery-scroll",      "weight": 0.6, "op": "encode-tiles",  "files": ["tiles/256/*.ppm"], "effort": 3, "note": "Q8 256px tile ladder, dominant ingest op" },
    { "name": "pyramid-ladder",      "weight": 0.25, "op": "encode-pyramid", "files": ["full/*.ppm"], "effort": 3, "levels": 5 },
    { "name": "metadata-sidecars",   "weight": 0.1, "op": "encode-container", "files": ["full/withmeta/*.ppm"] },
    { "name": "hiquality-archival",  "weight": 0.05, "op": "encode", "files": ["full/*.ppm"], "effort": 7, "note": "exercises butteraugli/VarDCT search paths (Lens 15)" }
  ]
}
```
Weights drive iteration counts in `pgo-train.mjs` (e.g., weight × N base reps). `effort: 3` is the project's ratified default — train where we ship; the small effort-7 slice exists because butteraugli-adjacent search code only executes at high effort, and giving it *some* profile mass prevents PGO from pessimizing it into the cold partition (Lens 15: this is the honest build-layer lever on butteraugli — that, plus the relaxed-SIMD tier's FMA/dot ops). Decode-scenario PGO for the dec module is a documented follow-up, not this pass.

### P2 — Hash corpus contents, not manifest text
`createHash("sha256").update(JSON.stringify(manifest))` (line 21) misses the actual pixels: swap an image file, same manifest → same hash → stale lock looks fresh. Fix: resolve every file in the manifest, sort paths, stream each through sha256, then hash the sorted `path:hash` lines. Also canonicalize the manifest JSON (sorted keys) before hashing so whitespace edits don't churn. Keep a `{ files: N, bytes: total }` summary in the lock for observability. Friendly error naming the expected path when the corpus is absent (current ENOENT bubbles raw through build.mjs's warn).

### P2 — Honest CLI
`main()` should accept `--stage-only` (today's behavior) vs default full pipeline (or `--train` / `--apply` stages for CI splitting). Keep `stagePgoLock()` exported — build.mjs imports it. Update the misleading console message ("Run the Docker build with profile-generate/profile-use stages enabled" — those stages now exist because you built them).

### Verification (required before merge)
- End-to-end: `node scripts/build-pgo.mjs` inside Docker produces profdata; pass-2 enc wasm sha differs from non-PGO build; manifest says `applied`.
- **Benchmark:** encode-throughput on the corpus (effort 3, tile + pyramid scenarios) PGO vs non-PGO, same tier, ≥3 runs. Expect 5–15%; if <2%, document in `docs/rejected optimizations.md` and leave the pipeline behind a flag rather than default-on. CLAUDE.md's "no tunables without evidence" applies to making PGO the default.
- Integration edits you'll likely request approval for: build.mjs `--pgo` branch calling your orchestrator (replacing the stage-only call), Dockerfile `ARG PGO` hook (Agent 4 has the matching item).

---

# Agent 4 — `packages/jxl-wasm/Dockerfile`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

**Context:** 24-line image: emsdk base (ARG `EMSDK_IMAGE`, default ghcr but build.mjs tries docker.io first — keep docker.io preference, ghcr auth is blocked on this machine), apt deps, WORKDIR, two ARG/ENV pairs (`LIBJXL_COMMIT/REPO`) that are exported but **never used in the image** — the clone happens at container runtime into `os.tmpdir()` (= `/tmp` in-container), and the container runs `--rm`. Net effect: every `docker run` re-clones libjxl **with full submodules** and recompiles emscripten system libraries from scratch, then throws both away. The image is an env shell when it should be a warm cache.

### D1 — P1 — Bake the pinned libjxl source (+ submodules + deps) into an image layer
The clone is keyed by `LIBJXL_COMMIT` — perfect Docker-layer cache key, already an ARG:
```dockerfile
# After apt layer:
RUN git clone --recursive --shallow-submodules --depth 1 --branch v0.11.2 \
      "${LIBJXL_REPO}" /tmp/jxl-wasm-work/libjxl \
 && test "$(git -C /tmp/jxl-wasm-work/libjxl rev-parse HEAD)" = "${LIBJXL_COMMIT}" \
 && bash -lc "cd /tmp/jxl-wasm-work/libjxl && ./deps.sh"
```
build.mjs's `ensureLibjxlSource()` already short-circuits when the dir exists at the pinned HEAD, so no build.mjs change is required — but the `/tmp` coupling to `os.tmpdir()` is implicit; add a Dockerfile comment stating it, and (optional, request approval) a one-line build.mjs env override `JXL_WASM_WORKDIR` to make the contract explicit. Note `--shallow-submodules` also benefits host clones if you touch that path — don't; just note it for Agent 1. Caveat: `/tmp` baked content survives into the container fs (image layer), but anything *written* at runtime still dies with `--rm` — that's fine, ninja dirs are per-run by design. Saves ~1–2 min + full network fetch per build. The branch tag `v0.11.2` duplicates build.mjs config — hoist to `ARG LIBJXL_TAG=v0.11.2` and have build.mjs pass `--build-arg LIBJXL_TAG` (approval-deferred build.mjs edit, 2 lines in `buildDockerImage`).

### D2 — P1 — Prewarm emscripten system libraries (`embuilder`)
First emcc invocation per container compiles libc/libc++/libc++abi/compiler-rt variants for each flag combo (lto × pthread), then `--rm` discards them — paid again next run, ~minutes. Bake them:
```dockerfile
RUN embuilder build libc libc++ libc++abi libcompiler_rt libmalloc-emmalloc libemmalloc --lto \
 && embuilder build libc-mt libc++-mt libc++abi-mt libcompiler_rt-mt --lto || true
```
Exact library names vary by emsdk release — verify with `embuilder build --help` / try `embuilder build ALL --lto` if granular names fight you (bigger image, still one-time). The `|| true` on the MT line is deliberate only if a name 404s — prefer fixing names over swallowing; drop it once verified. Verify: time `docker run … build.mjs --inside-docker` for one tier before/after; the "generating system library" log lines must disappear.

### D3 — P2 — ccache across the 6-cell matrix
`dec` and `enc` for the same tier compile near-identical highway/brotli/skcms/libjxl objects (delta: `JPEGXL_ENABLE_TRANSCODE_JPEG` and link-level `-s` flags that don't change most TUs' hashes). ccache turns the second kind's compile into mostly hits:
```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends ccache && rm -rf /var/lib/apt/lists/*
ENV EM_COMPILER_WRAPPER=ccache CCACHE_DIR=/work/jxl-wasm/.ccache CCACHE_MAXSIZE=5G
```
`EM_COMPILER_WRAPPER` is emscripten's sanctioned hook. Pointing `CCACHE_DIR` into the bind-mounted package dir persists the cache across `--rm` runs with **zero build.mjs changes** (it rides the existing `-v` mount); add `.ccache/` to the package `.gitignore`/`.npmignore` (approval-deferred, 1 line). If host-mount ACLs misbehave on Windows Docker Desktop, fall back to a named volume (that one would need a build.mjs `-v` addition — coordinate). Verify: `ccache -s` shows hits on the second kind of the same tier; wall-clock matrix time drops.

### D4 — P3 — Container hygiene
- `git config --global --add safe.directory '*'` — future-proofs any git op against the bind-mounted repo (uid mismatch → "dubious ownership").
- `ENV EMCC_SKIP_SANITY_CHECK=1` after a forced `RUN emcc --version` (bakes the sanity stamp, shaves per-invocation startup).
- Keep apt layer as-is otherwise (`--no-install-recommends` + list cleanup already correct).

### D5 — P3 — PGO stage hook (coordinate with Agent 3)
Add `ARG PGO=0` and a comment block documenting the two-pass contract (pass 1 instrumented + `pgo-train.mjs` + `llvm-profdata merge`; pass 2 `-fprofile-use`). `llvm-profdata` already ships in the emsdk image (`upstream/bin`) — verify with `RUN which llvm-profdata || ls /emsdk/upstream/bin | grep profdata` while developing, then remove the probe. No heavy logic here — orchestration lives in build-pgo.mjs; the Dockerfile just guarantees the tools and (optionally) a `/profiles` dir exist.

---

# Agent 5 — `build-parallel-wasm.ps1` (RAW pipeline parallel build)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

**Context:** PowerShell driver: nightly cargo `-Z build-std` with atomics RUSTFLAGS → wasm-bindgen (binary scavenged from wasm-pack's cache) → Node-compat patch of `workerHelpers.js` → optional wasm-opt → outputs duplicated to `pkg/` and `web/pkg/`. This builds the **hot RAW kernels** (demosaic/tonemap/downscale via rayon) — the pipeline's measured cost center (~2475 ms RAW decode), so codegen flags here matter more than anywhere.

### W1 — P1 — Add `+simd128` to RUSTFLAGS
Line 34: `-C target-feature=+atomics,+bulk-memory,+mutable-globals` — **no `+simd128`**. `wasm32-unknown-unknown` does not enable SIMD by default, so unless `.cargo/config.toml` adds it (check first — if it does, document and skip), every autovectorizable pixel loop in demosaic/tonemap/downscale ships scalar. Compatibility cost is zero: this artifact already requires atomics + COOP/COEP, a strictly newer baseline than simd128. Also the forward lever for the perceptual-color LUT engine (Lens 17) — log/exp/spline LUT sampling in `apply_tone_math` wants SIMD lanes.
```powershell
$env:RUSTFLAGS = "-C target-feature=+atomics,+bulk-memory,+mutable-globals,+simd128 -C link-arg=--max-memory=4294967296"
```
**Benchmark required** (CLAUDE.md rule): `benchmark/deep-dive-tests.mjs` before/after on an ORF/DNG decode; expect demosaic/downscale gains, report numbers — don't claim, measure ([[feedback-claim-fixed-only-after-user-tests]] pattern). Optional follow-up (don't bundle): `+relaxed-simd` on nightly for FMA in tonemap — separate bench, separate decision.

### W2 — P1 — wasm-opt: missing feature flags + swallowed failures
Line 113: `& $wasmOptBin $wasmOut -O2 --enable-threads --enable-bulk-memory -o $wasmOut | Out-Null`. Three problems:
1. **No `--enable-simd`** — the moment W1 lands, wasm-opt hard-errors on SIMD opcodes; also missing `--enable-mutable-globals`, `--enable-nontrapping-float-to-int`, `--enable-sign-ext` (Rust emits these on modern LLVM).
2. **`| Out-Null` + no `$LASTEXITCODE` check** — a wasm-opt failure today silently ships the unoptimized binary (or worse, with future in-place semantics, a truncated one). The whole script is `$ErrorActionPreference='Stop'` everywhere else — this is the one silent hole.
3. In-place `-o` same path — write to temp, replace on success.
```powershell
$tmp = "$wasmOut.opt"
& $wasmOptBin $wasmOut -O3 --enable-threads --enable-bulk-memory --enable-simd `
    --enable-mutable-globals --enable-nontrapping-float-to-int --enable-sign-ext `
    -o $tmp
if ($LASTEXITCODE -ne 0) { throw "wasm-opt failed for $wasmOut" }
Move-Item -Force $tmp $wasmOut
```
`-O2`→`-O3`: bench with W1's run (same harness); this is compute-bound code, speed-biased opt is the right default — if `-O3` shows nothing over `-O2`, keep `-O2` and note it. Also reconsider the skip-if-missing branch (line 117): with optimization now mattering (SIMD + threads), a loud `Write-Warning` is the minimum; consider `throw` behind a `-RequireWasmOpt` switch.

### W3 — P1 — wasm-bindgen version skew: first-found is Russian roulette
Lines 25–27 take the **first** `wasm-bindgen.exe` anywhere under `$env:LOCALAPPDATA\.wasm-pack` (multiple cached versions sort arbitrarily), else bare PATH fallback. A CLI/crate version mismatch fails at *runtime* with schema errors, not at build. Fix: parse the pinned version from `Cargo.lock` and demand a match:
```powershell
$lockText = Get-Content (Join-Path $repoRoot "Cargo.lock") -Raw
$wbVer = [regex]::Match($lockText, 'name = "wasm-bindgen"\s+version = "([^"]+)"').Groups[1].Value
$wasmBindgen = Get-ChildItem "$env:LOCALAPPDATA\.wasm-pack" -Recurse -Filter "wasm-bindgen.exe" -ErrorAction SilentlyContinue |
    Where-Object { (& $_.FullName --version) -match [regex]::Escape($wbVer) } |
    Select-Object -First 1 -ExpandProperty FullName
if (-not $wasmBindgen) { throw "wasm-bindgen-cli $wbVer not found. Run: cargo install wasm-bindgen-cli --version $wbVer" }
```
(Cheaper variant: match the version-stamped directory name `wasm-bindgen-cargo-install-$wbVer` before falling back to `--version` probing.) Same Cargo.lock-driven discipline the jxl side gets from pinned commits.

### W4 — P2 — Bindgen/patch/opt once, copy twice
Lines 102–103 + 110–114 run the full wasm-bindgen + patch + wasm-opt chain **twice** (pkg/, web\pkg/) on identical input — double time, and a theoretical divergence window. Do `pkg/` once, then `Copy-Item -Recurse -Force` into `web\pkg/`. Halves post-cargo wall time and guarantees byte-identical artifacts. Verify: `Get-FileHash` equality across both dirs.

### W5 — P2 — Hermetic hygiene: RUSTFLAGS restore, `--locked`, pinned nightly, preflight
- Line 124 `$env:RUSTFLAGS = ""` **clobbers** any pre-existing user RUSTFLAGS: capture `$savedRustflags = $env:RUSTFLAGS` before overwrite, restore in `finally`.
- Add `--locked` to the cargo invocation — CI/local drift protection, matches the jxl side's pinned-commit ethos.
- Floating `+nightly` means any nightly regression breaks the build nondeterministically: pin (`+nightly-2026-06-01` style) in one place at the top, or better a repo `rust-toolchain.toml` (file outside your scope — implement the in-script pin now, propose the toml in your summary for approval).
- Preflight with friendly errors beats `-Z build-std`'s cryptic failure: `rustup component list --toolchain $pin | Select-String 'rust-src.*(installed)'` else throw with the two `rustup` commands from the header comment.

### W6 — P3 — Emit a build manifest (parity with jxl side)
The jxl loader gets sha256/sizes/flags from `build-manifest.json`; the RAW artifact gets nothing — no integrity, no cache-bust key, no provenance (Lens 1 asymmetry; Lens 14 scientific reproducibility). After wasm-opt, write `pkg/build-manifest.json`:
```powershell
@{
  builtAt   = (Get-Date).ToString("o")
  rustc     = (& rustup run $pin rustc -V)
  rustflags = $env:RUSTFLAGS
  features  = ($Features -join ",")
  wasmBytes = (Get-Item $wasmOut).Length
  sha256    = (Get-FileHash $wasmOut -Algorithm SHA256).Hash.ToLower()
} | ConvertTo-Json | Set-Content (Join-Path $pkgDir "build-manifest.json")
```
Copied to web\pkg by W4. Loader-side consumption is future work — manifest first.

### W7 — P3 — Parameterize features (perceptual-LUT runway, Lens 17)
Hardcoded `--features parallel-wasm` (line 43). Add `param([string[]]$Features = @('parallel-wasm'))` at top, use `--features ($Features -join ',')`. When the LookRenderer perceptual-constancy engine lands as a cargo feature, the build script is already ready — no speculative code, one parameter.

### W8 — P3 — Patch robustness note
The `workerHelpers.js` line-regex patch (lines 58–99) is pinned to one wasm-bindgen emission shape (`waitForMsgType\(self, 'wasm_bindgen_worker_init'\)` + first `^\s*\}\);$` heuristic — that closing-line match can hit an inner callback if upstream reformats). The whole-file-wrap fallback (lines 94–96) is actually the *more* deterministic transform. Either promote the fallback to primary, or leave as-is and rely on W3's version pinning to freeze the emission shape — your call; document the choice in a comment. Do not expand the patch machinery.

---

## What implementing this achieves

The immediate effect is that the flagship build works again and stops lying about itself: build.mjs currently cannot execute at all (stray TypeScript syntax), its manifest can advertise stale multithreaded tiers to the wasm loader and claims PGO is enabled when no profile has ever been collected, and both wasm-opt and budget failures pass silently. After Agents 1, 2 and 5, every artifact that reaches `dist/` or `pkg/` is parse-checked, export-verified against its exports file, size-budgeted with teeth, integrity-stamped (sha256 + SRI + Brotli wire size), and produced by a toolchain whose versions are pinned and checked — the RAW side finally getting the same provenance discipline the libjxl side already aspires to. For a platform whose images feed scientific digital-twin and biodiversity workflows, build provenance is data provenance.

The performance story has two arms. Build-time: baking the pinned libjxl clone, `deps.sh`, and prewarmed emscripten system libraries into Docker layers, adding ccache across the near-identical dec/enc compiles, hoisting loop-invariant setup, and using the machine's real core count should cut full-matrix wall time dramatically (the current flow re-clones, re-fetches and re-bootstraps everything on every `--rm` run). Runtime: `+simd128` on the RAW kernels attacks the measured 2475 ms cost center directly; per-role wasm-opt (`-Oz` for the latency-critical viewer decoder, `-O3` for the lazy-loaded encoder) plus a minimal `INCOMING_MODULE_JS_API` trims the first fetch that AR and field clients on thin links actually feel; and the PGO redesign converts a stub into a real two-pass profile-generate → train → profile-use pipeline whose training corpus is weighted gallery-scroll tile encodes at the ratified effort 3 — compiling the binary for the exact hot paths the application exercises, with an honest benchmark gate (≥2% or it stays behind a flag) so the manifest's `pgo.enabled` finally means something.

Strategically, the suggestions converge the repo's two build systems toward one standard of hermeticity and observability: same manifest shape, same hash discipline, same fail-loud posture, same benchmark-before-merge rule. The deferred items (wasm-split cold-code splitting, decoder-side PGO, relaxed-SIMD on the Rust side) are recorded with their prerequisites so future sessions inherit a roadmap rather than re-deriving it — and every rejected branch lands in `docs/rejected optimizations.md`, which is how this project compounds knowledge instead of re-litigating it.
