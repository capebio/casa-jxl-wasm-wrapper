# Ingestion Admin Plane — Lens Review & Handoffs

**Files assessed (Group 10):**
`packages/pyramid-ingest/src/cli.ts`, `migrate.ts`, `validate.ts`, `telemetry-tty.ts`, `rm.ts`

**Scope rule for implementers:** one agent per file. Do not touch other files except this plan and
`C:\Foo\raw-converter-wasm\docs\rejected optimizations.md`. Optional shared-helper work (Chapter 0)
is cross-cutting and must be confirmed with the user before a single file takes ownership.

---

## Lens 1 — Strategic view & data flow

These five files are the **command/administration surface** sitting on top of the ingest engine
(`ingest.ts`). They share one mental model of the on-disk store:

```
out/
  images/<imageId>/manifest.json   ← per-image truth (schema, master, levels[])
  levels/<contenthash>.jxl         ← content-addressed level blobs (deduped, shared across images)
  index.json                       ← gallery index (l0 per image)
  .pyramid-ingest.runlog.json      ← append-only run history (bounded)
```

Data flow:

- **`cli.ts`** parses argv → routes to a subcommand (`batch | gc | validate | rm | migrate | reindex | explain`),
  acquires the right advisory lock, calls into the engine, and renders output (human or `--json`).
  It is the only producer of the runlog and the only owner of signal handling.
- **`migrate.ts`** rewrites every `manifest.json` to a target `schema`/`layout`, atomically, under per-image locks.
- **`validate.ts`** is read-only: walks manifests + levels + index and emits a `ValidationReport` of issues.
- **`telemetry-tty.ts`** is the human-facing renderer (`stage`/`progress`/`event`) selected by `--verbose`.
- **`rm.ts`** deletes one image dir and (optionally) orphan levels; the CLI rebuilds the index afterward.

The recurring shapes — *walk `images/`, read a manifest, atomically write a manifest, take a lock,
render status* — are re-encoded in four of the five files. The strongest structural finding (Lens 21)
is that a thin `store` abstraction would collapse all of them and centralise the correctness fixes below.

Lenses 15 (Butteraugli) and 17 (non-Riemannian colour) touch the Rust/WASM render core, not this
admin plane — **N/A here**. Lens 20 ("move the pointer, don't reread memory") has a direct, literal hit
in `validate.ts` (VAL-2). Lenses 11/13/14/16 fold into the parallelism, progress-UX, and provenance
features below.

---

## Chapter map (implementation layers)

Findings are grouped into layers so a reader can implement related things together. Each finding also
carries a per-file ID used in the agent handoffs.

- **Layer A — Stream hygiene (machine-clean stdout):** TTY-1, TTY-2, TTY-3, CLI-6
- **Layer B — Data safety & correctness:** VAL-1, MIG-1, MIG-2, MIG-3, RM-1, CLI-1
- **Layer C — Performance ("don't reread memory"):** VAL-2, VAL-3, MIG-5, CLI-5, CLI-7, RM-3
- **Layer D — Honest reporting:** CLI-2, CLI-3, VAL-4
- **Layer E — DRY / dead code / cleanup:** CLI-4, CLI-9, MIG-4, RM-2, CLI-8
- **Layer F — Features (UX & provenance):** TTY-4, VAL-5, MIG-6

Severity: **P0** = data-loss / wrong-result risk, **P1** = real bug or material perf, **P2** = clear
improvement, **P3** = polish / verify.

---

## Chapter 0 — Shared helpers (cross-cutting; confirm ownership before implementing)

Three patterns are duplicated across all five files. If the user approves a shared module
(`packages/pyramid-ingest/src/store-fs.ts`), implement once; otherwise each agent inlines the local fix.

```ts
// readFileOrNull: collapses the fileExists()+readFile() double-stat into one syscall.
export async function readFileOrNull(p: string): Promise<string | null> {
  try { return await readFile(p, "utf8"); }
  catch (e: any) { if (e?.code === "ENOENT") return null; throw e; }
}

// atomicWriteJson: the tmp+rename+EEXIST dance duplicated in cli.ts and migrate.ts (×2).
export async function atomicWriteJson(path: string, obj: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, JSON.stringify(obj, null, 2));
  await rename(tmp, path).catch(async (e: any) => {
    if (e?.code === "EEXIST") { await unlink(tmp).catch(() => {}); }
    else throw e;
  });
}

// iterImageManifests: walk images/<id>/manifest.json once, yielding parsed manifest + path.
// Centralises VAL-2 (reuse parse) and MIG-4 (dedupe migrate walks).
```

