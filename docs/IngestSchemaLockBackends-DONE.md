# Ingest Engine Core — Lens Review & Handoffs

**Files assessed:** `packages/pyramid-ingest/src/ingest.ts`, `schema.ts`, `lock.ts`, `backends.ts`
(the engine beneath the Group-10 admin plane).

**Scope rule for implementers:** one agent per file; do not touch other files except this plan and
`C:\Foo\raw-converter-wasm\docs\rejected optimizations.md`. Connected edits (cli.ts tier handling,
checkpoint.ts shape) are called out explicitly where a fix is incohesive without them.

---

## Lens 1 — Strategic view & data flow

These four files are the **ingest engine**:

```
ingest.ts   orchestrator: collectInputs→computeIngestPlan→applyIngestPlan→ingestBatch
            (in-process pool OR worker_threads pool), rebuildIndex, removeOrphans (gc)
   ├─ backends.ts  RawBackend (orf/dng/cr2 decode) + JxlBackend (encode pyramid/tile, downscale,
   │               transcodeJpeg, decodeToRgba8, profileConvergence[Curve] — Butteraugli/SSIM)
   ├─ schema.ts    zod: manifest (v1/v2/v4), gallery index, cliArgs, producedBy; parseManifest is
   │               the single validation gate every other file funnels through
   └─ lock.ts      advisory multi-process locks (write: ingest/gc/rm/migrate; read: validate/explain;
                   per-image write/read), stale detection, EBUSY retry
```

`parseManifest` (schema) is the chokepoint: ingest writes manifests, validate/migrate/rm/rebuildIndex
read them through it. Two **capability-drift** seams run through the set (Lens 21): ingest advertises
RAW formats (`RAW_EXT`) that schema's enum rejects, and cli advertises tier values schema's enum
rejects. `lock.ts` documents a shared-read/exclusive-write contract its code does not fully implement.
Lens 17 (non-Riemannian colour) lives in the Rust `LookRenderer`, not here — **N/A**. Lens 15
(Butteraugli) lands squarely in `backends.ts`.

---

## Chapter map (implementation layers)

- **Layer A — Capability-contract drift (correctness):** SCH-1, SCH-5, SCH-4
- **Layer B — Lock contract (concurrency correctness):** LOCK-1, LOCK-2, LOCK-3
- **Layer C — Robustness & type-debt:** ING-5, ING-21, BK-4, BK-9
- **Layer D — Dead code / cleanup:** ING-9, ING-20, BK-6
- **Layer E — Performance (opt-in/at-scale):** ING-2, ING-4, BK-1, BK-3
- **Layer F — Platform features:** SCH-7 (Darwin Core), ING-12 (capture metadata), BK-8 (recognition thumbnail)

Severity: **P0** data-loss · **P1** real bug / latent breakage · **P2** clear improvement · **P3** polish.

---

## Agent 1 — `ingest.ts`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

### ING-5 [P1, Layer C] — Corrupt existing manifest fails the image instead of re-ingesting (L445–451)

```ts
if (!opts.force && (await fileExists(manifestPath))) {
  const existing = parseManifest(await readFile(manifestPath, "utf8")); // throws on corrupt → image FAILS
  ...
}
```
A torn/corrupt existing manifest should be treated as "not up to date" and **re-ingested**, not throw
(which records the image as failed and leaves the corruption). Also collapses the
`fileExists`+`readFile` double-stat:
```ts
if (!opts.force) {
  const txt = await readFileOrNull(manifestPath);
  if (txt !== null) {
    try {
      const existing = parseManifest(txt);
      const wantProxy = opts.proxy !== undefined;
      const uptodate = isUpToDate(existing, info.mtimeMs, wantProxy)
        || ((existing as any).stub === true && existing.master.mtimeMs === info.mtimeMs);
      if (uptodate) return { outcome: "skipped" };
    } catch { /* corrupt manifest → fall through and re-ingest (overwrite) */ }
  }
}
```

### ING-21 [P1, Layer C] — Pre-existing tsc error: checkpoint literal missing `version` (L639)

