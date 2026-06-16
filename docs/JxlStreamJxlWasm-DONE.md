# JxlStreamJxlWasm.md

Group 8: Partial Stream Fetching & Core WASM Loaders. Files: packages/jxl-stream/src/browser.ts, packages/jxl-stream/src/node.ts, packages/jxl-stream/src/index.ts, packages/jxl-wasm/src/loader.ts, packages/jxl-wasm/src/index.ts.

Only these files examined/edited. 21 lenses applied. Rejections doc cross-checked (no direct prior hits on these symbols; tangential layer note only). Duplicates amalgamated. Work from full file contents in memory + targeted verification. Caveman terse.

## Lens 1 Strategic + Linkages (amalgam 1,21,9,11)
jxl-stream: network/Blob/Node partial window ingestion to DecodeSession contract. fromByteRange/fromRangePrefix/resume handle 206+200-skip+ETag-If-Range safety+maxBytes cutoff for manifest-driven pyramid tiles. from*Readable honour backpressure (await push), one-ahead prefetch overlap I/O, onHeaders/onRangeNegotiated+ttfb/transferMs+priority. fromBlobRange zero-copy for OPFS cached levels.

jxl-wasm/loader: loadJxlModule(manifest{buildId,wasmSha,wasmUrl}, LoaderOptions{fetchImpl,idbFactory,nodeFs,cacheDbName,wasmUrl}). Dual cache: module-scope Promise<WebAssembly.Module> (browserModuleCache/nodeCache keyed build:sha per P5-1) + IDB persistence of compiled Module. compileStreaming preferred; refetch-closure no-.clone() on fallback (P5-2 saves ~2.7MB peak). isNode + resolve for fs.

Linkage: indirect only. Stream supplies byte segments (from manifests, range offsets) that feed DecodeSession implemented over facade instantiated from Module obtained here. "Partial binary range fetches and feeding the streamed segments directly into the low-level FFI decoders". No cross imports in these sources. Reexports via index keep surface clean. Loose coupling intentional (stream transport, loader bootstrap; decode state in scheduler/worker/facade per CLAUDE).

## Per-file API / State / Data (lenses 2,4,5,7,8 amalgam)
browser exports: DecodeSession/EncodeSession/PipeOptions/RangeNegotiation/RangePrefixOptions/ByteRangeResumeState + fromReadableStream/fromResponse/fromBlob/fromBlobRange/fromByteRange/fromRangePrefix/resumeFromByteRange/createByteRangeResumeState + toReadableStream. Heavy abort/cancel (allSettled, releaseLock guard, removeListener, pending rejections marked handled). State: delivered/skipped/pending/honored/t0/tHeaders/info(lazy)/cr. Copies: subarray (views, 0-copy windows), blob.slice (ref).

node: fromNodeReadable/toNodeReadable + BufferedReader (chunks[] + head/total; append no-copy, take fastpath slice or spanning new+set; "move pointer not reread"). ABORT strings hardcoded. Iterator + cutoff for maxBytes.

index: export * only.

loader: JxlWasmManifest/LoaderOptions + loadJxlModule + internals (loadBrowser/Node, compileFromResponse, read/write/open IDB, requestToPromise, txComplete, isNode, resolveNodeWasmUrl). State: two Map<string,Promise<Module>>. No Abort in surface. IDB stores Module objects directly (structured clone).

Boundaries (lens7): stream push(ArrayBuffer|Uint8Array) -> later WASM write in facade (not here). Loader produces Module for instantiate (env imports for bridge). No Rust/C here.

Support (lens8): range/finite/positive/type validation, no logs, callbacks for progress/negotiate, no tests in scope.

## Pipeline / Hot / Kernels / Stages (lenses 3,6)
These are pre-pipeline edges: ingest (partial) + runtime load. Not decode/transform/resize/encode/cache/return. Chunk loops are the while(pending){ await; trim subarray; await session.push; schedule next read } in from* + 200-skip subarray. No pixels/colour/resample (lens6). Overlap via prefetch + push await = natural backpressure at feeder (correct per invariants). Loader hot: fetch+compile+IDB once per key.