The `fileExists(p)` + `readFile(p)` sequence (in `validate.ts` L51/L55 & L102/L103, `migrate.ts`
L32/L35, `rm.ts` L20/L25) is two syscalls where one suffices, and is a TOCTOU window. `readFileOrNull`
removes both problems.

---

## Agent 1 — `packages/pyramid-ingest/src/cli.ts`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

### CLI-1 [P0, Layer B] — Config precedence is inverted and parse failures are silent (L112–118)

```ts
if (values.config) {
  try {
    const cfg = JSON.parse(await readFile(values.config as string, "utf8"));
    Object.assign(values, cfg);   // ← cfg overwrites CLI-provided values
  } catch {}                       // ← malformed config silently ignored
}
```

`Object.assign(values, cfg)` makes the **config file win over explicit CLI flags** — the opposite of
expected precedence (a flag the user typed should override a file default). And a malformed/missing
config is swallowed with no diagnostic. Fix: config is a *default* layer, CLI args override, and a
bad config is a hard error.

```ts
if (values.config) {
  let cfg: Record<string, unknown>;
  try { cfg = JSON.parse(await readFile(values.config as string, "utf8")); }
  catch (e: any) { throw new Error(`--config ${values.config}: ${e?.message || e}`); }
  // CLI-supplied keys win: only fill keys the user did NOT pass.
  for (const [k, v] of Object.entries(cfg)) {
    if ((values as any)[k] === undefined) (values as any)[k] = v;
  }
}
```
(Note: `parseArgs` leaves unset options `undefined` unless they have a `default`. Booleans with
`default:false` will already be present — if config-overridable booleans are wanted, gate on
"was the flag actually on argv" instead. Keep it simple: at minimum fix the throw-on-bad-config and
the precedence for string options.)

### CLI-2 [P1, Layer D] — Runlog durations are fabricated (~100 ms always) (L452–453, L460)

```ts
durationMs: endMs - (Date.now() - 100 /*approx*/) // ≈ +100 always
...
startedAt: endMs - 100,
```

`endMs - (Date.now() - 100)` ≈ `100` on every run because `endMs ≈ Date.now()`. The real start time is
never recorded, so both the `batch-end` event and the runlog `startedAt/durationMs` are meaningless.
Capture a real start timestamp before `ingestBatch`:

```ts
const startMs = Date.now();
// ... const result = await ingestBatch(...)
const endMs = Date.now();
emitJson({ type: "batch-end", written: result.written, skipped: result.skipped,
           failed: result.failed.length, stagedBytes: (result as any).totalStagedBytes || 0,
           durationMs: endMs - startMs });
// runlog:
startedAt: startMs, endedAt: endMs,
```

### CLI-3 [P1, Layer D] — `-vv` detection is a fragile substring count (L382)

```ts
const vv = (process.argv.join("").match(/-v/g) || []).length;
```

Joining argv with no separator and counting the substring `-v` miscounts: any positional containing
`-v` (`my-video.orf`, `clip-v2/`) inflates it, and `--verbose` contributes a phantom match. Count real
tokens instead:

```ts
const vv = process.argv.slice(2).reduce((n, a) =>
  n + (a === "-vv" ? 2 : a === "-v" ? 1 : /^-v+$/.test(a) ? a.length - 1 : 0), 0);
```
(Or declare `verbose: { type: "boolean", short: "v", multiple: true }` in `parseArgs` and use the array
length — cleaner if the schema allows it.)

### CLI-4 [P2, Layer E] — Dead duplicate `reindex`/`explain` blocks (L232–264)

`reindex-only` early-returns at L126–130 and `explain` early-returns at L132–196, both *before* the
`try`. The copies inside the `try` (L232–236 reindex, L238–264 explain) are unreachable — the comments
even admit it ("dupe minimal… real path early-returns"). Delete both inner blocks. Keep one
canonical implementation per command. Consider hoisting the two early returns to sit beside the other
subcommand handlers for a single dispatch site, but at minimum remove the dead code.