`CheckpointState` requires `version: "1"` (checkpoint.ts) but the fresh-state literal omits it:
```ts
const cpState: CheckpointState = checkpoint || { version: "1", batchId, startedAt, inFlight: [], completed: [], failed: [] };
```
This clears one of the two standing `tsc --noEmit` errors.

### ING-9 [P2, Layer D] — Worker-pool chaos injection wastes a full encode and mislabels result (L867–872)

The chaos throw fires **after** `w.postMessage(...)`, so the worker still decodes+encodes+writes the
image, then the main side throws and records it **failed** despite the file being written. Move the
injection before dispatch so it models a real pre-work failure:
```ts
// before lock/postMessage:
if (opts.chaosTest && Math.random() < 0.25) { /* record failed + continue, no work done */ }
```
(Place it alongside the in-process path's injection point, before `acquireImageWriteLock`.)

### ING-20 [P3, Layer D] — Unnecessary `(result as any)` casts for declared fields

`degraded` and `totalStagedBytes` are declared on `BatchResult` (L59–60); the repeated
`(result as any).degraded` / `(result as any).totalStagedBytes` casts are noise — use the typed fields.

### ING-2 [P2, Layer E — DEFERRED rec] — exifr parsed 2–3× per fallback image

`extractBasicMetadata` (L458), `tryExtractEmbeddedJpeg` (L534), and `probeOrientation` (L547) each run
their own `import("exifr")` + full parse of the **same** master bytes on the Tier-3 fallback path.
Consolidate into one `exifr.parse` pass returning {metadata, orientation, embeddedPreview}. Real
per-image latency win on the RAW-fallback path; flagged for a careful follow-up (touches 3 helpers).

### ING-4 [P2, Layer E — DEFERRED rec] — `applyIngestPlan` does `readdir(levelsDir)` per image (L397)

The shared `levels/` dir can hold 10k+ blobs; reading the whole listing **per image** is O(N·files).
At biodiversity-collection scale this dominates. Either build the existing-set once per batch and thread
it down (in-process path), or revert to per-level `fileExists` (≈5–8 cheap stats/image) for large dirs.
Needs a benchmark before changing — record the decision.

---

## Agent 2 — `schema.ts`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

### SCH-1 [P1, Layer A] — Format enum drops RAW formats `ingest.ts` advertises → manifest parse throws

`ingest.ts RAW_EXT` maps `.pef → pef`, `.srw → srw`, `.x3f → x3f`, but `masterInfoSchema.format`
(L53) lists only `orf,dng,cr2,jpg,nef,arw,raf,rw2,unknown`. Ingesting a `.pef/.srw/.x3f` builds a
manifest with `format:"pef"` → `parseManifest` rejects it (Tier-5 stub throws outright at L596 of
ingest; Tier-3 manifests are later skipped by rebuildIndex as "unreadable"). Either add the three to
the enum, or map them to `unknown` in `RAW_EXT`. Advertised support ⇒ add them:
```ts
format: z.enum(["orf","dng","cr2","jpg","nef","arw","raf","rw2","pef","srw","x3f","unknown"]),
```

### SCH-5 [P1 latent, Layer A] — `producedBy` major-version pinned to `"0"` bricks the store at v1.0

```ts
producedBy: producedBySchema.refine((p) => (p.version || "").split(".")[0] === "0", { ... }).optional()
```
The moment `package.json` hits `1.0.0`, `makeProducedBy()` stamps `version:"1.x"`, and every freshly
written manifest **fails its own `parseManifest` on the next read** — the whole gallery becomes
unreadable. Accept the current major and below instead of hard-pinning `0`:
```ts
.refine((p) => {
  const maj = Number((p.version || "0").split(".")[0]);
  if (!Number.isFinite(maj) || maj < 0) return false;
  const curMaj = Number((getVersion() || "0").split(".")[0]);
  return maj <= (Number.isFinite(curMaj) ? curMaj : 0); // accept ≤ tool major; reject newer-major
}, { message: "unsupported producedBy major version" })
```
(Compares against the running tool's major from `getVersion()` — accepts the tool's own + older
manifests, still rejects forward-incompatible ones. NB: `manifest.test.ts` B10 requires a `999.0.0`
major to be rejected, so do **not** blanket-accept all majors.)

### SCH-4 [P2, Layer A] — cli offers tier values the enum rejects (cross-file with cli.ts)

`cliArgsSchema.tier` is `z.enum(["simd","scalar","auto"])` (L199), but `cli.ts` (L352–354) branches on
`tier === "simd-mt" || tier === "relaxed-simd-mt"` — values that can never pass schema validation, so
that branch is dead. Either add the MT tiers to the enum (if `setForcedTier` accepts them) or drop the
dead names in cli, keeping the reachable `"auto"` case. Recommend the cli cleanup unless MT tiers are
a planned, supported input.

### SCH-7 [P2 feature, Layer F — DEFERRED] — Typed Darwin Core occurrence sub-schema

`manifest.metadata` is `z.record(z.unknown())`. For the biodiversity platform, a typed optional
`occurrence` block (decimalLatitude/Longitude, coordinateUncertainty, eventDate ISO8601, recordedBy,
scientificName/taxonID) would make manifests first-class Darwin Core and queryable for georeferenced
occurrences. Additive; pairs with ING-12.

---

## Agent 3 — `lock.ts`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

### LOCK-1 [P1, Layer B] — Write lock ignores outstanding READ locks (contract violation)

The module documents (L144–145) "write waits for reads to release + blocks new reads", but
`acquireWriteLockFile` (L62–86) only creates the single write-lock file and **never scans the
`.read.*` files**. So a writer (gc / ingest / migrate) proceeds **concurrently with active readers**
(validate / explain) — gc can delete level blobs while validate is hashing them. Make the writer, after
claiming the write-lock (which blocks *new* readers), wait for existing live read locks to drain:
```ts
// after successfully creating the write lock file, before returning the AdvisoryLock:
await waitForReadLocksToClear(dirname(lockPath), timeoutMs - (Date.now() - start), label);
```
where `waitForReadLocksToClear` reads the lock dir, filters `*.lock.read.*`, prunes stale ones
(dead pid / age>STALE_MS — see LOCK-2/LOCK-3), and sleeps until none remain or it times out (on
timeout: release the write lock and throw). Keep the **no-readers fast path instant** (empty scan →
return immediately) so single-command runs are unaffected.

### LOCK-2 [P2, Layer B] — pid liveness is host-local; network volumes mis-judge staleness

`isPidAlive` (L27–35) uses `process.kill(pid,0)`, meaningless for a lock written by another host on a
shared volume (the platform's likely storage). A coincidentally-live pid on host B keeps a dead host-A
lock forever; a dead pid steals a live remote lock. Stamp the host and only trust the pid check when it
matches:
```ts
interface LockFile { kind: "write" | "read"; pid: number; host: string; createdAt: number; }
// write: { ..., host: os.hostname() }
// staleness: alive = (existing.host && existing.host !== os.hostname()) ? true /* can't tell → rely on age */ : await isPidAlive(existing.pid)
```
Back-compat: treat a missing `host` as same-host (current behaviour).

### LOCK-3 [P2, Layer B] — Read-lock files are never stale-GC'd → leak (and would block writers once LOCK-1 lands)

`acquireReadLock` writes a unique `.lock.read.<pid>.<rand>` (L122); only `release()` removes it. A
crashed reader leaks it forever, and nothing ever prunes read locks. Implement pruning inside the
LOCK-1 writer scan (and optionally on read acquisition): a read lock whose pid is dead (same host) or
whose age exceeds `STALE_MS` is unlinked and ignored. Without this, fixing LOCK-1 would let one leaked
read lock wedge all writers — implement the two together.

---

## Agent 4 — `backends.ts`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

### BK-9 [P2, Layer C] — Pre-existing tsc error: `cachedSsim` may be `undefined` (L227)

`getCachedSsimFn` returns `Promise<fn|null>` but the module `let cachedSsim` is `fn|null|undefined`;
`return cachedSsim` (after the `!== undefined` guard, which TS doesn't narrow across the await) trips
TS2322. Fix:
```ts
return cachedSsim ?? null;
```
Clears the second standing `tsc --noEmit` error.

### BK-4 [P2, Layer C] — `encodeTileContainer16` lacks the presence guard its siblings have

`downscaleRgba8/16` check `typeof ds !== "function"` and throw a clear error (L168, L178), but
`encodeTileContainer16` (L151–153) calls `JW.encodeTileContainerRgba16` blind — on a WASM build
without the rgba16 export (per CLAUDE.md the 16-bit JXTC path needs a rebuild) it throws an opaque
"enc is not a function". Add the guard:
```ts
const enc = JW.encodeTileContainerRgba16;
if (typeof enc !== "function") throw new Error("encodeTileContainerRgba16 missing on jxl-wasm module (16-bit JXTC build required)");
```

### BK-6 [P3, Layer D] — Remove dead `decodeProgressivePasses` (~60 lines, L267–329)

Module-private and unreferenced — `measureConvergenceProfile` uses its own streaming decode. Delete it
(the comment already marks it "kept for legacy/external use", but nothing in-repo imports it; it is not
exported).

### BK-1 [P2, Layer E — DEFERRED] — Butteraugli: cutoff-only path computes the full curve then discards it

`profileConvergence` (cutoff-only) calls `measureConvergenceProfile`, which measures **every** pass's
SSIM+Butteraugli, then returns only `convergedByteEnd`. For the non-curve flag, add an early-stopping
measure that halts after the first pass meeting `SSIM_CONVERGED || BUTTERAUGLI_CONVERGED`. Butteraugli
is the pipeline's slowest op (Lens 15); this avoids measuring every tail pass when only the cutoff is
wanted.

### BK-3 [P2, Layer E — DEFERRED] — Redundant SSIM alongside the Butteraugli comparator

When `ButteraugliComparator` is available, the per-pass loop computes **both** SSIM (L390–397, full
`Uint8ClampedArray.from` copy + JS SSIM) and Butteraugli (L399–403). Butteraugli alone drives
convergence. Skipping SSIM when the comparator is present roughly halves per-pass metric cost. Deferred
because the persisted `qualityCurve` would then carry Butteraugli-only when the comparator is active —
a (documented) change to the manifest data contract.

### BK-8 [P2 feature, Layer F — DEFERRED] — Recognition thumbnail for ML/AR (Lens 12/16)

The backend already has `decodeToRgba8` + `downscaleRgba8`; emitting a small normalized thumbnail
(e.g. 224×224) per image during ingest would feed embedding/recognition and real-time AR plant-ID
without a re-decode. Additive; persist a reference in the manifest.

---

## Overview — what implementing this achieves

The headline of this pass is **closing capability-drift seams** that turn advertised features into
latent breakage. `schema.ts` rejects three RAW formats (`pef/srw/x3f`) that `ingest.ts` cheerfully
accepts, so those files fail at the manifest gate today (SCH-1); and the `producedBy` major-version is
hard-pinned to `"0"`, meaning the first `1.0.0` release would make every freshly written manifest
unreadable on its very next read (SCH-5) — a quiet time-bomb under the whole store. Both are one-line
schema fixes with outsized blast radius. The cli/enum tier mismatch (SCH-4) is the same class of drift,
caught before it confuses a user.

The second theme is **making the concurrency model honest**. `lock.ts` advertises shared-read /
exclusive-write semantics, but the writer never looks at reader locks, so a `gc` can delete blobs while
`validate` reads them (LOCK-1) — and because read locks are never stale-collected (LOCK-3) and pid
liveness is meaningless across hosts on a shared volume (LOCK-2), the lock store both under- and
over-trusts itself. Implemented together — writer drains live readers, stale readers are pruned, host
is recorded — the locks finally enforce the contract they document, while keeping the common
single-command path instant.

The remainder hardens robustness and pays down debt: a corrupt manifest now triggers a clean re-ingest
instead of failing the image (ING-5); both standing `tsc` errors are cleared (ING-21, BK-9); the
16-bit encode path fails loudly instead of obscurely (BK-4); and dead code and stray `any`-casts are
removed (BK-6, ING-20, ING-9). The deferred items chart the next, higher-effort wins — collapsing the
triple exifr parse on the fallback path (ING-2), taming the per-image `readdir` at collection scale
(ING-4), and cutting Butteraugli cost on the convergence profiler (BK-1, BK-3) — plus the
platform-facing features (Darwin Core occurrences, capture metadata, recognition thumbnails) that this
engine is well placed to grow into.

---

## Implemented (2026-06-13)

Each item re-checked against live source + connected files (`hash.ts`, `checkpoint.ts`, `cli.ts`,
`manifest.ts`) before applying. **Verification:** `tsc --noEmit` = **No errors found** (the 2 errors
standing on HEAD — `backends.ts:227`, `ingest.ts` checkpoint `version` — are now *fixed* by BK-9 and
ING-21); `bun test` = **53 pass / 0 fail** across 7 files.

### ingest.ts
- **ING-5 ✅** Corrupt existing manifest now falls through to a clean re-ingest (try/catch around `parseManifest`) instead of failing the image; `fileExists`+`readFile` collapsed to `readFileOrNull`.
- **ING-9 ✅** Worker-pool chaos injection moved before job claim/`postMessage` — no wasted decode, no written-but-marked-failed.
- **ING-20 ✅** Dropped `(result as any)` casts on the declared `degraded`/`totalStagedBytes` fields.
- **ING-21 ✅** Checkpoint literal now includes `version: "1"` (cleared a standing tsc error).
- **ING-10 ❌ REJECTED** — claimed a double full-file read (main hashes content, worker re-reads). Grounded in `hash.ts`: `imageIdForPath` hashes the **realpath string**, not file content — no double read. Logged.
- **ING-2 / ING-4 ⏭️ DEFERRED** — triple-exifr consolidation and per-image `readdir(levelsDir)` at scale; both need a careful refactor/benchmark.

### schema.ts
- **SCH-1 ✅** Added `pef`/`srw`/`x3f` to `masterInfoSchema.format` (matches ingest `RAW_EXT`; those formats no longer throw at the manifest gate).
- **SCH-5 ✅** `producedBy` major-version check now accepts majors **≤ the running tool's major** (via `getVersion()`), killing the v1.0 time-bomb while still rejecting forward-incompatible (newer-major) manifests — reconciled with the existing `manifest.test.ts` B10 case that requires a `999.0.0` major to be rejected.
- **SCH-4 ✅** (connected, cli.ts) Removed the unreachable `simd-mt`/`relaxed-simd-mt` tier branch; kept the reachable `auto`→`simd` downgrade for single-thread.
- **SCH-7 ⏭️ DEFERRED** — typed Darwin Core occurrence sub-schema (feature).

### lock.ts
- **LOCK-1 ✅** Writers now drain live readers after claiming the write lock (`waitForReadLocksToClear`); on timeout they release and throw. No-readers fast path returns immediately. Readers use optimistic-claim + re-verify to close the interleave race symmetrically.
- **LOCK-2 ✅** `LockFile.host` recorded; `isLockStale` only trusts pid liveness on the same host, else relies on age (safe for network volumes). Missing host = treated as same-host (back-compat).
- **LOCK-3 ✅** Stale read locks (dead pid / aged out) are pruned during the writer drain scan — no more permanent reader-lock leaks.

### backends.ts
- **BK-4 ✅** `encodeTileContainer16` now guards `typeof enc !== "function"` with a clear "16-bit JXTC build required" error, matching the downscale paths.
- **BK-6 ✅** Removed dead, unreferenced `decodeProgressivePasses` (~60 lines).
- **BK-9 ✅** `getCachedSsimFn` returns `cachedSsim ?? null` (cleared the second standing tsc error).
- **BK-1 / BK-3 ⏭️ DEFERRED** — Butteraugli cutoff-only early-stop and redundant-SSIM skip; the latter changes the persisted `qualityCurve` data contract, so deferred for explicit sign-off.
- **BK-8 ⏭️ DEFERRED** — recognition thumbnail (feature).

### Connected files edited (beyond the four)
- **cli.ts** — SCH-4 tier-branch cleanup.
- (Grounding only, not edited: `hash.ts`, `checkpoint.ts`, `manifest.ts`.)

---

**Last agent:** once this plan has been implemented in part or in its entirety, append `-DONE` to this
file's name — i.e. rename `IngestSchemaLockBackends.md` → `IngestSchemaLockBackends-DONE.md`.
