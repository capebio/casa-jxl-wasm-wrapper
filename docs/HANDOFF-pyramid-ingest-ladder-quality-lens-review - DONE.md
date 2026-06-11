# HANDOFF — Lens Review: pyramid-ingest `ingest.ts` / `ladder.ts` / `quality.ts`

22-lens review (strategic, API, pipeline, state, data structures, hot kernels, boundaries, support, owl, reversal, astronomy, ML, gaming, photogrammetry, Butteraugli, AR, perceptual colour, pure math, hacker, gaps, birds-eye). Findings amalgamated and deduplicated. Five Grok agents; **one file per agent** (ingest.ts split across Agents 1–3 by concern). Agents may read other files for context but must defer edits outside their file to the end and request approval first.

## Global constraints (do not violate)

- **Ratified, do not re-propose:** `EFFORT = 3` (user-measured best speed/size); smallest level stays 256 px (Q8); `packedRgb16ToRgba16` conversion stays in JS (Q12).
- Check `docs/rejected optimizations.md` before implementing anything that smells like a previously rejected idea.
- `convergedByteEnd`: WASM/backend measures only; client abort lives in the stream layer.
- Surgical edits only; match existing style; no opportunistic refactors.

---

## Agent 1 — `ingest.ts`: batch loop, worker pool, checkpoint

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in `C:\Foo\raw-converter-wasm\docs\rejected optimizations.md`