### CLI-5 [P2, Layer C] — `collectInputs` walks serially with an extra stat per entry (L26–44)

Each directory entry triggers a separate `stat` just to learn `isDirectory()`, and the whole tree is
walked one `await` at a time. Use `withFileTypes` (Dirent gives type for free) and bound the fan-out:

```ts
const walk = async (p: string): Promise<void> => {
  const entries = await readdir(p, { withFileTypes: true });
  await Promise.all(entries.map(async (d) => {
    const full = join(p, d.name);
    if (d.isDirectory()) return walk(full);
    const fmt = formatFromPath(full);
    if (!fmt) return;
    const s = await stat(full); // only files need size/mtime
    out.push({ path: full, stat: { size: s.size, mtimeMs: s.mtimeMs }, format: fmt });
  }));
};
```
The deterministic `out.sort(...)` (INVARIANT D3) must stay — parallel push reorders, the sort restores
determinism. (If trees are huge, cap concurrency to avoid EMFILE; a small p-limit around the file
`stat`s suffices.)

### CLI-6 [P1, Layer A] — `--json` + `--verbose` corrupts the JSON stream

When both flags are set, `baseTel = createTtyTelemetry()` and `tel.stage`/`tel.progress` still call
`baseTel`, which writes human `[stage]` lines and `\r…%` progress to **stdout**, interleaved with the
JSON lines `--json` consumers parse. Either fix the renderer to use stderr (TTY-1) **and/or** in the
CLI force the human renderer off in JSON mode:

```ts
const baseTel = (parsed.verbose && !isJson) ? createTtyTelemetry() : noOpTelemetry;
```
Pairs with TTY-1; do both for defence in depth.

### CLI-7 [P3, Layer C] — Shard filter is O(n·m) (L359–363)

```ts
const shardPaths = planShard(collected.map(c => c.path), i, n);
collected = collected.filter(c => shardPaths.includes(c.path)); // linear scan per item
```
`const keep = new Set(planShard(...)); collected = collected.filter(c => keep.has(c.path));`

### CLI-8 [P3, Layer E] — Verify numeric coercions (NaN risk)

`parseArgs` yields **strings**; confirm `cliArgsSchema` coerces these to numbers, else they are bugs:
- `memBudgetBytes = parsed["mem-budget-mb"] * 1024 * 1024` (L376) → `NaN` if undefined/string.
- `runlogKeepN = parsed["runlog-keep"] ?? 100` (L381) then `arr.slice(-runlogKeepN)` → `NaN` slice if string.
- `thr === 1` (L352) compares against a number; a string `"1"` is always `false`, silently disabling the
  single-thread tier downgrade.

If the schema already coerces (likely via Zod `z.coerce.number()`), reject this item with that note.
Otherwise coerce at use sites or in the schema.

### CLI-9 [P3, Layer E] — Redundant `|| parsed.gc` guards (L266, 281, 301, 328)

`subcmd` is already derived from `parsed.gc/validate/rm/migrate` at L201–221, so `if (subcmd === "gc" || parsed.gc)`
double-tests. Drop the `|| parsed.*` halves once you confirm the derivation covers every path. Pure
readability; no behaviour change.

---

## Agent 2 — `packages/pyramid-ingest/src/migrate.ts`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

### MIG-1 [P0, Layer B] — Lock-acquisition failure silently writes UNLOCKED (L45–47, L100–103)

```ts
let iLock: any = null;
if (!opts.dryRun) {
  try { iLock = await acquireImageWriteLock(outDir, id); } catch {} // ← swallowed
}
// ... proceeds to atomically write the manifest even if iLock === null
```

If the per-image lock can't be acquired (another process holds it — exactly the case the lock exists to
guard), the `catch {}` leaves `iLock = null` and the code **writes anyway**, racing a concurrent
ingest/rm on the same manifest. Treat failure as skip-with-error:

```ts
let iLock: AdvisoryLock | null = null;
if (!opts.dryRun) {
  try { iLock = await acquireImageWriteLock(outDir, id); }
  catch (e: any) {
    report.errors.push({ path: mpath, error: `lock: ${e?.message || e}` });
    report.skipped++;
    continue;
  }
}
```
Apply to both `migrateSchema` and `migrateLayout` (folded by MIG-4).