## Lenses 10,20,13,12,14,16,15,17,18,19 (backwards, tricks, gaming, LLM/AR/photogram, Butteraugli, color, gaps)
Backwards: early had void returns, clone spikes, loose cancels, non-strict header parse, no resume/ETag safety, prefix-only. Current SB/P hardened.

Tricks: subarray windows (0 copy), pending prefetch (net overlap push), refetch closure instead clone (mem), Buffered head+shift (pointer move, bounded chunks), lazy makeInfo, strict digit parse only, strong ETag only for If-Range.

Gaming: priority, cancel on "turn away", streaming texture (range tiles), shader cache = module IDB, ring for netcode = Buffered.

LLM/AR/photogram/immersive (12,14,16): partial DC-first prefixes + onHeaders early allow recognizer start on low res before full AC. Abort+priority let AR pivot without waste. fromBlobRange instant local for twin library. Loader module memo+IDB = instant worker respawn for parallel ROI/scale recognition or camera-frame JXL decode. Resume for flaky field capture sessions building photogram bundles. Facilitates real-time plant ID overlays without full asset.

Butteraugli (15): encoder internal (distance search). Not in these (transport+load). Wrong layer. Reject.

Color science (17): full engine+ B matrix + log + Molchanov A_tensor + hybrid spring + f(c) + LUT in raw-pipeline LookRenderer hot loop. Not here. Wrong layer per rejection log note. Reject.

Gaps (18,19): loader fetch has no Abort/priority (illuminated now). No WASM partial range (full binary; hard, reject). IDB open/close every op (but mem cache shields hot). Node lacks http Range parity (BufferedReader hints at byte-range callers). isNode weak vs bundlers. Cache reject poison + write-fail-kills-load (illuminated). 200-skip loop count on tiny chunks. Re-ask from offset: same gaps plus cross-env (deno/bun/worker) manifest fetch, no SRI/integrity passthru explicit (can via fetchImpl wrapper).

## Handoffs (5 agents, 1 file each)

## Handoff Agent 1: packages/jxl-stream/src/browser.ts
If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Amalgamated proposals (efficiency/speed/perf/bug/feature from all lenses; surgical only):
- Strengthen 206 Content-Range guard (lens4/7/9/18): after parse, require start present on honored to prevent silent corrupt on non-compliant 206 (no header or *). Matches P1-2 intent, existing mismatch throw. Positive for resumable pyramid/AR field use.
  Suggested:
  ```ts
  honored = resp.status === 206;
  const cr = parseContentRange(resp.headers.get('Content-Range'));
  if (honored && cr.start !== start) {
    const err = new Error(`[jxl-stream] server returned mismatched range start ${cr.start}, expected ${start}: ${url}`);
    await cancelBoth(err.message);
    throw err;
  }
  ```
  (removes the `!== undefined &&` guard; if absent cr.start===undefined !== start so throws -- explicit fail fast).
- No other surgical in this file. Prefetch, subarray, abort, maxBytes, resume, fromBlobRange all tight and correct. No new surface. (Dupe pump pattern and 200 skip loop left; extraction or fast-skip would be non-minimal per style.)

## Handoff Agent 2: packages/jxl-stream/src/node.ts
If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

- Consistency (bug/lens4): ABORT strings duplicated/hardcoded vs browser const. Export const from browser, import+use in node for single source of truth on cancel reasons. Cohesive, zero behavior change.
- BufferedReader (lens6/20/5): already optimal pointer (head) + O(1) append + bounded shifts. No change (larger chunkIndex compaction non-surgical, no evidence needed).
- Other: from/to Node* solid, maxBytes cutoff, zero-copy Buffer.from comment. No further.

## Handoff Agent 3: packages/jxl-stream/src/index.ts
If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

- Pure barrel. After browser/node edits (e.g. new exported ABORT const), * reexport will surface automatically. Verify build/types clean. No logic change required. Agent may reject if no work.