### B1 (BUG, high) — Worker crash poisons all jobs, then batch hangs
`pending` is one shared `Map` for all workers. `w.on("error")` (≈line 587) rejects **every** pending job (including other workers'), and the dead worker is never replaced — its dispatcher loop posts the next job to a dead worker, the promise never settles, `await p` hangs, the whole batch deadlocks.

Fix: track owner per entry and stop dispatching to dead workers:
```ts
const pending = new Map<number, { resolve: (o: any) => void; reject: (e: any) => void; worker: number }>();
const dead = new Set<number>();
w.on("error", (e) => {
  dead.add(wi);
  for (const [id, p] of pending) if (p.worker === wi) { pending.delete(id); p.reject(e); }
});
// in runOne(): if (dead.has(wi)) break;  // checked each iteration, before postMessage
```
Optional follow-up: respawn the worker once before giving up.

### B2 (BUG) — `chaosTest` throw escapes try/finally: lock leak + whole-batch crash
In both loops the chaos injection (≈lines 522, 614) sits **after** `acquireImageWriteLock` and **before** the `try` block. The throw skips `finally` (lock never released) and rejects the dispatcher promise, so `Promise.all` kills the entire batch — defeating the point of a recovery test. Move the chaos throw to the first line **inside** the `try`.

### B3 (perf) — Checkpoint state is O(n²) and writes too often
- `cpState.inFlight.includes(path)` + `.filter(...)` are O(n) per image → O(n²) per batch. Hold `inFlight` as a `Set<string>` in memory; convert to array inside `persistCheckpoint()`.
- `persistCheckpoint()` runs twice per image (start + end), each a full JSON write that grows with `completed` → O(n²) bytes for 10k-image batches. Keep the immediate persist for `inFlight` additions (crash-recovery value), but debounce completion persists (~1 s dirty-flag timer) and always flush in the batch epilogue and on failure.

### B4 (perf, small) — `conc`/worker spawn computed before resume filtering
`total` and `conc` (≈lines 477–478) use the pre-filter `activeFiles`. After a resume filter leaves 2 files, you still spawn `opts.concurrency` workers, each paying thread + WASM init. Compute `conc` after the resume filter; spawn `min(conc, activeFiles.length)` workers.

### B5 (perf) — `postMessage({ id, path, opts })` structured-clones full `opts` per job
`opts.statMap` can be a large Record (whole batch). Per-job clone is pure waste. Send per-path data only:
```ts
const jobOpts = { ...opts, statMap: undefined as any, statEntry: opts.statMap?.[path] };
w.postMessage({ id, path, opts: jobOpts });
```
(ingest-worker.ts must map `statEntry` back; that is a deferred cross-file edit — request approval.) Alternative: send `statMap` once in a worker init message.

### B6 (design) — Resume permanently skips prior failures
Resume filter treats `checkpoint.failed` as done. Transient errors (EBUSY, OOM, chaos) are never retried without `--force`. Add `opts.retryFailed?: boolean` that excludes `failed` from the skip set, and store the error `code` alongside the message in `cpState.failed` so the CLI can distinguish transient vs permanent.

### B7 (feature) — Abort does nothing mid-image
`backends.signal` is only polled between images; a long decode/encode is uninterruptible and workers are only terminated in the epilogue. Add `signal.addEventListener("abort", () => workers.forEach(w => w.terminate()))` (with pending rejections per B1's per-worker map) for prompt cancellation.

### B8 (cleanup) — Dual-shape worker reply protocol
`outcomeOrRes` "may be string (old) or object (new)". Collapse to one object shape `{ outcome, stagedBytes?, durationMs? }`; delete the `typeof === "string"` branches. (Worker-side change deferred — request approval.)

### B9 (verify) — `new URL("./ingest-worker.ts", import.meta.url)`
A `.ts` specifier only resolves under tsx/ts-node loaders. Verify what the build ships (`dist` should reference `./ingest-worker.js`). If broken in compiled output, the worker pool path dies in production while tests (in-process fakes, `__testInProcess`) pass — exactly the kind of blind spot to close. Fix with a `.js` specifier or build-time rewrite.

### B10 (minor) — `perImage` in resume mode mixes runs
`cpState.completed` from a loaded checkpoint includes prior runs' entries; `written`/`skipped` counters count only this run. Tag entries (e.g. `runId`) or filter `perImage` to this run for consistent runlogs.

### B11 (minor) — `imageIdForPath(path)` computed twice per image
Once in the dispatcher, again inside `ingestImage`. If it hashes only the path string this is noise; if it ever touches the fs, it is real. Pass the id through (e.g. extend the worker message / an optional arg) only if profiling shows it matters.

---

## Agent 2 — `ingest.ts`: per-image pipeline, fs atomicity, GC, index

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in `C:\Foo\raw-converter-wasm\docs\rejected optimizations.md`

### P1 (BUG) — `require()` in ESM: empty image dirs never removed
`removeOrphans` ≈line 758: `require("node:fs/promises")` throws `ReferenceError` in an ES module; the surrounding catch swallows it, so the dir is neither removed nor reported. Fix:
```ts
import { rm } from "node:fs/promises"; // add to existing import
...
if (!opts.dryRun) await rm(idDir, { recursive: true, force: true }).catch(() => {});
removedImageDirs.push(id);
```

### P2 (BUG) — Timeout race: timer leak + unhandled rejection + wrong coverage
≈lines 380–387:
- The `setTimeout` is never cleared on success → process lingers up to `timeoutMs` after the batch.
- If the timeout wins, `execP` keeps running and a later rejection is **unhandled** (Node may hard-exit).
- The race only wraps `applyIngestPlan` (fs writes, cheap). The expensive phase — decode + encode in `computeIngestPlan` — is unbounded, so `timeoutMs` doesn't do what its name says.

Fix:
```ts
let timer: NodeJS.Timeout | undefined;
const t = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`ingest timeout after ${timeout}ms for ${masterPath}`)), timeout); });
try {
  await Promise.race([execP, t]);
} finally {
  clearTimeout(timer);
  execP.catch(() => {}); // detach loser
}
```
Then either move plan computation inside the raced region (preferred) or rename/document the option as `applyTimeoutMs`.

### P3 (perf) — `contentHash16` computed twice per level
`toEntry` runs in `computeIngestPlan` (manifest) and again in `applyIngestPlan → writeLevelFiles`. That hashes every encoded level's bytes twice (MBs per image). Carry the entries in the plan:
```ts
export interface IngestPlan { ...; entries: LevelEntry[]; }
// computeIngestPlan: entries already computed — store them.
// applyIngestPlan: pass plan.entries to writeLevelFiles (new optional param) and skip re-toEntry.
```
Keep `writeLevelFiles`' standalone behaviour when entries are not supplied (other callers).

### P4 (BUG/perf) — mtimecache: lost-update race; possibly dead code
≈lines 392–399: every image does read-modify-write of one shared JSON from multiple workers — last writer wins, entries silently lost. First **verify a consumer exists** (grep for `.pyramid-ingest.mtimecache.json` outside this file). If none: delete the block (two fs ops per image saved). If consumed: write it **once per batch** from the coordinator (it already owns per-image results via `cpState`), not per image. Coordinator change coordinates with Agent 1 — keep the edit in this file's batch epilogue.

### P5 (perf) — `writeLevelFiles`: serial writes + per-level `access()`
Levels are independent and content-addressed: write with `Promise.all`. Optionally accept `existingLevels?: Set<string>` (one `readdir(levelsDir)` per batch, supplied by caller) to replace N `fileExists` stats; staleness is harmless because writes are idempotent.
```ts
await Promise.all(levels.map(async (level) => { ...existing body... }));
```
(Preserve output entry order: build `entries` by index, not by push order.)

### P6 (BUG, race) — GC can delete levels of an in-flight image
`removeOrphans` builds `referenced` from manifests; an image whose levels are written but whose manifest rename hasn't happened yet loses its level files. Add a grace window and document it:
```ts
const GRACE_MS = 10 * 60 * 1000;
const st = await stat(full).catch(() => null);
if (st && Date.now() - st.mtimeMs < GRACE_MS) continue; // too fresh to judge
```
Optionally also skip when a live image lock dir exists (read-only check on lock.ts naming — verify, no edits there).

### P7 (perf) — Proxy ingests never skip
≈line 345: the up-to-date check requires `opts.proxy === undefined`, so proxy runs re-decode + re-encode every time. The manifest carries a `proxy` flag — extend the check: if an existing manifest has `proxy === true`, matching `mtimeMs` (and ideally matching proxy size, if recorded; if not recorded, add it to the manifest — schema addition, request approval) → skip.

### P8 (BUG-ish) — `dryRun` promises a plan it never returns
Comment says "caller (CLI) prints plan" but `ingestImage` returns `{ outcome: "written" }` only. Add `plan?: IngestPlan` to `IngestResult` and return it under `dryRun`. Separately: dry-run still pays full decode+encode. A true plan-only mode (dims/targets, no encode) needs ladder cooperation — propose, defer, request approval (coordinate with Agent 4).

### P9 (robustness) — Lock acquisition failure silently ignored
`try { imgLock = await acquireImageWriteLock(...) } catch {}` proceeds **unlocked** on contention — exactly the case the lock exists for. Minimum: `tel?.event?.("lock-failed", { path, imageId })`. Better: a bounded wait/retry, then record as failed rather than writing unlocked.

### P10 (tests) — `Backends.clock` declared, never used
`Date.now()` everywhere despite the injected `Clock`. Route through `backends.clock?.now() ?? Date.now()` (a tiny local helper) so batch tests can be deterministic.

### P11 (minor) — Consistency & dead code
- `rebuildIndex` writes warnings via `process.stderr.write` — route through `telemetry.event` when available, stderr as fallback.
- `withEbusyRetry`'s `label` param is unused — include it in the rethrown error context (`e.message += \` (\${label})\`` is enough) or drop it.
- `isUpToDate(...) || (existing as any).stub === true && ...` — precedence is correct but parenthesize the `&&` clause for readability.

---

## Agent 3 — `ingest.ts`: fallback tiers, metadata, domain features

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in `C:\Foo\raw-converter-wasm\docs\rejected optimizations.md`

### F1 (BUG, quality) — Tiny thumbnail beats full-size embedded preview
`tryExtractEmbeddedJpeg` tries `exifr.thumbnail()` (IFD1, typically 160×120) **first**; any thumb >4096 B wins over `JpgFromRaw`/`PreviewImage` (often full-resolution). The fallback pyramid is then built from a postage stamp. Reorder: parse `JpgFromRaw`/`JpegFromRaw`/`PreviewImage` first; `thumbnail()` is the last resort. Then prefer the **largest** candidate by byte length.

### F2 (quality guard) — Minimum-dimension gate on Tier 3
Even reordered, a small preview can pass the 4 KB gate. Decode just the JPEG SOF header (cheap scan for 0xFFC0/C2 marker — ~20 lines, no new dep) to get dims; if long edge < 1024, either drop to Tier 5 or proceed but set `metadata.degraded = true` in the manifest so the gallery can badge it. Manifest field addition — request approval if schema validation rejects unknown keys.

### F3 (BUG, edge) — Fallback ignores `opts.proxy`
When a native raw decode fails with `opts.proxy` set, `buildFallbackPlan` builds the **full** jpg ladder. Honor proxy: if `opts.proxy !== undefined`, decode the embedded JPEG to rgba (`jxl.transcodeJpeg` + `decodeToRgba8`) and call `buildProxyLadder` instead of `buildJpgLadder`.

### F4 (feature, high value) — EXIF metadata for ALL ingests, including GPS
`extractBasicMetadata` runs only for Tier-5 stubs and has `gps: false`. For a biodiversity platform, GPS + `DateTimeOriginal` are the most valuable fields in the file (georeferenced occurrence records, Darwin Core `decimalLatitude/Longitude/eventDate`). Run extraction on the master bytes for every ingest path (it is one exifr parse, microseconds against a multi-second encode), enable `gps: true`, add `datetime`, and attach to the manifest's `metadata`. Add `opts.stripGps?: boolean` for sensitive-species privacy. Manifest schema addition — coordinate/request approval before editing `schema.ts`/`manifest.ts`.

### F5 (observability) — Silent degradation needs telemetry
`acceptUnsupported` defaults true, so Tier 3/5 engagement is invisible. Emit `tel?.event?.("fallback-tier", { path, tier: 3|5, detected, reason })` at each fallback branch, plus a `degraded` count surfaced in `BatchResult` if cheap.

### F6 (BUG, user-visible) — JPEG EXIF orientation dropped
`decodeMaster` (jpg) and `buildJpgLadder` hardcode `orientation: "source"`. If `jxl.transcodeJpeg`/`decodeToRgba8` do **not** bake EXIF rotation into pixels, every phone/portrait JPEG renders sideways. First verify backend behaviour with a rotated test JPEG; if rotation is not baked, read the Orientation tag via exifr in the jpg ingest path and set the manifest orientation accordingly (orientation enum lives in `backends.ts` — read-only; mapping happens here). Coordinate with Agent 4 (ladder returns orientation) — ladder edit deferred, request approval.

### F7 (feature, note-only — do not implement without approval)
- `fullLossless?: boolean` ingest option (distance 0 on the full level) for photogrammetry/digital-twin sets where feature matching wants no lossy artifacts; default unchanged.
- Manifest hint mapping levels to common ML input sizes (224/336/448/518) so recognition clients pick levels without dimension math; the existing 256/512 levels already serve most ViT/CLIP/DINO pipelines.
- `colorSpace: "srgb"` tag in the manifest — future perceptual-constancy engine needs to know the source space of stored pixels.

Record these in the handoff outcome (implemented / rejected / deferred) rather than silently dropping them.

---

## Agent 4 — `ladder.ts`: cascade correctness, memory, level planning

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in `C:\Foo\raw-converter-wasm\docs\rejected optimizations.md`

### L1 (CRITICAL BUG) — Ascending cascade upscales: most levels built from the 256 px image
All three 8-bit loops iterate targets **ascending** while cascading from the running buffer:

- `buildRawLadder` grid path: `gridTargets = [256, 512, 1024]` → full→256 (fine), then `downscaleRgba8(cur8 /*256px*/, …, 512)` = **upscale**; 1024 likewise.
- `buildRawLadder` 8-bit-only path: `targets.sort((a,b) => a.size - b.size)` → full→256, then 512/1024/2048/**masterLong all upscaled from 256** — the "full" level is an upscaled thumbnail.
- `buildJpgLadder`: identical pattern.

(The 16-bit big path is correct — it sorts descending.) Verify `downscaleRgba8`'s behaviour for target > source in `rgb16.ts`/backend; regardless of whether it upscales or clamps, the ascending order is wrong. Fix — descend, cascade, then restore ascending output order:
```ts
const targets = [...sideTargets, { size: masterLong, distance: qualityToDistance(BIG_QUALITY) }];
targets.sort((a, b) => b.size - a.size); // descending: full first, classic mip cascade
for (const t of targets) { ...existing body unchanged... }
levels.reverse(); // manifest/levels stay smallest-first
```
Apply the same to the grid path (`gridTargets` descending + `gridLevels.reverse()`). Add a regression test: ladder on a synthetic gradient; assert each level's downscale source was ≥ its own size (or assert via spy that `downscaleRgba8` is never called with `dstW > srcW`).

### L2 (BUG) — Grid targets not bounded by master size; duplicate-dims levels
`gridTargets` filters only `sc.size <= GRID_MAX_LONG` — a 800 px master gets 1024 grid target (upscale or duplicate, depending on `targetDimsForLongEdge` clamping), plus a 16-bit full at the same dims. Fix in two layers:
- filter `sc.size < masterLong` in the grid path (mirrors the other paths);
- in every loop, skip a target whose computed `dst` equals the previously emitted level's dims:
```ts
let lastW = -1, lastH = -1;
...
if (dst.w === lastW && dst.h === lastH) continue;
... after push: lastW = dst.w; lastH = dst.h;
```
Near-duplicate (not exactly equal) full vs largest sidecar — e.g. masterLong 2100 emitting both 2048 and 2100 — is planned in quality.ts; consume Agent 5's ratio-guarded plan if approved, else apply the same `masterLong / sc.size < 1.15` skip locally.

### L3 (memory) — Peak RSS: release dead full-res buffers
For a 100 MP master the 16-bit branch concurrently holds master bytes + `rgba` (400 MB) + `rgb16` (600 MB) + `rgba16` (800 MB). Two cheap releases:
```ts
let cur16 = packedRgb16ToRgba16(rgb16, width, height);
(decoded as any).rgb16 = undefined;            // packed source dead after conversion
// grid loop has finished by the first 16-bit downscale (grid runs first):
(decoded as any).rgba = undefined;             // after grid loop, before/at 16-bit loop
```
Mind ordering: grid loop reads `rgba` — only null it after that loop. This halves peak per worker; multiplied by pool concurrency it is the difference between fitting in RAM and OOM. (Do not propose moving the rgb16 conversion to WASM — ratified Q12.)

### L4 (perf, measure first) — Overlap encode N with downscale N+1
Each loop serially awaits `encodeTileContainer` before the next downscale, though the encode reads a buffer the next downscale doesn't mutate (downscale allocates a new buffer). Collect encode promises and `Promise.all` at the end. **Caveat:** the worker-pool design pins one core per worker — overlap only helps if the jxl backend has internal MT or the await gaps are I/O-bound. Benchmark on one large master before keeping; reject with numbers otherwise (per CLAUDE.md: heuristic changes need benchmark data).

### L5 (perf — Butteraugli layer) — `attachConverged` serial + redundant re-decode
Convergence profiling (Butteraugli/ssim, slowest op in the JXL pipeline) runs per level ≥1024, strictly serial, after all encodes. (a) Run the per-level `profileConvergence` calls with `Promise.all` (independent inputs). (b) Bigger win, backend API change — propose only: `profileConvergence(data, w, h, refPixels?)`, passing the `cur8`/`cur16` we already hold at encode time so the backend skips its internal reference decode. Defer (b), request approval; it touches `backends.ts` + the backend impl.

### L6 (consistency) — Proxy path is the only non-JXTC producer
`buildProxyLadder` uses `encodePyramid` (no `tiled: true`), while every other level is `encodeTileContainer` JXTC. If the viewer special-cases tiled containers, proxies take a different decode path. Verify the consumer; if uniformity is wanted, switch proxy to `encodeTileContainer` with the same `TILE_SIZE` and set `tiled: true`. If the monolithic proxy is intentional (small, single-shot decode), document it at the call site instead.

### L7 (invariant) — Level output order inconsistent
16-bit branch emits `[256, 512, 1024, full, 2048]` (grid ascending, then big **descending**). Any consumer assuming sorted-by-size order mis-picks. After L1's `reverse()` fixes, sort the final combined array ascending by `Math.max(w, h)` and add a one-line comment declaring the invariant: "levels are ascending by long edge".

### L8 (verify, no code) — 8-bit grid vs 16-bit big tonal continuity
Grid levels derive from `decoded.rgba`, big levels from `decoded.rgb16`. If the raw backend renders these through different tone paths, the 1024→2048 zoom transition shifts visibly. Verify in the raw backend that `rgba` is the quantized form of the same render as `rgb16`; record the answer as a comment in `buildRawLadder`.

### L9 (with Agent 3 F6) — Orientation plumb-through
`buildJpgLadder` returns `orientation: "source"` unconditionally. If Agent 3's verification shows EXIF rotation is not baked by the decode, accept an `orientation` parameter (default `"source"`) so ingest.ts can pass the EXIF value. Tiny signature addition; coordinate before editing.

---

## Agent 5 — `quality.ts`: plan-level intelligence

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in `C:\Foo\raw-converter-wasm\docs\rejected optimizations.md`

### Q1 (design, enables Agent 4) — Master-aware ladder planning
`planLadder()` is context-free; every caller re-filters by `masterLong` (and one forgot — Agent 4 L2). Centralize: accept an optional `masterLong` and return only meaningful targets, with a near-duplicate ratio guard:
```ts
const NEAR_FULL_RATIO = 1.15; // sidecar within 15% of full → redundant ~2x storage of the largest level
export function planLadder(masterLong?: number): PyramidEncodeOptions {
  const gridDistance = qualityToDistance(GRID_QUALITY);
  const bigDistance = qualityToDistance(BIG_QUALITY);
  let sizes: readonly number[] = LEVEL_SIZES;
  if (masterLong !== undefined) {
    sizes = LEVEL_SIZES.filter((s) => s < masterLong && masterLong / s >= NEAR_FULL_RATIO);
  }
  const sidecars = sizes.map((s) => ({ size: s, distance: BIG_SIZES.has(s) ? bigDistance : gridDistance }));
  return { sidecars, fullDistance: bigDistance, effort: EFFORT };
}
```
Backwards-compatible (no-arg keeps current behaviour). Updating `ladder.ts` call sites is a deferred cross-file edit — coordinate with Agent 4, request approval.

### Q2 (robustness) — Bucket exhaustiveness guard
`ladder.ts` buckets sidecars into grid (`<= 1024`) and big (`>= 2048`); a future `LEVEL_SIZES` entry like 1536 silently vanishes. Add a module-load assertion here (single source of truth for the constants):
```ts
for (const s of LEVEL_SIZES) {
  if (s > 1024 && s < 2048) throw new Error(`LEVEL_SIZES ${s} falls in no ladder bucket (grid<=1024, big>=2048)`);
}
```
(Or export `GRID_MAX_LONG`/`BIG_MIN_LONG` from here and have ladder.ts import them — deferred, approval needed.)

### Q3 (micro) — Precompute distances
`qualityToDistance(GRID_QUALITY)` etc. recomputed per plan call. Export `const GRID_DISTANCE = qualityToDistance(GRID_QUALITY);` (and BIG/PROXY) at module load; use in `planLadder`/`planProxy`. Negligible CPU, but removes repeated validation-throw paths from the plan hot path and gives constants a name.

### Q4 (docs) — Pin the ratified constants
Add one comment line above `EFFORT`: `// RATIFIED: effort=3 measured best speed+filesize (do not raise without new benchmark data)` and above `LEVEL_SIZES`: `// RATIFIED Q8: 256 is the smallest level`. This is the cheapest possible defense against future "optimization" churn.

### Q5 (minor) — `BIG_SIZES` single-member Set
Either document why a Set (future growth) or replace the lookup with `s >= 2048`. Keep whichever matches Q2's resolution (if `BIG_MIN_LONG` is exported, the predicate wins).

---

## Cross-cutting verification checklist (any agent, read-only)

1. `downscaleRgba8` / `targetDimsForLongEdge` behaviour when target ≥ source (clamp? upscale?) — determines L1/L2 blast radius.
2. Does anything consume `.pyramid-ingest.mtimecache.json`? (P4)
3. Does compiled dist resolve `./ingest-worker.ts`? (B9)
4. Does `decodeToRgba8` bake JPEG EXIF rotation? (F6/L9)
5. Is `decoded.rgba` tonally identical to quantized `decoded.rgb16`? (L8)

---

## What implementing this achieves

The headline is correctness: the ascending-cascade bug (L1) means that today, every 8-bit pyramid level above 256 px — including the full-resolution level on the 8-bit-only and JPEG paths — is reconstructed from a 256-pixel thumbnail. Fixing the cascade direction, bounding grid targets by master size, and deduplicating near-identical levels restores the entire visual point of the pyramid: each zoom step genuinely adds detail, and storage stops paying for upscaled or duplicate levels. Alongside it, a cluster of silent-failure bugs gets closed: the worker pool no longer deadlocks or poisons unrelated jobs when one worker crashes, chaos testing tests recovery instead of causing it, GC can no longer eat the levels of an image being written, timeouts actually bound the expensive phase without leaking timers or crashing the process, and the ESM `require` means empty-dir cleanup finally runs at all.

The performance tier is about scale economics for large batches: hashing each encoded level once instead of twice, parallel level writes with a single directory listing instead of thousands of stats, O(n) checkpoint bookkeeping with debounced persistence instead of O(n²) JSON churn, per-job messages that stop cloning the whole batch's stat map, and explicit release of dead full-resolution buffers that roughly halves peak memory per worker — which directly raises the safe concurrency ceiling on big masters. Butteraugli-adjacent convergence profiling stops serializing behind the encodes and, with one approved backend API extension, stops re-decoding reference pixels it already had.

The feature tier aligns the ingest layer with where the platform is going: EXIF extraction (with GPS and capture time) on every ingest turns each pyramid into a georeferenced occurrence record ready for Darwin Core; fallback-tier telemetry makes silent quality degradation visible to fleet QA; embedded-preview selection prefers full-size previews over postage stamps; and the deferred options (lossless full level for photogrammetry, ML input-size hints, a colour-space tag in the manifest) lay the rails for digital-twin capture, on-device recognition, and the perceptual colour engine without committing schema changes unreviewed.