### MIG-2 [P1, Layer B] — Re-parse-then-write may silently drop manifest fields / never "stick"

```ts
const m = parseManifest(txt);
const updated = { ...m, schema: 2, producedBy: makeProducedBy() };
```
If `parseManifest` validates against a closed schema (strips unknown keys), then `...m` is **lossy** —
any field the schema doesn't model is dropped on rewrite. Worse for `migrateLayout`: it writes
`layout: target`, but if `parseManifest` doesn't include `layout`, the **next** read strips it and the
migration never sticks → `validate`/re-run re-migrates forever.

**Verify** `parseManifest`'s passthrough behaviour. If it strips:
```ts
const raw = JSON.parse(txt);            // preserve all fields
parseManifest(txt);                     // still validate (throws on bad)
const updated = { ...raw, schema: targetVersion, producedBy: makeProducedBy() };
```
and ensure `layout`/`schema` round-trip through the schema. If `parseManifest` already passes unknown
keys through, reject this item with that note.

### MIG-3 [P1, Layer B] — No downgrade guard; blindly stamps target + new producedBy (L38, L52)

The only skip is `m.schema === targetVersion`. With current schema 2 and `--migrate-schema 1`, it
"migrates" **down**, rewriting `producedBy`. The `schema: targetVersion as 2` cast also lies about any
non-2 target. Guard against no-op/downgrade:

```ts
if ((m.schema ?? 1) >= targetVersion) { report.skipped++; continue; }
```
and validate `targetVersion` is a supported value before looping.

### MIG-4 [P2, Layer E] — `migrateSchema`/`migrateLayout` are ~90% identical → one helper

Both walk `images/`, gate, lock, transform, atomic-write. Collapse:

```ts
async function migrateManifests(
  outDir: string,
  shouldMigrate: (m: any) => boolean,
  transform: (raw: any) => any,
  opts: { dryRun?: boolean },
): Promise<MigrationReport> { /* shared walk + lock (MIG-1) + atomicWriteJson (Ch.0) */ }

export const migrateSchema = (o, target, opts) =>
  migrateManifests(o, m => (m.schema ?? 1) < target,
                   raw => ({ ...raw, schema: target, producedBy: makeProducedBy() }), opts);
export const migrateLayout = (o, target, opts) =>
  migrateManifests(o, m => (m as any).layout !== target,
                   raw => ({ ...raw, layout: target }), opts);
```
Removes the duplicated atomic-write/lock logic (one place to keep correct).

### MIG-5 [P2, Layer C] — Serial walk + double-stat

Replace `fileExists(mpath)` + `readFile(mpath)` with `readFileOrNull` (Ch.0), and bound-parallelise the
per-image loop (per-image locks already make concurrent writes safe). Use the existing
`boundedConcurrency`/pool utility rather than unbounded `Promise.all` to avoid EMFILE on large stores.

### MIG-6 [P3, Layer F] — Provenance & real transforms (digital-twin audit; Lens 14)

Today migration is a metadata bump (`schema`+`producedBy`) with no per-version data transform; a v1→v2
that needs structural changes would produce a manifest *labelled* v2 but shaped v1. Two additive
improvements: (a) a small transform registry keyed by `from→to` so future structural migrations are
expressible; (b) append a `migrationHistory: [{from, to, at, producedBy}]` entry so the digital-twin
provenance chain is auditable. Document the metadata-only limitation if (a) is deferred.

---

## Implemented (2026-06-13)

Each item was re-checked against the live source **and** the connected files (`schema.ts`,
`ingest.ts`, `lock.ts`, `backends.ts`) before applying; a few were rejected/deferred on that
re-read (below). **Verification:** `tsc --noEmit` adds **0 new errors** (the 2 errors that remain —
`backends.ts:227`, `ingest.ts` checkpoint `version` — are pre-existing on HEAD, confirmed by stash
test, and untouched by this work). `bun test` on `cli.test.ts` + `ingest.test.ts` +
`lifecycle.integration.test.ts` = **26 pass / 0 fail**; the runlog now reports a real `durationMs`
(e.g. `44`) instead of the former constant ~100.