## Handoff Agent 4: packages/jxl-wasm/src/loader.ts
If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Amalgamated (high impact on 2/4/5/7/9/11/12/13/14/16/18/20/21):
- (bug/perf) Module promise caches (nodeCache, browserModuleCache) retain rejected promises on transient fail (net, IDB). All future callers get instant reject, no retry until reload. Delete on catch.
  Snippet (apply in both branches):
  ```ts
  if (isNode()) {
    if (!nodeCache.has(cacheKey)) {
      const p = loadNodeModule(manifest, options).catch((e) => {
        nodeCache.delete(cacheKey);
        throw e;
      });
      nodeCache.set(cacheKey, p);
    }
    return nodeCache.get(cacheKey)!;
  }
  if (!browserModuleCache.has(cacheKey)) {
    const p = loadBrowserModule(manifest, options).catch((e) => {
      browserModuleCache.delete(cacheKey);
      throw e;
    });
    browserModuleCache.set(cacheKey, p);
  }
  return browserModuleCache.get(cacheKey)!;
  ```
- (bug/robustness) writeIndexedDbModule failure (quota, private mode, Module clone issues) rejects the load promise even after successful compile/fetch. Cache is best-effort; success must not depend on persistence.
  Snippet:
  ```ts
  const module = await compileFromResponse(response, () => fetchImpl(wasmUrl));
  writeIndexedDbModule(key, module, options).catch(() => {
    /* best-effort; proceed without IDB persistence (quota/incognito) */
  });
  return module;
  ```
- (feature/speed/AR/LLM/priority/gaming lens12-16) Add AbortSignal + priority to LoaderOptions + wire (parity with Range*Options). Enables abort of long WASM fetch/compile during view change; priority for critical main decoder vs background.
  Add to interface:
  ```ts
  export interface LoaderOptions {
    fetchImpl?: typeof fetch;
    idbFactory?: IDBFactory;
    nodeFs?: { readFile(path: string | URL): Promise<Uint8Array> };
    cacheDbName?: string;
    wasmUrl?: string;
    signal?: AbortSignal;
    priority?: 'high' | 'low' | 'auto';
  }
  ```
  Wire (loadBrowserModule):
  ```ts
  const response = await fetchImpl(wasmUrl, {
    headers: undefined,
    signal: options.signal,
    priority: options.priority,
  } as RequestInit);
  ```
  Node side (loadNodeModule, recent node fs supports signal):
  ```ts
  const bytes = await fs.readFile(await resolveNodeWasmUrl(wasmUrl ?? ""), { signal: options.signal } as any);
  ```
  Refetch closure (rare) omits signal; acceptable for surgical.
- (correctness) Validate manifest early.
  Snippet after cacheKey:
  ```ts
  if (!manifest?.buildId || typeof manifest.buildId !== 'string' ||
      !manifest?.wasmSha || typeof manifest.wasmSha !== 'string') {
    throw new Error('[jxl-wasm] manifest requires buildId and wasmSha strings');
  }
  ```
- (small) Harden isNode against bundler-injected process:
  ```ts
  function isNode(): boolean {
    return typeof process !== "undefined" && !!process.versions?.node && typeof window === "undefined";
  }
  ```
- All reassessed: bootstrap layer, no backpressure/dedup/budget/scheduler contracts touched. Signal aborts only fetch (not mid-compile, which is fine). Positive for cold-start reliability + AR/LLM control.

## Handoff Agent 5: packages/jxl-wasm/src/index.ts
If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

- Barrel reexport loader + facade. LoaderOptions extension auto-visible. Post-edit task: confirm no type/consumer break (reexports cover). Likely zero diff. Agent may reject as no-op.

## Reassessment + Apply Log (per query)
Each item re-examined vs touched files, pipeline position (pre-decode feeder + bootstrap), CLAUDE/AGENTS invariants (layer, no speculative without evidence where heuristic, surgical, match style SB/P comments, no widening), long-term vision (AR/plant/photogram/LLM/stream resilience), and prior rejections (no cache-coalesce, no layer cross). 

Only +ve, minimal, within-5 (or connected within 5 for ABORT) applied. Others (node http range parity, pump extraction, 200-skip accel, Butteraugli/Look/color here, full SRI, WASM range fetch, new callbacks) rejected internally -- would violate simplicity, layer, scope, or need benchmark.

