# EpicCodeReview

**Target:** `packages/jxl-pyramid/src/` (focus: decode-level.ts, choose-level.ts, tiled-decode-pool.ts)
**Branch reviewed:** `performance/jxl-pyramid-warm-pool` (worktree)
**Mode:** workalone | **Status:** review-only (user halted before fix stage)
**Generated:** 2026-06-09

## Summary

- **111 candidates** raised by 6 finders (CodeQL skipped — not on PATH)
- **93 confirmed** by verifier — 2 critical, 17 high, 39 medium, 29 low, 6 info
- **2 uncertain** → see Open questions
- **16 false positives** dismissed

**One-line verdict:** Hot path is structurally sound for 8-bit happy path; 16-bit support is silently broken end-to-end through worker + dist, and the warm pool lacks cancellation, timeout, factory-isolation, and dispose — most acute risks are correctness (16-bit), safety (untrusted JXTC header), and pool lifecycle.

---

## Findings (confirmed)

### Critical (2)

**packages/jxl-pyramid/dist/tiled-decode-pool.js**
- L1-90 **dist/tiled-decode-pool.js is severely stale vs src — missing 16-bit path, missing persistent pool, missing transferable, missing error/messageerror listeners**
  - _Evidence:_ Direct read of dist/tiled-decode-pool.js (90 lines) confirms: line 1 imports only decodeTileContainerRegionRgba8 (no rgba16); line 4 hardcodes `viewport.w * viewport.h * 4`; line 38-61 reimplements per-frame Array.from(factory) + finally-terminate (no PyramidWorkerPool class). di

**packages/jxl-pyramid/src/tiled-decode-pool.ts**
- L366-425 **Parallel worker pool path silently corrupts 16-bit tiled containers (worker.js only decodes rgba8)**
  - _Evidence:_ Verified web/lightbox/tiled-decode-worker.js line 9 calls decodeTileContainerRegionRgba8 unconditionally; no 16-bit branch. The pool path (decodeTiledViewportPooled) passes header.bitsPerSample to bppFor() and uses 8bpp stitch buffer when bits=16, but worker output is 4bpp. stitc


### High (17)

**packages/jxl-pyramid/dist/decode-level.js**
- L1-82 **dist/decode-level.js is stale: only imports decodeTileContainerRegionRgba8 — no 16-bit path, no pickRegionDecoder(bits), no bpp parametrization**
  - _Evidence:_ Confirmed by reading dist/decode-level.js: imports only decodeTileContainerRegionRgba8 (line 1), stitchTileDecodes hardcodes *4 (lines 31-39), no pickRegionDecoder, no bits parameter, no rgba16 branch. dist/level-source.js similarly omits bitsPerSample from the tiled result. dist