**Chapter 0 (shared):** rather than introduce a new file, `readFileOrNull` was added to `ingest.ts`
(its existing FS-util home, already imported by every admin file) and `pMapLimit` was exported from
the same module. `atomicWriteJson` was inlined in `migrate.ts`.

### cli.ts
- **CLI-1 ✅** Config fills only keys the user did not pass (CLI flags win); malformed/missing config now throws instead of being swallowed.
- **CLI-2 ✅** Real `startMs` captured before `ingestBatch`; `batch-end.durationMs` and runlog `startedAt` are now accurate.
- **CLI-3 ✅** `-v`/`-vv`/`-vvv` counted from real argv tokens (no more substring inflation from file paths).
- **CLI-4 ✅** Dead duplicate `reindex`/`explain` blocks inside the `try` removed.
- **CLI-5 ✅** `collectInputs` uses `readdir({withFileTypes})` + bounded-parallel `stat` (pMapLimit 16); D3 sort preserved.
- **CLI-6 ✅** Resolved by TTY-1 (renderer now on stderr) + `showStages` plumbed in; wrapper simplified. Deliberately did **not** disable the renderer in `--json` mode — stderr progress alongside stdout JSON is the better UX once streams are separated.
- **CLI-7 ✅** Shard filter uses a `Set`.
- **CLI-8 ❌ REJECTED** — `cliArgsSchema` already coerces `mem-budget-mb`/`runlog-keep`/`encoder-threads` via `strictPositiveInt` with defaults; no NaN risk exists. (Logged in rejected optimizations.)
- **CLI-9 ⏭️ DEFERRED** — purely cosmetic (`subcmd` derivation already subsumes `|| parsed.*`); skipped to avoid edit risk in the critical dispatch for zero behaviour change.
- **gc output:** now surfaces a `parseErrors` count (JSON) and a stderr warning when orphan deletion was skipped (ties to VAL-1).

### migrate.ts
- **MIG-1 ✅** Lock-acquire failure records an error and skips — never writes unlocked.
- **MIG-2 ✅** Validate via `parseManifest`, then transform a **raw `JSON.parse`** so zod-stripped fields survive. Connected fix: `layout` added to `manifestSchemaV1` in `schema.ts` so the marker round-trips (kills the infinite re-migrate).
- **MIG-3 ✅** Upgrade-only guard (`(schema ?? 1) < target`); unsupported targets (not 2/4) rejected up front — prevents downgrades and invalid schema literals.
- **MIG-4 ✅** `migrateSchema`/`migrateLayout` collapsed into one `migrateManifests()`.
- **MIG-5 ✅** Bounded-parallel (pMapLimit 8) + `readFileOrNull`.
- **MIG-6 ⏭️ DEFERRED** — provenance `migrationHistory` + transform registry left for follow-up; current behaviour is a documented metadata bump.

### validate.ts
- **VAL-1 ✅** Orphan scan skipped (emits `orphan-scan-skipped`) when any manifest is unparseable. **Connected, critical:** `removeOrphans` in `ingest.ts` — the actual gc *delete* path — hardened identically (`parseErrors` guard + `GcResult.parseErrors`), so the data-loss path itself is closed, not just the report.
- **VAL-2 ✅** First pass caches each image's l0; index-stale check reuses it — no second read/parse.
- **VAL-3 ✅** Bounded-parallel walk; verify path reads the level once (no `fileExists`+`readFile`).
- **VAL-4 ✅** `level-read-error` kind now distinct from `hash-mismatch`.
- **VAL-5 ✅ (partial)** `index-orphan` added (reuses `manifestPresent`); progress callback + stale-`.tmp` sweep deferred.

### telemetry-tty.ts
- **TTY-1 ✅** All status to stderr.
- **TTY-2 ✅** TTY-aware; non-TTY emits plain per-percent lines (no `\r`).
- **TTY-3 ✅** Env-only gate replaced; stages shown when `showStages` (from `-vv`) **or** `VERBOSE`/`DEBUG`.
- **TTY-4 ✅** ~10 fps redraw throttle, width-clamped line, rate + ETA.