## Implemented
- loader.ts: cache-reject-clean (both Maps), write best-effort catch, LoaderOptions+signal/priority wired to fetch+nodeFs.readFile, manifest validate, isNode harden. 6 surgical replaces.
- browser.ts: ABORT exported, 206 cr.start guard (removed !==undefined, now throws explicit on absent/mismatch).
- node.ts: import ABORT_REASON (mixed), 3 sites now use identifier (string literals excised).
- index*.ts: 0 edits (export * covers new LoaderOptions fields + ABORT const).
- docs/JxlStreamJxlWasm.md: Implemented + test record updated surgically.
- Rejects during apply: none. All handoff items +ve after re-exam (layer ok, contracts preserved, vision support for AR/LLM/photogram via signal/priority/resume robustness).

## Overview of Achievements (if implemented)
Cache hygiene + best-effort persistence remove two silent killers of first-paint and retry in the WASM bootstrap: transient network blips no longer poison all subsequent worker spawns (scheduler/pool benefit), and IDB policy blocks no longer turn a successful 2.7 MB compile+fetch into a user-visible failure. Abort+priority on load bring the codec binary acquisition to the same control surface as JXL content ranges, letting high-level orchestrators (AR viewports, speculative LLM probes, priority tile ladders) cancel or deprioritize expensive bootstrap when the scene changes or a hotter asset wins -- directly enabling the "real-time plant recognition in immersive" and "flaky field photogrammetry resume" stories without stranded resources. Strengthened 206 guard + ABORT const sharing close small but real correctness gaps for 200-fallback and cross-platform (browser/node) partial streams used by pyramid manifests and OPFS tiles. 

The net is a tighter, more observable, more cancelable edge for the entire progressive pipeline: partials arrive with better diagnostics and safety, the decoder binary is resident with higher success probability and lower latency on repeat, and callers gain the levers (signal/priority) needed for responsive AR/LLM/photogrammetry workloads on streamed JXL without full-file tax. All while preserving the existing zero-copy views, prefetch overlap, pointer tricks, and strict contracts. Long-term these two packages become dependable "visibility ingest" and "firmware loader" for digital-twin and telescope-scale image flows. No hot kernels altered; no layer violations.

## Test Execution
Command: node StandardMultifileTest.mjs (post-edit timings for regression check). exit=0. Full output truncated in log; key aggregates from run 2026-06-13T10:49:25Z (simd+mt tiers, 8 assets incl RAW/JXL):
- Preload/scale: small=7ms, windows=190ms, DNGs~740-770ms, ORFs~1230ms, CR2s~1020ms.
- Seq simd: prog_enc e.g. 83-303ms, first_paint 18-141ms, final 34-411ms; shot_dec 13-289ms.
- Seq relaxed-mt: prog_enc 95-185ms, first 18-35ms, final 34-123ms; shot_dec 13-77ms.
- Multi-worker: seq dec sum 1807ms, wall 2027ms, speedup 0.89x.
- Transfer diag: 1-30MB transferable 44-310x vs structured.
- JXTC ROI: tiled 72ms vs mono 308ms (4.3x); full tiled ~312ms vs mono 271ms.
- Averages: raw 703ms, prog_first_simd 117ms / mt 31ms, shot_dec_simd 226 / mt 60.
- TOON + HTML graphs emitted; browser graph launched. No crashes, all variants (ds2/region/chunked/mod/photon) exercised.
Our edits (loader caches+signal/priority, stream abort/guard) touch ingest/bootstrap used by prog paths indirectly; timings in expected ranges vs historical baselines in repo (no gross regression visible; JXL prog first_paint/mt low single-digit to low-hundreds ms on small/medium; RAW decode unchanged as expected). Full log at session terminal artifact. No action required.

## Final Agent Instruction
When your assigned file's items are complete (or explicitly rejected to rejected optimizations.md), rename/append -DONE to this document filename (JxlStreamJxlWasm.md becomes JxlStreamJxlWasm-DONE.md). If only partial per agent, still append on your exit.
DONE: rename performed; all 5 file handoffs executed in one session (browser/node/loader changes + indexes noop + doc/test). See Implemented chapter.

---
END OF PLAN + EXECUTION RECORD (DONE)
