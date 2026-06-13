# CheckpointLockShardHashBackends

Analysis of packages/pyramid-ingest/src/{checkpoint.ts,lock.ts,shard.ts,hash.ts,backends.ts} through 21 lenses. Focus: efficiency, speed, perf, bugs, features. From the 5 files only (list_dir/imports for structure only; no other src read). All findings from direct file contents + cross-file data flow inferred from types/comments.

## Lens Synthesis (amalgamated; dups removed)

**Strategic links (L1):** hash produces stable 16-hex imageId (dirs, per-image locks, manifests). shard partitions input lists + caps concurrency via mem/per-image bytes before dispatch. lock provides advisory FS exclusivity (global .lock for batch mutate; per images/<id>/.lock for L3 targeted ops) around writes/checkpoint updates. checkpoint persists resume state (inFlight/completed/failed + stagedBytes from backends, duration). backends (Raw+Jxl) execute decode/encode/downscale + optional heavy post-encode profile (qualityCurve, convergedByteEnd, stagedBytes). Data handoff: imageId+sharded paths -> lock acquire -> backend work (produces PyramidLevelBytes with metrics/staged) -> write outputs -> checkpoint write (completed with outcome/staged) -> release. These 5 are cluster control plane (coord/resume/shard/lock) + WASM data plane adapter.

**API (L2):** checkpoint: CheckpointState, read/write/clearCheckpoint. lock: AdvisoryLock + 4 acquire* (write/read x global/image). shard: boundedConcurrency, planShard. hash: contentHash16, imageIdForPath. backends: RawBackend/JxlBackend interfaces (many: DecodedMaster w/ optional rgb16, PyramidLevelBytes w/ qualityCurve/stagedBytes, Tile/Pyramid opts, Telemetry, Clock), createJxlBackend, profile* optional. WASM: JW.encodeRgba8Pyramid / encodeTileContainer* / downscale* / transcode / createDecoder + events/push + ButteraugliComparator / computeButteraugli. No worker msgs here.

**Pipeline (L3):** hash/shard pre (planning). lock/checkpoint wrap mutate/write stages. backends implement core: raw decode (RawBackend), encodePyramid (main), tile container (JXTC 8/16), downscale (per-level), transcode jpeg, decodeToRgba8, + profileConvergence/Curve (post-encode re-decode analysis for manifest curves). Profile sits after encode before return; does not affect main encode path.

**State (L4):** checkpoint = explicit persisted FSM (batchId, inFlight[], completed[], failed[]). lock = implicit FS state machines (wx create for exclusive; N unique read files; stale via pid+24h). Acquire loops = retry+backoff+steal state machines w/ 30s default timeout. backends = per-call decoder state (events stream); stateless across calls (comparator per profile). No queue/cancel here (outer). Errors -> checkpoint failed[] + Advisory release on throw paths.

**Data (L5):** checkpoint JSON arrays of {path, outcome, stagedBytes?, ...}. locks = {kind,pid,createdAt} JSON sidecars. shard = T[] filter + scalar calc. hash = 16-hex strings (path NFC or content sha). backends = Uint8Array (rgba always, rgb16 opt, jxl data, pass pixels); QualityCurvePoint[] (bytes + ssim/butter); PyramidLevelBytes (data + optional curve/staged/tiled/bits). Many interface option bags. Copies at every WASM boundary.

**Hot kernels (L6):** None in pure TS (mod hash/shard tiny). All in backends profile path: decodeProgressivePasses (32k chunk loop + subarray + push + N progress events), measure loop (N passes), per-pass full-res copies (new Uint8Array, Uint8ClampedArray.from x2 for ssim), butter/ssim per pass. Butteraugli (comparator or compute) is dominant cost when --profile-convergence on high-MP + high-pass JXL. Early-out <1024px. No pixel loops/resample/color here (WASM).

**Boundaries (L7):** JS<->WASM dominant in backends: large Uint8Array in/out (masters, levels, downscales, jxl for profile), decoder push (chunked), events() yielding pixels (defensive new Uint8Array on every progress/final to materialize). decoder.push+close+drain+dispose patterns x3 (decodeTo, decodeProg, profile). No Rust direct. Mem copies explicit at every handoff + Clamped for ssim.js.

**Support (L8):** Telemetry (stage for encode/down/tile, progress, optional event). Minimal validation (len checks, size match in measure, early undef). Errors swallowed in optional metrics (continue). No tests in these files (separate).