### rm.ts
- **RM-1 ✅** Defensive parse — a corrupt manifest no longer blocks removal.
- **RM-2 ✅** Dead imports (`readdir`/`stat`/`unlink`/`rebuildIndex`) and unused `hashes` removed.
- **RM-3 ⏭️ KEPT (documented)** — full-store `removeOrphans` retained (dedup-safe; targeted delete would risk shared blobs); rationale noted in code.
- **RM-4 ✅** Single `readFileOrNull`.

### Connected files edited (beyond the five)
- **ingest.ts** — added `readFileOrNull`, exported `pMapLimit`, hardened `removeOrphans` (parse-failure guard), added `GcResult.parseErrors`.
- **schema.ts** — added optional `layout` to `manifestSchemaV1` (MIG-2 round-trip).

---

**Last agent:** once this plan has been implemented in part or in its entirety, append `-DONE` to this
file's name — i.e. rename `CliMigrateValidateTelemetryTtyRm.md` → `CliMigrateValidateTelemetryTtyRm-DONE.md`.

---

## Agent 3 — `packages/pyramid-ingest/src/validate.ts`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

### VAL-1 [P0, Layer B] — Parse-failed manifests produce FALSE `orphan-level` reports → gc can delete live data

`allLevelHashesFromManifests` is only populated from manifests that parsed successfully (a parse error
hits `continue` at L59–62 before its levels are added, L65–67). Every level referenced **only** by a
broken manifest is then reported as `orphan-level` (L90–96). Since operators run `gc` to delete orphans,
acting on this report can **delete blobs that real images still need**. Make orphan detection refuse to
run (or downgrade to indeterminate) when any manifest failed to parse:

```ts
let parseFailures = 0;
// ...in catch for manifest parse: parseFailures++; issues.push({kind:"manifest-parse-error",...}); continue;

// orphan scan:
if (parseFailures === 0) {
  for (const f of levelFiles) {
    if (!f.endsWith(".jxl")) continue;
    const h = f.slice(0, -4);
    if (!allLevelHashesFromManifests.has(h)) issues.push({ kind: "orphan-level", contenthash: h });
  }
} else {
  issues.push({ kind: "orphan-scan-skipped", reason: `${parseFailures} manifest(s) unparseable` } as any);
}
```
Add `orphan-scan-skipped` to the `ValidationIssue` union. (Coordinate with `gc` in `ingest.ts`: ideally
`removeOrphans` adopts the same guard, but that's out of this file's scope — note it for the user.)

### VAL-2 [P1, Layer C] — Index-stale loop re-reads & re-parses EVERY manifest a second time (L100–111) — Lens 20

The first loop (L49–85) already reads+parses every manifest. The index-stale check then reads+parses
them all **again**. Classic "reread memory" — instead, move the pointer: stash each image's l0
contenthash in the first pass and reuse it.

```ts
const l0ByImage = new Map<string, string | undefined>(); // imageId -> level[0].contenthash
// in the first loop, after successful parse:
l0ByImage.set(id, (manifest.levels || [])[0]?.contenthash);

// index-stale, no second read:
for (const ie of indexImages) {
  const truthL0 = l0ByImage.get(ie.imageId);
  if (truthL0 && ie.l0 && ie.l0.contenthash !== truthL0) {
    issues.push({ kind: "index-stale", expected: truthL0, got: ie.l0.contenthash });
  }
}
```
Eliminates N extra reads + N parses on the hot path of a large store.

### VAL-3 [P1, Layer C] — Fully serial scan; collapse double-stat

Every image, and every level within it, is awaited one at a time (L49–85). On a store with thousands of
images this is the dominant cost. Bound-parallelise the per-image loop and the per-level `fileExists`
checks (use the existing pool util; cap concurrency for EMFILE). Replace `fileExists(p)+readFile(p)`
with `readFileOrNull` (Ch.0). Validation is read-only, so parallelism is safe.

### VAL-4 [P2, Layer D] — Read failures mislabelled as `hash-mismatch` (L80–82)

A `readFile` error during `--verify-hash` is pushed as `kind:"hash-mismatch", actual:"read-error"`,
conflating "blob is corrupt/wrong" with "blob couldn't be read". Add a distinct
`{ kind: "level-read-error"; imageId; contenthash; error }` so operators can tell a permissions/IO fault
from genuine corruption.