**packages/jxl-pyramid/src/choose-level.ts**
- L13-15 **chooseLevelForTarget sorts by pixel area but selects by long edge — picks the wrong level when area order disagrees with long-edge order**
  - _Evidence:_ Math is correct: with levels [{w:200,h:900,area:180000,longEdge:900}, {w:600,h:600,area:360000,longEdge:600}] sorted by area gives [200x900, 600x600]. find(longEdge>=550) returns 200x900 first. The doc-stated 'smallest pyramid level' should be 600x600. Standard pyramid levels (PY
- L8-16 **chooseLevelForTarget allocates and sorts a new array on every viewport/zoom change**
  - _Evidence:_ Confirmed: choose-level.ts:13 allocates `[...levels]` + sort on every call. web/lightbox/pyramid-lightbox.js:61 calls chooseLevelForTarget from pickLevel(zoomPct) which is invoked on every wheel/zoom interaction. web/pyramid-gallery/grid-controller.js:105 calls it from paintCell 

**packages/jxl-pyramid/src/decode-level.ts**
- L60-83 **stitchTileDecodes pixel-buffer allocation has unchecked multiplication overflow**
  - _Evidence:_ Verified decode-level.ts:65 and tiled-decode-pool.ts:41 both use unchecked w*h*bpp allocations. The viewport derives from clamps against source.width/height which come unchecked from JXTC header (level-source.ts:21-22). Worker output dims arrive at tiled-decode-pool.ts:87-88 with
- L114-119 **Promise.all over tile decodes has no AbortSignal — first failure leaves remaining tiles racing to completion with no cancellation**
  - _Evidence:_ Verified decode-level.ts:89-122. Function signature accepts no AbortSignal in options (lines 92-95). The RegionDecoder type (lines 15-18) has no signal parameter. Promise.all on line 114 fans out N tile decodes with no abort coordination — first rejection abandons in-flight WASM 
- L20-45 **decodeWhole leaks decoder if push/close/drain reject before dispose**
  - _Evidence:_ Lines 39-42 await push, close, drain, dispose sequentially with no try/finally. If decoder.push throws (malformed input), or the drain IIFE's 'error' branch (line 35) throws, decoder.dispose() is never invoked. WASM heap buffers and session state remain until GC reclaims the deco
- L29-41 **drain IIFE rejection becomes unhandled if push/close throws first**
  - _Evidence:_ Lines 29-38 start the drain IIFE immediately. Lines 39-41 await push, close, drain in order. If await decoder.push(bytes) rejects, the function unwinds before await drain is reached. drain remains an in-flight promise; if it later rejects (e.g., the 'error' event was already buff

**packages/jxl-pyramid/src/level-source.ts**
- L5-28 **LevelSource kind="whole" silently discards PyramidLevel.bitsPerSample — 16-bit whole-frame levels decode as 8-bit**
  - _Evidence:_ Confirmed: level-source.ts:5-7 "whole" variant has no bitsPerSample, createLevelSource on line 10 picks only "w"|"h"|"tiled" (drops bitsPerSample), and decode-level.ts:22 decodeWhole hardcodes `format: "rgba8"`. web/lightbox/pyramid-lightbox.js:52 filters levels by `l.bitsPerSamp

**packages/jxl-pyramid/src/tiled-decode-pool.ts**
- L304-321 **Module-singleton pool captures the first caller's workerFactory and ignores all subsequent factories**
  - _Evidence:_ Verified: module-level `let pool: PyramidWorkerPool | null = null;` (line 304) and `if (pool && !pool['destroyed']) return pool;` (line 307). The incoming `factory` argument is silently ignored when a pool exists. Combined with logic-006 (destroyed never set), second callers with
- L338-357 **Worker death between tile jobs in coroutine slicing can cause indefinite hang — postMessage to terminated worker returns no response**
  - _Evidence:_ Verified tiled-decode-pool.ts:234-258 (spawnOne attaches permanent recycle listener; recycle calls destroyHandle which calls worker.terminate()) and 338-357 (coros hold a WorkerLike reference and call decodeTileWithWorker in each loop iteration). If recycle fires between iteratio
- L68-124 **decodeTileWithWorker has no timeout and no per-call abort — if worker silently never replies, promise hangs forever**
  - _Evidence:_ Verified tiled-decode-pool.ts:68-124. The Promise executor installs only message/error/messageerror listeners. No setTimeout, no AbortSignal, no health-check ping. The single hang-resistance mechanism is the permanent recycle listener in spawnOne (separate scope) — it terminates 
- L372-426 **decodeTiledViewportPooled cannot be cancelled — pan/zoom in UI keeps in-flight decode running and holds pool workers busy**
  - _Evidence:_ Verified at tiled-decode-pool.ts:372-426. The options type (lines 374-379) explicitly omits AbortSignal. decodeTilesParallel (line 323-364) similarly has no abort plumbing. The active workers set (line 149) gets populated by acquire() but only released when the decode resolves/re
- L68-124 **decodeTileWithWorker never times out — hung worker stalls the pool slot forever**
  - _Evidence:_ src/tiled-decode-pool.ts:68-124 — the Promise has no setTimeout / AbortController arm. Only message-with-id, 'error', and 'messageerror' resolve it. If the worker hangs in WASM, the promise never settles; the await in decodeTilesParallel coro (line 345) blocks indefinitely; relea
- L381-397 **parseJxtcHeader called on every decodeTiledViewportPooled invocation**
  - _Evidence:_ Confirmed: tiled-decode-pool.ts:381 calls parseJxtcHeader on every invocation; pyramid-decode.js:16 calls decodeTiledViewportPooled inside a closure that is re-created per decode request. The sibling decodeTiledViewport in decode-level.ts accepts a pre-parsed LevelSource. Real wa

**packages/jxl-pyramid/src/tiling.ts**
- L37-51 **parseJxtcHeader reads attacker-controlled uint32 dims with no range validation**
  - _Evidence:_ Verified at tiling.ts:42-50. Five uint32 fields read with no bounds checking and returned to createLevelSource (level-source.ts:17-25), which assigns header.imageW/imageH/tileSize verbatim to source.{width,height,tileSize}. Downstream allocations at decode-level.ts:65 and tiled-d
- L61-96 **tilesOverlappingRegion can produce unbounded tile-list growth from attacker-controlled imageW/H/tileSize**
  - _Evidence:_ Verified tiling.ts:61-96 has no cap on the (tyMax-tyMin+1)*(txMax-txMin+1) iteration count. decode-level.ts:136 confirms `roi = { x: 0, y: 0, w: source.width, h: source.height }` for null region. Whole-level decode path forces tile generation across the full image area. Chained w

**web/pyramid-gallery/image-store.js**
- L21-29 **No runtime schema validation at manifest.json boundary — JSON.parse cast directly to PyramidManifest**
  - _Evidence:_ Confirmed: image-store.js:26 does `const manifest = await res.json()` with no shape check. Confirmed via Glob + Grep that no schema.ts exists in pyramid-ingest/src (files: backends, cli, hash, index, ingest, ladder, manifest, quality, raw-backend, rgb16, shard) and grep for `prod


### Medium (39)

**packages/jxl-pyramid/src**
- L0-0 **No shared assertion/invariant utility — pyramid coord/level math sprawls without a check-once-per-boundary discipline**
  - _Evidence:_ Verified three independent clamp sites: decode-level.ts:100-103, tiled-decode-pool.ts:382-385, tiling.ts:68-71. Verified no byteLength assertion in either stitch function. Concrete evidence of need: logic-001 (16-bit worker corruption) would be mechanically caught by an assertDec

**packages/jxl-pyramid/src/choose-level.ts**
- L1-26 **No memo / pre-sort cache for pyramid level picker**
  - _Evidence:_ choose-level.ts:13 copies and sorts on every invocation. No WeakMap or module-level cache exists in the file. `levelRank` (line 19-21) is a pure function and is recomputed by `shouldUpgrade` on each call. A WeakMap memo on the levels array is a small, clean fit; PyramidLevel arra

**packages/jxl-pyramid/src/decode-level.ts**
- L89-122 **decodeTiledViewport does Promise.all fan-out with no concurrency cap on non-worker path**
  - _Evidence:_ Verified decode-level.ts:107-119. The parallel path (line 114) calls Promise.all over the full tiles array with no chunking or semaphore. tiles.length is itself unbounded (see security-c3d4e5f6). decodeRegion ultimately calls decodeTileContainerRegionRgba{8,16} which allocates a 
- L114-122 **Promise.all short-circuit leaks in-flight tile decodes on first failure**
  - _Evidence:_ Lines 114-119 use Promise.all with no per-tile .catch and no AbortSignal. CLAUDE.md confirms 'decoder.push() (WASM) is synchronous — cannot yield mid-push'. Sibling decode promises continue running and their rejections (if any) become unhandled. The contrast with tiled-decode-poo
- L75-80 **stitchTileDecodes allocates a Uint8Array subarray view per row in fallback path**
  - _Evidence:_ Lines 75-80 confirm per-row subarray() allocation; each row creates a new Uint8Array view object. Same code pattern exists at tiled-decode-pool.ts:51-55. The allocation overhead is real, though Uint8Array.prototype.set has no zero-alloc range-copy overload, so the proposed fix pa

**packages/jxl-pyramid/src/fixtures.ts**
- L14-56 **APPROVED_FIXTURES is re-exported as part of public surface but contains Windows absolute paths (c:\\Foo\\...) — leaks dev-machine paths into the package public API**
  - _Evidence:_ Confirmed: fixtures.ts:15-56 exports APPROVED_FIXTURES with hardcoded `c:\Foo\...` and `c:\995\...` paths. index.ts:7 re-exports it via `export * from "./fixtures.js"`. The const lives in src/ (not test/) so it ships in the public bundle and type definitions, leaking dev-machine 

**packages/jxl-pyramid/src/grid-layout.ts**
- L15-22 **layoutFromIndex divides by aspect with no guard against zero/NaN/negative**
  - _Evidence:_ src/grid-layout.ts:15-22 — entry.aspect comes from GalleryIndexEntry (manifest.ts:56-60) and is typed `number` with no runtime validation. If aspect is 0, rowSpan = Infinity. Math.round(Infinity) is Infinity (not NaN), and Math.max(1, Infinity) is Infinity. CSS grid will silently
- L21-21 **rowSpan formula collapses to 1/aspect — base cancels out, formula ignores column width**
  - _Evidence:_ Confirmed: `(base / aspect) / base` = `1 / aspect`. base is mathematically eliminated. The docstring says rows are scaled by columnWidthPx but the formula ignores it. For typical aspects (>=0.5), rowSpan is always 1 — visibly wrong layout for any non-square grid sizing. Either th

**packages/jxl-pyramid/src/level-source.ts**
- L9-28 **createLevelSource propagates unchecked JXTC header dims to LevelSource width/height**
  - _Evidence:_ Verified level-source.ts:9-25. The function signature even includes entry.w/h via Pick<PyramidLevel, 'w' | 'h' | 'tiled'> but ignores them for the tiled branch. Whole branch uses entry.w/h (line 27), tiled branch uses header.imageW/imageH (lines 21-22). No cross-validation. Inver

**packages/jxl-pyramid/src/manifest.ts**
- L35-46 **No runtime schema validation (Zod) for PyramidManifest / GalleryIndex at boundary**
  - _Evidence:_ Verified manifest.ts has only TypeScript interfaces, no Zod schemas. grep for 'zod' across the worktree returned no matches in jxl-pyramid (despite WU-1 zod adoption noted in CLAUDE.md for pyramid-ingest, that work hasn't reached this package). grid-layout.ts:21 confirms the aspe
- L17-46 **pyramid-ingest and jxl-pyramid define structurally-similar but separate manifest interfaces — no shared type, compile-time drift possible**
  - _Evidence:_ Confirmed: pyramid-ingest/src/manifest.ts:22-32 declares Manifest with `proxy?: true` (narrow literal), and jxl-pyramid/src/manifest.ts:36-46 declares PyramidManifest with `proxy?: boolean` (wider). pyramid-ingest's isUpToDate() (line 101) reads `existing.proxy !== true` so the f
- L36-46 **No runtime schema version check — schema:1 declared as literal type but never verified at parse**
  - _Evidence:_ Confirmed: PyramidManifest.schema and GalleryIndex.schema are literal `1` (manifest.ts:37, 64) but image-store.js:26 does plain JSON.parse and the package itself never checks schema version. No runtime version guard exists.

**packages/jxl-pyramid/src/tiled-decode-pool.ts**
- L62-90 **WorkerReply.pixels typed as ArrayBuffer but worker posts a Uint8Array — `new Uint8Array(ab)` copies instead of wrapping**
  - _Evidence:_ Verified worker at web/lightbox/tiled-decode-worker.js line 10: `self.postMessage({ id, ok: true, pixels: out.pixels, ... }, [out.pixels.buffer])`. `out.pixels` is a Uint8Array; structured clone preserves the typed-array view (even when buffer transferred). On receiver, ev.data.p
- L261-273 **armIdleTimer arms only the just-released handle — handles enqueued earlier when idle count was below minIdle are never reaped**
  - _Evidence:_ Traced the logic: armIdleTimer only arms a timer on the just-released handle and only when idle.length > minIdle. Walkthrough with minIdle=2: release w1 (idle=1, no timer), release w2 (idle=2, no timer), release w3 (idle=3, timer on w3 only). w3 reaps after 5s, idle=2 again. Next
- L76-92 **Worker message handler trusts ev.data shape without validation**
  - _Evidence:_ Verified at tiled-decode-pool.ts:76-92. WorkerReply is TS-only (lines 62-64). The handler does no runtime shape/type checks. Compromised worker output flows directly into stitchTileDecodes (line 87-89 returns the raw width/height). Threat model treats workers as a trust boundary 
- L66-73 **Module-scoped nextWorkerId is shared across all pool callers and never reset — collision risk if module loaded twice (HMR / multiple bundles)**
  - _Evidence:_ Verified at tiled-decode-pool.ts:66 and 73. The id is module-scoped and never reset. Workers do persist across decode calls via the pool (workers are reused — see decodeTilesParallel coros at line 338), so HMR scenario is plausible. Worker handle does not track outstanding reques
- L304-321 **Module-scoped `pool` singleton is never destroyable — no exported shutdown(), and `pool['destroyed']` is never set to true**
  - _Evidence:_ Verified at tiled-decode-pool.ts:152 (`private destroyed = false;`) and grep for 'destroyed =' shows it is only ever set to false at declaration. No setter, no shutdown/dispose method. Line 304 module-scope `pool` variable has no export reset. Tests cannot tear it down between ru
- L306-321 **Pool singleton binds to the first-seen workerFactory — subsequent callers passing a different factory are silently ignored**
  - _Evidence:_ Verified at tiled-decode-pool.ts:306-321. The first call captures `factory` into the new PyramidWorkerPool constructor; subsequent calls hit the cache and ignore the passed factory. API contract gap is real: decodeTiledViewportPooled accepts workerFactory per call (line 378) but 
- L110-123 **worker.postMessage is not wrapped in try/catch — synchronous throw (DataCloneError, terminated worker) prevents promise from ever settling**
  - _Evidence:_ Verified at tiled-decode-pool.ts:110-123. The try/catch on lines 111-116 only guards the addEventListener calls (for test doubles), not the postMessage call at line 122. A synchronous postMessage throw escapes the Promise executor and leaves the promise pending forever. DataClone
- L186-214 **No backpressure / queue on acquire — pool at cap returns fewer workers and caller silently falls back to single-WASM decode**
  - _Evidence:_ Lines 186-214 show acquire() drains idle then spawns up to maxSize, then returns. No waiter queue. Lines 414-418 confirm the fallback to single-WASM decodeRegion when liveWorkers.length === 0. Pattern matches finding exactly; behavior is silently sub-optimal for concurrent ROI ba
- L234-250 **Permanent recycle listener is never removed — accumulates across worker lifetime; harmless per-worker but no removal on destroyHandle**
  - _Evidence:_ Lines 242-248 add 'error'/'messageerror' listeners. destroyHandle (lines 288-301) calls terminate() but never removeEventListener. The recycle() guard on line 253 (`if (!this.all.has(h)) return`) protects correctness, but the listener-removal omission is observable, as described.
- L192-214 **acquire() does not verify a warm idle worker is actually responsive — silent-fail workers stay in idle until they error**
  - _Evidence:_ Lines 192-201 only check h.terminated, h.bad, and this.all.has(h). decodeTileWithWorker (lines 68-124) has no timeout, so a wedged worker causes the promise to hang indefinitely. There is no liveness mechanism beyond worker-emitted error events (lines 244-245).
- L204-212 **spawn-on-demand uses try/catch around spawnOne, but a partial spawn (factory creates Worker that fails immediately) puts a bad handle into `active` then breaks the loop — caller never releases this handle**
  - _Evidence:_ The race is concrete: spawnOne at lines 234-250 returns a handle with permanent 'error'/'messageerror' listeners pointing to recycle (which calls destroyHandle, line 258, removing from all). If the worker errors before/during decodeTileWithWorker dispatch, recycle removes the han
- L117-123 **containerBytes is structured-cloned N times (once per tile) — N parallel postMessage of the same large buffer is a hidden N x copy cost**
  - _Evidence:_ Lines 117-122 contain an explicit acknowledgment from the codebase: 'bytes (full JXTC container) is structured-cloned here'. postMessage at line 122 has no transferable list. canUseParallelTileWorkers() in tiling.ts asserts SAB preconditions (per comment) but this code does not e
- L234-302 **No periodic health monitor — a worker that loaded WASM but later starts failing every tile sits in idle/active rotation until terminated by error event**
  - _Evidence:_ recycle() (lines 252-259) is only invoked from the worker error/messageerror events (lines 242-247). decodeTileWithWorker (lines 90-92) rejects on `ok:false` but does not propagate to the pool to mark the handle bad. A worker stuck returning ok:false would be returned to idle by 
- L204-213 **spawnOne failure is swallowed with no logging or escalation**
  - _Evidence:_ src/tiled-decode-pool.ts:204-212 — bare `catch { break; }` with no logging. Verified against jxl-scheduler/pool.ts which has spawnFailed metric and a console.warn for spawn timeout (line 388-393). This pool has none of that observability.
- L242-248 **Silent catch on lifecycle addEventListener disables worker recycling**
  - _Evidence:_ src/tiled-decode-pool.ts:243-248 — silent catch around addEventListener. In standard browsers Worker.addEventListener is safe; the catch only exists for test doubles. In production a real throw here would leave the handle without recycle wiring; the comment acknowledges the test-
- L304-321 **Module-level pool ignores subsequent workerFactory arguments**
  - _Evidence:_ src/tiled-decode-pool.ts:304-321 — module-level singleton, factory argument used only on first call. No identity check, no reset API, no log on mismatch. In production single-app flow this is fine; in HMR/test/scenarios where worker URL changes between calls, the stale factory wi
- L333-364 **decodeTilesParallel allocates results array sized to caller-supplied tiles.length**
  - _Evidence:_ src/tiling.ts:37-51 parses u32 dimensions with no upper bound. src/tiled-decode-pool.ts:333 calls `new Array(tiles.length)` — and tiles.length is driven by clamped viewport, but `tilesOverlappingRegion` iterates a double loop up to (txMax-txMin+1) * (tyMax-tyMin+1) (line 80-94) w
- L372-405 **decodeTiledViewport and decodeTiledViewportPooled have divergent signatures for the same logical operation**
  - _Evidence:_ Confirmed: decode-level.ts:89-95 declares decodeTiledViewport(source: LevelSource tiled variant, ...) while tiled-decode-pool.ts:372-380 declares decodeTiledViewportPooled(containerBytes: Uint8Array, ...). Both are exported via index.ts. The pooled variant calls parseJxtcHeader o
- L141-302 **PyramidWorkerPool has no public dispose() / isDestroyed() — leaked module-scope pool can't be cleanly torn down by callers**
  - _Evidence:_ Confirmed: class PyramidWorkerPool exposes only get size, prewarm, acquire, release (private spawnOne/recycle/armIdleTimer/clearIdleTimer/reap/destroyHandle). The `destroyed` flag is declared private (line 152) and read in destroy paths (lines 172, 187, 222, 235) but never writte
- L226-229 **release() does O(idle) Array.includes scan per worker returned**
  - _Evidence:_ Confirmed: tiled-decode-pool.ts:227 does `if (!this.idle.includes(h)) this.idle.push(h)` — O(idle) per worker. With maxSize=8 it's bounded but the check shouldn't be needed: acquire moves handles to active and removes from idle (lines 193-199), so a released handle is never alrea
- L40-60 **stitch() in tiled-decode-pool.ts duplicates stitchTileDecodes from decode-level.ts**
  - _Evidence:_ Direct side-by-side comparison: tiled-decode-pool.ts lines 40-60 implements `stitch` and decode-level.ts lines 60-83 implements `stitchTileDecodes`. Both build a destination Uint8Array, have an identical fast-path check (`decoded.width === viewport.w && dx === 0`), and identical 
- L117-123 **Documentation of transferable convention is in a comment, not enforced**
  - _Evidence:_ Verified web/lightbox/tiled-decode-worker.js:10 does `self.postMessage({...}, [out.pixels.buffer])` — transfer enforced by hand on the worker side. Sender side (tiled-decode-pool.ts:80-83) trusts this via comment. Out-of-tree workers could silently drop the transfer list and the 

**packages/jxl-pyramid/src/tiling.ts**
- L1-9 **No upper-bound cap on image/level dimensions before allocation**
  - _Evidence:_ Verified constants.ts and tiling.ts contain no MAX_IMAGE_DIMENSION / MAX_TILE_COUNT constants. The existing MASSIVE_* thresholds gate ingest tiling decisions, not decode-side input validation. Pairs naturally with security-a1b2c3d4 and security-c3d4e5f6 as a unified hardening poi
- L37-51 **parseJxtcHeader accepts arbitrary u32 dimensions without sanity bounds**
  - _Evidence:_ src/tiling.ts:37-51 reads five u32 dimension fields and only validates magic and version. No upper bound on imageW/imageH/tileSize or coherence check between (imageW, tileSize, tilesX). tileSize=0 is caught later in tilesOverlappingRegion line 67 but only inside that function — o
- L60-96 **tilesOverlappingRegion rebuilds tile grid every call; no cache by (imageW, imageH, tileSize)**
  - _Evidence:_ tiling.ts:61-96 confirmed: function always allocates a fresh `out` array and recomputes Math.floor/Math.min/Math.max for every tile in the visible subset. No cache exists. For pan-at-60Hz with dozens of tiles, the constant overhead is real. The opportunity self-rates 'worth a ben

**packages/jxl-pyramid/test**
- L0-0 **No fast-check / property-based tests for tilesOverlappingRegion, chooseLevelForTarget, or stitch geometry**
  - _Evidence:_ Verified test files in jxl-pyramid/test/ are single-shape only (choose-level.test.ts, tiling.test.ts use hardcoded inputs). Verified concrete value: a property test ∀ levels with mixed aspect ratios would surface logic-002 (the area-vs-longEdge sort mismatch) immediately. tilesOv

**packages/jxl-pyramid/test/pyramid.test.ts**
- L1-146 **No round-trip contract test: pyramid-ingest writes manifest → jxl-pyramid reads + decodes**
  - _Evidence:_ Confirmed: pyramid.test.ts contains only constant verification, preset enumeration, fixture path checks, and a compile-time-only structural test. No imports of buildManifest from pyramid-ingest, no round-trip JSON parse → chooseLevelForTarget → createLevelSource → decodeLevel tes


### Low (29)

**packages/jxl-pyramid/src**
- L0-0 **Region clamping is duplicated across decode-level.ts, tiled-decode-pool.ts, and tilesOverlappingRegion — extract clampRegionToImage(region, imageW, imageH)**
  - _Evidence:_ Verified three identical clamp blocks: decode-level.ts:100-103 (rx/ry/rw/rh on source.width/height), tiled-decode-pool.ts:382-385 (same on header.imageW/H), tiling.ts:68-71 (same on imageW/H). All three would change in lockstep for any boundary semantic shift. Trivial dedupe.

**packages/jxl-pyramid/src/choose-level.ts**
- L8-16 **chooseLevelForTarget silently accepts NaN/negative/zero targetLongEdge**
  - _Evidence:_ Lines 8-16 contain no Number.isFinite or >0 guard on targetLongEdge. NaN comparisons always return false in JS, so `.find()` returns undefined and the function returns the largest level (the fallback). For targetLongEdge=0 or negative, every level satisfies the predicate so the s

**packages/jxl-pyramid/src/decode-level.ts**
- L99-106 **decodeTiledViewport region.x/y/w/h not checked for finite/non-NaN before clamp arithmetic**
  - _Evidence:_ Verified by running `new Uint8Array(NaN)` — produces length 0, does not throw. NaN <= 0 is false (NaN comparisons all return false), so the guard at decode-level.ts:104 is bypassed for NaN inputs. Same gap exists in tiled-decode-pool.ts:382-386 (decodeTiledViewportPooled has iden
- L100-105 **NaN region dimensions bypass empty-check and allocate huge buffer**
  - _Evidence:_ Lines 100-104: NaN propagates through Math.min/Math.max. NaN < 0 is false, so the `rw <= 0 || rh <= 0` guard at line 104 fails to catch NaN. Subsequent flow uses viewport.w/h in stitchTileDecodes (line 65: `new Uint8Array(viewport.w * viewport.h * bpp)`) where NaN multiplication 
- L97-97 **decodeTiledViewport defends against undefined bitsPerSample on a non-nullable typed field**
  - _Evidence:_ Confirmed: level-source.ts:7 declares bitsPerSample: 8 | 16 as required on the tiled variant; decode-level.ts:97 uses `source.bitsPerSample ?? 8`. The fallback is unreachable under the declared type. The same pattern appears in tiled-decode-pool.ts:389 `const bits = header.bitsPe
- L125-138 **decodeLevel throws on region+kind=whole but silently defaults region for kind=tiled — asymmetric contract**
  - _Evidence:_ Confirmed: decode-level.ts:131-137 implements an asymmetric contract — region passed with whole throws, region omitted with tiled silently defaults to full ROI. The type signature `region?: ImageRegion` does not surface either constraint.
- L100-107 **Region clamping done twice: in caller and again inside tilesOverlappingRegion**
  - _Evidence:_ decode-level.ts lines 100-103 perform Math.min/Math.max clamping; tilesOverlappingRegion in tiling.ts lines 68-71 repeats the identical clamp on the already-clamped viewport. The same pattern appears in tiled-decode-pool.ts lines 382-385. The work is redundant but cheap; severity
- L20-45 **decodeWhole creates an IIFE async drain and awaits three independent promises**
  - _Evidence:_ decode-level.ts:29-42 confirms the IIFE drain pattern followed by four sequential awaits. The push/drain dataflow does naturally race (drain awaits events while push pumps them), but the chain of awaits adds microtask overhead. Self-rated low confidence and low severity since dec

**packages/jxl-pyramid/src/grid-layout.ts**
- L15-22 **rowSpan formula (base / aspect) / base simplifies to 1 / aspect — `base` (columnWidthPx) is dead and the formula is unit-incoherent**
  - _Evidence:_ Verified algebra: (base / aspect) / base = 1 / aspect. The `base` variable from columnWidthPx is dead in the rowSpan computation. Function signature accepts columnWidthPx but doesn't use it meaningfully. Concrete failure: caller passing different columnWidthPx values gets identic
- L15-23 **layoutFromIndex assumes entry.aspect is positive — divide-by-zero or NaN propagates to rowSpan**
  - _Evidence:_ Confirmed: grid-layout.ts:21 lacks any aspect-positivity guard; GalleryIndexEntry declares `aspect: number` with no refinement; combined with no manifest schema validation (contracts-004), aspect=0 or NaN from a bad index would propagate. Math.max(1, NaN) = NaN. The math bug susp

**packages/jxl-pyramid/src/index.ts**
- L1-14 **No deprecation-warning framework — backwards-incompatible changes to exported surface have no migration path**
  - _Evidence:_ Confirmed: index.ts is bulk star re-export with no JSDoc, no @deprecated annotations anywhere in src. Opportunity for a deprecation framework is valid but low severity; menu-listed gap.

**packages/jxl-pyramid/src/tiled-decode-pool.ts**
- L141-321 **`destroyed` flag is checked in 4 places but never set — destroy() method missing, getOrCreatePool's guard is dead code**
  - _Evidence:_ Verified by reading the full file: `private destroyed = false;` (line 152). Checks at lines 172, 187, 222, 235, 307. No `this.destroyed = true` assignment anywhere in tiled-decode-pool.ts. Concrete consequence: in test / HMR / multi-tenant scenarios there's no recovery path; comb
- L40-60 **`stitch` in tiled-decode-pool.ts is byte-for-byte equivalent to `stitchTileDecodes` in decode-level.ts — divergence risk**
  - _Evidence:_ Verified by direct file comparison: tiled-decode-pool.ts:40-60 and decode-level.ts:60-83 have identical stitching logic — same fast-path condition (decoded.width === viewport.w && dx === 0), same per-row fallback with subarray copy. Divergence risk is real: any fix to one (e.g., 
- L66-124 **Global nextWorkerId is monotonic across all sessions; id reuse on overflow could mis-route worker replies**
  - _Evidence:_ Verified tiled-decode-pool.ts:66 and 73. ID is module-scoped and never reset. Each onMessage filters by `ev.data.id !== id`. Per-decode listeners are added (line 110), so multiple in-flight decodes on the same worker each see all messages — id uniqueness is the only routing guara
- L23-26 **Worker factory URL provenance is implicit; no allowlist defense if ever wired to manifest**
  - _Evidence:_ Verified tiled-decode-pool.ts:23-26 and 378. workerFactory is caller-supplied today (see pyramid-decode.js:18-22 — `new Worker(new URL('../lightbox/tiled-decode-worker.js', import.meta.url))` is a closed-over hard-coded URL). Severity is appropriately low (forward-looking hardeni
- L76-99 **onMessage handler does not check `settled` before resolving — late message after error path causes double-settle (benign but indicates contract gap)**
  - _Evidence:_ Verified at tiled-decode-pool.ts:76-95. onError guards on `if (settled) return;` (line 95) but onMessage does not (line 76-93). cleanup() at line 100-109 sets settled=true. The race is real but benign because JS promises ignore subsequent settle calls. The asymmetry is the real f
- L171-179 **prewarm() returns synchronously but worker WASM module load is asynchronous — first request after prewarm may still pay the cold-start cost without observable signal**
  - _Evidence:_ prewarm() (lines 171-179) is synchronous and the JSDoc explicitly states 'their top-level preloadJxlModule() runs' which is asynchronous. No readiness mechanism is exposed by the pool API. The semantics are exactly as described; the comment 'Re-warm on first use' at line 317 conf
- L323-364 **decodeTilesParallel hand-rolls a coroutine slicer; a structured TaskGroup-style helper would handle cancellation, partial failure, and AbortSignal uniformly**
  - _Evidence:_ decodeTilesParallel (lines 323-364) and decodeTiledViewport in decode-level.ts (lines 114-119) both implement coroutine/Promise.all parallel-tile patterns. Neither accepts AbortSignal nor exposes progress. The opportunity for a shared helper is real and evidenced by duplication; 
- L329-332 **decodeTilesParallel returns [] when workers.length === 0, but caller's stitch over [] yields a zero-filled viewport — silent visual corruption**
  - _Evidence:_ Lines 329-332 do return [] on empty workers. stitch() at line 40-60 over empty parts produces an all-zero Uint8Array (allocation only, no fills). decodeTilesParallel is module-internal and only called from decodeTiledViewportPooled where line 414 guards, so the path is unreachabl
- L293-300 **worker.terminate() exceptions swallowed without logging**
  - _Evidence:_ src/tiled-decode-pool.ts:293-300 — silent catch around terminate(). Low risk in practice (browser Worker.terminate is void) but no observability if a shim or future implementation throws. The finding is accurate at low severity.
- L307-318 **Private field accessed via bracket notation bypasses encapsulation and typing**
  - _Evidence:_ src/tiled-decode-pool.ts:152 initializes `destroyed = false`; grep confirms no reassignment anywhere in the file. The class has no destroy() method. So `pool["destroyed"]` is invariantly false at line 307, making the !destroyed branch dead code. `p["minIdle"]` (line 318) is also 
- L76-99 **onMessage runs cleanup() unconditionally even if onError already fired**
  - _Evidence:_ src/tiled-decode-pool.ts:76-99 — onMessage has no `if (settled) return` guard, while onError does (line 95). Cleanup happens to be idempotent and Promise resolve/reject after settlement is a no-op, so no functional bug. The asymmetric guard is a clarity / consistency issue, corre
- L186-214 **acquire() declared async but does no awaits — concurrent callers race against shared state without queueing**
  - _Evidence:_ src/tiled-decode-pool.ts:186-214 — acquire is `async` but has no awaits. The fallback at lines 414-418 (caller) silently degrades to single-WASM decode when liveWorkers is empty. Not a correctness issue, but the silent degradation matches the description. Reasonable info-level fi
- L420-425 **release() in finally can throw and mask the decode error**
  - _Evidence:_ src/tiled-decode-pool.ts:420-425 — release() is called bare in finally. release() loops setTimeout-arming over each worker; any throw inside replaces the original decode error per JS semantics. The probability is low (release is mostly safe operations) but the masking pattern is 
- L306-321 **getOrCreatePool reads private fields via ["destroyed"] / ["minIdle"] bracket access — bypasses TS access control**
  - _Evidence:_ Confirmed: tiled-decode-pool.ts:307 reads `pool["destroyed"]` and line 318 reads `p["minIdle"]`. Both fields are declared private (lines 145, 152). The bracket access compiles but is fragile to rename refactors. Note: the `destroyed` field is never set to true anywhere in the cla
- L306-321 **getOrCreatePool prewarms on first call — this is on the user's first interactive frame**
  - _Evidence:_ Code at tiled-decode-pool.ts:306-321 matches the description exactly. The pool is created lazily on first acquire, and `p.prewarm()` synchronously calls `spawnOne()` per worker (via `this.factory()`); web/lightbox/tiled-decode-worker.js imports and calls `preloadJxlModule()` at t

**packages/jxl-pyramid/src/tiling.ts**
- L104-109 **canUseParallelTileWorkers returns false when `crossOriginIsolated` is undefined — Node.js worker_threads contexts always lose parallel path**
  - _Evidence:_ Verified at tiling.ts:107-108: returns false when crossOriginIsolated is undefined. Verified at decode-level.ts:108: parallel gate uses canUseParallelTileWorkers. Verified test at decode-level.test.ts:60: passes parallel:true but Bun/Node lacks crossOriginIsolated → wantParallel=
- L73-78 **Tile index math uses Math.floor((rx+rw-1)/tileSize) — overflow at edge**
  - _Evidence:_ The author's own analysis confirms NaN propagates safely to empty array (degrades to no-op) and u32 max can't overflow Number.MAX_SAFE_INTEGER. The finding is low-priority defense-in-depth — caller-bug surfacing via Number.isFinite. Confirmed as info.
- L37-51 **JXTC container version is hardcoded to 1 in parser — no migration path documented or signaled**
  - _Evidence:_ Confirmed: tiling.ts:41 throws on `getUint32(4) !== 1`. JxtcHeader interface (line 12-21) carries no version field, so consumers can't route on version. The check is correct but offers no migration path or version metadata. Informational; low priority.


### Info (6)

**packages/jxl-pyramid/src/choose-level.ts**
- L15-15 **Trailing `?? null` is unreachable after non-empty length guard**
  - _Evidence:_ src/choose-level.ts:12 returns null when levels.length === 0, so sorted is non-empty afterward and sorted[sorted.length-1] is always defined. The trailing `?? null` on line 15 is unreachable. Strict TS noUncheckedIndexedAccess may need the fallback for type-safety, but at runtime
- L8-16 **chooseLevelForTarget re-sorts a readonly array on every call though manifest is already sorted ascending by ingest**
  - _Evidence:_ Confirmed: pyramid-ingest/src/manifest.ts:75 in buildManifest does `const levels = [...args.levels].sort((a, b) => a.w * a.h - b.w * b.h);` before writing. chooseLevelForTarget at choose-level.ts:13 re-sorts on every call. The PyramidManifest.levels type carries no ordering invar

**packages/jxl-pyramid/src/decode-level.ts**
- L1-138 **All failure modes throw generic Error — no taxonomy for callers to discriminate**
  - _Evidence:_ src/decode-level.ts lines 35, 43, 104, 132 all throw `new Error(...)`. src/tiled-decode-pool.ts:91 and 97 also throw `new Error(...)`. Callers cannot discriminate by class. The opportunity to introduce sentinel error classes is real and aligns with CLAUDE.md's emphasis on disting

**packages/jxl-pyramid/src/tiled-decode-pool.ts**
- L1-426 **Zero logging anywhere in the pool — spawn fail, recycle, fallback all silent**
  - _Evidence:_ Grep over src/tiled-decode-pool.ts for `console.` returns zero matches. Compare to jxl-scheduler/pool.ts which has console.warn (line 388, 585) and spawnFailed metric (line 22, 56, 306). This pool has no observability whatsoever. Reasonable info-level opportunity.
- L323-364 **No retry on transient worker failures — single failure aborts whole viewport**
  - _Evidence:_ src/tiled-decode-pool.ts:349-355 — first error sets `failed=true` and aborts all coros. The viewport-level call in decodeTiledViewportPooled (line 420-422) does not retry. For transient worker crashes, an opportunity to retry once on a fresh handle is reasonable. Info-level, opti
- L307-318 **Bracket-access of private fields defeats TypeScript and may inhibit JIT inlining**
  - _Evidence:_ tiled-decode-pool.ts:307 uses `pool["destroyed"]` and line 318 uses `p["minIdle"]` to bypass TS private-field visibility (declared at lines 152 and 145). Code-smell is real; the JIT-inlining concern is plausible but unverified. Severity 'info' is appropriate.


---

## Uncertain (deferred to QUESTIONS.md)

- `packages/jxl-pyramid/src/tiled-decode-pool.ts:333-364` **On first failure, sibling workers' in-flight WASM jobs continue and pollute next acquire**
  - _Why uncertain:_ The author's own analysis is internally inconsistent (concludes 'no in-flight job is orphaned in the literal sense' then speculates about a 'risk window' for stale replies). Each worker has only one in-flight Promise at a time (sequential await in the coro), and cleanup() removes
- `packages/jxl-pyramid/src/tiled-decode-pool.ts:338-357` **decodeTilesParallel mutates a sparse results array via late-binding indices**
  - _Why uncertain:_ Code structure matches the finding (lines 333-348). However, since `idx = next++` is monotonically increasing and writes complete (potentially out-of-order) at indices 0..N-1, the array is transiently holey but always fully populated before consumption. V8's elements-kind transit

---

## Detector counts

| Detector | Candidates | Confirmed | FP | Uncertain |
|----------|-----------:|----------:|---:|----------:|
| concurrency | 24 | 18 | 6 | 0 |
| contracts | 18 | 18 | 0 | 0 |
| errors | 24 | 22 | 1 | 1 |
| logic | 20 | 12 | 8 | 0 |
| performance | 14 | 12 | 1 | 1 |
| security | 11 | 11 | 0 | 0 |

---

## Workspace

Full per-candidate JSON (candidates → verified → plan): `.epiccodereview/20260609T103535Z/sections/000/`

- `findings/<role>.json` — raw finder output
- `verified_chunk_<NN>.json` — verifier verdicts + evidence
- `plan.json` — fix-task plan (93 pending, 2 deferred; all sonnet/workalone)
- `fix_briefs/<file>.json` — per-file extracts ready for fixers if you resume

## Next

Review halted at planning stage per user request. To resume:

1. Re-enter worktree: `git worktree list` → `C:\Fooaw-converter-wasm\.worktrees\jxl-pyramid-warm-pool`
2. Pick fix scope (recommend: critical + high + 16-bit propagation chain first)
3. Skill resume not native — dispatch fixers manually from `fix_briefs/*.json`

Stash carrying parked HANDOFF docs on the original branch: `stash@{0}: epiccodereview: park HANDOFF docs`

---

# Lens 1 — Strategic view + pipeline (2026-06-09)

**Files in memory:** `choose-level.ts` (26 LoC), `decode-level.ts` (138 LoC), `tiled-decode-pool.ts` (426 LoC).

## Pipeline + data passed

```
manifest.json[] → PyramidLevel[]
    ↓
choose-level.ts: chooseLevelForTarget(levels, targetLongEdge) → PyramidLevel
    ↓ (level-source.ts → LevelSource | raw containerBytes)
    ↓
    ├── decode-level.ts: decodeLevel(LevelSource, region?)
    │       whole  → decodeWhole(bytes)              [hardcoded rgba8 ← bug]
    │       tiled  → decodeTiledViewport()           [main-thread Promise.all]
    │                   stitchTileDecodes(viewport, parts, bpp)
    │
    └── tiled-decode-pool.ts: decodeTiledViewportPooled(containerBytes, region, opts)
            parseJxtcHeader(bytes) → {imageW, imageH, tileSize, bitsPerSample}
            pool.acquire(N) → workers
            decodeTilesParallel(bytes, tiles, workers)
               per-worker coroutine: postMessage({id, bytes, region}) → WorkerReply
            stitch(viewport, parts, bpp)
            pool.release(workers)

Both return: DecodedLevel { pixels: Uint8Array, width, height }
```

## Strategic observations (action items)

### L1-1. Sibling-decoder divergence
- **Category:** bug-prone, perf
- **Issue:** Two source-of-truth schemes: decode-level reads LevelSource.bitsPerSample, pool re-parses JXTC header every call. Two stitch impls (byte-for-byte identical), two clamp blocks, two pickRegionDecoder selections.
- **Fix:** Extract `clampRegion`, `stitch`, `pickRegionDecoder` to shared helper (tiling.ts or new decode-core.ts). Pool entry should accept pre-parsed header to skip re-parse.

### L1-2. Pool path bypasses LevelSource
- **Category:** perf + contract
- **Issue:** Pool takes raw bytes — caller already has bits/dims from manifest but pool re-discovers them via header parse on hot path.
- **Fix:** Add overload `decodeTiledViewportPooled(source: LevelSource, region, opts)` reusing manifest dims; keep raw-bytes overload for transitional callers.

### L1-3. choose-level re-sorts every viewport change
- **Category:** speed + efficiency
- **Issue:** `[...levels].sort(…)` allocates + O(n log n) on every pan/zoom/IntersectionObserver fire. Manifest is pre-sorted ascending by pyramid-ingest.
- **Fix:** Drop the sort (`levels.find(l => longEdge(l.w, l.h) >= target) ?? last ?? null`). If defensive sort wanted: memoize per-levels-identity via WeakMap.

### L1-4. `decodeTilesParallel` is a half-built scheduler
- **Category:** bug + missing feature
- **Issue:** Hand-rolled coroutine slicer with no cancellation, no per-tile timeout, no work-stealing replacement on failure. First failure orphans in-flight work.
- **Fix:** Thread `AbortSignal` through `decodeTiledViewportPooled → decodeTilesParallel → decodeTileWithWorker → onMessage/onError`. Add per-call timeout configured at pool construction.

### L1-5. Singleton pool ignores subsequent workerFactory
- **Category:** bug + missing feature
- **Issue:** `getOrCreatePool(factory)` binds first factory forever — test swaps, HMR, per-gallery factories no-op. `destroyed` flag read 4 places, written 0.
- **Fix:** Add `PyramidWorkerPool.destroy()` (sets destroyed, drains active+idle). Detect factory-identity change in `getOrCreatePool` and rebuild. Export `disposeWorkerPool()`.

### L1-6. decodeWhole hardcodes rgba8 — 16-bit whole-frame silently downsampled
- **Category:** critical bug
- **Issue:** `decodeWhole` (L22) → `createDecoder({ format: 'rgba8' })`. `LevelSource.kind='whole'` carries bitsPerSample but level-source.ts strips it via Pick.
- **Fix:** Thread `bits: 8|16` through `decodeWhole(bytes, bits)` → `format: bits===16 ? 'rgba16' : 'rgba8'`. Stop the `Pick` in level-source.ts.

### L1-7. Worker structured-clone amplification
- **Category:** perf
- **Issue:** `postMessage({bytes, region})` per tile per worker. 16 tiles × 4 workers = up to 64 copies of multi-MB JXTC container. Comment L117-121 acknowledges.
- **Fix:** Send container **once per worker** at acquire-time via `{type:'load', bytesId, bytes}`. Worker caches `bytesId → bytes`. Subsequent tile decodes send `{id, bytesId, region}` only. Worker.js protocol bump.

### L1-8. Pool fallback bypasses the pool
- **Category:** perf + missing feature
- **Issue:** When `liveWorkers.length === 0` (pool at cap), pool falls back to main-thread single `decodeRegion` (L417). Slower than queuing.
- **Fix:** Expose `pool.awaitOne()`: resolves when worker frees. Bounded wait; main-thread WASM only on timeout. Acquisition queue ≠ pixel-buffer pool (no transferable conflict).

### L1-9. Sort-key vs select-key mismatch in chooseLevelForTarget
- **Category:** bug
- **Issue:** `levelRank = w*h` but selection uses `longEdge`. With mixed aspect ratios, smallest-rank fails long-edge test → fall-through picks 'largest' rather than next-larger-by-long-edge.
- **Fix:** Sort by `longEdge` (or eliminate sort per L1-3) so `find(longEdge ≥ target)` is monotone.

### L1-10. No header memoization across pool calls
- **Category:** perf
- **Issue:** Each `decodeTiledViewportPooled` re-parses 32-byte header per ROI. Header is immutable per-level. Pan/zoom over same level → repeated parse.
- **Fix:** WeakMap<Uint8Array, JxtcHeader> cache keyed by `containerBytes` identity. Better still: thread `header` through caller (see L1-2).

### L1-11. CLAUDE.md crosscheck
- **Category:** info
- **Issue:** None of L1-1…L1-10 conflict with the rejected-claims list. Transferable + SAB constraints respected. Worker-input bytes pool is read-only — distinct from rejected pixel-buffer pool.