**Owl + all other lenses (9-21):** 
- Dupe: 4 near-identical acquire loops (stale check, wx, backoff, timeout, pid alive) in lock.ts. writeLockFileAtomic inferior (wx tmp + overwrite write, no rename) and unused vs checkpoint's solid rename+ebusy.
- Sleep helpers duped in checkpoint/lock.
- Mem/perf disaster in profile (L6/15/20): decodeProgressive holds *all* pass pixel Uint8Arrays + final until end (O(passes * res) mem/alloc/GC for high-pass large images). Then measure re-copies every one to Clamped + runs butter. Two decodes for ref+partials would allow compute-on-receipt + immediate discard of pass pixels (only final + curve metadata live). ssim dynamic import *inside* measure (per-level cost).
- Butter is slow; profile is opt-in but when on, serial per level, adds 2-10x wall on detailed pyramids. No tel timing on profile path.
- Atomic robustness: checkpoint good (tmp+rename+ebusy). lock acquire uses wx (create) directly; no ebusy retry on wx/unlink. No fsync. 24h stale + pid works for crash recovery but FS-dependent (NFS/SMB wx not guaranteed atomic).
- Hash: both fns 16-hex truncate (64-bit); birthday risk ~2^32 noted. imageId path-based (stable name for gallery); contentHash16 pure-content (for dedup/replace detect). No central const.
- Shard: deterministic mod good for repro; bounded mem-first. Simple filter always O(N) alloc. No size-aware or consistent-hash for variable-MP cost balance.
- Features (L11-17, photogram/AR/ML/gaming/color): stable sharded IDs + resume + advisory cluster locks enable distributed survey ingest (telescope array / drone flora / digital-twin photogrammetry corpus build). Progressive qualityCurve + convergedByteEnd in manifest (from profile) lets AR/LLM clients do early recognition/plantID on partial JXL bytes (sub-ms inference trigger at "good enough" offset) without full download/decode. 16-bit rgb16/down/encode paths preserve radiometric precision for metric photogram + future non-Riemannian perceptual engine (LookRenderer hot loop; these layers receive post-look pixels for pyramid). Gaming: locks=mutexes, checkpoint=savepoint, shard=zone partition, stale=afk reclaim. Astro: imageId=catalog name, qualityCurve=exposure curve, shard=field segmentation, checkpoint=survey logbook. No direct color LUT work here (future in raw-pipeline); ensure 16-bit first-class and profile measures post-look output.
- Gaps (L18/19): 3 largest unlit: (1) orchestrator wiring (how resume filters inFlight, how staged/curve flow from backends -> checkpoint -> manifest, worker vs main lock/checkpoint usage, --shard/--resume/--profile-convergence call sites); (2) FS durability/semantics (no fsync, wx/rename/visibility on network FS, partial write recovery if checkpoint says "written" but pyramid files missing); (3) 16-bit + tiled JXTC end-to-end + profile interaction (when rgb16 flows, when bitsPerSample=16 set on levels, whether profile ever sees 16-bit data, stagedBytes population).
- Last (L21): thin clean separation. Backends file bloated (adapter + full profiling engine + butter/ssim glue). Birds-eye: control (4) thin pure + state on disk; data (1) thick WASM glue. Connectivity low (good); last threads: unify atomic fs, dedup lock loops, streaming profile metrics, add profile tel, hash len const, contentHash integration point for idempotent ingest.

## Issues / Improvements / Fixes (amalgamated, per-file; no non-issues)

## checkpoint.ts (Agent 1 - one file only)
If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

- Add `version: "1"` to CheckpointState for future schema evolution (resume safe).
- Compact JSON: change writeCheckpoint to `JSON.stringify(state)` (drop ,null,2). Saves I/O + disk for 10k+ image batches; readability loss minor (machine file).
- Add ebusy retry to clearCheckpoint unlink (mirrors write safety).
- Optional durability: after successful rename in writeFileAtomic, open fd and fsync (use `import { open } from "node:fs/promises";` then fd.sync() + close). Behind small helper. Long-term cluster power-loss resume safety. (Snippet below if accept.)
- In readCheckpoint: on parse fail, could return null still (current) but distinguish missing vs corrupt via code if needed; leave for now.
- Export or use a const for filename? Internal ok.
- (cross note for caller context only; do not edit others): stagedBytes/duration from backends flow here.

Suggested for atomic durability (only if positive; small):
```ts
import { open } from "node:fs/promises";
// inside writeFileAtomic after rename success:
if (process.platform !== "win32") { // windows rename often sufficient
  try {
    const fd = await open(dest, "r");
    await fd.sync();
    await fd.close();
  } catch {}
}
```

## lock.ts (Agent 2 - one file only)
If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