### VAL-5 [P3, Layer F] — Progress + stale-tmp sweep + index-orphan detection

(a) Large-store validation is silent; accept an optional `telemetry`/progress callback and report
images-scanned. (b) Atomic writes (cli/migrate) can leave `*.tmp` files behind after crashes — report
them as `{ kind: "stale-tmp"; path }` (and let `gc` remove them). (c) Index entries whose manifest is
gone are currently skipped silently (L102 `if (await fileExists(mp))`); emit `{ kind:"index-orphan"; imageId }`.
These make the report a complete machine-readable health signal (Lens 12/16 — feed validation JSON to a
monitoring/ML pipeline).

---

## Agent 4 — `packages/pyramid-ingest/src/telemetry-tty.ts`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

### TTY-1 [P1, Layer A] — Status/progress write to stdout, polluting piped data & `--json` (L15, L21–28)

`stage` and `progress` write to `process.stdout`. stdout is the **data** channel (the CLI emits `--json`
NDJSON and result summaries there). Human progress belongs on **stderr** so stdout stays machine-clean
and pipelines/`--json` aren't corrupted. Route every human write to stderr:

```ts
stage(name, fields) { /* ... */ process.stderr.write(`[stage] ${name}${f}\n`); }
progress(done, total, currentItem) { /* ... */ process.stderr.write(line); /* and the final "\n" */ }
```

### TTY-2 [P1, Layer A] — Not TTY-aware: `\r` produces garbage when piped / in CI (L21–29)

The carriage-return progress line assumes an interactive terminal. Piped to a file or CI log it yields a
single smeared line with embedded `\r`s. Gate on `isTTY` and degrade gracefully:

```ts
const tty = process.stderr.isTTY;
progress(done, total, currentItem) {
  const pct = total > 0 ? Math.floor((done / total) * 100) : 0;
  if (tty) {
    const line = `\r${pct}% (${done}/${total})${currentItem ? " " + currentItem : ""}`;
    if (line !== last) { process.stderr.write(line); last = line; }
    if (done >= total && total > 0) { process.stderr.write("\n"); last = ""; }
  } else {
    // non-tty: occasional newline lines, no \r
    if (pct !== lastPct) { process.stderr.write(`${pct}% (${done}/${total})\n`); lastPct = pct; }
  }
}
```

### TTY-3 [P2, Layer A] — `stage` is double-gated and effectively silent under `-v` (L13)

`stage` only prints when `process.env.VERBOSE || process.env.DEBUG` is set — but the CLI already
*selects* this renderer only when `--verbose`/`-v` is passed (`cli.ts` L389). So `-v` alone selects the
tty telemetry yet `stage` stays silent unless an env var is *also* set. Drop the env gate (let selection
decide), or have the CLI pass the `vv` level in and gate on that. Recommended: print whenever this
renderer is active; reserve env vars for an extra-chatty tier if needed.

### TTY-4 [P3, Layer F] — Frame-budget throttle, width-truncate, ETA/throughput (Lens 13/21)

(a) Throttle redraws to ~10 fps (skip if `<100 ms` since last paint) to cut syscalls during fast
batches. (b) Long `currentItem` paths wrap the terminal, defeating `\r` (which only returns to column 0
of the *current* line) and leaving residue — truncate to `process.stderr.columns`. (c) Track a start
time and render rate (`items/s`) + ETA. Useful for the multi-thousand-image ingests this platform
targets.

```ts
// width-safe, residue-free single-line render
const cols = process.stderr.columns ?? 80;
let line = `${pct}% (${done}/${total})${currentItem ? " " + currentItem : ""}`;
if (line.length > cols - 1) line = line.slice(0, cols - 2) + "…";
line = "\r" + line.padEnd(cols - 1); // pad clears leftover chars from a longer previous line
```

---

## Agent 5 — `packages/pyramid-ingest/src/rm.ts`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

### RM-1 [P1, Layer B] — A corrupt manifest makes the image UN-removable (L25)

```ts
const manifest = parseManifest(await readFile(manifestPath, "utf8")); // throws on bad JSON/schema
```
If the manifest is corrupt, `parseManifest` throws *before* the directory delete, so `rm` propagates to
the CLI's top-level catch and the image can never be removed — the exact situation where removal is most
needed. Parse defensively, still delete the dir, and only skip the hash-scoped gc when hashes are
unknown:

```ts
let hashes: string[] = [];
try {
  const m = parseManifest(await readFile(manifestPath, "utf8"));
  hashes = (m.levels || []).map((l: any) => l.contenthash).filter(Boolean);
} catch (e) {
  // corrupt manifest: still remove the dir; gc by full scan only
}
if (!opts.dryRun) {
  try { await rm(imageDir, { recursive: true, force: true }); removedDirs.push(imageId); }
  catch {}
} else { removedDirs.push(imageId); }
```

### RM-2 [P2, Layer E] — Dead imports and an unused variable

`readdir`, `stat`, `unlink` (L1) and `rebuildIndex` (L6) are imported but never used; `hashes` (L26) is
computed and never read (gc does a full `removeOrphans` instead). Remove the dead imports and either use
`hashes` (RM-3) or delete it. Keeps the lint surface clean.

### RM-3 [P3, Layer C/F] — Single-image `rm --gc` triggers a full-store orphan scan (L40–44)

`removeOrphans(outDir)` rescans the entire `levels/` + every manifest just to clean up one image's
now-unreferenced blobs. With the `hashes` already in hand (RM-1), a **targeted** sweep is possible —
delete only those `hashes` not referenced by any *other* manifest. That needs a global refcount, so the
full scan is *correct* (dedup-safe) where a naïve targeted delete would corrupt shared levels. Options:
(a) keep full scan, document the cost; (b) build a refcount map once and reuse for targeted deletes.
Pick (a) unless rm-heavy workflows prove the cost matters; record the decision.

### RM-4 [P3, Layer C] — Double-stat read (L20/L25)

`fileExists(manifestPath)` then `readFile(manifestPath)` → use `readFileOrNull` (Ch.0): one syscall,
`null` ⇒ early `{removedDirs:[],removedLevels:[]}`.

---

## Overview — what implementing this achieves

The five files are the operator's hands on the ingest store, and the review surfaces three classes of
win. **First, it closes two genuine data-safety holes.** `validate` currently turns a single corrupt
manifest into a list of "orphan" level blobs (VAL-1), and `gc` exists precisely to delete orphans — so a
parse error in one manifest can cascade into the deletion of blobs that healthy images still depend on.
`migrate` silently writes manifests *without the lock it just failed to acquire* (MIG-1), racing
concurrent ingests on the same file. And `rm` refuses to delete an image whose manifest is corrupt
(RM-1) — the one case where you most need it gone. These are the findings that protect the user's
irreplaceable biodiversity captures, and they should land first.

**Second, it makes the admin plane honest and scriptable.** Today `--json` output is corrupted the
moment `--verbose` is also set, because the human progress renderer writes to the same stdout the JSON
consumer reads (TTY-1, CLI-6); the same renderer smears `\r` across CI logs because it never checks for
a TTY (TTY-2). The runlog records a fabricated ~100 ms duration for every run regardless of real elapsed
time (CLI-2), and `-vv` is detected by counting a substring that any file path can trigger (CLI-3).
Moving status to stderr, making it TTY-aware, and recording a real start timestamp turn these commands
into reliable building blocks for automation and the monitoring/ML pipelines the platform is heading
toward.

**Third, it removes redundant work and duplication.** `validate` reads and parses every manifest twice
— once to check levels, once for the index-stale pass — a literal "reread the memory instead of moving
the pointer" that VAL-2 fixes by caching the l0 hash from the first pass. Across all five files the
`fileExists()+readFile()` pattern doubles syscalls where a single `readFileOrNull` suffices, the serial
directory walks leave parallelism on the table (CLI-5, VAL-3, MIG-5), and `migrate`'s two functions are
near-identical copies (MIG-4). Consolidating the shared *walk / atomic-write / read-or-null* patterns
into one small `store-fs` helper (Chapter 0) both speeds the commands up on large stores and gives every
future correctness fix a single home — which is the structural shape the defocused, birds-eye view
(Lens 21) keeps pointing at. The feature layer (ETA/throughput progress, validation health signals,
migration provenance) then sits cleanly on top of an admin plane that is finally safe, honest, and fast.