- Major dedup + robustness: extract 2-3 internal helpers to eliminate 4x duplicated acquire loop logic (stale check + alive + wx + backoff + timeout + release closure). E.g.:
  ```ts
  async function acquireWriteLockFile(lockPath: string, timeoutMs: number, label: string): Promise<AdvisoryLock> {
    await mkdir(dirname(lockPath), {recursive:true});
    const start = Date.now();
    for(;;) {
      const now=Date.now(); const data:LockFile={kind:"write",pid:process.pid,createdAt:now};
      try { await writeFile(lockPath, JSON.stringify(data), {flag:"wx"}); return {async release(){await unlink(lockPath).catch(()=>{}); }}; } catch(e:any){ if(e?.code!=="EEXIST") throw e; }
      const existing = await readLockFile(lockPath);
      if(existing){ const age=Date.now()-existing.createdAt; const alive=await isPidAlive(existing.pid);
        if(!alive || age>STALE_MS){ await unlink(lockPath).catch(()=>{}); continue; } }
      if(Date.now()-start > timeoutMs) throw new Error(`acquire ${label} timeout...`);
      await sleep(50 + Math.random()*50);
    }
  }
  // similar acquireReadLockFile(writeLockPath, myReadPath, timeout, label)
  // then:
  export async function acquireWriteLock(outDir:string, t=30000){ const p=join(outDir,LOCK_FILE); return acquireWriteLockFile(p,t,"write"); }
  export async function acquireImageWriteLock(outDir:string, id:string, t=30000){ const p=join(outDir,"images",id,".lock"); return acquireWriteLockFile(p,t,`image-write:${id}`); }
  // same for reads (pass prebuilt readLockPath)
  ```
  Reduces ~70 lines to ~30, single place for stale/steal/backoff. Easier long-term evolution (e.g. heartbeat, fsync).
- Fix writeLockFileAtomic (or delete if dead code): it is not called by any acquire*. Either remove, or rewrite to use tmp+rename+ebusy pattern copied from checkpoint (for any future in-place lock content update). Current wx-tmp + plain writeFile(p) + unlink has weaker atomicity on content and no ebusy. Prefer: keep acquires as wx-create (correct for exclusive), delete the helper or mark @internal unused.
- Apply ebusy retry wrapper (copy from checkpoint, small fn) to wx/unlink/write in acquire paths for EBUSY on contended network FS.
- Add `fsync` after successful wx create for lock files (same pattern as proposed checkpoint).
- Minor: use Date.now() consistently (one readLock uses it in create).
- Keep 24h STALE, 30s timeout, jitter backoff, pid alive — proven for WU-6 L3.

## shard.ts (Agent 3 - one file only)
If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

- Add JSDoc guards: `planShard` if (n<=0 || i<0 || i>=n) behavior explicit (current: n<=0 -> all; i>=n -> []; negative i -> some). Add:
  ```ts
  if (n <= 0) return items.slice();
  if (i < 0 || i >= n) return [];
  return items.filter((_,k)=>(k%n)===i);
  ```
- boundedConcurrency: already correct (max(1, min(...))). Optional: when mem-bound < requested, no side effect (pure). For variable sensor MP, callers sort large-first before sharding for better balance; note in comment only.
- No alloc tricks (filter is fine; lists not 1M+). Keep minimal.

## hash.ts (Agent 4 - one file only)
If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

- Central const: `const HASH_TRUNC_BYTES = 8; // 16 hex chars = 64 bit` (or 12 for 24-hex future). Use in both fns: `.slice(0, HASH_TRUNC_BYTES*2)`.
- Add optional for future scale (per existing comment): keep imageIdForPath as 16-hex; add 
  ```ts
  export async function imageIdForPath(masterPath: string, truncateHex = 16): Promise<string> {
    ... .digest("hex").slice(0, truncateHex);
  }
  ```
  (non-breaking; default 16). Document birthday: 16-hex ~ safe to 2^32; 24-hex to 2^48. Callers control.
- contentHash16: likewise `contentHash(bytes: Uint8Array, truncateHex=16)`. Keep old name as alias or update body. Use for content-based idempotency (different path, same bytes -> same short hash for skip/dedup in checkpoint/inFlight logic at call site).
- No perf change (hash fast); realpath+ NFC required for I1/I2 stability (shortnames, mac/win, unicode paths in photogrammetry corpora).
- (L12/14/16) imageId + contentHash give stable keys for ML feature cache / plant twin catalog / AR asset map.

## backends.ts (Agent 5 - one file only)
If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Core: streaming profile mem/perf fix + telemetry + ssim cache + minor.

- **Primary perf/mem fix (butter slow path, L6/9/15/20):** rewrite measureConvergenceProfile + decodeProgressivePasses so profile path never holds >1 full-res pixel buffer at a time (plus tiny curve).
  Strategy (two decodes, discard intermediates immediately):
  1. Obtain clean final ref once (reuse existing decodeToRgba8 logic or a final-only decoder; no emitEveryPass).
  2. Run progressive decode (emitEveryPass), but *in the "progress" event handler*: take px copy, *compute ssim/ba immediately* (ref known), record only `{bytes, ssim?, butteraugli?}` to curve, drop px ref. Never push to passes[] array.
  - Memory: O(final + curve len) vs O(passes * final).
  - Trade: 2 decodes of level JXL (cheap relative to N butters + allocs/GC for 8-20 passes). For cutoff-only (profileConvergence) still full but same.
  - If first decode for ref fails, fallback to old single-prog path.
  - Update decodeProgressivePasses to keep old behavior (for any other use) or make internal "collect all" opt-in. measure uses new streaming path.
  - In measure loop removal: no more "for (const p of passes)" after; curve built live. Remove the size-mismatch continue (compute only if match final len).
  - Comparator still created once with final (before second decode).
  - Suggested sketch (adapt in file):
    ```ts
    async function measureConvergenceProfile(jxl:Uint8Array, w?:number,h?:number): Promise<...> {
      // 1. final ref (cheap full decode, no progress events)
      let finalPixels: Uint8Array | null = null; let useW=w||0, useH=h||0;
      try {
        const ref = await decodeToFinalPixelsOnly(jxl); // new helper or call path w/ progressionTarget final + no emit
        finalPixels = ref.pixels; useW=ref.w; useH=ref.h;
      } catch { return undefined; }
      if (!finalPixels || Math.max(useW,useH)<1024) return undefined;
      // 2. prog decode; metric on receipt
      const ssimFn = await getCachedSsimFn();
      const comparator = await tryCreateButterComparator(finalPixels, useW, useH);
      const butterFallback = !comparator && typeof JW.computeButteraugli==="function";
      const curve: QualityCurvePoint[] = [];
      // ... create prog decoder (emitEveryPass true) ...
      const drain = (async () => { for await (const ev of decoder.events()) {
        if (ev.type==="header") { useW=...; }
        else if (ev.type==="progress") {
          const px = ...new Uint8Array...;
          const bytes = bytesPushed;
          // compute ssimVal / ba *now* using finalPixels + comparator (same as old per-pass code)
          // if either, build pt, dedup same-bytes, curve.push
          // NO store px
        } else if (ev.type==="final") { /* verify matches our ref */ }
      }}) ();
      // chunk push same as before
      ...
      // dispose etc
      if (curve.length===0) return undefined;
      // compute convergedByteEnd from curve (same)
      ...
    }
    ```
  This directly attacks "Butteraugli one of slowest" by slashing allocation/GC/mem pressure during the metric phase (enables higher concurrency via shard/bounded). Retains full curve deliverable for manifest (L3/14/16 clients use for early AR/LLM inference cutoff).
- Cache ssim: hoist dynamic import to module scope (one-time):
  ```ts
  let cachedSsim: ((a:any,b:any)=>any) | null | undefined = undefined;
  async function getCachedSsimFn() {
    if (cachedSsim !== undefined) return cachedSsim;
    try { const mod = await import("ssim.js").catch(()=>null); ... cachedSsim = ...; } catch { cachedSsim=null; }
    return cachedSsim;
  }
  ```
  Call in measure (once per process, not per level).
- Add telemetry to profile path: in createJxlBackend profile* fns and inside measure, `tel?.stage?.("profile-convergence", {w:useW, h:useH, curveLen:curve.length, ms: Date.now()-t0, butterUsed:!!comparator, ssimUsed:!!ssimFn});` (and for legacy profileConvergence). Makes cost visible in O/runlog (unlocked per comments).
- In decodeToRgba8 / profile decoder setup: minor common decoder opts (rgba8, final target or emit, no icc/meta) — leave or tiny factory if want; not hot.
- Keep all instanceof/new Uint8Array boundary copies (required for safety across WASM heap / transfer).
- rgb16 / 16-bit / JXTC: no change (profile always visual 8-bit post-encode correct for curves). Ensure downscaleRgba16 etc stay wired.
- For color (L17): no direct edit; this layer will receive post-LookRenderer (perceptual geodesic/log) pixels for pyramid when that lands in raw-pipeline. 16-bit paths + staged/curve already prepared for precision + client early-exit.
- Small: in encodePyramid map, could propagate more fields if WASM returns; current drops ok.

## Integration / Handoff Notes (for agents; touch only your one file)
- All changes stay inside the assigned .ts. If a change requires a one-line caller signature tweak in unlisted file to wire (e.g. new tel call or hash len), note it in your Implemented entry and reject or ask; prefer local-only.
- Reassess each item against pipeline (cluster safety, resume correctness, mem for high-MP sensors, manifest qualityCurve consumers, 8/16 paths, progressive emit contract) before edit. Positive = net win on eff/speed/bugfix/feature; else reject in docs/rejected optimizations.md.
- Verify: after your file edits, the 5-file set must typecheck and basic flow (checkpoint roundtrip, lock acquire/release, shard split, hash stable, backends create + profile undef on small) still hold. Use `cd packages/pyramid-ingest && npx tsc --noEmit` (or full harness later).
- Telemetry/event usage, AdvisoryLock shape, CheckpointState shape, JxlBackend surface are contracts — do not break.

## Outcomes from Implementing Suggestions
Implementing the amalgamated items yields a tighter, more scalable cluster ingest control plane: deduplicated lock state machines cut maintenance surface and bug risk for multi-node --out shared FS (critical for WU-6 L3). Atomic+fsync patterns unified raise crash-resume durability for long high-res surveys (checkpoint now survives power loss better; locks reclaimed cleanly). Primary win in backends: profile mem footprint drops from O(passes) full images to O(1), directly mitigating Butteraugli cost and enabling higher boundedConcurrency on high-MP masters without OOM during --profile-convergence (used for manifest curves that power AR/LLM early recognition and client progressive quality choice). Hash/shard become future-proof (len param, explicit guards) for 2^48-scale corpora and variable-cost sensor data without changing deterministic partitioning semantics. Overall: faster wall time on profiled runs, lower peak mem (more parallel shards), stronger safety for 24/7 flora twin / photogrammetry / immersive catalog builds, and clearer extension points for the upcoming non-Riemannian perceptual LookRenderer (16-bit paths + post-encode curves already align). No behavior change for non-profile / single-process paths. Long-term: these 5 files stay the narrow "dome control + plate log + catalog ID + field split + sensor readout adapter" for the ingest telescope array.

## Implemented
checkpoint.ts: added version:"1" to state, compact JSON.stringify (no indent), ebusy retry on clear, fsync-after-rename in writeFileAtomic (win32 skip): accepted - positive for durability + I/O on cluster resume paths. No contract impact. (Agent 1)
lock.ts: extracted acquireWriteLockFile / acquireReadLockFile (elim 4x dupe loops), wired global+image acquires to them, added withEbusyRetry to wx/unlink, removed dead writeLockFileAtomic, minor cleanup (unused access import): accepted - positive for maintainability/safety in L3 cluster locking (less bug surface, consistent ebusy). Exact semantics preserved. (Agent 2)
shard.ts: added explicit i<0 / i>=n guards + JSDoc to planShard (n<=0 already): accepted - positive (defensive + self-doc; deterministic semantics unchanged for valid CLI i/n). (Agent 3)
hash.ts: added HASH_TRUNC_BYTES const (used by both), made imageIdForPath + new contentHash accept optional truncateHex (default 16, backward compat), kept contentHash16 as thin alias, expanded docs: accepted - positive for future scale (2^48) + content-based idempotency keys for ML/AR twin catalogs without breaking existing imageId callers. (Agent 4)
backends.ts: (1) hoisted ssim cache (getCachedSsimFn) - 1 import/process not per-level; (2) added module decodeFinal helper (final-only, no-emit) + used by decodeToRgba8 (dupe reduction) and new measure; (3) primary: measureConvergenceProfile now does ref decode + streaming prog decode (metric on "progress" receipt, drop px immediately; no passes[] buffer); old decodeProgressivePasses kept unchanged; (4) wired tel?.stage "profile-convergence" (with kind/ms/curveLen) in the two public profile* methods; (5) minor clean. All accepted - primary mem/perf win directly mitigates Butteraugli (O(1) vs O(passes) res buffers + allocs) while preserving exact curve/converged/early-out contract and progressive emit. Enables higher shard concurrency on profiled high-MP runs. Tel + cache small eff wins. (Agent 5)
ALL AGENTS COMPLETE. Per final instruction: appended -DONE suffix to this doc filename (mv). See terminal for test run. (Last agent)

## Final Instruction to Last Agent
When your handoff items are done (or after rejecting some), append -DONE to the document filename as the terminal step before handing back. Capture all outcomes in this Implemented chapter. Re-run any timing harness only after all 5 agents/sections complete if required by outer flow.

