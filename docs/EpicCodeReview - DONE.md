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

## Lens 1 — strategic / cross-file data flow

Scope: decode-level.ts, choose-level.ts, tiled-decode-pool.ts — the seams between them, not their internals. Pipeline spine is `chooseLevelForTarget` (pick level) → `createLevelSource` (parse header → `LevelSource`) → `decodeLevel`/`decodeTiledViewport` (in-thread decode). `tiled-decode-pool.ts` is a *second*, parallel decode path that bypasses that spine.

**L1-A (High) — Two divergent decode entry points with incompatible inputs; the pooled path re-derives what the spine already produced.**
- _Issue:_ `decodeTiledViewport` (decode-level.ts:89) consumes a pre-parsed `Extract<LevelSource,{kind:"tiled"}>` (built once by `createLevelSource` from the manifest `PyramidLevel`). `decodeTiledViewportPooled` (tiled-decode-pool.ts:372) instead takes raw `containerBytes` and re-runs `parseJxtcHeader` on **every** call (line 381). It cannot accept a `LevelSource`, so a caller using the pool must hold raw bytes separately, and `imageW/H/tileSize/bitsPerSample` get parsed twice (createLevelSource + pooled) — then again on every pan/zoom frame because the pooled fn re-parses per invocation (matches doc perf-finding L381-397).
- _Fix:_ Make the pooled path accept the same tiled `LevelSource` (it already carries `bytes` + parsed dims/bits). Drop the in-function `parseJxtcHeader`. One selection→source→decode spine, header parsed once at source creation; pooled and non-pooled paths then differ only in executor (workers vs in-thread).

**L1-B (High) — decode-level.ts "parallel" branch is illusory concurrency and strictly slower than the single-ROI call it replaces.**
- _Issue:_ `decodeTiledViewport:114-119` fans out `decodeRegion` per tile via `Promise.all`, but `decodeRegion` is a **synchronous** WASM call (`decodeTileContainerRegionRgba8/16`) wrapped in `async` — on one thread the CPU work serializes; there is no real parallelism (CLAUDE.md: "decoder.push() (WASM) is synchronous"). The non-parallel branch (line 111) does **one** whole-viewport ROI decode. The "parallel" branch therefore adds N per-tile container re-entries + N allocations + a stitch pass for **zero** concurrency gain — net slower. Compounding the confusion, it gates on `canUseParallelTileWorkers()` (line 108), a COOP/COEP/SAB *worker* capability check that is meaningless for an in-thread fan-out.
- _Fix:_ Remove the in-thread tile fan-out from `decodeTiledViewport`; always take the single-ROI path for the non-worker case. Genuine per-tile parallelism belongs only in `tiled-decode-pool.ts` (real Workers). This deletes the `parallel` option here (or routes it to the pool) and eliminates `stitchTileDecodes`' only caller in this file.

**L1-C (Medium) — `DecodedLevel` drops bit-depth at every module seam; each consumer re-derives bpp.**
- _Issue:_ `DecodedLevel = { pixels: Uint8Array, width, height }` (decode-level.ts:9-13). For 16-bit, `pixels` holds 2 bytes/channel (bpp=8) but the type carries no depth tag. The `bits→bpp` map is recomputed independently at every site — decode-level.ts:120 inline `bits===16?8:4`, tiled-decode-pool.ts:366 `bppFor` — and the returned struct discards it, so the downstream canvas/render caller cannot distinguish rgba8 from rgba16 without re-parsing the JXTC header itself. The depth that `pickRegionDecoder(bits)`/`header.bitsPerSample` knew is lost across the return boundary.
- _Fix:_ Add `bytesPerPixel: 4 | 8` (or `bits: 8 | 16`) to `DecodedLevel`; populate it in `decodeWhole`, `stitch`/`stitchTileDecodes`, and the worker-reply mapping. Makes the seam self-describing and removes the duplicated mapping in L1-D.

**L1-D (Medium) — stitch geometry, bpp mapping, and the rgba8/16 decoder default are duplicated across the two files instead of shared.**
- _Issue:_ tiled-decode-pool.ts imports only the `DecodedLevel` *type* from decode-level.js, then re-implements: `stitch` (40-60) ≡ `stitchTileDecodes` (60-83) byte-for-byte; `bppFor` (366) ≡ inline (120); the rgba8/16 `decodeRegion` default closure (390-395) ≡ `pickRegionDecoder` (47-58). Divergence risk is real — a correctness fix to one stitch (e.g. row-overflow guard) silently skips the other decode path. Cross-file linkage exists for types but not for the logic that operates on them.
- _Fix:_ Export `stitchTileDecodes`, `pickRegionDecoder`, and a single `bppFor` from decode-level.ts (or a small shared `tile-geom.ts`); import them in the pool. One source of truth for stitch + depth mapping.

**L1-E (Medium) — `chooseLevelForTarget` orders by pixel area but selects by long edge; the two keys can disagree, and the selected level feeds dims straight into decode.**
- _Issue:_ choose-level.ts:13 sorts ascending by `w*h`, then 14 picks the first with `longEdge >= target`. For any level set where area order ≠ long-edge order (non-similar aspect ratios), this returns a level violating the documented "smallest level whose long edge >= target." Pyramids are normally similar so it doesn't bite today, but the input type `readonly PyramidLevel[]` encodes no monotonicity invariant, and this is the *head* of the spine — a wrong pick silently propagates wrong `w/h`/`tileSize` into `createLevelSource`→decode (duplicates/strengthens doc logic-002).
- _Fix:_ Sort by the selection key: `.sort((a,b) => longEdge(a.w,a.h) - longEdge(b.w,b.h))`, or assert area-monotonicity at the boundary. Order key must match predicate key.

---

## Lens 2 — public API surface

Scope: exported symbols, `@casabio/jxl-wasm` bindings, and the worker message protocol of the 3 files. Exports today: decode-level.ts → `DecodedLevel`, `RegionDecoder`, `decodeTiledViewport`, `decodeLevel`; choose-level.ts → `longEdge`, `chooseLevelForTarget`, `levelRank`, `shouldUpgrade`; tiled-decode-pool.ts → `TileRegionDecoder`, `decodeTiledViewportPooled` (the `PyramidWorkerPool` class + singleton are unexported).

**L2-A (High) — The worker pool has no public lifecycle API: not exported, not disposable, not pre-warmable, not configurable.**
- _Issue:_ `PyramidWorkerPool` is module-internal; the only public door is `decodeTiledViewportPooled`, which lazily builds a process-wide singleton in `getOrCreatePool` (304-321). Surface gaps: (1) no exported prewarm — warming happens on first `acquire`, i.e. on the user's first interactive frame (doc low L306-321); (2) no `dispose` — `destroyed` is never set (doc multiple), so workers leak for the process lifetime across tests/HMR/route changes; (3) tunables `maxSize/idleTimeoutMs/minIdle` are hardcoded at 310-316 with no override.
- _Fix:_ Export `prewarmPyramidPool(factory, opts?)` and `disposePyramidPool()` (set `destroyed`, terminate all, null the singleton). Optional `configurePyramidPool(opts)` for the three tunables. Lifecycle becomes a first-class, testable part of the package API.

**L2-B (High) — `workerFactory` is presented as a per-call option but binds permanently to the first caller.**
- _Issue:_ `decodeTiledViewportPooled` options expose `workerFactory?: () => WorkerLike` (378), implying per-call control. `getOrCreatePool` (306) ignores the argument once a pool exists, so a second caller with a different worker URL/`type` is silently dropped (doc high L304-321). The public type promises behavior the implementation does not honor.
- _Fix:_ Move factory to a one-time `prewarmPyramidPool(factory)` init (pairs with L2-A) and remove it from per-call options; or key the singleton by factory identity. Do not expose a parameter that is ignored.

**L2-C (Medium) — Three overlapping public "decode a viewport" functions with divergent first-arg types and no façade.**
- _Issue:_ `decodeLevel(source, region?)`, `decodeTiledViewport(tiled source, region)`, and `decodeTiledViewportPooled(containerBytes, region)` all decode a viewport but take `LevelSource` | tiled `LevelSource` | `Uint8Array` respectively, with two structurally-identical option types. The caller must know the matrix; nothing marks one as the entry point (links L1-A).
- _Fix:_ Single public `decodeLevel(source, region?, opts)` where `opts` optionally carries a pool handle to select the worker path; demote `decodeTiledViewport`/`...Pooled` to internal. One documented entry, one option type.

**L2-D (Low) — `RegionDecoder` and `TileRegionDecoder` are byte-identical exported types from two modules.**
- _Issue:_ decode-level.ts:15 and tiled-decode-pool.ts:28 declare the same `(bytes, region) => Promise<DecodedLevel>` shape under two public names. A caller injecting a custom decoder satisfies two symbols; they can drift if one later gains a parameter.
- _Fix:_ Export one `RegionDecoder` from decode-level.ts; the pool imports and reuses it (folds into L1-D's shared module).

**L2-E (Medium) — The worker message protocol — the real cross-process API — is local, untyped at receipt, unversioned, and not exported.**
- _Issue:_ Outbound `{ id, bytes, region }` (postMessage, 122) and inbound `WorkerReply` (62-64) are file-local types; the actual worker (web/lightbox/tiled-decode-worker.js) is plain JS sharing no definition. `onMessage` (76-93) reads `ev.data.{id,ok,pixels,width,height}` behind a TS cast with no runtime check, then feeds `width/height` straight into `stitch` (doc med L76-92). No protocol version field.
- _Fix:_ Export `PyramidTileRequest` / `PyramidTileReply` from the package so worker and host share one contract; add a minimal runtime guard at receipt (`ok` boolean, finite numeric `width/height`, `pixels instanceof ArrayBuffer`) before trusting dims downstream.

**L2-F (Low) — `WorkerLike.postMessage` type omits the transferable list, so the transfer convention the protocol depends on is comment-only and inexpressible by a conformant host.**
- _Issue:_ `WorkerLike.postMessage(data: {...})` (19) has no `transfer?: Transferable[]` parameter. The outbound container `bytes` is structured-cloned per tile (117-122 self-acknowledges); the return-path transfer is hand-coded in the worker JS. A caller implementing the public `WorkerLike` type has no typed slot to express transfers (doc med L117-123).
- _Fix:_ Add `transfer?: Transferable[]` to the `postMessage` signature in `WorkerLike`; document transfer direction in the exported protocol types from L2-E.

**L2-G (High) — WASM binding mismatch: `decodeWhole` hardcodes `format:"rgba8"`, so 16-bit whole-frame levels silently decode at 8-bit through the public `decodeLevel`.**
- _Issue:_ `createDecoder({ format: "rgba8" })` (decode-level.ts:22) ignores bit depth; `decodeLevel` whole branch (130-134) calls `decodeWhole(source.bytes)` with no `bits`. The tiled path threads `bits → decodeTileContainerRegionRgba16`, but the whole path is depth-locked at the WASM binding (doc high L5-28). Public `decodeLevel` therefore downconverts 16-bit whole levels with no signal.
- _Fix:_ Thread `bits` into `decodeWhole`; `format: bits === 16 ? "rgba16" : "rgba8"`. Depends on the `LevelSource` "whole" variant carrying `bitsPerSample` (level-source.ts — out of these 3 files; note as a cross-file prerequisite).

---

## Lens 3 — pipeline stages

Stage map for the 3 files (read path): **decode** ✓ three impls (`decodeWhole`, `decodeRegion`/`decodeTileContainerRegionRgba{8,16}`, `decodeTileWithWorker`); **transform** ✗ absent (no color/ICC/normalize); **resize/fit** ✗ absent (level-pick is the only resolution control); **encode** — N/A (these files are decode-only); **cache** ✗ none (no decoded-tile or decoded-level memo); **return** ✓ `DecodedLevel`. The gaps below are missing/under-built stages, not line bugs.

**L3-A (Medium) — Missing fit stage: the chosen level is almost always larger than target, but the scale factor is dropped at return, forcing every consumer to recompute it.**
- _Issue:_ `chooseLevelForTarget` returns the *smallest level whose longEdge ≥ target* — in a power-of-two ladder that is up to ~2× the requested long edge per axis (~4× pixels). Nothing between decode and return fits the pixels to target, and `DecodedLevel` (decode-level.ts:9-13) carries only `width/height`, not the `target/longEdge` ratio. A 200px grid cell pulling a 384px level decodes+stitches ~3.7× the displayed pixels; the consumer must re-derive the downscale factor from level dims it has to look up again (compounds L1-C).
- _Fix:_ Carry `scale` (or the chosen `targetLongEdge`) on the decode result so the GPU/canvas consumer scales precisely without recomputation. Per CLAUDE.md layer discipline the actual downscale stays in the WebGL/canvas layer — this fix only stops the pipeline from *discarding* the scale it already knew.

**L3-C (High) — Missing cache stage: every pan/zoom re-runs decode + stitch from scratch; adjacent frames share most tiles but nothing is memoized.**
- _Issue:_ Trace one pan frame: `chooseLevelForTarget` (re-sort) → `tilesOverlappingRegion` (rebuild grid) → `decodeTilesParallel` (re-decode **every** overlapping tile through WASM) → `stitch` (full alloc) → return. Successive frames overlap heavily in tile set, yet there is no decoded-tile cache anywhere in these files — identical WASM tile decodes are repeated for tiles that never left the viewport. This is the dominant wasted work of the read pipeline (the per-call re-sort in doc info-L8-16 and grid-rebuild in doc med-L60-96 are the cheap symptoms; the expensive one is re-decode).
- _Fix:_ In-memory LRU of decoded tiles keyed by `(container identity, tileIndex, bits)`, byte-budget-capped. On viewport change, decode only newly-revealed tiles and stitch cache-hits + new. NOTE — this is an ephemeral *decode memo*, not the OPFS `jxl-cache` (which CLAUDE.md keeps content-agnostic/persistent); it lives in the decode pipeline, keyed by tile index, dropped on container change. Frame it that way to avoid the "dedupe-aware caching" rejection (G2-1).

**L3-D (Medium) — Assembly stage allocates a fresh full-viewport buffer every frame; constant-size pans churn multi-MB buffers through GC.**
- _Issue:_ `stitch`/`stitchTileDecodes` do `new Uint8Array(viewport.w*viewport.h*bpp)` per call (tiled-decode-pool.ts:41, decode-level.ts:65). During a continuous pan the viewport dimensions are constant — only tile contents shift — so each frame allocates and discards an identically-sized buffer. No scratch reuse.
- _Fix:_ Reuse a per-pool scratch destination (ping-pong pair) when the requested viewport size equals the last. CAVEAT — this is distinct from the rejected "pixel buffer pool for output" (R1-2/DH-2): that rejection is about ArrayBuffers **transferred** via postMessage (which detach and have no safe release). This stitch buffer is the **in-thread return value**, never transferred — so reuse is viable, but only if the consumer uploads/copies synchronously before the next frame. Gate on that lifetime contract or skip; flag as opportunity, not a defect.

**L3-E (Low/Info) — Transform stage is silently absent: ICC/colorspace stripped at decode, return carries no signal that pixels are raw/unmanaged.**
- _Issue:_ `decodeWhole` sets `preserveIcc:false, preserveMetadata:false` (decode-level.ts:25-26); the region decoders return raw rgba. There is no color-management/transform stage and no flag on `DecodedLevel` indicating pixels are unmanaged in the container's native primaries. Fine for thumbnails; potentially wrong for the photogrammetry/digital-twin consumers noted in project memory, and undocumented either way.
- _Fix:_ Document that decode emits unmanaged rgba (ICC stripped) by contract; if color-managed display is ever needed, add it as an explicit downstream transform stage with `preserveIcc` threaded through — out of scope for these files. Info-level until a consumer needs fidelity.

---

## Lens 4 — state machinery

State inventory: **session** — `decodeWhole`'s decoder lifecycle (push→close→drain→dispose) + per-call `settled` in `decodeTileWithWorker`; **queue** — none (acquire has no waiter queue; `decodeTilesParallel` uses a shared `next` cursor); **cancellation** — none (no AbortSignal; batch-local `failed` is the only stop); **error** — handle `bad`, batch `failed`/`firstErr`, call `settled`, pool `destroyed`. choose-level.ts holds no state. The theme: liveness/stop state is spread across disjoint flags and **two owners** (the batch coro vs the pool) that never reconcile.

**L4-A (High) — Worker liveness is modeled by 3 booleans + membership in 3 collections, with no single state field; the batch coro and the pool hold divergent views of "alive."**
- _Issue:_ A handle's real state is scattered across `terminated`, `bad`, and which of `all`/`idle`/`active` it sits in — invalid combos are representable (e.g. `bad && !terminated` is a real transient in `recycle`). Worse, `decodeTilesParallel` coros capture the raw `WorkerLike` (338), not the handle, so when `recycle`→`destroyHandle` terminates a worker mid-batch the coro has no flag to read and calls `decodeTileWithWorker` on a dead worker → indefinite hang (doc concurrency L338-357). Two owners of "is this worker alive," no shared truth.
- _Fix:_ Single `state: "idle" | "active" | "dead"` on the handle (fold in `terminated`/`bad`); coros hold the **handle** and check `state === "dead"` before each dispatch. One authoritative liveness field both owners read.

**L4-B (High) — No cancellation state anywhere; `failed` stops only *future* iterations and cannot preempt an in-flight tile, so superseded pan/zoom decodes run to completion and starve the pool.**
- _Issue:_ `decodeTiledViewportPooled` takes no `AbortSignal` (375-379); `decodeTilesParallel`'s `failed` (335) halts the next loop turn but the awaited `decodeTileWithWorker` runs to completion (WASM synchronous). There is a "failed" state but no "cancelled" state. A user panning past a frame cannot cancel its decode; workers stay `active`, `acquire` returns fewer/none, caller silently degrades to single-WASM (doc high L372-426).
- _Fix:_ Thread `AbortSignal` decodeTiledViewportPooled → decodeTilesParallel → decodeTileWithWorker. On abort: stop dispatch, reject pending with a distinct `AbortError`, release workers immediately. Model "cancelled" as a first-class terminal state separate from "failed."

**L4-D (Medium) — Request-id state (`nextWorkerId`) is module-global, never reset, and reply-routing depends entirely on its uniqueness while every per-call listener on a shared worker sees every reply.**
- _Issue:_ `let nextWorkerId = 0` (66) is module-scoped; `decodeTileWithWorker` adds a fresh `onMessage` per call (110) that filters by `id`. Correct routing rests solely on `++nextWorkerId` never colliding. HMR / double module load resets the counter to 0 while the previous module's workers still carry live ids → collision → a reply resolves the **wrong** tile promise → wrong pixels stitched (doc med L66-73, low L66-124). The id namespace is global+mutable+unscoped.
- _Fix:_ Scope the counter to the pool instance (reset on dispose), or — better — keep a per-handle `Map<id, {resolve,reject}>` with **one** persistent message listener per worker that dispatches by map lookup. Removes both the collision risk and the per-tile add/removeEventListener churn.

**L4-E (High) — Four disjoint "stop" flags (`settled`, `failed`, `bad`, `destroyed`) with no propagation across the session↔pool boundary; an error in one layer doesn't transition the others.**
- _Issue:_ `decodeTileWithWorker` rejects on `ok:false` (91) but never marks the handle `bad`, so the pool returns the faulty worker to `idle` and re-hands it out (doc med L234-302). Inversely, `recycle` sets `bad` + terminates, but the coro awaiting that worker's reply never receives a message and hangs (no rejection path; L4-A). The error states are siloed — call-level failure ≠ handle-level health ≠ batch abort.
- _Fix:_ One error-propagation path: `decodeTileWithWorker` reports failure to the pool (handle ref/callback) so the handle goes `dead`; `recycle` rejects the handle's tracked outstanding request (from the L4-D map) so the awaiting coro settles. Session error state and pool health state become one signal.

**L4-F (High) — decodeWhole's decoder session has no guaranteed terminal transition: dispose is a plain sequential await, not a finally, so a mid-lifecycle throw strands WASM session state.**
- _Issue:_ Lines 39-42 run `push → close → drain → dispose` as bare sequential awaits. If `push` rejects (malformed input) or the drain IIFE's `error` branch (35) throws, control unwinds before `dispose()` — the decoder's WASM heap/session is never released, and the in-flight `drain` promise can reject unhandled (doc high L20-45, L29-41). The session state machine has no enforced terminal state.
- _Fix:_ Wrap the lifecycle in try/finally with `dispose()` in `finally`; capture the drain promise and settle/await it on both success and error paths so a push-first throw can't orphan it. Invariant: every created decoder reaches `dispose`.

**L4-G (Info) — The only level-transition logic (`shouldUpgrade`) is pure and stateless, so there is nowhere to hold hysteresis — level thrash during zoom jitter cannot be damped here.**
- _Issue:_ `shouldUpgrade(current, candidate)` (choose-level.ts:23) is a pure monotonic compare; the "current level" state lives entirely in the caller. With no held state there is no anti-flap guard — small zoom oscillations around a level boundary can ping-pong level selection (and, combined with L3-C's absent cache, re-decode each flip).
- _Fix:_ If thrash is observed, add a small hysteresis margin (e.g. require candidate to exceed current by a ratio, or a debounce) — but that needs caller-held state or a stateful selector, and benchmark evidence per CLAUDE.md before adding a tunable. Info until measured.

---

## Lens 5 — hot kernels

Kernel inventory across the 3 files: the **only** per-pixel/byte kernel is the stitch row-copy (`stitchTileDecodes` decode-level.ts:67-81 ≡ `stitch` tiled-decode-pool.ts:43-58); the **chunk loop** is per-tile dispatch (`tiles.map` decode-level.ts:114, `decodeTilesParallel` coros tiled-decode-pool.ts:338-357); **copy loop** is inside stitch; **colour transform** and **resampling** kernels are *absent* (rgba passed through; pyramid pre-resamples at ingest). The stitch copy is already well-shaped (fast-path single `set` + strided fallback) — findings are micro-tightening, a missing bounds guard, and the real hot cost living in the chunk loop, not the pixel loop.

**L5-A (Low) — Strided stitch fallback recomputes source/dest row offsets with a per-row multiply; strength-reduce to additive strides.**
- _Issue:_ Inner loop computes `srcOff = row*srcStride` and `dstOff = ((dy+row)*viewport.w + dx)*bpp` every iteration (decode-level.ts:76-77, tiled-decode-pool.ts:52-54) — two multiplies per row. For a 512-row tile that is 1024 multiplies per tile per frame in the hot path. (The per-row `subarray()` view alloc flagged in doc med-L75-80 is *not* separately fixable — it is the minimal correct cross-buffer range copy; confirm and close.)
- _Fix:_ Hoist and accumulate: `let s = 0, d = (dy*viewport.w + dx)*bpp;` then per row `pixels.set(decoded.pixels.subarray(s, s+srcStride), d); s += srcStride; d += dstStride;`. Pure strength reduction, identical output, zero risk. Apply to both copies (folds into L1-D's shared stitch).

**L5-B (Medium) — The stitch copy loop has no per-part bounds guard before writing; it trusts that every part fits the viewport, which depends entirely on out-of-scope clamping in `tilesOverlappingRegion`.**
- _Issue:_ The kernel writes at `dstOff = (region.x-viewport.x ...)` with no check that `0 ≤ dx`, `dx+decoded.width ≤ viewport.w`, `dy+decoded.height ≤ viewport.h`. If `tilesOverlappingRegion` (tiling.ts — not among these 3 files) ever returns full tile-grid cells instead of viewport-clamped intersections, `dx`/`dy` go negative or overrun and the loop writes out of bounds (`RangeError`) or silently into wrong rows. Pairs with the unchecked `w*h*bpp` alloc (doc high L60-83) and the missing-assertion point (doc med L0-0).
- _Fix:_ One cheap assert per part (not per row) before the loop: verify the part rect lies within `[0,viewport.w]×[0,viewport.h]`. Cost is O(parts), negligible vs the copy; turns a possible memory-corruption into a clear contract failure at the kernel boundary. (Confirm clamping semantics in tiling.ts as the real prerequisite.)

**L5-C (High) — The parallel chunk loop's dominant hot cost is N× structured-clone of the whole container, not the pixel copy — O(N · containerBytes) per frame.**
- _Issue:_ `decodeTilesParallel` dispatches one `postMessage({ id, bytes, region })` per tile (tiled-decode-pool.ts:122) with no transfer list, so the **entire** JXTC container is structured-cloned once per tile (self-acknowledged 117-122; doc med L117-123). A 5 MB container over 12 tiles = ~60 MB copied per frame before any decoding — this swamps the stitch copy by orders of magnitude and is the true kernel bottleneck of the worker path.
- _Fix:_ Clone the container **once**: put it in a `SharedArrayBuffer` (precondition already asserted by `canUseParallelTileWorkers`, currently unexploited) and pass tiles only `{id, region}`; or transfer once to a long-lived worker that retains it across tiles. Either turns O(N·container) into O(container) per container, not per tile.

**L5-D (Info / guardrail) — No colour-transform or resampling kernel exists here, by design; keep it that way.**
- _Issue:_ These files pass decoded rgba straight through — resampling happened at ingest (the pyramid ladder), colour is unmanaged (L3-E). The fit-to-target gap (L3-A) is the one place someone might be tempted to add a runtime downscale.
- _Fix / guardrail:_ Any fit-to-target must be **GPU bilinear** in the WebGL/canvas layer, never a JS per-pixel resample loop in these files. Pre-reject a CPU downscale kernel here on sight (same spirit as CLAUDE.md's rejected-claims log). No action needed unless such a kernel is proposed.

---

## Lens 6 — boundary points

Boundaries in scope: **JS↔WASM** — `createDecoder` + `decodeTileContainerRegionRgba{8,16}` via the `@casabio/jxl-wasm` facade; **worker↔main** — `decodeTileWithWorker` postMessage/reply; **memory copy points** — decodeWhole's `ev.pixels` wrap (decode-level.ts:32), the per-tile container clone (tiled-decode-pool.ts:122), the result transfer+wrap (84-89), and the stitch assembly copy. **Rust↔C/C++** is *not* present here (see L6-D).

**L6-A (High — verify) — JS↔WASM return aliasing: decode results may be Uint8Array *views into the WASM heap*; returning them and then calling `dispose()` (or letting the next grow-only realloc fire) is a use-after-free.**
- _Issue:_ `decodeWhole` captures `result.pixels` during drain (33) via the **zero-copy** branch `ev.pixels instanceof Uint8Array ? ev.pixels : …`, then calls `await decoder.dispose()` (42) before returning (44). CLAUDE.md states the facade does "zero-copy writes" over "grow-only realloc buffers" — which strongly implies emitted pixels can be **heap-backed views**. If so, `dispose()` frees/reuses the heap and the returned buffer dangles. Corollary on the region path: if `decodeTileContainerRegionRgba8/16` returns a view into a *shared* scratch heap, then decode-level.ts's `Promise.all` fan-out (114-119) makes **all N parts alias the same buffer** → every part shows the last-decoded tile, and stitch copies garbage (a second, independent reason L1-B's fan-out is unsafe).
- _Fix:_ Verify the facade ownership contract. If pixels are heap views: copy at the boundary (`.slice()`) before `dispose()` and before returning across any `await`. If they are owned/detached copies: document it at each call site so nobody adds a redundant copy. This is the highest-risk boundary question in the file; resolve it before the L3-D buffer-reuse opportunity is even considered.

**L6-B (Medium) — Worker boundary applies the cheap technique to the small payload and the expensive one to the large payload.**
- _Issue:_ Outbound, the full container `bytes` is **structured-cloned** per tile (122, no transfer list) — the large payload copied N× (L5-C). Inbound, the result pixels are **transferred** (worker side `postMessage(…, [buffer])`) then wrapped zero-copy via `new Uint8Array(ab)` (84-89) — the small payload moved cheaply. The boundary techniques are backwards relative to payload size.
- _Fix:_ Flip the large side to zero-copy: container in a `SharedArrayBuffer` (precondition already asserted by `canUseParallelTileWorkers`, unused) or transferred once to a retained worker. Folds into L5-C; called out here as a boundary-technique mismatch.

**L6-C (Medium) — Worker reply crosses the boundary with no size contract: `new Uint8Array(ab)` is trusted without checking `ab.byteLength === width*height*bpp`.**
- _Issue:_ `onMessage` resolves `{ pixels: new Uint8Array(ab), width: ev.data.width, height: ev.data.height }` (84-89) using the worker-supplied `width/height` and the transferred buffer with no cross-check. A buggy/compromised/version-skewed worker (e.g. an 8-bit worker replying for a 16-bit request — exactly doc critical L366-425) yields a buffer whose length disagrees with `width*height*bpp`; stitch then reads/writes past the buffer or stitches misaligned rows (doc med L62-90, L76-92).
- _Fix:_ At receipt, assert `ab.byteLength === width * height * bppFor(bits)` before resolving; reject as a boundary-contract violation otherwise. Cheap, once per tile, and catches the 16-bit corruption class at the seam instead of downstream.

**L6-D (Info) — Rust↔C/C++ boundary is out of blast radius for these 3 files.**
- _Issue:_ decode-level/choose-level/tiled-decode-pool are TypeScript that call the **already-wrapped** WASM exports of `@casabio/jxl-wasm`. The RAW pipeline (`src/lib.rs`) and the libjxl bridge (`bridge.cpp`, incl. the forward-declaration blocker noted in CLAUDE.md) are never reached here. The only native crossing in scope is JS↔WASM through the facade.
- _Fix:_ None. Stated to close the lens dimension — native-bridge correctness belongs to a jxl-wasm/bridge.cpp review, not this one.

**L6-E (Low) — JS↔WASM crossing count: the in-thread fan-out crosses the boundary once per tile (each re-entering container parse), vs one crossing for the single-ROI decode.**
- _Issue:_ decode-level.ts's parallel branch calls `decodeRegion` per tile (114-119) — N boundary crossings, each marshalling `bytes` in and pixels out and re-parsing the container header inside WASM — where the non-parallel branch (111) crosses **once** for the whole viewport. On a single thread this is pure overhead (the WASM is synchronous; L1-B) plus the aliasing hazard of L6-A.
- _Fix:_ Subsumed by L1-B — drop the in-thread fan-out so the non-worker path crosses the WASM boundary exactly once. Minimize crossings: one ROI decode beats N tile decodes whenever they share a thread.

---

## Lens 7 — stop doing work

The read path redoes, every frame, work whose inputs did not change. Ranked by wasted-cost: per-frame container re-decode (no tile reuse) > per-frame full-container clone (L5-C) > per-frame header parse + tile-grid rebuild > per-call level re-sort. The unifying fix is *memoize-by-identity* + *delta* + *early-reject*; the unifying hazard is reaching for content hashes on hot buffers (L7-E).

**L7-A (Medium/High) — Early-reject: identical `(container, level, viewport)` re-paints redo a full decode+stitch instead of returning the last result.**
- _Issue:_ `decodeTiledViewportPooled` / `decodeLevel` have no top-of-function identity guard. Re-paints with unchanged inputs are common — grid re-layout calls `paintCell` (doc note, grid-controller.js:105), a resize/redraw, a zoom that lands on the same level and region — and each re-runs parse → tile-grid → decode → stitch from scratch.
- _Fix:_ Cache the last `{containerRef, level, viewport, result}` and return `result` immediately when all four match (viewport compared by value). One comparison guards the entire pipeline. Cheapest possible win; strictly additive.

**L7-B (High) — Delta-decode: every frame re-decodes *all* visible tiles though a pan changes only the few that entered the viewport.**
- _Issue:_ `decodeTilesParallel` decodes the full overlapping-tile set each call (tiled-decode-pool.ts:333-357); adjacent pan frames overlap by ~90% of tiles, all re-decoded through WASM. Nothing reuses last frame's decoded tiles, and the stitched output is rebuilt from zero (L3-C, L3-D).
- _Fix:_ Keep an in-memory decoded-tile LRU keyed by `(containerRef, tileIndex, bits)` (ephemeral decode-memo, *not* OPFS — dodges G2-1). Each frame: decode only newly-revealed tiles, stitch cache-hits + new. Further: when only the offset changed, **scroll-blit** the prior stitched buffer (`copyWithin` the overlapping rect) and fill only the exposed margin — turns a full re-stitch into an edge update.

**L7-C (High) — Memoize per-container immutable derivations by reference identity; today they recompute every frame.**
- _Issue:_ `parseJxtcHeader` runs on **every** `decodeTiledViewportPooled` call (381) though the header is immutable per container (doc high L381-397); `tilesOverlappingRegion` rebuilds the whole tile grid every call (doc med L60-96). Both depend only on the container (+ viewport for the grid), not on anything that changes between repaints of the same image.
- _Fix:_ `const headerCache = new WeakMap<Uint8Array, JxtcHeader>()` — parse once per container. Cache the tile-grid base (tile rects for the full image) per container and intersect with the viewport per frame instead of regenerating. Or, cleaner, adopt L1-A: pass a pre-parsed `LevelSource` so the header is parsed once at source creation and never re-derived here.

**L7-D (Medium) — `chooseLevelForTarget` re-sorts and re-allocates the level array on every wheel/zoom event, though the manifest is already sorted at ingest.**
- _Issue:_ choose-level.ts:13 does `[...levels].sort(...)` per call; `buildManifest` already sorts ascending by area (doc info L8-16, ingest manifest.ts:75). Two wasted operations — a copy and an O(n log n) sort — on the hottest interactive path, producing GC pressure (doc high L8-16).
- _Fix:_ Trust the ingest order: drop the sort, assert ascending once (dev build), iterate directly. If the input order can't be trusted, `WeakMap<readonly PyramidLevel[], sorted>` memo by array identity. Either eliminates per-event sort+alloc. (Aligns the order key with the predicate per L1-E.)

**L7-E (Info / caution) — Use *reference identity* (WeakMap), not content hashes, as the memo key on the hot path.**
- _Issue:_ The natural temptation for L7-B/L7-C keys is "hash the container." Hashing a multi-MB JXTC buffer per frame costs more than the decode work it would save — net-negative, and it touches every byte (the opposite of "stop doing work").
- _Fix:_ Key all hot-path memos on the `Uint8Array`/container **object identity** via `WeakMap` — O(1), no byte scan, auto-evicts with the buffer. Reserve real hashing for cross-session persistence (the jxl-cache layer), never for per-frame memoization.

---

## Lens 8 — do less precise work first

The pyramid is *itself* the coarse→fine primitive, and `shouldUpgrade`/`levelRank` (choose-level.ts:19-25) are an upgrade policy — yet the decode entry points are single-shot: pick the target level, decode it fully, return. The coarse-first machinery exists but is not orchestrated, and within a level the progressive-decode capability is explicitly switched off.

**L8-B (High) — Coarse-level-first is not orchestrated: `chooseLevelForTarget` jumps straight to the target level; the `shouldUpgrade` primitive that exists for staged refinement is unused by the decode flow.**
- _Issue:_ A caller doing `chooseLevelForTarget → decodeLevel` gets exactly one (the largest-needed) level, decoded fully before anything paints. The pyramid was built to show a tiny level instantly then refine, and `shouldUpgrade(current, candidate)` is the gate for that swap — but nothing here yields a coarse level first. The cheap-then-expensive ladder is left entirely to the caller, with no primitive to make it the default.
- _Fix:_ Offer a staged decode that yields the smallest already-cached/cheapest level immediately (often a few KB), then decodes the target and emits an upgrade gated by `shouldUpgrade`. Pairs with L7-B's tile cache (coarse level is frequently a single whole-frame, already decodable in one cheap call).

**L8-A (Medium) — `decodeWhole` opts out of JXL progressive decode: it requests only the final frame and ignores intermediate passes, so a large whole-level paints blank→full with no DC/low-res preview.**
- _Issue:_ `createDecoder({ progressionTarget: "final", emitEveryPass: false })` (decode-level.ts:23-24) and the events loop handling only `"final"`/`"error"` (30-37) together discard libjxl's progressive passes. JXL can emit a low-res DC image first then refine; this path waits for full quality and emits nothing earlier — counter to the active jxl-progressive work noted in project memory. (Caveat: "whole" levels are usually the *small* pyramid tiers, so the win is bounded; it matters for any large non-tiled level and forecloses the option everywhere.)
- _Fix:_ When the consumer wants progressive, set `emitEveryPass: true` and handle intermediate pass events → emit a coarse `DecodedLevel` first, replace with `"final"`. Gate behind an option so one-shot callers are unaffected.

**L8-C (Medium) — Tiles decode in flat row-major order; the viewport center (what the user looks at) is not prioritized.**
- _Issue:_ `decodeTilesParallel` hands tiles to workers by `idx = next++` (tiled-decode-pool.ts:341-343) — i.e. top-left→bottom-right tile-index order. The center of the viewport, where attention is, fills no sooner than the corners; on a partial paint the most-looked-at region can be the last to resolve.
- _Fix:_ Sort the `tiles` array by distance from viewport center (or last cursor) before dispatch — a cheap O(n log n) on a small array. Center tiles resolve first; combined with L7-B (only-new tiles) the perceived latency drops without more decode work.

**L8-D (Medium) — No precision-by-motion: every frame attempts the full target decode even while the user is actively panning, when a coarse level would suffice until motion settles.**
- _Issue:_ The decode flow has no notion of "in motion vs at rest." During a fast pan, decoding the full target level each frame is wasted precision — the frame is gone before the eye resolves it — yet that is what `decodeLevel`-per-frame does. The cheap path (coarse level) and the expensive path (target) are treated identically.
- _Fix:_ Escalate precision on settle: serve a coarse level during active motion (cheap, possibly cached), decode the target only when panning stops (debounce). Needs caller-held motion state (relates to L4-G hysteresis); the decode API should expose a clean "coarse now / fine on settle" entry so the caller isn't forced to overshoot every frame.

---

## Lens 9 — change the representation

The pyramid already embodies one representation win (full resolution → multi-level), but the *byte transport* and the *level-selection structure* still use the naive shapes: the whole container is re-serialized per tile, levels are re-sorted from scratch on every query, and 16-bit pixels travel as an untyped `Uint8Array` whose stride is re-derived by magic at two sites. Each is a representation mismatch with a cheaper canonical form.

**L9-A (High) — The full container is structure-cloned to every worker, once per tile; the representation should be one shared/owned binary, not N copies.**
- _Issue:_ `decodeTileWithWorker` does `postMessage({ id, bytes, region })` with no transfer list (tiled-decode-pool.ts), so the entire JXTC container is structured-cloned into each worker for *every* tile. For a viewport spanning T tiles that is T× full-container copies across the boundary — the dominant cost grows with tile count even though the bytes are identical and read-only. (Ties L6-A boundary copy / L5 clone.)
- _Fix:_ Change the representation of the shipped bytes. When `canUseParallelTileWorkers()` is true, COOP/COEP is present, so place the container in a `SharedArrayBuffer` **once** and pass a read-only view to all workers — zero per-tile clone. Where SAB is unavailable, slice the compressed byte-range per tile (see L9-C) and `postMessage(slice, [slice.buffer])` to transfer, so each worker receives only its tile's bytes, transferred not cloned. Either way clone volume drops from `T × full` to ≈ `1 × full`.

**L9-B (Medium) — `chooseLevelForTarget` re-spreads and re-sorts the (static) level set on every call, then linear-scans; the representation should be a precomputed sorted index with binary search.**
- _Issue:_ `const sorted = [...levels].sort((a,b) => a.w*a.h - b.w*b.h)` allocates a fresh array and pays O(n log n) on each query for a level set that never changes during a session, then `find` does a linear scan (choose-level.ts:13-14). It also sorts by **area** but selects by **long edge**, so the scan is only correct when area order and long-edge order coincide.
- _Fix:_ Build the sorted view once — sort by the *actual selection key* (`longEdge`) into a stored array (or require manifest levels pre-sorted) — then binary-search the first level whose long edge ≥ target. Linear scan → index; removes the per-call allocation and resolves the area/long-edge key mismatch in one move.

**L9-C (Medium) — Parsing the JXTC header yields no reusable binary tile index; building an offset/length table once turns "find a tile's bytes" from a re-parse into an array lookup.**
- _Issue:_ `decodeTiledViewportPooled` calls `parseJxtcHeader(containerBytes)` on every invocation and keeps nothing; tile byte locations are re-derived each time and the whole container is the only addressable unit (forcing L9-A's full-container ship). There is no representation that maps tile (col,row) → (byteOffset, byteLength).
- _Fix:_ Parse once into a compact binary index — e.g. parallel `Uint32Array` offset[] and length[] (SoA) keyed by tile index — cached by container identity (`WeakMap<Uint8Array, TileIndex>`). `tilesOverlappingRegion` then indexes directly into byte ranges, enabling per-tile slicing (L9-A) and avoiding repeat header parsing (ties L7/L3 memoization).

**L9-D (Low) — 16-bit levels are carried as an untyped `Uint8Array`, so pixel stride is re-derived via `bits === 16 ? 8 : 4` at two separate sites; the representation should name its own element size.**
- _Issue:_ `DecodedLevel { pixels: Uint8Array; width; height }` has no channel/bit-depth field, so byte-stride knowledge lives outside the data: `stitchTileDecodes` takes a separate `bytesPerPixel` argument and both callers recompute `bpp = bits === 16 ? 8 : 4` independently (decode-level.ts and tiled-decode-pool.ts). Two parallel sources of truth that can drift; a 16-bit consumer must also reinterpret raw bytes itself.
- _Fix:_ Make the struct self-describing — add `bytesPerPixel` (or `bitDepth`/`channels`) to `DecodedLevel` so stride is read from the value, not re-derived. Optionally expose a typed accessor (`Uint16Array` view) for 16-bit. Removes the duplicated magic and the implicit reinterpret at the consumer.

---

## Lens 10 — move work to where it is cheapest

A worker pool exists, but it is reached only by the multi-tile parallel path; the two most common decodes (whole level, single-tile region) still run WASM on the **calling thread**, and the post-decode stitch copy and the level sort also run wherever the caller happens to be — usually the main thread. The cheap locations (workers, shared memory, build/ingest time) are available but under-used.

**L10-A (High) — Whole-level and non-parallel region decodes run WASM on the caller's thread; if that is the main thread, the full decode blocks the UI even though an idle worker pool exists.**
- _Issue:_ `decodeWhole` (decode-level.ts:20-45) creates a decoder and drains it inline, and the non-parallel branch of `decodeTiledViewport` does `decodeRegion(source.bytes, viewport)` directly (110-112). Neither touches the pool — only the `tiles.length > 1` parallel path does. So a whole-frame decode (the *common* case for coarse levels and any single-tile viewport) executes synchronous WASM on whatever thread called it. On the main thread that is a frame-blocking stall for the whole decode duration.
- _Fix:_ Route all decode through the pool — give `decodeWhole` and the single-tile path a worker hop too (decode on a pooled worker, transfer pixels back). Main thread → worker. The `tiles.length > 1` gate should decide *fan-out width*, not *whether a worker is used at all*.

**L10-B (Medium) — The full-viewport stitch copy runs on the orchestrating thread after `Promise.all`; the blit can move into the workers, writing into shared output memory.**
- _Issue:_ `stitchTileDecodes` (decode-level.ts:60-83) and `decodeTilesParallel`→`stitch` (tiled-decode-pool.ts) copy every tile's pixels into the assembled viewport buffer on the calling thread — MBs of memcpy on (likely) the main thread, serialized after all tiles return. The workers sit idle during the copy.
- _Fix:_ With COOP/COEP present (the parallel precondition), allocate the viewport output as a `SharedArrayBuffer` and have each worker blit its tile directly into its destination sub-rect (it already knows its region). No central stitch, no main-thread copy. Main thread → worker; also removes one full pixel copy (ties L9-A).

**L10-C (Medium) — `chooseLevelForTarget` sorts the level set at query time on every call; that order is fixed and computable at manifest build/load.**
- _Issue:_ The `[...levels].sort(...)` (choose-level.ts:13) is a runtime calculation repeated for a result that never changes within a session — pure work in the wrong place. It executes on whatever thread asks for a level, typically during interaction.
- _Fix:_ Precompute the sorted level order once — at manifest build time (ship pre-sorted in the manifest) or at load time (sort once on ingest, store) — so the hot path does only a lookup/binary-search. Runtime calculation → precomputation; per request → build time (ties L9-B's index representation).

**L10-D (Low) — Pool prewarm is paid on the first decode rather than ahead of need; worker spawn + WASM init lands on the critical path of the first viewport.**
- _Issue:_ `PyramidWorkerPool` supports `prewarm`/`minIdle: 2`, but if prewarm is only invoked lazily at first `acquire`, the cost of spawning workers and initializing the WASM module is charged to the first user-visible decode.
- _Fix:_ Trigger `prewarm` at manifest-load (as soon as a pyramid is known to be openable), before the first viewport is requested. Moves spawn/init off the interaction critical path into idle ingest time. Per request → ahead-of-need.

---

## Lens 11 — batch everything

The parallel path is structured one-tile-per-unit at every level: one WASM call per tile, one `postMessage` (and one full-container clone) per tile, one output allocation per tile, one reply per tile. Each tile pays a fixed crossing/parse/clone overhead that is independent of tile size, so the per-tile constant dominates as tile count grows. Most of it batches.

**L11-A (High) — One WASM region call per tile; each call re-parses the container inside WASM. A batched call would decode all requested regions with a single crossing and a single parse.**
- _Issue:_ The parallel path issues `decodeTileContainerRegionRgba8/16(bytes, region)` once per tile. Every call crosses the JS↔WASM boundary and re-parses the JXTC container header inside WASM to locate the tile. For a T-tile viewport that is T boundary crossings and T full-container parses for one logical decode.
- _Fix:_ Add a batched region decoder — `decodeTileContainerRegionsRgba8(bytes, regions[])` — that parses the container once and decodes every region in one WASM invocation, returning the regions packed (or blitted into a caller-provided output). One WASM call per batch; parse amortized from T to 1.

**L11-B (High) — One `postMessage` per tile, each structure-cloning the whole container. Partitioning tiles per worker collapses this to one message and one clone per worker.**
- _Issue:_ `decodeTilesParallel` dispatches tiles individually and `decodeTileWithWorker` does `postMessage({ id, bytes, region })` per tile with no transfer list — so the full container is cloned T times and T messages flow each way (tiled-decode-pool.ts). The clone volume scales with tile count even though every tile shares identical bytes.
- _Fix:_ Partition the tile set across the W acquired workers and send each worker its slice in **one** message — `{ id, bytes, regions[] }` — with the worker replying once carrying all its tiles. Clones drop from T to W (W ≤ 8), messages from 2T to 2W. (Where SAB is available, L9-A removes the clone entirely; this is the batching win for the no-SAB transfer path.)

**L11-C (Medium) — One output allocation and one copy per tile; decoding into a single pre-sized buffer makes it one allocation and zero stitch copies per batch.**
- _Issue:_ Each tile decode allocates its own pixel buffer, then `stitchTileDecodes` allocates the viewport buffer and copies every tile in (T+1 allocations, T copies, per viewport). The intermediate per-tile buffers exist only to be copied out and discarded — pure allocator and memcpy churn.
- _Fix:_ Allocate the viewport output once and have the (batched) decode write each region directly into its destination sub-rect — one allocation per batch, no stitch pass. Combine with L11-A/L11-B so the batched WASM/worker call targets the shared output (ties L10-B, L9-A).

**L11-D (Low) — Batching per worker trades away the current work-stealing balance; use chunked dispatch, not all-or-one.**
- _Issue:_ Today's `idx = next++` scheme is dynamic work-stealing — a worker that finishes a cheap (edge) tile immediately grabs the next, so uneven tile decode times self-balance. A naive static partition for L11-B (T/W tiles each, fixed) reintroduces stragglers: one worker handed all the expensive center tiles stalls the whole `Promise.all`.
- _Fix:_ Batch in **chunks** rather than per-tile or per-worker-all — dispatch tiles in small groups (e.g. 2-4 per message) and let workers pull the next chunk when done. Keeps most of the clone/message savings of L11-B while preserving load balance. Tune chunk size against tile count and worker count; do not hardcode without the bench data CLAUDE.md requires.

---

## Lens 12 — make the common path brutally simple

The hot path here is the repeated viewport decode during pan/zoom and the per-tile copy that follows. It is currently routed through the same generic, allocation-happy machinery as a cold first-open: closures rebuilt per call, output objects re-wrapped per tile, an inner copy loop that multiplies per row, and a level lookup that sorts from scratch. The generic setup can stay elegant; these inner repetitions should be boring.

**L12-A (Medium) — Region decoders re-wrap the WASM output into a fresh `{ pixels, width, height }` object per tile, and the default decoder closure is rebuilt per call — per-tile allocation and indirection for a no-op repack.**
- _Issue:_ `pickRegionDecoder` returns an arrow that does `const out = await decodeTileContainerRegionRgba8(bytes, r); return { pixels: out.pixels, width: out.width, height: out.height }` (decode-level.ts:47-57) — `out` already has exactly those fields, so the literal is a redundant allocation on every tile of every frame. `decodeTiledViewportPooled` likewise builds its default `decodeRegion` closure inline on each call. On the hot path that is one throwaway object + one closure per tile/frame.
- _Fix:_ Return the decoder result directly when its shape already matches `DecodedLevel` (drop the repack), and hoist the region-decoder closures to module-level constants so they are bound once, not per call. Alloc-free, indirection-free hot path; the type alignment also removes a copy of three numbers per tile.

**L12-B (Medium) — `stitchTileDecodes` slow-path inner loop recomputes `((dy+row)*viewport.w + dx)*bytesPerPixel` every row; the boring form precomputes offsets and increments by stride.**
- _Issue:_ The per-row copy (decode-level.ts:75-79) computes `srcOff = row*srcStride` and `dstOff = ((dy+row)*viewport.w + dx)*bytesPerPixel` inside the loop — a multiply-add per row for a value that simply advances by a constant stride. Branchy index math in the tightest loop, defeating sequential-access prediction.
- _Fix:_ Hoist the base once and walk by stride: `let dstOff = (dy*viewport.w + dx)*bpp, srcOff = 0; for (let row=0; row<h; row++){ pixels.set(decoded.pixels.subarray(srcOff, srcOff+srcStride), dstOff); dstOff += dstStride; srcOff += srcStride; }`. Multiply-free, strictly sequential, cache-friendly. The existing full-width fast path stays as the even-simpler special case.

**L12-C (Medium) — `chooseLevelForTarget`'s common case is the *same* target as last frame, yet it spreads, sorts, and linear-scans every call.**
- _Issue:_ During a steady zoom level the target long edge repeats frame after frame, but each call still does `[...levels].sort(...)` + `find` (choose-level.ts:13-14) — full generic work for an answer that did not change. The hot path is anything but boring.
- _Fix:_ Make the common path a one-liner: keep a `{ lastTarget, lastLevel }` memo and return immediately when the target repeats; on a miss, binary-search a sorted-once array (L9-B). The generic "any target, any level set" logic stays for the cold path; the steady-state path becomes a compare + return.

**L12-D (Low) — `decodeTiledViewportPooled` re-runs full generic setup (header parse, closure build, capability/`wantParallel` branch chain) every frame for what is almost always the same container with parallelism available.**
- _Issue:_ Every viewport request repeats first-open work: parse the header, build the default decode closure, re-evaluate `canUseParallelTileWorkers()` and the `wantParallel` branch ladder. For a container already open and being panned, none of that changes between frames.
- _Fix:_ Resolve it once into a resident per-container decode context (cached header/tile index, bound closures, capability decided once); the per-frame hot path then reduces to clamp → `tilesOverlappingRegion` → dispatch. Elegant generic open path, brutally simple steady-state path (consolidates L9-C, L10-C, L10-D under one "open once" structure).

---

## Lens 13 — the owl

Lenses 1-12 swept the structure: representation, batching, hot paths. The owl turns its head — listening for the silences (paths that fail without a sound), tasting bad input, glancing behind at the duplicated history and ahead at the consumers project memory names (photogrammetry / digital-twin). The findings below are what the structural lenses flew past because they are about what *doesn't* happen: cleanup that is skipped, a promise that never settles, an error that is swallowed into a blank frame.

**OWL-A (High) — *Hear the silence in the error path.* `decodeWhole` disposes the decoder only on the success path; any thrown event leaks the WASM session, silently, on every failed decode.**
- _Issue:_ The lifecycle is a straight sequential await with no `try/finally`: `push → close → await drain → dispose` (decode-level.ts:39-42). The drain IIFE `throw`s on an `"error"` event (35); when it does, `await drain` rejects and `decoder.dispose()` (42) never runs. The WASM decoder session and its heap allocation leak — and because corrupt/oversized inputs are exactly when errors fire, this leaks repeatedly under the conditions that least afford it. No log, no signal; just a slow heap climb.
- _Fix:_ Wrap the body in `try { … } finally { await decoder.dispose(); }` so disposal happens on every exit. (The same applies if `push`/`close` reject.) This is the cleanup the success path already does — make it unconditional.

**OWL-B (High) — *Hear the promise that never resolves.* A worker that dies mid-decode orphans its pending promise; `Promise.all` then hangs forever with no error.**
- _Issue:_ `decodeTileWithWorker` settles only from a matching `onMessage` reply (tiled-decode-pool.ts). There is no `worker.onerror` / `onmessageerror` handler and no timeout, and the pool's terminate/reap path (`destroyHandle`, `bad`) does not reject in-flight handles. If a worker throws uncaught, runs out of memory, or is reaped while decoding, its promise is never resolved or rejected — `decodeTilesParallel`'s `Promise.all` waits indefinitely and the decode silently stalls. The user sees a viewport that never finishes, with nothing in the console.
- _Fix:_ Reject pending handles on worker death: attach `onerror`/`onmessageerror`, and have the pool reject any in-flight handle for a worker it terminates or marks `bad`. Add a watchdog timeout per tile as a backstop. Surface the rejection so `decodeTilesParallel` can fail (or retry on another worker) instead of hanging. Ties L4 (error/cancellation state).

**OWL-C (Medium) — *Taste the bad input.* The region clamp lets `NaN` slip through into a zero-length buffer, returning a silent blank decode instead of an error.**
- _Issue:_ Clamping is `rw = Math.min(region.w, source.width - rx)` with the guard `if (rw <= 0) throw` (decode-level.ts:100-104). `Math.min(NaN, x)` is `NaN`, and `NaN <= 0` is `false`, so a `NaN`/`undefined` width (or x/y) sails past the guard; `new Uint8Array(NaN * bpp)` is a length-0 array, and the caller gets an empty "successful" decode. A malformed viewport degrades to a blank frame, not a thrown error — the worst failure mode for a debugging consumer.
- _Fix:_ Validate at the boundary before clamping: `Number.isFinite` + integer + within-bounds for `x/y/w/h`, throwing on violation. Boundaries are exactly where CLAUDE.md says validation belongs; the interior can then trust the region.

**OWL-D (Medium) — *Turn your head and look behind.* Two divergent decode orchestrators implement the same job; every fix in this review must land twice or they drift.**
- _Issue:_ `decodeTiledViewport` + `stitchTileDecodes` (decode-level.ts) and `decodeTiledViewportPooled` + `stitch` (tiled-decode-pool.ts) are parallel implementations of the same pipeline — duplicate clamp logic, duplicate `wantParallel` decision, a literal duplicate stitch routine. The owl's backward glance matters here: the L12-B inner-loop fix, the L9 tile index, the OWL-C clamp guard would each need applying in *both* copies, and history shows duplicated copies drift (one already has the pool, the other does not). The duplication is a bug-multiplier.
- _Fix:_ Collapse to one decode core. `decode-level.ts` owns clamp + tile enumeration + stitch and accepts an injected `RegionDecoder`; the pool simply supplies a worker-backed `RegionDecoder`. One place to fix, one place to test. (Backward-glance guard for this review's own proposals: the L9-A / L10-B shared-output idea uses a `SharedArrayBuffer`, which is *shared*, not *transferred* — it does not detach, so it does **not** recreate the rejected output-buffer-pool pattern in CLAUDE.md. Keep it that way.)

**OWL-E (Low) — *See far ahead, to the consumers and the scale.* The module-singleton pool is an unbounded-lifetime, unfair shared resource the moment more than one pyramid is open.**
- _Issue:_ `getOrCreatePool` returns one process-wide pool of `maxSize = min(hwc, 8)` workers, and `destroyed` is never set true so it is never torn down. A gallery showing many pyramids at once contends on those ≤8 workers with no fairness (one large pyramid's tiles can starve the others), and on navigation/unmount the workers live for the page's lifetime. Ahead lie the 16-bit photogrammetry/digital-twin consumers (project memory) that will open many high-resolution pyramids — the place this ceiling bites hardest.
- _Fix:_ Give the pool a real teardown (`destroy()` that flips `destroyed`, terminates workers, rejects in-flight per OWL-B) tied to viewer lifecycle, and either scope pools per viewer/context or add simple fairness (round-robin across active pyramids) so one source cannot monopolize the workers.

---

## Lens 14 — run the film backwards

Tracing the pipeline from the consumer's pixels back toward the container bytes — and the worker lifecycle from termination back toward spawn — surfaces things forward reading hides: cancellation that never travels upstream, reuse that only ever moves toward more detail, a cache that discards exactly what a reversing pan wants, and a teardown that does not undo setup.

**REV-A (High) — *End → beginning: the abort doesn't propagate backward.* On the first tile failure, sibling tiles already dispatched are neither cancelled nor awaited, and their workers are released while still busy.**
- _Issue:_ `decodeTilesParallel` does `failed = true; break` on a tile error (tiled-decode-pool.ts). That stops *scheduling* new tiles, but the tiles already in flight keep decoding on their workers; their results are discarded, and the `finally release` hands those workers back to the pool while they may still be mid-decode. A subsequent `acquire` can then receive a worker that is still chewing on an orphaned tile — its next reply collides or arrives on the wrong session. The failure stops forward scheduling but never travels back to undo the work already launched.
- _Fix:_ On failure, propagate cancellation upstream to the in-flight tiles (post a cancel message / carry an `AbortSignal`), and only `release` a worker once its current decode has actually settled (resolved, rejected, or acked-cancelled). Pairs with OWL-B (a dead worker must reject) and L4 cancellation state.

**REV-B (Medium, feature) — *Far → near reuse runs only one way.* A smaller target is always decoded fresh even when a larger level is already decoded and could simply be downscaled.**
- _Issue:_ `shouldUpgrade`/`levelRank` only move toward *more* pixels (choose-level.ts:19-25); the decode flow has no inverse. Zoom out, and the fine level just decoded is dropped while the coarse level is decoded from scratch — even though downscaling the resident fine level is often far cheaper than a fresh JXL decode of the coarse one. The pyramid is reused going near→far in *storage* but never near→far in the *live decoded buffer*.
- _Fix:_ When a cached decoded level of rank ≥ target already exists, satisfy a smaller target by downscaling it (one resample pass) instead of decoding afresh; add a `reuseByDownscale` check beside `shouldUpgrade`. Guardrail (per L5-D): only when the downscale is genuinely cheaper than a decode — for very large reduction ratios a direct decode of the small level may win, so gate on the ratio.

**REV-C (Medium) — *Old → young: LRU evicts exactly what a reversing pan re-requests.* The oldest-used tiles are the just-departed ones — the most likely to re-enter on pan-back or jitter.**
- _Issue:_ Any plain LRU tile/level memo (the natural choice for L7-B) treats the tiles that just left the viewport as the coldest and evicts them first. But panning is rarely monotonic — a reversal, an overshoot-and-correct, or hand jitter brings those exact tiles straight back, now forcing a re-decode. Recency-of-use runs opposite to probability-of-reuse here.
- _Fix:_ Bias retention toward recently-departed tiles — keep a small "just behind me" set pinned out of LRU eviction, or make eviction direction-aware (favor keeping tiles on the side the viewport came from). Complements L7-B (tile cache) and L8-D (motion state).

**REV-D (Medium) — *Death → birth: teardown does not invert setup, so usable capacity decays.* `spawnOne` adds to several structures; the death paths remove from only some.**
- _Issue:_ Reading from terminate back to spawn: `spawnOne` registers a handle in `all`, arms an idle timer, and records `handleByWorker`; the death paths (`reap`, `destroyHandle`, marking `bad`) are not the exact inverse. A worker marked `bad` can leave `idle` while remaining in `all`, where it still counts against `maxSize` — so over a long session, transient failures permanently shrink the effective pool even though `all.size` looks healthy. And `destroyed` is never set, so birth (`prewarm`) has no matching death at all.
- _Fix:_ Make every death path the precise inverse of birth — remove the handle from *every* set it was added to (`all`/`idle`/`active`), clear its timer, drop `handleByWorker` — and add a pool `destroy()` that reverses `prewarm` and flips `destroyed` (OWL-E). Restores capacity after transient worker failures and gives the pool a real end of life.

---

## Lens 15 — the telescope

A tiled multi-resolution image viewer *is* an observatory. The pyramid is a turret of focal lengths (finder scope → main optic); a tile region decode is a windowed CCD readout; the worker pool is aperture (more workers = more light-gathering = faster collection on a big target); JXL progressive passes are integration time accumulating signal; the coarse DC preview is a guide star — a cheap, always-available reference that steers the expensive exposure. Some astronomical solutions are already present (the pyramid gracefully hits its "diffraction limit" when `chooseLevelForTarget` returns the largest available level for an over-zoomed target). The techniques below are the ones astronomy has and this code does not yet.

**ASTRO-A (High, feature) — *Sidereal tracking → predictive tile prefetch.* A mount slews ahead to where the target will be; this viewer only ever decodes where the viewport already is, so the leading edge of every pan is undecoded.**
- _Issue:_ During a pan the eye outruns the decode — fresh tiles enter the viewport faster than they can be produced, because nothing is fetched until it is already on screen. L8-C prioritizes the center of the *current* viewport and L8-D drops precision during motion, but neither anticipates *where the viewport is heading*. A telescope does not wait for a star to drift into frame; it tracks ahead of it.
- _Fix:_ Use the pan velocity vector (caller motion state, L8-D) to prefetch tiles just beyond the leading edge — decode the tiles the viewport is about to reach before it arrives. A modest lead distance proportional to velocity hides decode latency entirely on steady pans; combine with REV-C (keep the trailing edge) for a tracked, hysteretic window that moves with the user.

**ASTRO-B (Medium) — *Windowed CCD readout → confirm the region decode is a true sub-window read, not decode-then-crop.* Planetary imagers hit high frame rates only by reading a sensor sub-frame, not the whole chip.**
- _Issue:_ The whole point of `decodeTileContainerRegionRgba8/16(bytes, region)` is a windowed readout — pull only the ROI. But if the underlying WASM path decodes the full container and crops to the region, every pan frame silently pays full-frame decode cost, and the "tiled" advantage is illusory. This is the difference between a CCD that clocks out 200×200 pixels at 200 fps and one that reads the full sensor every frame. (These three files cannot confirm which it is — the truth is in the bridge.)
- _Fix:_ Verify the region decoder reads only the tile's compressed bytes (backed by the L9-C tile offset index) and decodes only that window. If it currently decodes-then-crops, make it a genuine windowed read. Until confirmed, treat per-tile cost as full-frame for budgeting.

**ASTRO-C (Medium, feature) — *Photon/exposure budget → foveated, importance-weighted decode precision.* Faint targets get long integration, bright ones short; the eye itself is sharp only at the fovea.**
- _Issue:_ Every tile in the viewport is decoded to identical quality regardless of where attention is. Astronomy allocates exposure by priority and the human visual system resolves detail only at the center of gaze — yet here the periphery costs exactly as much as the focal point. This is spent precision the observer cannot perceive.
- _Fix:_ Decode the focal region (viewport center / cursor) at full quality and the periphery at a coarser pyramid level or fewer progressive passes — foveated decode. Distinct from L8-C (which sets tile *order*); this sets per-tile *quality/exposure*. Reallocates a fixed decode budget (CLAUDE.md session budget) to where it is seen.

**ASTRO-D (Medium) — *Plate solving / HEALPix → one hierarchical spatial index across levels, not a per-call overlap scan.* Surveys map a sky region to data instantly via a nested quadtree index.**
- _Issue:_ The pyramid levels plus per-level tiles already form a natural quadtree (a HEALPix-like nested hierarchy), but they are addressed ad hoc: `tilesOverlappingRegion` derives overlap per call, and level selection (choose-level.ts) is decoupled from tile addressing. There is no single index that answers "for this viewport at this zoom, which (level, tile) cells?" in one step.
- _Fix:_ Build a hierarchical spatial index — region + target zoom → (level, tileCol, tileRow) by direct arithmetic (`col = floor(x / tileSize)`), unifying the L9-C per-level offset table across levels into one quadtree address space. Turns level choice and tile lookup into a single O(1) coordinate transform (a WCS for the image), and makes cross-level operations like ASTRO-A prefetch and REV-B downscale-reuse trivial to express.

**ASTRO-E (Low) — *Co-addition / image stacking → progressive passes refine one buffer in place, never blank-then-replace.* Stacking sums sub-exposures into a single accumulating frame.**
- _Issue:_ A stacked astrophoto never goes black between sub-exposures; each frame adds signal to the running co-add. If progressive decode (L8-A) emits each pass as a fresh `DecodedLevel` that *replaces* the previous, it re-allocates per pass and risks a visible flash, instead of accumulating into the same buffer like a co-add.
- _Fix:_ Refine progressive passes in place — decode each pass into the *same* output buffer (one allocation, monotonic improvement), and only swap what the consumer sees, never to blank. One buffer per level lifetime; reinforces L11-C (one allocation) and L8-A (progressive).

---

## Lens 16 — flow, elegance, communication

The previous lenses asked whether the code is *fast* and *correct*. This one asks whether it *communicates* — between producer and consumer, between the three files, between caller intent and decoder behavior. Read relationally, the code is a monologue: it takes a one-shot command, works in silence, and returns a bare buffer with no account of itself. The improvements here are about turning that monologue into a conversation, and letting results, types, and names speak clearly.

**FEM-A (Medium) — The whole system speaks in flowing event streams; the pyramid decode alone returns a single lump. Make the result flow.**
- _Issue:_ `jxl-session` "emits an AsyncEventStream of frames" (CLAUDE.md), and the pipeline is built around progressive emission — yet `decodeLevel`/`decodeTiledViewport` return a single `Promise<DecodedLevel>`: nothing is heard until everything is done. This breaks the house idiom and forecloses the coarse→fine flow that L8-A/ASTRO-E want. Buckets where the rest of the system pours water.
- _Fix:_ Return an `AsyncIterable<DecodedLevel>` (or reuse the session's stream type) that yields refinements as they arrive — guide-star preview first, tiles as they land, final frame last. The consumer collaborates by iterating; the producer stops hiding its progress. Aligns the pyramid with the layer it lives beside.

**FEM-B (Medium) — The result under-communicates: a bare `{pixels, width, height}` cannot tell the consumer what it is holding.**
- _Issue:_ `DecodedLevel` carries no provenance — not which level, not whether it is a partial preview or the final frame, not its bit depth (L9-D), not whether it came from cache. So the consumer cannot make obvious UI decisions: show a refining spinner or not, allow pixel-peeping or not, treat it as 8- or 16-bit. The producer knows all of this and says none of it.
- _Fix:_ Make the result self-describing: `{ pixels, width, height, bitsPerSample, level, stage: "preview" | "final", fromCache }`. The consumer reads intent from the value instead of guessing. (Extends L9-D from stride-typing to full provenance.)

**FEM-C (Medium) — Cancellation and intent have no back-channel; the caller can only shout a command and wait.**
- _Issue:_ The caller fires `decodeLevel` and awaits. It cannot say "I've changed my mind" (cancel — REV-A), "I'm still moving, your cheap guess is fine" (L8-D), or "spend your budget on the center" (ASTRO-C). The decode talks *at* the caller, never *with* it — so every scattered need for cancel/quality/priority has to be bolted on separately.
- _Fix:_ Give the call a two-way channel: accept an `AbortSignal` and an intent (`quality: "preview" | "full"`, optional focal point/priority), and emit progress events back. One coherent conversation that subsumes REV-A cancellation, L8-D motion, and ASTRO-C foveation instead of three ad-hoc hooks.

**FEM-D (Low) — Fractured vocabulary: one concept wears three names, so reading one file doesn't teach you the next.**
- _Issue:_ `RegionDecoder` (decode-level.ts) and `TileRegionDecoder` (tiled-decode-pool.ts) are the same type; `stitchTileDecodes` and `stitch` are the same routine; `decodeRegion` recurs as an unshared parameter. The three files don't speak a common language, so a reader re-learns the dictionary in each, and a change must be translated across copies (this is the elegance cost behind OWL-D's correctness cost).
- _Fix:_ Lift the shared names and types into one small module both files import — a single `RegionDecoder`, one `stitch`, one `DecodedLevel`. Shared vocabulary is how modules collaborate; it also makes OWL-D's de-duplication natural rather than forced.

**FEM-E (Low) — The API teaches correct use by throwing; let the types teach instead.**
- _Issue:_ `decodeLevel(source, region?)` accepts a region for any source, then throws "region decode requires a tiled level source" / "whole-frame decode" at runtime when the combination is illegal (decode-level.ts:130-135). The shape of the call permits the mistake; the code only scolds afterward.
- _Fix:_ Make illegal states unrepresentable — `decodeWhole(wholeSource)` and `decodeRegion(tiledSource, region)` as distinct entry points, so the type system guides the caller and the runtime guards disappear. The API communicates its contract by its shape, not by exceptions.

---

## Lens 17 — where the flashlight has not shone

Sixteen lenses swept structure, speed, concurrency, lifecycle, features, and communication. Re-reading them together, the beam has consistently fallen on *how the code moves data* and consistently missed three things: whether the pixel values are *numerically right*, whether the inputs are *trusted too much*, and whether anyone can *see inside* when it fails. These are the dark corners where the worst gremlins hide — wrong colors that look plausible, a crafted file that exhausts memory, and a production hang with no trace. Three self-prompts to light them up.

**DARK-1 — Fidelity lens: trace one pixel's numeric identity end to end.**
> Follow a single pixel's value from libjxl output to the consumer. `decodeWhole` sets `preserveIcc: false` and `preserveMetadata: false` (decode-level.ts:25-26) — does the pyramid silently discard the color profile, so wide-gamut or 16-bit images render with subtly wrong color that still *looks* like an image? For rgba16 carried in a `Uint8Array`: what byte order does the WASM write, and does `stitchTileDecodes`' blind byte copy preserve it for a consumer that reinterprets as `Uint16Array` (endianness)? Is alpha premultiplied or straight, and is that consistent across the whole/region paths? Is any gamma / transfer function assumed? Judge against the project's color-parity rules (trust camera WB; embedded-JPEG baselines) and the 16-bit photogrammetry/digital-twin consumers in memory — for them a wrong value is a wrong measurement, not just a wrong look.

**DARK-2 — Adversarial lens: treat `containerBytes` and the manifest as hostile.**
> Assume the JXTC container and the pyramid manifest are attacker-controlled. `parseJxtcHeader` yields width/height/tileSize/bitsPerSample/tile-count — what happens when `tileSize === 0` (division by zero or an unbounded tile list in `tilesOverlappingRegion`), when dimensions or tile count are enormous (`new Uint8Array(viewport.w * viewport.h * bpp)` becomes an allocation DoS; `w * h * bpp` can overflow past safe-integer range and mis-size the buffer), or when a tile's declared byte offset/length exceeds the actual buffer? Where exactly is the bounds check between *trusting the header* and *allocating from it*? Cross-reference the recent OOM-guard / adversarial-fallback commits (`JXLWASM-OOM-001`, the adversarial unknown-format work) — do those guards reach into the pyramid layer, or do they stop at the wasm facade, leaving this layer to trust freely?

**DARK-3 — Observability & coverage lens: what is visible when it breaks, and what is tested?**
> When OWL-B's silent hang or REV-A's released-but-busy worker happens in production, what can anyone *see*? Audit instrumentation: any logs, counters, or timing spans around decode start/finish, pool acquire/release, worker spawn/death, budget consumption? Right now there appear to be none — define the minimum trace needed to diagnose a stuck or slow decode (a pending-tile count, a worker-state dump). Then audit tests under `packages/jxl-pyramid`: do they exercise the parallel path, the stitch fast vs slow path, worker failure and cancellation (OWL-A/B, REV-A), the `NaN` region (OWL-C), and single- vs multi-tile selection? Enumerate the highest-risk paths that currently have *no* test — the failure and concurrency paths are both the most dangerous and, historically, the least covered.

---

## Lens 17 / DARK-1 illuminated — pixel fidelity

Tracing one pixel from libjxl to consumer reveals a single structural fault with four faces: the whole-level path (`decodeWhole`) is hardcoded to a lossier configuration than the tiled region path, and the result type carries no information to detect the difference. A 16-bit wide-gamut image therefore renders *differently* depending on which pyramid level happens to be stored whole vs tiled — and nothing in the data says so.

**DARK1-A (High) — `decodeWhole` hardcodes `format: "rgba8"`, silently truncating 16-bit whole levels to 8-bit; precision depends on whether a level is stored whole or tiled.**
- _Issue:_ The region path honors source depth via `pickRegionDecoder(bits)` (8 or 16), but `decodeWhole` requests `format: "rgba8"` unconditionally (decode-level.ts:22) and ignores `source` bit depth entirely. The whole path is taken for the *small* coarse levels (and any non-tiled level). So in one pyramid the coarse overview is 8-bit and the fine tiled levels are 16-bit — the overview throws away 8 bits per channel. For the photogrammetry / digital-twin consumers in project memory, that coarse level is not just "a bit flatter," it is quantized measurement data.
- _Fix:_ Thread the source bit depth into `decodeWhole` and pick `"rgba8"` / `"rgba16"` to match, exactly as the region path does. Whole and tiled levels of the same image must decode at the same depth.

**DARK1-B (High) — `preserveIcc: false` discards the color profile, so wide-gamut images are interpreted as sRGB — plausible-looking but wrong — and the whole vs region paths may disagree on color management.**
- _Issue:_ `decodeWhole` sets `preserveIcc: false` (decode-level.ts:25); the decoded pixels carry no ICC and the result has no colorspace tag, so a Display-P3 / AdobeRGB / ProPhoto level is treated as sRGB downstream — oversaturated or dull, but never obviously broken. Worse, the region decoders are called as `decodeTileContainerRegionRgba8/16(bytes, region)` with *no options*, so their ICC handling is the facade default — which may differ from the whole path's explicit `false`. Two levels of one image could then be color-managed inconsistently. This directly contradicts the project's color-parity discipline in memory.
- _Fix:_ Preserve ICC (or at minimum extract the colorspace and attach it to the result — see DARK1-C / FEM-B), and make the whole and region paths use the *same* color-management setting. _(Verify the region decoders' actual ICC default in `facade.ts` — that truth lives outside these three files.)_

**DARK1-C (Medium) — rgba16 endianness and alpha mode are untracked: the byte copy is endian-agnostic and correct, but the result tells a `Uint16Array` consumer nothing, so reinterpretation relies on an implicit contract.**
- _Issue:_ `stitchTileDecodes` copies raw bytes (decode-level.ts:60-83) — correct, it preserves whatever order the WASM wrote — but `DecodedLevel` exposes only a `Uint8Array` with no `bitsPerSample`, byte-order, or premultiplied-alpha flag (L9-D / FEM-B). A consumer that reinterprets the buffer as `Uint16Array` uses the platform's endianness; wasm32 is little-endian and so are current hosts, so it works *today* by coincidence, on an undocumented contract. Likewise nothing states whether alpha is premultiplied or straight, or that whole (`rgba8`) and region paths agree on it.
- _Fix:_ Make the result self-describing — carry `bitsPerSample`, `byteOrder: "LE"`, and an alpha-mode flag — and assert the WASM write order at the boundary so a future big-endian or differently-built target fails loudly instead of silently swapping bytes. _(Confirm the actual write order and alpha convention in `bridge.cpp` / `facade.ts`.)_

**DARK1-D (Medium) — `preserveMetadata: false` drops orientation and colorspace metadata, so even correct pixels arrive with no instructions for interpreting them.**
- _Issue:_ `decodeWhole` sets `preserveMetadata: false` (decode-level.ts:26). Combined with DARK1-B, the consumer receives a bare buffer with no gamut, no transfer-function, and no orientation hint. If orientation is *not* fully baked into the pyramid at build time, levels could display rotated; and for measurement consumers, a buffer with no colorspace is uninterpretable data, not a minor loss.
- _Fix:_ Preserve (or extract and attach to the result) at least colorspace and orientation; gate the cost behind the consumer's need so one-shot viewers that don't care pay nothing. Confirm at the build/manifest layer whether orientation is already applied — if so, document that the decode path may drop it safely.

**Throughline & next torch:** all four are the same defect — `decodeWhole` is configured for cheap thumbnails, not fidelity, and is silently used for levels that feed precision consumers; the result type then hides the discrepancy. The definitive answers to *byte order*, *alpha convention*, and *region-path ICC default* live in `facade.ts` / `bridge.cpp`, outside the three files in scope — flagged for verification rather than asserted here.

---

## Lens 17 / DARK-2 illuminated — adversarial input

Treating `containerBytes` and the manifest as hostile exposes a layer that trusts freely: header fields flow straight into division, allocation sizing, and array lengths with no gate between *parsing* a number and *acting* on it. A single crafted field crashes or exhausts the tab. The same poison enters from two doors — `source.*` in decode-level.ts and `parseJxtcHeader(...)` in tiled-decode-pool.ts — neither re-validated.

**DARK2-A (Critical) — `tileSize === 0` (or negative / `NaN`) drives `tilesOverlappingRegion` into division by zero → an `Infinity`/`NaN` tile count → `new Array(Infinity)` throw or an unbounded tiling loop.**
- _Issue:_ `tilesOverlappingRegion(source.width, source.height, source.tileSize, viewport)` (decode-level.ts:107) and the equivalent in `decodeTiledViewportPooled` take `tileSize` directly from the header/manifest. Tiling math is `ceil(extent / tileSize)`; a `tileSize` of 0 yields `Infinity` tiles, a negative or `NaN` value yields nonsense — either `new Array(tiles.length)` throws "Invalid array length" or the tile loop never terminates. One byte in the header hangs or kills the decode. This is the cheapest possible DoS.
- _Fix:_ Validate `tileSize` is a positive integer (and ≤ image dimension) at the trust boundary, before any tiling arithmetic; reject the container otherwise. Same guard on both entry paths.

**DARK2-B (High) — Attacker-controlled dimensions size allocations directly; huge values are an OOM DoS and values past 2^53 corrupt the buffer size via lost integer precision.**
- _Issue:_ `stitchTileDecodes` does `new Uint8Array(viewport.w * viewport.h * bytesPerPixel)` (decode-level.ts:65) and `decodeTilesParallel` does `new Array(tiles.length)` — all sized from header dims and tile counts. A manifest claiming `width = height = 100000` requests a ~40 GB allocation (instant OOM crash); and when `w * h * bpp` exceeds `Number.MAX_SAFE_INTEGER` (~2^53) the product silently rounds, so `new Uint8Array` is mis-sized and the later `pixels.set(...)` either overflows (RangeError) or writes garbage. The clamp at decode-level.ts:100-104 bounds the region to `source.width/height` but those are *themselves* the hostile values, so it clamps to the attacker's number.
- _Fix:_ Cap total pixel count against a sane device-derived maximum and assert `w`, `h`, `w*h*bpp` are safe integers *before* allocating; reject oversize containers up front rather than discovering them via an allocation crash.

**DARK2-C (High) — `bitsPerSample` is assumed to be exactly 8 or 16 but never checked; any other value maps through `bits === 16 ? 8 : 4` to a wrong stride, mis-sizing buffers against the actual decoded bytes.**
- _Issue:_ `bits = source.bitsPerSample ?? 8` (decode-level.ts:97) and `bpp = bits === 16 ? 8 : 4` (120) — a header value of 12, 32, 0, `NaN`, or negative silently falls into the `bpp = 4` branch. If the real decoded tile is a different depth, every stride and offset in the stitch is wrong: buffer too small → RangeError, or right size by luck → misaligned color garbage. The depth is load-bearing for all the pointer math yet is taken on faith.
- _Fix:_ Validate `bitsPerSample ∈ {8, 16}` at the boundary; reject or explicitly normalize anything else. Never derive stride from an unchecked field.

**DARK2-D (High) — The whole layer consumes `parseJxtcHeader` output (dims, tileSize, tile offsets/lengths, count) without re-validation; the trust boundary *is* that parser, and any per-tile slicing (L9-C/L11) turns a bad offset into an out-of-bounds read.**
- _Issue:_ `decodeTiledViewportPooled` calls `parseJxtcHeader(containerBytes)` and immediately trusts the result. Today the full container is shipped to workers, so a malicious tile *offset* is not yet dereferenced — but the moment the L9-C tile index / L11 per-tile slicing lands, a tile claiming `offset + length > containerBytes.length` is a read past the buffer. The count field also feeds DARK2-A/B. Every defense here depends on a parser these three files do not own.
- _Fix:_ Confirm `parseJxtcHeader` validates each tile entry (`offset + length ≤ buffer`, `count ≤` a hard cap, dims internally consistent); if it does not, add a validation gate in this layer before trusting the header. Cross-reference `JXLWASM-OOM-001` and the adversarial-fallback commits — verify those guards extend into the pyramid layer rather than stopping at the wasm facade.

**DARK2-E (Low) — `chooseLevelForTarget` sorts the manifest level list on every call with no cap; an absurd level count is an O(n log n)-per-call DoS, and `w*h` rank math overflows for crafted dims.**
- _Issue:_ `[...levels].sort((a,b) => a.w*a.h - b.w*b.h)` (choose-level.ts:13) trusts `levels.length` from the manifest; a file declaring millions of levels makes every level query a sort-and-spread DoS, and `w*h` overflow makes the comparator return `NaN` (undefined order, not a crash, but wrong selection).
- _Fix:_ Cap level count at parse time; the L9-B precomputed sorted index also eliminates the repeated cost. Compute rank with overflow-aware math or pre-validated dims.

**Throughline & next torch:** every finding is the same missing gate — a header/manifest number used for division (A), allocation (B, E), stride (C), or indexing (D) with no validation between parse and use. The strongest single fix is a `validateHeader()` / `validateManifest()` boundary check (tileSize ≥ 1, dims safe-integer and under a cap, `bitsPerSample ∈ {8,16}`, tile entries in-bounds, level count capped) run once at open, after which the interior can trust its inputs — matching CLAUDE.md's "validate at boundaries, trust the interior." Whether `parseJxtcHeader` already does any of this is the open question; it lives outside the three files and must be confirmed.

---

## Lens 17 / DARK-3 illuminated — observability & coverage

The three files emit *nothing*: no logs, no counters, no timing spans, no diagnostic events. They also branch heavily on exactly the conditions most likely to be untested — worker death, mid-flight cancellation, `NaN` regions, the slow stitch path. So the layer is dark in two senses: you cannot see inside it at runtime, and you cannot be sure its dangerous paths have ever been exercised. Light both.

**DARK3-A (High) — The failure modes that hang or silently corrupt produce no signal whatsoever; OWL-B's stuck decode and REV-A's wrong-worker reply are invisible.**
- _Issue:_ There is no pending-tile gauge, no per-decode or per-tile timing, no worker-lifecycle event, no correlation id anywhere in the three files. When a worker dies and `Promise.all` hangs (OWL-B), nothing logs "tile N pending for 5 s"; when a released-but-busy worker returns a stale reply (REV-A), it surfaces as a mystery frame with no trail back to the cause. The most dangerous behaviors are precisely the silent ones.
- _Fix:_ Add structured diagnostic events at the seams, behind a debug flag: decode start/finish (id, level, tile count, elapsed), pool acquire/release/spawn/death, and an in-flight tile count with a slow-tile warning threshold. Minimal volume, but enough to see a stall as it happens.

**DARK3-B (Medium) — The pool has no introspection, so "why is the decode slow or stalled" is unanswerable at runtime.**
- _Issue:_ Nothing exposes the pool's `all` / `idle` / `active` / `bad` counts, `maxSize`, in-flight depth, or reap activity. A caller cannot distinguish a *starved* pool (all workers legitimately busy) from a *decayed* one (all marked `bad`, per REV-D) from a genuinely slow decode. The single most useful diagnostic — pool health — is unreadable.
- _Fix:_ Expose a `pool.stats()` snapshot (per-state counts, in-flight tiles, lifetime spawned/terminated) and emit it on spawn/death/reap. Makes REV-D capacity decay and OWL-E contention observable instead of inferred.

**DARK3-C (Medium) — Errors are stringly-typed and context-free; a failure carries no breadcrumb to the level, source, or tile that produced it.**
- _Issue:_ `decodeWhole` throws `new Error(\`decode ${ev.code}: ${ev.message}\`)` (decode-level.ts:35) — no level dimensions, no source key, no tile region, and not a typed error the caller can branch on (FEM-C). In a log it is an anonymous "decode error" with a generic stack; root-causing it requires a repro, not a record.
- _Fix:_ Throw typed errors carrying context (level, region, tile index, code). Diagnosable from the log line alone, and pattern-matchable by the caller for recovery (ties FEM-C two-way channel).

**DARK3-D (High) — The risk surface is dominated by failure and concurrency paths, the ones historically least tested; whether *any* of them are covered is unverified (the tests live outside the three files).**
- _Issue:_ Enumerating what these files branch on, ranked by danger:
  - **Failure / concurrency (highest):** `decodeWhole` error-event → dispose leak (OWL-A) and no-final-frame throw; worker death mid-decode → hang (OWL-B); first-tile-fail → sibling cancel + release-while-busy (REV-A).
  - **Bad input:** `NaN`/negative/empty region (OWL-C); `tileSize` / dimension / `bitsPerSample` edges (DARK2-A/B/C).
  - **Geometry:** stitch fast path (full-width, `dx===0`) vs slow per-row path; tile larger than remaining viewport; partial edge tiles when size does not divide dimensions; single-tile (non-parallel) vs multi-tile (parallel) branch.
  - **Selection:** empty levels (`→ null`); target exceeding all levels (`→ largest`); the area-vs-long-edge mismatch (L9-B); single level.
  - **Pool:** prewarm; idle reap firing during acquire; contention; `bad`-worker capacity decay (REV-D); teardown (which does not exist).
- _Fix:_ Prioritize tests for the failure/concurrency paths first (OWL-A/B, REV-A, OWL-C) — they cause hangs, leaks, and corruption — then the geometry edges, then selection. **Do not assume these are untested:** confirm against `packages/jxl-pyramid/test` before treating any as a gap. That directory is outside the three-file scope of this review and was not inspected here.

**Throughline & why this lens unblocks the others:** the layer cannot currently *prove* any claim — not a bug's existence, not a fix's benefit. CLAUDE.md requires benchmark data before any adaptive or tunable change, and the perf fixes proposed across L9–L15 (clone volume, batching, prefetch) are exactly that. Without DARK3-A/B instrumentation there is no way to measure clone bytes, decode latency, or pool contention, so none of those optimizations can be landed *safely* — they would be guesses. Observability is therefore the prerequisite fix: it converts this entire review from assertion into measurement. Test existence and current coverage are unverified (outside the three files) and should be confirmed before acting.

---

## Lens 18 — substrate for machine recognition & LLMs

These three files already implement, by accident, most of what a recognition pipeline needs: multiple resolutions (models want a fixed native input), tiles (large-image inference is sliding-window), coarse→fine (detection cascades), and a worker pool (inference is embarrassingly parallel). The gap is that the API targets a *human display* — "decode this viewport for the screen" — when the same machinery could target a *model*: "give me this content at the resolution and layout the model wants, only where it matters." Closing that gap makes recognition quicker (decode and infer less), better (right resolution, no boundary splits), and more accurate (correct color, native input size). For multimodal LLMs the same moves directly cut vision-token cost.

**LLM-A (High, feature) — Select the pyramid level by the model's native input size, never decode-then-downscale.** `chooseLevelForTarget` already finds the smallest level ≥ a target long edge — exactly the primitive a model needs, except the target is a screen size, not a model input (224 / 384 / 512 / 1024). Feeding a 100 MP image to a 224-px model today means decoding full resolution and downscaling — wasteful and lossy; feeding a too-small level upscaled hurts accuracy. _Fix:_ expose a level-selection variant tuned to "closest to N" so inference decodes the pyramid tier nearest the model's trained resolution directly. Quicker (decode kilobytes, not gigapixels) and more accurate (the model sees the resolution it was trained on). For an LLM, this is the cheapest level that is still "good enough" → fewest vision tokens.

**LLM-B (High, feature) — Turn tiled region decode into sliding-window inference, with halo overlap so boundary objects survive.** Detection / segmentation / OCR on large images is slicing-aided inference (SAHI): slice, infer per tile, merge. `tilesOverlappingRegion` + the region decoders are that slicer — but the tiles appear disjoint, so an object straddling a tile seam is cut in half and mis-detected. _Fix:_ add configurable tile overlap (a halo margin) and a tile-stream API (FEM-A) the inference loop consumes; the seam-merge mirrors non-max-suppression across tile boundaries (the stitch logic generalizes to box-merging). Quicker (tiles run in parallel, batched per L11), more accurate (no boundary splits).

**LLM-C (High, feature) — Two-stage cascade: cheap recognition on the coarse level finds regions of interest; the heavy model runs only on fine tiles where ROIs landed.** Most recognition is sparse — a few objects in a large frame. Running the expensive model on every full-res tile (including empty background) is the dominant waste. The pyramid gives this for free: run a fast detector / saliency pass on the tiny coarse level (L8 coarse-first, L15 foveation), get candidate regions, then decode and run the heavy model only on the fine tiles overlapping them. _Fix:_ a `findThenRefine` flow over the existing choose-level + tiles-overlapping primitives. For a vision-LLM this is decisive: the coarse pass decides *which* region to send at high resolution, so the LLM receives one relevant crop instead of the whole image — maximal detail where it matters, minimal tokens everywhere else.

**LLM-D (Medium, feature) — Emit model-ready tensors from the worker, not RGBA bytes the caller must convert.** Models want planar CHW, RGB (no alpha), float32 normalized by mean/std, in a known colorspace. `DecodedLevel` is interleaved HWC RGBA `Uint8Array`, so every inference caller redoes RGBA→RGB, HWC→CHW, and uint→float-normalize on the main thread, per tile. _Fix:_ do that conversion in the decode worker (L10 — cheapest location, beside the pixels, before the transfer) behind an optional output-layout request. This compounds with DARK-1: a model trained on sRGB fed wide-gamut-as-sRGB silently loses accuracy, so the fidelity fixes (correct colorspace, full bit depth) are *recognition-accuracy* fixes, not just visual ones.

**LLM-E (Medium, feature) — Cache recognition results by tile content hash; never re-recognize an unchanged tile.** Inference is expensive and deterministic per tile content, and panning revisits the same tiles (REV-C). _Fix:_ key recognition output (boxes, labels, embeddings) by a stable tile content hash — the L9-C tile index gives the identity — so a revisited tile returns its result instantly and recognition layers persist across navigation. Note this is a *results* cache, not a decoded-pixel cache, so it does **not** recreate the rejected dedupe-aware pixel-storage pattern (CLAUDE.md G2-1) — it stores small metadata, not doubled pixels. Quicker (skip redundant inference) and enables gallery-wide semantic/visual search by embedding the near-free coarse levels once at ingest (ties pyramid-gallery-architecture in memory).

**Throughline:** the pyramid is a resolution ladder and the tile pool a parallel inference engine; almost everything recognition needs is a thin API away from what exists. Sequenced: LLM-A (right resolution) and LLM-B (overlapping tiles) are the substrate; LLM-C (cascade) is the big speed/accuracy/token win on top; LLM-D (tensors) and LLM-E (result cache) remove the per-call conversion and redundant-inference taxes. None require the heavy model to live in this layer — these files stay a decoder; they simply hand recognition the right pixels, at the right size, only where needed.

---

## Lens 19 — less is more (recognition & photogrammetry)

Precision is a cost, and recognition routinely gets *better* when you spend less of it: downsampling suppresses sensor noise and aliasing, so a coarser level yields fewer but more repeatable features; coarse-first matching finds a robust global solution that fine-only matching misses by falling into local minima; thumbnails prune the matching graph before any expensive work. Photogrammetry is built on exactly this — SIFT is a Gaussian scale-space, SfM/MVS run coarse-to-fine — and the decode pyramid already *is* that scale-space. The pipeline's native ability to serve less is the recognition feature; the API just needs to let the consumer ask for less on purpose.

**LESS-A (High, photogrammetry) — Expose the pyramid as a feature-matching scale-space; match coarse first for a robust global estimate, refine fine only where matched.** SfM/MVS feature extraction and matching are hierarchical: align at a low octave to fix global pose and reject outliers, then refine at higher octaves in matched regions. The levels are ready-made octaves and `chooseLevelForTarget` / `shouldUpgrade` / `tilesOverlappingRegion` are the ladder + ROI selector. _Fix:_ a level-as-octave access path plus a coarse→fine match flow (the geometry twin of LLM-C). Less resolution first converges better (avoids the local minima that trap fine-only matching), produces fewer spurious correspondences, and runs faster.

**LESS-B (High) — Downsampling is denoising: a coarser level often gives MORE repeatable keypoints than full resolution.** Full-res frames carry sensor noise, aliasing, and compression artifacts that fire spurious, non-repeatable detections → false matches → corrupted reconstruction. A pyramid level below native is pre-decimated and effectively pre-blurred, so detection on it is more stable. The "lossy" rgba8 whole-path that DARK1-A flagged as a fidelity bug is, for feature *detection*, the right thing. _Fix:_ default feature detection to a level below native (e.g. half-res) unless fine detail is needed — let the pyramid be the denoiser instead of detecting on noisy full-res.

**LESS-C (Medium) — For matching, quantize hard: grayscale 8-bit (or less) beats 16-bit RGBA — faster and equally accurate.** FAST/ORB/SIFT operate on 8-bit grayscale and frequently use binary descriptors; matching repeatability does not improve with bit depth, and color is usually discarded. Feeding 16-bit RGBA to a matcher wastes 4–8× bandwidth and a conversion for zero accuracy gain. _Fix:_ offer a cheap grayscale-8 (or lower) output mode for recognition/matching consumers — deliberately less precise, much faster, no loss for keypoints. **Crucial distinction:** this is true for *detection/matching/pose*; dense MVS depth and measurement need the full precision DARK-1 demands. Same pyramid, opposite needs — so precision must be a per-request choice (LESS-C output mode + DARK1 self-describing result), not a fixed config.

**LESS-D (Medium, photogrammetry) — Prune the O(n²) match graph with thumbnails: decide which image pairs overlap from the coarse level before any fine matching.** SfM's dominant cost is testing every image pair. A global descriptor / bag-of-visual-words computed on the near-free coarse level prunes the candidate list to likely-overlapping pairs. _Fix:_ embed/descriptor each coarse level at ingest (ties LLM-E results cache) and use it for pair preselection. Turns O(n²) full matching into sparse matching on probable pairs — quicker, and more robust because it never attempts matches between unrelated images that only manufacture outliers. Less data (a thumbnail) finds the right work to do.

**LESS-E (Medium) — Early-out on the coarse stream: stop decoding finer the moment coarse already answers.** Often the coarse level alone suffices — the object is detected, the pose is estimated, the pair is confirmed — and decoding finer is pure waste. With a coarse-first stream (FEM-A) the consumer gates on confidence and aborts the upgrade. _Fix:_ streamed coarse-first decode plus a consumer confidence/early-stop hook. For a vision-LLM this is the cheapest path of all: send the coarse image first and escalate resolution only when the model signals uncertainty — minimum tokens for a confident answer, more only when the answer is in doubt.

**Throughline:** every win here is "spend less precision deliberately." The pyramid already produces the cheap, lossy, denoised representations recognition and photogrammetry prefer for detection, matching, and pair selection — the missing piece is an API that lets a consumer *request less* (a coarser octave, grayscale-8, coarse-only-with-early-out) as a first-class intent. This sits alongside DARK-1, not against it: matching wants the cheap path, measurement wants the faithful one, and the only real requirement is that the consumer — not a hardcoded config — chooses which.

---

## Lens 20 — searches, tries, graphs

The data here is highly structured — pyramid levels are a near-geometric sequence, tiles are a regular grid, in-flight tiles are a small keyed set — yet several lookups treat it as unstructured: a sort-then-scan for a level, a linear id-match for a reply, a (possible) full-grid scan for overlap. Structure that regular admits arithmetic, hashing, and graph traversal in place of search. And the pyramid plus its tiles *is* a quadtree graph; making that graph explicit turns the coarse/fine/neighbor operations the other lenses wanted into O(1) edge-follows.

**SRCH-A (High) — Level selection is a closed-form `log2` index, not a sort + scan.** A pyramid's levels are a geometric (≈power-of-two) ladder, so the level for a target long edge is `clamp(round(log2(maxEdge / target)), 0, nLevels-1)` — O(1) arithmetic, no allocation, no search. `chooseLevelForTarget` instead does `[...levels].sort(...)` + `find` every call (choose-level.ts:13-14), solving a search problem that isn't one. _Fix:_ for a regular pyramid, index by `log2`; for an irregular level set, binary-search a once-sorted array. This is the optimal form behind L9-B / L10-C / L12-C — not "precompute the sort," but "there is no sort."

**SRCH-B (High) — Worker-reply routing is O(in-flight) per message through N listeners; one dispatcher with an `id → resolver` map makes it O(1) and fixes orphan cleanup.** Each `decodeTileWithWorker` registers its own `onMessage` that checks `reply.id === id`, so every reply from a worker fires *all* its registered listeners, each doing a compare — O(k) per message with k tiles in flight (worse under the L11 chunked dispatch). _Fix:_ one persistent dispatcher per worker holding `Map<id, {resolve, reject}>` — O(1) routing, and the single place to reject every pending id when a worker dies (OWL-B) or is released mid-flight (REV-A). The right data structure collapses a search, a leak, and a race together.

**SRCH-C (High) — Overlapping-tile lookup is O(k) grid arithmetic, and the pyramid should be one explicit quadtree graph.** For a regular grid the tiles overlapping a viewport are a rectangular index range — `c0 = floor(rx/ts) … c1 = floor((rx+rw-1)/ts)`, likewise rows — yielding exactly the k result tiles with no scan of the others. Generalized across levels this is a quadtree whose edges are the operations the review keeps needing: the parent edge is the coarser level (REV-B downscale reuse), child edges are finer tiles (L8 / LESS-A refine), neighbor edges are adjacent tiles (ASTRO-A prefetch). _Fix:_ compute tile ranges arithmetically and represent the pyramid as an explicit graph, turning coarse↔fine↔neighbor moves into pointer-follows instead of recomputed searches. _(Verify whether `tilesOverlappingRegion` already does range arithmetic or scans the full grid — flagged, not asserted.)_

**SRCH-D (Medium) — A Morton / Z-order tile index (a radix trie) gives locality-preserving range scans and a stable 1-D tile id.** Linearizing `(col, row)` to a Morton code maps a 2-D viewport to a few contiguous 1-D ranges, so a radix-trie / sorted-Morton index answers "tiles in viewport" by range scan, hands each tile a stable id for the LLM-E content cache and the L9-C offset table, and improves cache locality of decode order. _Fix:_ Morton-code the tile grid and index it as a radix trie. This is the "trie" the structure naturally wants, and it dovetails with SRCH-C's quadtree (Morton codes *are* the quadtree's linearization).

**SRCH-E (Medium, photogrammetry) — Replace brute-force O(n²) pair matching with ANN over a vocabulary tree / HNSW graph.** LESS-D's pair pruning is a search problem, and the photogrammetry-standard answer is a vocabulary tree (a trie of visual words) or an HNSW graph for approximate-nearest-neighbor retrieval over coarse-level descriptors. _Fix:_ index the near-free coarse-level embeddings (LLM-E) in a vocabulary tree / ANN graph and query it for candidate overlaps — O(n²) brute force becomes ~O(n log n) retrieval, and the graph also models the reconstruction's image-overlap structure directly. (All three of the lens's terms — search, trie, graph — applied to the recognition layer these files feed.)

**Throughline:** the recurring fix is to let structure replace search — `log2` for the geometric level ladder (A), a hash map for the keyed reply set (B), grid arithmetic + an explicit quadtree for the regular tile lattice (C, D), and an ANN graph for the matching problem downstream (E). The single highest-leverage piece is SRCH-C's pyramid-as-graph: it is the concrete form of ASTRO-D's spatial index and the carrier for REV-B reuse, ASTRO-A prefetch, and LESS-A coarse-to-fine, so one data structure discharges several earlier findings at once.

---

## Lens 21 — probabilistic & approximate methods

Lens 19 argued for spending less precision; this lens makes it rigorous — trade *exactness* for speed and memory under an explicit error budget. A Bloom filter answers "seen this tile?" in a few bits with a known false-positive rate; a random pixel sample classifies a tile without decoding it; RANSAC fits robust geometry from noisy matches; LSH finds image pairs by hash collision. Each replaces an exact, expensive computation with a cheap estimate whose error is bounded and tunable. The pyramid's coarse levels are the natural cheap estimator feeding all of them.

**PROB-A (Medium) — A Bloom filter over tile content-hashes gives an O(1), few-bit "definitely-not-seen" test to gate cache lookups, prefetch, and inference.** Before dispatching a decode or recognition for a tile, a Bloom filter keyed by the tile's content hash (LLM-E / SRCH-D id) answers "definitely new" vs "probably seen" in constant time and tiny memory, short-circuiting the full cache probe for the common new-tile case and bounding prefetch (ASTRO-A) to genuinely-unseen tiles. _Fix:_ maintain a Bloom filter of decoded/recognized tile hashes; tune bits-per-entry to the acceptable false-positive rate (a false positive only costs a redundant cache miss, never correctness). Cheap negative test in front of the expensive paths (L7).

**PROB-B (High, photogrammetry) — RANSAC-family robust estimation is the canonical approximate method, and coarse-to-fine pyramids feed it ideally.** Feature matching always yields outliers; SfM fits a robust model (homography / fundamental / essential matrix) by random-sample consensus (RANSAC, PROSAC, MAGSAC). A coarse-level match set (LESS-A) gives a fast, low-outlier prior that seeds and bounds the fine-level RANSAC — fewer iterations to reach consensus and a higher starting inlier ratio. _Fix:_ expose coarse-level matches as priors and budget RANSAC iterations by coarse inlier confidence, so the expensive fine estimate starts near the answer instead of from scratch. Randomized sampling + scale-space, working together.

**PROB-C (Medium, photogrammetry) — LSH / random projections retrieve candidate image pairs by hash collision — the randomized cousin of SRCH-E.** Locality-sensitive hashing buckets similar coarse-level descriptors so likely-overlapping pairs are found by collision in ~O(1) per query, trading a small recall miss for a large speedup over exact ANN. _Fix:_ LSH (or random-projection codes) over the coarse-level embeddings (LLM-E) for pair-candidate generation, with the vocabulary-tree/HNSW path (SRCH-E) as the higher-recall fallback. A bounded recall loss is acceptable because the downstream RANSAC (PROB-B) rejects the bad pairs anyway — approximation upstream, robustness downstream.

**PROB-D (High) — Sample before you compute: a random pixel sample or the coarse level answers "is this worth the expensive work?" without decoding the full tile.** Many gating decisions need an estimate, not exact pixels — "is this tile mostly empty background?" (skip heavy inference, LLM-C), "has this region changed since last frame?" (skip re-decode), "how complex is this tile?" (allocate budget / passes, ASTRO-C). All are answerable from a stratified pixel sample or the coarse pyramid level at a fraction of the cost. _Fix:_ cheap sample-based classifiers in front of the expensive paths — decode/infer fully only when the estimate says it pays. The coarse level is a ready-made low-variance sample, so this mostly reuses LESS-E's early-out with an explicit estimator.

**PROB-E (Medium) — Probabilistic change detection: sketch tiles to send only what changed, like video P-frames.** During pan/zoom most tiles are unchanged or merely translated (the existing `copyWithin` scroll-blit already exploits pure translation). A cheap perceptual hash / sketch per tile — computed on the coarse level — detects unchanged tiles with bounded error, so decode, transfer, and inference are skipped for them and only the delta is dispatched. _Fix:_ per-tile content sketch + delta dispatch, treating the previous frame's tiles as reference frames. Ties the convergedByteEnd theme in memory (measure what's worth sending) and L7 (stop doing redundant work).

**Throughline & guardrail:** every item swaps an exact computation for a bounded-error estimate — Bloom (A) and sketches (E) bound false positives, sampling (D) bounds estimation variance, RANSAC (B) and LSH (C) bound recall/consensus failure. They compose cleanly: approximate aggressively upstream (LSH pairs, sampled gates), then let robust estimation (RANSAC) and exact verification clean up downstream, so user-visible correctness is preserved while the expensive work shrinks. Per CLAUDE.md, every error-budget threshold (Bloom bits, sample size, RANSAC iterations, LSH bands) is a tunable that needs benchmark data before it is fixed — these are directions with knobs, not constants to hardcode.

---

## Lens 22 — low-level: bits, words, passes, lanes

Pixel work is memory-bound: the limiter is bytes moved through cache, not arithmetic. So the dominant low-level wins are *fewer passes over the buffer* and *wider operations per pass*; cheaper-per-element tricks (shift/mask, LUTs, multiple accumulators) matter on the arithmetic kernels. The codebase is already good where it counts (`.set` is a memmove, the full-width stitch path is one contiguous copy) — these target the slow path and the per-pixel transforms the feature lenses would add.

**LOW-A (High) — Power-of-two tile sizes turn division and modulo into shift and mask.** Tile sizes are conventionally 2^k (256, 512); when so, `floor(x / tileSize)` is `x >> k` and `x % tileSize` is `x & (tileSize - 1)` — single-cycle bit ops replacing multi-cycle integer div/mod on the hot tiling path (SRCH-C grid range, SRCH-D Morton codes). _Fix:_ at open, detect a power-of-two `tileSize`, store `k = log2(tileSize)`, and use shift/mask in tile enumeration; keep a div/mod fallback for irregular sizes. Classic, exact, free.

**LOW-B (High) — Process rgba8 as 32-bit words: one `u32` is one pixel.** Any whole-pixel pass — fill, copy on the slow path, change-detection hash (PROB-E), equality/clear tests — iterates four bytes where it could iterate one word. A zero-copy `Uint32Array` view over the same buffer quarters the loop count and the load/store count (rgba16 → `BigUint64Array` or paired `u32`). _Fix:_ keep a `Uint32Array` alias alongside the `Uint8Array` and run whole-pixel operations through it. Alignment is satisfied for free — rgba8 row stride is `w*4`, always a multiple of 4 — but assert it before aliasing so a future odd layout fails loudly. The word-at-a-time win is the JS equivalent of using a wide register.

**LOW-C (High) — Fuse per-pixel passes so each pixel is touched once.** The risk as features land is a chain of full-buffer passes — decode → stitch → normalize/tensorize (LLM-D) → grayscale (LESS-C) → hash/sketch (PROB-E) — each re-reading and re-writing megabytes, and on a memory-bound kernel every extra pass is pure bandwidth lost. _Fix:_ make the stitch a single configurable transform pass — the requested conversions run inline during the one copy, so the buffer is traversed once. Loop fusion on a bandwidth-bound kernel is the highest-leverage low-level change here; it is also why LOW-B and LOW-C compound (one wide pass beats four narrow ones multiplicatively).

**LOW-D (Medium) — SIMD (wasm-simd128) for the genuinely arithmetic kernels.** Pure copy is already optimal, but resample/downscale (REV-B), grayscale (LESS-C), uint→float normalize (LLM-D), and histogram binning (PROB-D) are arithmetic-per-pixel and map to v128 lanes for a 4–16× speedup. These kernels live in WASM, so the work is in `bridge.cpp`; the JS layer's part is to feature-detect SIMD (`WebAssembly.validate`) and route to the SIMD kernel, padding row strides to the lane width so loads stay aligned. _Fix:_ SIMD pixel kernels behind a capability check (flagged as cross-boundary — the kernels are outside these three files).

**LOW-E (Medium) — Aggregate with lookup tables and multiple accumulators.** The fixed per-value transforms — uint→float-normalize for tensors (LLM-D), any gamma/colour map — are a 256-entry LUT lookup instead of a per-pixel multiply-add; and the reductions the probabilistic lenses want (sample mean/variance PROB-D, exposure histogram ASTRO-C, change sketch PROB-E) should use several independent bin accumulators to break the serial dependency chain and keep the pipeline full. _Fix:_ LUT the fixed maps (CLAUDE.md already tracks a pre-LUT sizing question), and unroll reductions across multiple accumulators. ALU-side wins that stack on top of the memory-traffic wins above.

**Throughline:** rank by the bottleneck — memory bandwidth first (LOW-C fuse passes, LOW-B/LOW-D widen each touch), then ALU (LOW-A shift/mask, LOW-E LUT/accumulators). The single highest-leverage item is LOW-C: as the LLM/photogrammetry transforms arrive, doing them inline during the existing stitch traversal — rather than as separate passes — is the difference between touching each pixel once and touching it five times. The SIMD and some LUT kernels live in WASM (`bridge.cpp`), outside the three files — flagged for implementation there, not asserted here.

---

## Lens 23 — high-level: standards, placement, platform

At the metal (L22) the question was cycles per pixel; from orbit it is architecture — what this module *speaks*, *where its work runs across machines*, and *what it is growing into*. These three files quietly reinvent a tiled multi-resolution image system, hardwire decode to the local client, and treat the pipeline as two fixed functions. Each is a system-level choice that could be opened up for large strategic leverage. (Directional by nature — these are architecture bets, not line fixes.)

**ARCH-A (High) — Speak an existing deep-zoom standard (IIIF / DeepZoom / XYZ map tiles), don't invent a bespoke addressing scheme.** Tiled multi-resolution image serving is a solved, standardized space: the IIIF Image API (gigapixel cultural-heritage imaging), DeepZoom/DZI (OpenSeadragon), and slippy-map XYZ/TMS (web maps) all define level + tile addressing with mature viewers, CDN tile servers, and annotation tooling. IIIF's `region/size` request semantics map almost 1:1 onto `decodeTiledViewportPooled(region)`. _Opportunity:_ keep JXTC as the storage container but make the *coordinate/addressing* scheme convertible to one of these standards — instantly inheriting an ecosystem (viewers, servers, measurement/annotation tools) instead of building each piece in-house. The biggest high-level win is the one that stops you writing code at all.

**ARCH-B (High) — Make decode *placement* a deployment strategy, not a hardwiring to client WASM.** The `RegionDecoder` seam (OWL-D) is the natural injection point for *where* a tile is produced: pre-rendered tiles from a CDN (zero client decode, instant first paint), edge-function decode (no client WASM, cheap cold start), or local WASM (offline-capable). For a gallery where many users view the same pyramids, a server/CDN tile cache amortizes one decode across thousands of viewers — the single largest systemic efficiency available, dwarfing any per-client optimization. _Opportunity:_ treat tile provenance as pluggable behind the existing decoder seam. This is L10 ("cheapest location") lifted from threads to the whole fleet — the cheapest place to decode a popular tile is once, upstream, for everyone.

**ARCH-C (Medium) — Architect the pipeline as a composable stage graph, so the whole review's feature set is additive rather than a tangle of flags.** OWL-D found two hardwired orchestrators; every feature lens since (LLM-D tensorize, LESS-C grayscale, PROB-E change-detect, LOW-C fused transform, ASTRO-C foveation) is really a *stage*. Bolted into `stitch` as options they become an unmaintainable switchboard; expressed as composable stages over a common contract (fetch → decode → transform → recognize → render) they compose cleanly and the LOW-C fusion becomes "fuse adjacent stages." _Opportunity:_ generalize the single `RegionDecoder` seam into a small stage pipeline. This is the architectural frame that lets the rest of this document be implemented without collapsing into complexity.

**ARCH-D (Medium) — Treat the pyramid as a content-addressed asset graph spanning the storage tiers, with progressive delivery over the wire.** The tile/level graph (SRCH-C) should be content-addressed (hash-keyed) so every tile and level is independently fetchable and cacheable at each tier — RAM, OPFS (jxl-cache), HTTP/CDN — and identical tiles across different images dedupe at the asset layer. Coarse-first should extend from *decode* order to *transport* order: the coarse level ships first over the network (FEM-A / L8 at the wire, tying the convergedByteEnd net-savings theme in memory). _Opportunity:_ content-address the asset graph and deliver it progressively. Note this *aligns* with CLAUDE.md rather than violating it — content-hash addressing is not the rejected sourceKey-dedupe caching (G2-1); it keys by content, so it cannot double-count, and jxl-cache stays content-agnostic.

**ARCH-E (Medium, product) — Design the coordinate/tile model to carry co-registered layers, not just pixels — the difference between a viewer and a digital-twin platform.** The photogrammetry / digital-twin consumers in memory need more than imagery over a coordinate space: measurements, annotations, ML detections (LLM-C/E), and change-over-time, all co-registered to the same tiles. If the tile graph (SRCH-C) is the shared spatial index, every such layer hangs off it with one consistent addressing model. _Opportunity:_ make the spatial model layer-bearing now (imagery is layer zero), so overlays are first-class rather than retrofitted. Architecting for layers early is what turns this decode pipeline into the substrate for an inspection/geospatial product.

**Throughline:** the macro levers are *what you speak* (ARCH-A standards → an ecosystem you don't have to build), *where work runs* (ARCH-B placement → decode-once-for-all-users, the fleet-scale form of L10), *how features compose* (ARCH-C stage graph → the whole review stays additive), and *what the data becomes* (ARCH-D content-addressed delivery, ARCH-E layer-bearing coordinate model → platform, not viewer). Highest leverage: ARCH-A and ARCH-B — one deletes work by adopting a standard, the other deletes work by decoding popular tiles once upstream instead of on every client. Both are decisions to make before the lower-level optimizations harden the current shape in place.

## Lens 24 — panorama mapping & stitching (Street-View scale)

The viewer treats the image as a flat cartesian plane (`ImageRegion {x,y,w,h}`,
`tilesOverlappingRegion`, contiguous-buffer stitch). A 360° panorama is not flat:
it is a projection (equirectangular / cubemap / cylindrical) wrapped on a sphere,
addressed in spherical coordinates (yaw / pitch / fov), and at Street-View scale it
is gigapixel, sparse, and panned continuously. Five findings, kept distinct from a
build-side stitcher.

**PANO-A (High) — longitude wrap seam is truncated, not wrapped.** `decodeTiledViewport`
clamps with `rx = min(max(0,x), width); rw = min(w, width - rx)` (decode-level.ts:100-104).
For an equirectangular 360° image x wraps: the column at `width` is adjacent to column `0`.
A viewport centred on the wrap meridian (looking "across" the image edge) is hard-truncated
to whatever sliver fits before `width`; the half living at `x = 0` is silently dropped.
`tilesOverlappingRegion` and `stitchTileDecodes` both assume a single contiguous x-range, so
a wrapped viewport cannot even be expressed. _Fix:_ projection-aware addressing — add a
`wrapX` flag to the tiled level source; when set and `region.x + region.w > width`, split into
`[x .. width]` and `[0 .. (x + w - width)]`, decode both (the pool already fans these across
workers), stitch side-by-side. Without it, no seamless pan through the 360°→0° meridian.
_Flag — verify:_ `wrapX` / projection kind must come from the pyramid manifest (outside the
3 files). Cross-ref ARCH-E (coordinate model), ARCH-A (IIIF carries a 360 hint).

**PANO-B (High) — for perspective rendering, do not pre-stitch into one flat buffer.** A pano
viewer renders a perspective viewport by inverse-projecting each output pixel (equirectangular
→ gnomonic) — a GPU shader job. The current path decodes the overlapping tiles, copies them all
into one contiguous RGBA buffer (`stitchTileDecodes`), and returns that flat buffer; the consumer
then uploads it to a texture and reprojects. The CPU stitch copy is wasted — the GPU resamples
from tiles directly and never needs them laid out contiguously. _Fix:_ add an unstitched
"tile set" return mode (tiles + regions, no copy) so the consumer uploads each tile into a
texture atlas and reprojects on the GPU. This fuses the stitch into the upload (cross-ref LOW-C
loop fusion, OWL-D decoder seam, ARCH-B placement — move the resample to the GPU, the cheapest
place). Keep the flat-stitch path for flat-map / non-projected consumers.

**PANO-C (Medium) — predictive prefetch on pan velocity; warm tile ring.** Street-View panning
has continuous angular velocity. The pool decodes exactly the requested viewport and discards the
tiles after stitch (TDP keeps no tile cache), so panning re-decodes the overlapping tiles every
frame and stalls whenever a new tile enters the viewport. _Fix:_ maintain a warm ring of decoded
tiles keyed by tile id around the current viewport, and prefetch in the direction of motion
(yaw/pitch velocity → predicted region) during idle pool capacity. Cross-ref Lens 15 sidereal
tracking (lead the target) and convergedByteEnd (ship next bytes before they are asked for). Needs
a tile-level LRU the pool does not have today.

**PANO-D (Medium) — equirectangular pole oversampling wastes decode.** In equirectangular
projection a single point at the pole is stretched across the entire top (and bottom) image row.
A uniform tile grid therefore decodes full-width tile rows near the poles that carry ~1 texel of
real information. `chooseLevelForTarget` and `tilesOverlappingRegion` are latitude-blind, so polar
viewports pay full tile cost for almost no detail. _Fix:_ latitude-aware tile selection — coarser
level / fewer tiles as |pitch| → 90° — or equal-area addressing (HEALPix-style, cross-ref Lens 15
ASTRO) so tile density tracks real angular detail. _Flag — verify:_ requires projection + latitude
metadata in the manifest (outside the 3 files).

**PANO-E (Medium, guard-rail) — viewer stitch must stay hard-copy; blending belongs to the
builder.** `stitchTileDecodes` hard-copies (`pixels.set`, no blend). This is **correct** for the
viewer: JXTC tiles are exact, non-overlapping cuts, so any feather/alpha blend at tile edges would
soften seams that must stay pixel-exact. A *panorama build* pipeline is the opposite problem — it
assembles **overlapping** source captures and genuinely needs feather / multiband blending,
exposure compensation, and seam (graph-cut) optimisation; that is a separate, ingest-side stitch.
_Guard-rail:_ do not "improve" `stitchTileDecodes` with blending — it would corrupt exact tile
boundaries (same class of mistake as the rejected output-pool / drain-callback proposals).
Build-side blending is a new module, not an edit to this function. Cross-ref Lens 15 ASTRO
co-addition (multi-pass capture merge) and PANO-B (which removes the copy entirely for the GPU path).

**Throughline:** the viewer's flat-cartesian model is the constraint. PANO-A (wrap) and PANO-D
(poles) are projection-correctness gaps; PANO-B (no pre-stitch for GPU) and PANO-C (predictive warm
ring) are the scale wins for continuous panning; PANO-E protects the one piece of stitch logic that
is already right. All converge on the same move as ARCH-E: lift addressing from `{x,y,w,h}` pixels
to a projection-aware coordinate model, and let the GPU — not a CPU contiguous copy — own the resample.

## Lens 25 — failure modes & resilience (FMEA sweep)

Every prior lens assumed the happy path completes. This one walks each failure
systematically: what happens when a decode throws, a worker hangs or dies, a tile
fails mid-fan-out, the view tears down, or the input lies. The two worker files have
almost no error machinery — these are the reliability gaps, sharpened past the
worker-death mentions in OWL-B / REV-A / SRCH-B.

**RESIL-A (High, bug) — `decodeWhole` leaks the WASM decoder on any error.** The
sequence is `await push; await close; await drain; await decoder.dispose()` (dispose at
decode-level.ts:42) with **no try/finally**. If `push`/`close` rejects, or the drain
IIFE throws (the decode-error branch at line 35 throws, or malformed input), `dispose()`
never runs and the libjxl session + its WASM heap allocation leak for the worker's
lifetime. A run of failed decodes bloats the worker until it OOMs. _Fix:_ wrap in
`try { ... } finally { await decoder.dispose(); }`. Single most concrete reliability bug
in the three files. _Flag — verify:_ that `facade` `dispose()` is idempotent / safe to
call after a failed `push` (outside the 3 files).

**RESIL-B (High, bug) — no worker timeout or error handler: a stuck tile wedges the whole
viewport.** `decodeTileWithWorker` posts a message and waits on a Promise that only a
matching `reply.id` resolves — there is **no timeout, no `worker.onerror`, no
`worker.onmessageerror`**. If a worker hangs (pathological libjxl input), crashes, or
drops the message, the Promise never settles, the per-call `onMessage` listener never
detaches (listener + closure leak per stuck tile), and `decodeTilesParallel`'s coro pool
blocks forever — the entire viewport decode hangs with no error surfaced to the user.
_Fix:_ race each tile against a deadline (AbortController / timeout); on timeout mark the
handle `bad`, recycle the worker, reject the tile. OWL-B / SRCH-B flagged the missing
handlers; this adds the deadline, the listener-leak, and the silent-wedge propagation.

**RESIL-C (Medium, feature) — graceful partial render instead of all-or-nothing.**
`decodeTilesParallel` sets `failed=true; break` on the first tile error; in-flight tiles
are neither awaited nor cancelled (cross-ref REV-A wasted work) and the caller gets a
thrown error — so one bad tile blanks the entire frame even when every other tile decoded
fine. For a gallery / Street-View pan that is a black screen from a single corrupt tile.
_Fix:_ collect per-tile results, render the successes, and fill each failed tile with a
placeholder — last-good from the PANO-C warm ring, or an upsample of the parent (coarser)
level (ARCH-D coarse-first into the hole) — and surface a partial-failure signal rather
than throwing. Bulkhead the failure to the one tile.

**RESIL-D (Medium, bug) — `destroyed` flag is dead code; teardown is a silent no-op →
worker + timer leak.** `PyramidWorkerPool` initialises `destroyed = false` and **never sets
it true**. Any guard reading it is dead; a teardown path neither stops `armIdleTimer`
reaps, nor prevents `acquire`/`prewarm` from spawning fresh workers after teardown. Because
the pool is a module singleton, navigating away from the gallery (SPA route change) leaks
all live workers in `all`, their idle timers, and the OS threads behind them — workers are
the most expensive resource here. _Fix:_ set `destroyed = true` on teardown; short-circuit
`acquire`/`prewarm` when destroyed; clear every idle timer; terminate every worker in `all`.
Cross-ref the module-singleton lifetime concern — the pool currently outlives the view that
created it.

**RESIL-E (Medium, security) — trust-boundary allocation: a lying header drives an
unbounded or overflowing alloc.** `stitchTileDecodes` allocates
`new Uint8Array(viewport.w * viewport.h * bytesPerPixel)`, and `decodeTiledViewportPooled`
derives its dimensions from `parseJxtcHeader(containerBytes)` over untrusted bytes. A
crafted/corrupt header reporting enormous width/height is a decompression-bomb (instant
OOM); worse, dimensions whose product overflows 2^32 wrap to a *small* buffer, and the
stitch row loop then writes out of bounds. _Fix:_ validate header dimensions against a sane
cap and check that `w * h * bpp` neither overflows nor exceeds a memory budget **before**
allocating; reject early. Cross-ref Lens 17 adversarial + DARK flags. _Flag — verify:_
`parseJxtcHeader` bounds live outside the 3 files — confirm whether it already caps dims.

**Throughline:** the worker layer is optimised for throughput and bare on failure. RESIL-A
(dispose leak) and RESIL-B (no timeout / wedge) are the two must-fix reliability bugs;
RESIL-D (dead `destroyed` flag) leaks the most expensive resource on teardown; RESIL-C turns
a single-tile failure from a black screen into a graceful degrade; RESIL-E closes the
untrusted-header alloc hole. Together they are the difference between a demo that works on
clean input and a viewer that survives flaky networks, hostile files, and real navigation.

## Lens 26 — security & resilience, second pass

Lens 25 covered dispose leaks, worker timeouts, partial render, teardown, and the
lying-header alloc (RESIL-A..E). This pass hits a different set of threat classes:
the *input boundary* the caller controls, *memory amplification* under fan-out,
*steady-state concurrency races*, *count* (not size) bombs, and *cancellation*.

**SEC2-A (High, security) — region input is never validated at the public boundary
(NaN / Infinity / fractional / negative).** `decodeLevel` → `decodeTiledViewport` clamps
the region with `Math.min/max` (decode-level.ts:100-104) but never checks
`Number.isFinite` / `Number.isInteger`. A `NaN` `region.x` propagates through the clamp
to a NaN or fractional viewport; `new Uint8Array(viewport.w * viewport.h * bpp)` then
coerces `NaN → 0` (silent empty frame) or a fractional length (truncated buffer → later
out-of-bounds row writes in `stitchTileDecodes`). The region originates from caller
viewport / zoom / pan math — a user-driven untrusted boundary **distinct from RESIL-E's
header dims**. _Fix:_ validate `region.{x,y,w,h}` are finite non-negative integers (floor
or reject) before clamping.

**SEC2-B (High, resilience / DoS) — the full container is cloned to every worker, per
tile.** `decodeTileWithWorker` posts `{ id, bytes, region }` with no transfer list and no
slicing, so the entire JXTC container is structured-cloned once **per tile**. Fanning N
tiles transiently holds ~(N+1)× the container: a 200 MB panorama across 8 tiles ≈ 1.6 GB
spike → OOM. Self-inflicted on large images, and an attacker-supplied large container
amplifies it. _Fix:_ send only each tile's byte range (slice via header offsets), or share
the container once through a `SharedArrayBuffer` (COOP/COEP gated) so workers read it in
place. Cross-ref the clone-vs-share representation finding and CLAUDE.md SAB gating.

**SEC2-C (High, resilience / concurrency bug) — reap ↔ acquire TOCTOU: an idle worker is
terminated out from under an acquirer.** The idle reap timer (`armIdleTimer` → `reap`) can
terminate a worker in `idle` at the same moment `acquire` selects it (or `release` returns
one). Nothing guards between the timer callback and acquire/release, so `acquire` can hand
out a worker the reaper is mid-terminating; the next decode posts to a dead worker and —
per RESIL-B — wedges with no timeout. _Fix:_ on `acquire`, pop from `idle` **and cancel
that worker's idle timer atomically** before handing it out; in `reap`, re-check the worker
is still idle and not already handed out before terminating. Distinct from RESIL-D (that is
teardown) — this is steady-state.

**SEC2-D (Medium, security / DoS) — unbounded tile *count* from the header.** RESIL-E capped
tile *dimensions*; a crafted header can instead declare a huge tile *count* for a region.
`tilesOverlappingRegion` then returns a massive array and `decodeTilesParallel` allocates
`new Array(tiles.length)` and spins that many coroutines and clones (compounding SEC2-B) —
a count bomb rather than a size bomb. _Fix:_ cap tiles-per-viewport and total tile count
against a sane bound before fan-out; reject early. _Flag — verify:_ tile-grid math / header
tile-count parsing lives partly outside the 3 files.

**SEC2-E (Medium, resilience) — no cancellation path; superseded viewports run to
completion.** No `AbortSignal` is threaded `decodeLevel → decodeTiledViewport →
decodeTilesParallel → worker`. During a fast pan (PANO-C) each new viewport starts a fresh
decode while the superseded ones keep occupying workers and cloning containers (SEC2-B) to
produce pixels nobody will draw — a request-storm self-DoS and latency collapse. RESIL-C
addressed cancel-on-*failure*; this is cancel-on-*supersede*. _Fix:_ accept an `AbortSignal`,
check it between tiles and before stitch, post a cancel to workers, and have the caller abort
the prior viewport when a new one starts (mirrors the scheduler's preemption model). Cross-ref
REV-A wasted work, PANO-C predictive ring.

**Throughline:** Lens 25 hardened the *failure* paths; this pass hardens the *input and load*
paths. SEC2-A guards the caller boundary the header guard (RESIL-E) does not reach; SEC2-B and
SEC2-D are the two amplification bombs (size already covered, now memory-per-tile and count);
SEC2-C is a real steady-state race the teardown fix (RESIL-D) does not touch; SEC2-E stops the
viewer from DoS-ing itself under exactly the panning workload PANO-C optimises for. Validate at
the boundary, bound every fan-out, make every long operation cancellable.

## Lens 27 — security at the trust-boundary level (systemic, not line-level)

Lenses 25–26 found line-level bugs and per-request bombs. This pass climbs to the
*trust model*: which actors these three files implicitly trust, what side channels the
caching/dedup design opens, how isolation and admission behave under a hostile or noisy
neighbour, and whether failures fail open or closed. Same subject, higher altitude.

**TRUST-A (High, side-channel / privacy) — decode latency + dedup form a cross-content
existence oracle.** If decoded tiles are cached (jxl-cache, PANO-C warm ring) and/or
deduped by content (scheduler `DedupeRegistry`, ARCH-D content-addressing), then decode
*latency* leaks whether a given tile/image was already decoded on this device or CDN edge.
Code that can invoke `decodeLevel` (or merely time it) for an attacker-chosen pyramid id
learns "has this exact private image been viewed here" — a history / existence oracle.
Hit-vs-miss timing is the observable, and the three files are where that timing is produced.
_Mitigation:_ scope caches per-origin / per-session so cross-context probing can't reach
another principal's entries; avoid content-keyed sharing across trust domains. _Flag —
verify:_ dedup is in the scheduler and the cache is outside the 3 files; the leak surfaces
here but the fix spans layers.

**TRUST-B (High, trust model) — worker replies are consumed as ground truth and the worker
script is unauthenticated.** Trust inventory of these files: container/header — untrusted
(RESIL-E/SEC2-D); caller region — untrusted (SEC2-A); **worker reply — trusted blindly**;
**worker script — loaded from a URL with no SRI**. The new point is the reply: `out.width` /
`out.height` from `decodeTileWithWorker` drive both the destination buffer size and the stitch
offsets in `stitchTileDecodes` (`dstOff` from `decoded.width` vs `viewport.w`). A buggy or
compromised worker returning dims that disagree with the requested tile region causes
out-of-bounds writes in the stitch loop. _Fix:_ validate every reply's `width`/`height`/
`pixels.byteLength` against the region that was requested **before** stitching; pin the worker
script same-origin / with subresource integrity. This is the *inter-component* contract, a
different level from any single input field.

**TRUST-C (Medium, isolation / multi-tenant) — the singleton pool reuses workers across
unrelated images with no bulkhead.** The pool is a module singleton (RESIL-D) shared by every
decode regardless of which image / origin / user triggered it. CLAUDE.md states workers are
stateless between sessions — but that is a contract the pool must *enforce*; today a worker
that processed a malicious or pathological tile and survived in a subtly corrupted state
(leaked libjxl heap, partial allocation) is handed straight to the next, unrelated decode.
Nothing recycles a worker after a *successful-but-suspicious* decode, only after an outright
failure. _Fix:_ recycle rather than reuse after any abnormal decode; for a multi-tenant viewer,
consider per-origin pools so one principal's input cannot influence another's decode. Cross-ref
RESIL-D (teardown) and SEC2-C (reap race).

**TRUST-D (Medium, availability / admission) — no admission control or memory budget at this
layer.** Each `decodeTiledViewportPooled` independently acquires workers and allocates buffers;
nothing bounds simultaneous in-flight decodes or aggregate memory. With SEC2-B (clone per tile)
and SEC2-E (no cancel), a burst — rapid pan, or a gallery mounting many thumbnails at once — has
no backpressure here; only the pool's `maxSize` caps *workers*, nothing caps memory or queued
viewport requests. _Fix:_ an admission gate / semaphore bounding concurrent decodes plus a memory
high-water mark before accepting new work. _Note:_ per CLAUDE.md, backpressure belongs at the
scheduler/worker boundary, and the current branch is `feature/sched-2-admission-gate` — so the
gate itself belongs in the scheduler; these three files only need to accept and propagate the
admission signal, not implement it.

**TRUST-E (Medium, posture) — failures fail *open* (silent plausible output) where security
wants fail *closed*.** Disposition survey: the region clamp coerces bad input into a valid-looking
tiny/empty viewport (SEC2-A) and proceeds; a dropped worker reply hangs instead of erroring
(RESIL-B); the whole-frame path can leak its decoder on throw (RESIL-A). The cross-cutting policy
gap: a security-sensitive decoder should *reject and surface* rather than emit a buffer of
uncertain provenance. _Fix:_ make the validation gates (SEC2-A region, TRUST-B reply, RESIL-E
header) hard-reject with a typed error rather than clamp-and-continue — fail closed by default.
This is the posture that ties A–D together, not a single line.

**Throughline:** the line-level passes asked "is this call safe?"; this one asks "who do these
files trust, and what do they leak or expose by trusting them?" The decoder implicitly trusts the
header, the caller, the worker reply, and the worker script — only the first two were previously
examined. TRUST-A is a genuine privacy side-channel from the caching design; TRUST-B closes the
reply/script trust gap that makes the stitch OOB reachable; TRUST-C and TRUST-D are isolation and
admission, both of which the singleton-pool architecture currently lacks; TRUST-E says: when in
doubt, fail closed. Highest leverage: TRUST-B (cheap, closes a real OOB path) and TRUST-A (the
only finding in this review that leaks *user data* rather than crashing).

## Lens 28 — ecological principles (the platform is a biodiversity system)

Context shift: this is a **botanical and zoological platform**, not a gallery. An
ecologist sees not pixels but populations, occurrences, habitats, succession, and
change over time. Stepping back to see the woods for the trees: the image pyramid is
a *habitat substrate*; the living value sits in the layers on top of it. This reframes
the whole review and sharpens the feature axis. Five findings.

**ECO-A (High, standards) — adopt IIIF because it *is* the natural-history-collections
standard, not merely a generic deep-zoom one.** ARCH-A argued "speak a standard"; the
domain makes the choice concrete. GBIF, iDigBio, herbarium consortia, and natural-history
museums publish digitised specimens — herbarium sheets, pinned-insect drawers, microscope
slides, camera-trap frames — through the IIIF Image API, and occurrence data through Darwin
Core. Speaking IIIF + Darwin Core plugs the platform into the global biodiversity data
fabric for free: import specimens from collections, export observations to GBIF, and reuse
the annotation / measurement / georeferencing tools botanists and curators already run
(e.g. OpenSeadragon-based viewers, GeoLocate). For *this* domain, ARCH-A is no longer
"nice to have" — it is the single highest-leverage decision in the review. In ecology,
isolated populations are fragile; connected ones thrive.

**ECO-B (High, feature) — the coordinate model must carry georeferenced occurrences as
first-class layers (Darwin Core over ARCH-E).** The imagery is the substrate; the value is
the *occurrence record* — which taxon, where, when, by whom, at what confidence —
co-registered to the pixels: a point on a herbarium sheet, a bounding box on a camera-trap
frame, a quadrat on a drone orthomosaic. ARCH-E's layer-bearing model should bind to Darwin
Core terms and, for landscape imagery, a real-world CRS — not just pixel coordinates. The
woods-for-the-trees reframing: the platform is a spatial biodiversity *occurrence* system
that happens to render images, not an image viewer that happens to show organisms. Every
"layer" finding (ARCH-E, SRCH-C spatial index) should be designed around occurrences.

**ECO-C (Medium, feature / efficiency) — sample like a field ecologist: don't decode the
whole stand to count the trees.** A botanist estimates cover with quadrats and transects,
not a full census. The probabilistic/sampling lens (Lens 21 Bloom/sampling/RANSAC, LESS-C)
*is* ecological sampling theory. For biodiversity counts over gigapixel imagery — canopy
species composition, nest or individual counts, percent cover — stratified tile sampling
(strata = habitat / region, exactly stratified quadrat sampling) yields population estimates
with confidence intervals at a fraction of a full decode. _Opportunity:_ expose density /
abundance *estimates with CIs* rather than requiring exhaustive decode + recognition. See
the wood (the population estimate) without decoding every tree (every tile).

**ECO-D (Medium, feature) — phenology and change-over-time as a first-class temporal
layer.** Ecology is intrinsically temporal: phenology (leaf-out, flowering), migration,
population trends, disturbance (fire, disease, deforestation, bleaching). PROB-E
change-detection plus a time axis on the coordinate model (ECO-B) turns the viewer into a
*monitoring* tool — same georeferenced site, repeat captures, detect and visualise change.
The pyramid's coarse level is ideal for a fast whole-landscape change scan; fine levels
confirm the changed patch (coarse-first as a survey strategy). Frame time as a layer, not a
separate viewer. Cross-ref ASTRO co-addition (repeat-pass capture) and the warm-ring PANO-C.

**ECO-E (Medium, resilience / efficiency) — design for the field: offline, low-power,
low-bandwidth, intermittent.** Ecologists collect data at remote sites — poor or no
connectivity, battery-limited tablets and phones, harsh conditions. This makes several
prior findings *domain-critical* rather than optional: full offline OPFS cache (must work
fully disconnected), coarse-first / convergedByteEnd (a usable preview over a weak signal),
an energy budget (fewer workers under battery / thermal limits — the pool's carrying
capacity should track power, not just core count), and resilient partial render (RESIL-C — a
flaky field link drops tiles constantly; show what arrived). The environment the *code* runs
in is itself a harsh field habitat; like organisms adapted to scarcity, build for it.
Cross-ref RESIL-C, convergedByteEnd, the mobile/energy concern, TRUST-D admission under load.

**Throughline (the woods):** this is not a gallery — it is a spatial-temporal biodiversity
**occurrence platform**. The image pyramid is the habitat substrate; occurrences (Darwin
Core), recognition (species ID), sampling (population estimates with CIs), and phenology
(change over time) are the living layers co-registered on the SRCH-C / ARCH-E spatial index;
and the whole organism must survive the field (offline, low-power, resilient). Highest
leverage: ECO-A + ECO-B — adopt the biodiversity standards and make occurrences first-class,
so the platform joins the existing ecological data ecosystem instead of being an island.
Everything else in this review is a tree; this is the wood.

## Lens 29 — photogrammetry, practically, at the decode level

Goal: blend multiple images of the same specimen from different perspectives — 2D
(a flat herbarium sheet shot in sections / focus stack / lighting set) or 3D (a bush,
a pinned-insect or museum object reconstructed in the round). Photogrammetry is a
fundamentally **multi-image** workload; these three files are **single-image** (one
container, one pyramid). The practical question is what the decode/tile/pool layer must
provide so a reconstruction stage above it can do the geometry. Five concrete moves.

**PHOTO-A (High, enabler) — generalise the pool from multi-tile to multi-*source*
fan-out.** The single biggest enabler. `decodeTilesParallel` fans the tiles of *one*
container across workers; photogrammetry needs the same region (or corresponding patches)
decoded from *N* source images. Add `decodeRegionAcrossSources(sources[], region | regions[])`
that fans `(source × region)` work items across the existing pool — the work items are
already independent, only the orchestration assumes a single container. This makes multi-view
a first-class workload with the pool you already have. _Critical pairings:_ SEC2-B (share each
container once via `SharedArrayBuffer` so an N-source fan-out does not structured-clone N×
large images — at multi-view scale the clone bomb is N times worse) and SEC2-D (cap total work
items = sources × tiles).

**PHOTO-B (High, efficiency) — let the reconstruction stage drive the pyramid level; the
pyramid *is* the SfM scale-space.** Structure-from-Motion feature detection and pose
estimation run on coarse images; dense Multi-View Stereo and texturing run on fine ones. You
do not detect keypoints at full gigapixel resolution — you detect at a manageable level, then
refine. `chooseLevelForTarget` already selects a level by target size, so expose per-stage
level selection: SfM requests a coarse level, MVS/texture requests fine, both from the same
pyramid with **no separate Gaussian-pyramid downsampling pass** (cross-ref Lens 19). The
practical strategy: coarse-level feature/pose first, then fine-level dense refinement only in
regions that matched — coarse-to-fine photogrammetry that the pyramid gives for free.

**PHOTO-C (Medium, efficiency) — decode keypoint / epipolar *patches*, not whole images.**
Matching and dense stereo need small windows around keypoints and along epipolar lines, not
full N-gigapixel frames. The region decoder (`decodeTileContainerRegionRgba8/16`) already does
ROI decode; expose a batched patch decode — many small, source-tagged windows — so the matcher
pulls only what it needs (windowed readout, cross-ref Lens 15 CCD and PANO-C warm ring). This
avoids ever decoding entire multi-view sets at full resolution. Cap patch count (SEC2-D).

**PHOTO-D (Medium, fidelity) — serve geometry-grade pixels (16-bit, linear, un-resampled),
distinct from the display path.** SfM/MVS accuracy is sensitive to pixel fidelity: keypoint
localisation and triangulated depth degrade under 8-bit quantisation, sRGB gamma, and stitch
resampling. The 16-bit region path (`bits === 16`) already exists — ensure the photogrammetry
stage receives full-bit-depth, linear-light, **non-stitched** (no resample) pixels, while the
viewer keeps its 8-bit sRGB stitched path. Geometry path ≠ display path. Cross-ref the fidelity
lens and PANO-B (hand unstitched tiles up; let the geometry stage own any resampling).

**PHOTO-E (Medium, architecture — 2D vs 3D) — emit source-and-coordinate-tagged tiles; keep
blending and reconstruction above this layer.** As with PANO-B/PANO-E, the decode layer's job
is to deliver coordinate-tagged tiles from multiple sources; the geometry differs above it and
must not leak down. For a **2D herbarium** sheet: planar homography alignment + focus-stack
merge → flat orthomosaic. For a **3D specimen**: SfM → MVS → mesh → texture projection. The
multi-view *blend* (visibility-weighted, multi-band, exposure-compensated) must **not** be
bolted into `stitchTileDecodes` — that stays exact-copy for the viewer (PANO-E guard-rail).
At this level emit `{ sourceId, region, level, pixels }` tiles; the 2D path warps them to a
common plane, the 3D path projects them onto the mesh. One decode contract feeds both
(ARCH-C composable stage graph).

**Throughline:** facilitating photogrammetry here is three moves — (1) multi-*source* fan-out
(PHOTO-A, which the pool almost already is), (2) use the pyramid as scale-space so stages pick
coarse-vs-fine (PHOTO-B/C), and (3) deliver geometry-grade, unstitched, coordinate-tagged pixels
while the reconstruction and blend live above (PHOTO-D/E). The decode layer becomes a multi-view
ROI server feeding a composable photogrammetry stage; 2D and 3D differ only above it. Connects
ECO-B (the resulting orthomosaic or textured mesh is itself a co-registered occurrence layer)
and ARCH-C (composable stages). The biggest unlock is PHOTO-A — without multi-source fan-out
there is no photogrammetry; with it, the rest is staging.

## Lens 30 — appearance & neural capture (focus, light, radiance fields)

Slightly different perspective on "blending multiple images of the same specimen": the
varying axis need not be *viewpoint*. It can be **focus**, **light**, or a learned
**radiance field**. These photometric and neural siblings of geometric photogrammetry
(Lens 29) often reveal the diagnostic surface detail taxonomists actually key on, at lower
capture cost than full 3D — and they all ride the same PHOTO-A multi-source decode and
PHOTO-D geometry-grade pixels, differing only in the fusion math above the decode layer.

**APP-A (High, feature) — focus stacking (multi-focus fusion) for shallow-DoF specimens.**
Pinned insects, pollen and diatoms under a microscope, and 3D-textured botanical parts have
a depth of field shallower than the specimen, so no single shot is all-in-focus. Capture N
images at stepped focal planes; per pixel pick the sharpest (focus measure — local contrast /
Laplacian variance) → an all-in-focus composite plus a coarse depth-from-focus map. At this
level it *is* PHOTO-A multi-source fan-out where the varying axis is focus, with PHOTO-D
fidelity (the focus measure wants linear, full-bit-depth, un-resampled pixels); the
sharpest-pixel fusion is a stage above decode (PHOTO-E / ARCH-C). No new decode primitive
beyond PHOTO-A/D. Output is itself a co-registered occurrence-layer image plus a depth map
(ECO-B).

**APP-B (High, feature) — RTI / multi-light: blend different *illumination* perspectives.**
Reflectance Transformation Imaging / Polynomial Texture Maps: fixed camera, N shots under
known light directions → a per-pixel reflectance model that relights interactively and yields
surface normals revealing microsculpture — insect cuticle, leaf venation, herbarium-label
embossing, specimen surface relief. This is the literal "different perspective" reading: the
perspective of the *light*. Same PHOTO-A multi-source decode (same region, N light-varied
sources), PHOTO-D fidelity (the reflectance fit needs linear light, full depth), fit performed
above decode. Heavily used in museum and natural-history imaging. Output: a relightable layer +
normal map (ECO-B occurrence layer) that surfaces diagnostic features for identification.

**APP-C (Medium, feature) — neural reconstruction (3D Gaussian Splatting / NeRF) as the modern
alternative to mesh MVS.** For 3D specimens — a bush, a museum object — 3DGS / NeRF reconstruct
a radiance field from multi-view and render photorealistic novel views, often handling thin,
translucent, or furry structures (foliage, fur, bristles) that mesh MVS reconstructs poorly.
Decode-layer implications: training ingests all views at consistent exposure and resolution
(PHOTO-A + PHOTO-D), coarse-to-fine training maps onto the pyramid (PHOTO-B), and **rendering a
novel view becomes a new kind of "decode"** — sampling the splat cloud / field on the GPU, the
inverse of PANO-B's reprojection. Frame novel-view rendering as a `RegionDecoder` variant
(OWL-D seam): a viewport request returns GPU-rendered pixels from the field instead of decoded
tiles. The reconstruction output is not a static image but a renderable field.

**APP-D (Medium, efficiency) — precompute correspondence at ingest: descriptors (and focus /
light calibration) as a sidecar.** A different angle on work placement (Lens 10): the expensive,
deterministic part of multi-image fusion — feature detection + descriptors for SfM, or per-shot
focus / light calibration — can run once at ingest and be stored in the pyramid manifest as a
sidecar, so per-session reconstruction skips detection and goes straight to matching / fitting.
The decode layer then serves precomputed descriptors alongside tiles (a new manifest layer).
Build-time once versus per-view every session. Cross-ref Lens 10 and ARCH-D content-addressed
graph. _Flag — verify:_ manifest / sidecar schema lives outside the 3 files.

**APP-E (Medium, quality) — confidence-driven re-decode: spend pixels where the reconstruction
is uncertain.** All three fusion families produce per-region confidence — focus-measure
ambiguity, reflectance-fit residual, reprojection error, NeRF/3DGS view-disagreement. Close the
loop: the reconstruction stage tells the decode layer which regions are low-confidence, and the
pool preferentially re-decodes those at a finer pyramid level or with more sources (active
sampling). This turns the decode layer from a passive server into a feedback-driven refinement
loop — decode where the model is unsure, not uniformly. Cross-ref ECO-C stratified sampling,
RANSAC, PANO-C predictive ring, and TRUST-D admission (bound the refinement work).

**Throughline:** "different perspectives" generalises beyond viewpoint to **focus** (APP-A
depth-from-focus), **light** (APP-B RTI), and **neural fields** (APP-C 3DGS/NeRF) — all riding
the same PHOTO-A multi-source decode and PHOTO-D geometry-grade pixels, differing only in fusion
math above the layer. Two cross-cutting accelerators: precompute correspondence at ingest
(APP-D, work-placement) and close a confidence-driven refinement loop (APP-E, active sampling).
For specimen imaging the photometric pair — focus stacking + RTI — is often *more* valuable than
full 3D: it reveals the surface detail taxonomists key on, at far lower capture cost. Every
output is a co-registered occurrence layer (ECO-B).

## APP-A / B / C — implementation expansion

Concrete implementation design for the three capture-fusion features, grounded in the
actual decode-layer seams (`RegionDecoder`, `PyramidWorkerPool`, `decodeTilesParallel`,
`stitchTileDecodes`, `chooseLevelForTarget`). The discipline from PANO-E / PHOTO-E holds
throughout: **the decode layer only delivers source-tagged tiles; all fusion lives above
it.** The modality (focus / light / view) is orthogonal to the decode contract — one API,
three fusion stages.

### Shared foundation — multi-source decode (PHOTO-A) + geometry-grade pixels (PHOTO-D)

All three features sit on one new decode primitive and one shared data model.

```ts
interface CaptureSource {
  id: string;                 // sourceId, tags every emitted tile
  level: LevelSource;         // this capture's own pyramid (tiled/whole)
  // exactly one of these is set, per modality:
  focusZ?: number;            // APP-A: focal-plane position (step index or mm)
  lightDir?: [number, number, number]; // APP-B: unit light vector
  pose?: { R: Float32Array; t: Float32Array; K: Float32Array }; // APP-C: extrinsics+intrinsics
}

interface CaptureSet {
  sources: CaptureSource[];
  modality: "multifocus" | "multilight" | "multiview";
}

interface SourceTile {            // emitted UN-stitched (PHOTO-E)
  sourceId: string;
  region: ImageRegion;
  level: number;
  decoded: DecodedLevel;          // linear 16-bit for fusion (PHOTO-D)
}
```

The decode primitive generalises `decodeTilesParallel` from "tiles of one container" to
"(source × tile) work items across the pool":

```ts
async function decodeRegionAcrossSources(
  set: CaptureSet,
  region: ImageRegion,
  opts: { bits?: 8 | 16; colorSpace?: "linear" | "srgb"; level?: number; signal?: AbortSignal },
): Promise<SourceTile[]>;
```

Implementation notes that keep it safe and bounded:
- Build work items = `sources × tilesOverlappingRegion(level, region)`; fan them across
  `PyramidWorkerPool` exactly as `decodeTilesParallel` already does, but each work item
  carries `sourceId`.
- **Share each container once via `SharedArrayBuffer`** (SEC2-B) — an N-source fan-out that
  structured-clones every container per tile is the clone bomb multiplied by N. Workers read
  in place.
- **Cap total work items** = `sources × tiles ≤ bound` (SEC2-D), and thread the `AbortSignal`
  so a superseded reconstruction stops mid-flight (SEC2-E).
- **Stream tile-by-tile.** Never hold all N sources at full resolution: fuse one tile across
  its N sources, emit the fused tile, free the inputs. This bounds memory at `N × tileArea`
  rather than `N × imageArea`.
- Request `bits: 16, colorSpace: "linear"`, and do **not** stitch (PHOTO-D) — the fusion math
  wants full-depth linear light, and stitching would resample. The 8-bit sRGB stitched path
  stays for the plain viewer.

In-scope for the three files: the fan-out orchestration, the `SourceTile` contract, level
selection. Above the layer (a new module / ARCH-C stage): every fusion algorithm below.

### APP-A — focus stacking: implementation

**Capture.** Fixed camera and viewpoint; N exposures stepping `focusZ` through the specimen
depth (pinned insect, pollen slide, hairy leaf). Focus breathing slightly scales each slice —
microscope rigs are usually pre-aligned; for camera rigs add a lightweight per-slice
translation/affine align before fusion (estimated on a coarse pyramid level — PHOTO-B).

**Decode.** `decodeRegionAcrossSources(set, region, { bits: 16, colorSpace: "linear", level })`
→ N `SourceTile`s for the same region.

**Fusion (focus measure → per-pixel selection).** For each pixel, score local sharpness in
each slice and pick the sharpest:
- Sharpness operators (cheap, per-pixel local window): variance-of-Laplacian, Tenengrad
  (Sobel-gradient magnitude), or sum-modified-Laplacian (SML). SML is a good default for
  specimen texture.
- `allInFocus[p] = slice[argmax_s sharpness_s(p)][p]`.
- `depth[p] = focusZ(argmax slice)` → a depth-from-focus / height map. Refine to sub-slice
  precision by fitting a parabola to sharpness vs `focusZ` over the 3 slices around the
  argmax.
- De-speckle the selection index (it is noisy at low-texture pixels): max-pool the index over
  a small window, then guided-filter it against the all-in-focus luminance to snap depth edges.
- **Halo control via the pyramid (ties PHOTO-B).** Naïve per-pixel selection halos at depth
  discontinuities. The standard fix is multi-scale (Laplacian-pyramid) fusion — and the JXL
  pyramid *levels* serve directly as that scale-space: decode each level, fuse per level, then
  collapse. No separate Gaussian pyramid build.

**Output.** An all-in-focus image (a new occurrence layer, ECO-B) plus a depth/height map (a
2.5D layer). For pinned insects the depth map gives usable pseudo-relief without full 3D.

**Placement & perf.** Focus measure and selection are embarrassingly parallel per pixel →
tile-parallel via the pool, with the inner operator in WASM + `wasm-simd128` (Lens 10 / LOW).
Memory bounded by tile-streaming. No decode-layer change beyond the shared foundation.

### APP-B — RTI / multi-light: implementation

**Capture & calibration.** Fixed camera and viewpoint; N (typically 24–60) exposures under
known light directions, from a dome or freeform with a reflective sphere in frame. Light
vectors are recovered from the sphere highlight at ingest and stored as `lightDir` per source
(APP-D sidecar) — the decode layer only consumes the metadata.

**Decode.** `decodeRegionAcrossSources(set, region, { bits: 16, colorSpace: "linear" })`.
Linear light is non-negotiable here — the reflectance fit is physically meaningless in sRGB.

**Fit (per-pixel model over the N samples).** Three options, increasing fidelity:
- **PTM (Polynomial Texture Map):** fit luminance `L ≈ a0·lu² + a1·lv² + a2·lu·lv + a3·lu +
  a4·lv + a5`, where `(lu, lv)` is the light direction projected to the image plane — 6
  coefficients per pixel by least squares over the N shots; chrominance stored separately.
- **HSH (Hemispherical Harmonics):** order-2/3 SH over the hemisphere — better on glossy
  surfaces than PTM.
- **Photometric stereo:** solve `I = ρ (N·L)` per pixel for albedo `ρ` and surface normal `N`
  (≥3 lights, Lambertian). **Robustify with RANSAC** per pixel to reject specular highlights
  and cast shadows as outliers (ties the PROB / RANSAC lens) — critical for shiny insect
  cuticle.

**Relight = a `RegionDecoder` variant.** Store the per-pixel coefficient maps (6× PTM, or
normal + albedo) as a relightable layer. Interactive relighting evaluates the polynomial / SH
per pixel for a chosen light direction in a GPU fragment shader — i.e. the "decode" of a
viewport is parameterised by a light vector and renders on the GPU (same shape as APP-C's
novel-view render, and the inverse of PANO-B). Specular-enhancement and raking-light modes fall
out of the normal map and reveal microsculpture — leaf venation, cuticle sculpture, label
embossing.

**Output.** A relightable coefficient/normal layer (ECO-B) — diagnostic surface detail
taxonomists key on. Effective on near-flat herbarium sheets as well as 3D specimens.

**Placement & perf.** The per-pixel fit is a tiny fixed-size least-squares (6×6 normal
equations, or 3×3 for photometric stereo) over N samples → tile-parallel in WASM; relighting is
GPU. Memory bounded by tile-streaming.

### APP-C — neural reconstruction (3DGS / NeRF): implementation

The heaviest feature; mostly above the decode layer, with two real decode-layer hooks
(training feed, render seam). 3D specimens only — for 2D herbarium, APP-A/B plus a homography
orthomosaic suffice.

**Capture & poses.** N multi-view images; camera poses from SfM (precomputed at ingest, APP-D).
3D Gaussian Splatting initialises a set of 3D Gaussians (position, covariance, opacity, SH
colour) from the SfM sparse cloud and optimises them by differentiable rasterisation against
the N views.

**Decode-layer hook 1 — training feed (coarse-to-fine via the pyramid).**
- Coarse-to-fine training is standard for NeRF/3DGS; the pyramid *levels* are exactly the
  resolution schedule (PHOTO-B). Start training at a coarse level (fast convergence, low
  memory), decode progressively finer levels as the field sharpens — **no separate image
  resize**.
- Stochastic training samples random rays/pixels per minibatch → decode only the patches the
  current minibatch touches (PHOTO-C patch decode), never whole gigapixel views. This is the
  key memory unlock for large inputs.
- Loss-driven sampling (APP-E): draw more rays where photometric loss is high.

**Decode-layer hook 2 — rendering a novel view IS a decode.** A trained field renders a novel
viewpoint by GPU splat rasterisation (3DGS) or ray-marching (NeRF). Wrap it as a
`RegionDecoder` variant:

```ts
function makeRadianceFieldDecoder(field: TrainedField): RegionDecoder {
  // (bytes ignored) — region + camera params drive a GPU render of the field
  return async (_bytes, region, camera) => renderFieldToRegion(field, camera, region);
}
```

Because it satisfies the same OWL-D seam `decodeTiledViewport` already uses, the viewer treats
a reconstructed specimen and a flat pyramid **identically** — it just hands a camera instead of
relying on tile resampling. Level-of-detail (3DGS supports it) maps onto `chooseLevelForTarget`
over splat density: zoomed-out → fewer/coarser splats.

**Storage & streaming.** The trained field (a splat cloud, tens of MB, or NeRF weights) is a new
asset in the content-addressed graph (ARCH-D), streamed coarse-first (a coarse splat set renders
immediately, then refines) — convergedByteEnd applied to geometry rather than pixels.

**Placement.** Training is offline / ingest-time and heavy — a native or GPU service, not WASM
(APP-D). Rendering is client GPU (WebGL / WebGPU) behind the `RegionDecoder` seam. The only
decode-layer additions are the field-backed `RegionDecoder` and the multi-source patch feed for
training.

### Cross-cutting

- **One decode API, three fusion stages.** `decodeRegionAcrossSources` does not know or care
  whether the varying axis is focus, light, or view — only the per-source metadata and the
  fusion stage above differ. That is the clean ARCH-C composition.
- **Placement.** New compute is the fusion kernel: per-pixel/per-tile focus measure and
  least-squares fits → WASM + SIMD; relight and field render → GPU. Decode stays the ROI server.
- **Memory.** Tile-stream every modality (fuse-emit-free per tile); share containers via SAB
  (SEC2-B); bound work items (SEC2-D); cancellable (SEC2-E); admission-gated (TRUST-D).
- **Outputs are occurrence layers (ECO-B).** APP-A → all-in-focus + depth; APP-B → relightable
  normal/coefficient maps; APP-C → a renderable field. All co-register on the SRCH-C / ARCH-E
  spatial index, and the photometric pair (A + B) often delivers more taxonomic value than full
  3D at a fraction of the capture cost.

## Lens 31 — HDR, shadows & highlights (the blown-sky problem)

Blown-out skies are the target. The honest first move is to locate *where* the highlight
detail is lost, because most of it is gone before these three files ever run — and no
decode-side trick recovers clipped data. Then: what the decode layer can do (carry the
bits), and where the problem is actually solved (local tone mapping on the pyramid). Five
findings, each tagged by layer.

**HDR-A (High, root cause — upstream of the 3 files) — blown sky is usually lost before
decode: clipped in RAW or quantised at encode.** `decode-level.ts` decodes already-encoded
JXL tiles to RGBA; if the sky was clipped during ORF/DNG→RGB in `src/lib.rs` (overexposure,
no highlight rolloff, and per the pipeline-baselines note the baselines are tuned to the
embedded JPEG — which itself clips), or quantised to 8-bit at JXL encode, the highlight
detail is **gone** and nothing downstream restores it. The fix must start upstream: process
RAW to scene-linear with highlight headroom (including per-channel highlight reconstruction
when only one or two channels clip) and **store the pyramid at ≥10–16-bit or float**, not
pre-baked 8-bit sRGB. _Flag — verify (outside the 3 files):_ `src/lib.rs` highlight handling
and the JXL encode bit-depth / transfer function in the pyramid builder. You cannot recover
what was clipped before encode — this is the precondition for everything below.

**HDR-B (High, decode layer — grounded in the 3 files) — carry HDR through decode; do not
pre-bake 8-bit.** The tiled path already preserves depth (`pickRegionDecoder(bits)`,
`decodeTileContainerRegionRgba16`, `bits === 16`). But `decodeWhole` hardcodes
`format: "rgba8"` (decode-level.ts:21), so a blown-sky landscape decoded **whole** collapses
to 8-bit sRGB even when the pyramid stored 16-bit — discarding the headroom a tone-mapper
needs. _Fix:_ let `decodeWhole` / `decodeLevel` request 16-bit linear when the display
pipeline will tone-map (mirror the tiled path's `bits` parameter). This is the one concrete
decode-file change for HDR: stop throwing away highlight bits at the whole-frame path.

**HDR-C (High, the real win — local tone mapping via the pyramid) — the pyramid *is* the
multi-scale decomposition tone mapping needs.** A hard global clip blows the sky; a global
curve crushes either sky or foreground. *Local* tone mapping compresses the bright sky while
preserving foreground contrast — and the standard algorithms (exposure fusion / Mertens,
local Laplacian filters, bilateral-grid, gradient-domain compression) all operate on a
Gaussian/Laplacian **pyramid**. The JXL pyramid levels already *are* that pyramid (cross-ref
PHOTO-B, and the multi-scale fusion in focus-stacking APP-A). _Opportunity:_ a tone-map stage
that decodes several pyramid levels and runs local-Laplacian / exposure-fusion highlight
compression — recovering sky gradient and cloud detail without darkening the canopy. The
decode layer already produces the levels; the tone-map is a stage above (ARCH-C) fed by the
existing multi-level decode. This is where blown sky is actually solved on the display side.

**HDR-D (Medium, display map) — replace the hard clip with a filmic / ACES highlight
shoulder.** Even mapping HDR to an 8-bit SDR display, use a tone curve with a soft highlight
shoulder (Reinhard, Hable/filmic, or ACES) rather than `min(255)`. A hard clip turns a
bright-but-detailed sky into a flat white patch; a shoulder rolls highlights off smoothly and
keeps cloud/gradient structure. Cheap, high-impact, lives at the display stage above decode.
_Important (per pipeline-baselines):_ do **not** raise the global `BASELINE_EXP_EV` to address
this — the baselines are global and tuned to the embedded JPEG, so a global exposure lift blows
*more* sky. Highlight handling must be a shoulder / local operation, never a global exposure
shift.

**HDR-E (Medium, sky-aware — ecology) — mask the sky / highlights and compress selectively.**
The problem is region-specific: the sky is a large bright region, the canopy or specimen is the
subject. A highlight mask (luminance threshold, or the recognition cascade's sky segmentation,
LLM-C) lets tone mapping compress the sky hard while leaving the subject untouched. For the
botanical/landscape use this is not aesthetic: photographing canopy gaps against bright sky for
leaf-area-index or canopy-cover estimates *requires* a recoverable sky/gap boundary — blown sky
destroys the measurement (ECO-C sampling, ECO recognition). _Flag:_ segmentation lives above the
3 files.

**Throughline:** blown sky is three stacked problems. (1) It is usually lost *upstream* before
these files run — fix the RAW clip and store a high-bit-depth pyramid (HDR-A); you cannot
recover clipped data later. (2) The decode layer must *carry* the HDR, not pre-bake 8-bit —
`decodeWhole`'s `rgba8` hardcode is the one real decode-file gap (HDR-B). (3) The display map
must compress *locally* — and the pyramid is exactly the decomposition local tone mapping needs
(HDR-C) — with a soft highlight shoulder (HDR-D), optionally sky-aware (HDR-E). The decode
layer's job is narrow: preserve the bits and serve the levels; the tone-map stage above does the
rest. Cannot be claimed fixed from code review — it must be measured on real sky shots in the
user's own viewer.

## Closing audit — memory & doc accuracy (2026-06-09)

A wrap-up pass over the persistent memory backing this review surfaced five items, recorded here
rather than fixed, at the reviewer's request. A sixth item updates this document itself.

1. **Highlight root-cause pointer is wrong, and now stale.** The `feedback-highlight-preservation`
   memory attributes the highlight clip to `src/lib.rs`. The clip is actually in
   `crates/raw-pipeline/src/pipeline.rs`, function `build_pre_lut` — `lib.rs` holds only test
   vectors. The memory also frames the clip as unfixed; it is not (see item 6). The path should be
   corrected and the fix noted, so the shoulder is not re-proposed in a later session.

2. **"EpicCodeReview" names three different artifacts.** (a) This document — a 31-lens manual
   review of `decode-level.ts`, `choose-level.ts`, `tiled-decode-pool.ts`. (b)
   `HANDOFF-jxl-progressive.md` plus branch `epiccodereview/20260608T133747Z` — an automated
   finder/fixer loop over `jxl-progressive`, paused at section 005. (c) A root-level
   `EpicCodeReview.md` from 2026-05-15 covering Rust/web. The `project-jxl-progressive-handoff`
   memory's "PAUSED at section 005" refers to (b), not this document — a reader can easily
   mis-map it onto the lens review. Memory should disambiguate the three.

3. **`project-decode-perf-impl` is a file:line implementation log that will rot.** Its A1/A3/B1/B3
   detail now lives in code and git history. The durable content is what was *not* done and why
   (A2 needs a nightly toolchain plus atomics; B2/B6 deferred) plus the build steps. It also
   carries a now week-old open question ("did the Docker build complete after 2026-06-02?"). It
   should be slimmed to the non-derivable parts.

4. **Slug mismatch.** `project-jxl-progressive-handoff.md` declares `name: jxl-progressive-handoff`
   (no `project-` prefix), so `[[project-jxl-progressive-handoff]]` wiki-links will not resolve to
   it. Other project memories keep file name and slug aligned.

5. **One flagged claim is stated as fact.** The same highlight memory asserts `decodeWhole`
   hardcodes `format: "rgba8"`. That was flagged for verification during the lens pass but not
   re-confirmed this session; the file lives in a worktree. It matches HDR-B below, but should be
   marked "verify before acting" until a fresh read confirms it.

6. **Doc-accuracy update — HDR-D is implemented.** Lens 31 lists the soft highlight shoulder
   (HDR-D) and the RAW-clip fix (HDR-A) as recommendations. As of 2026-06-09 the shoulder is in the
   code: `pipeline.rs` `build_pre_lut` now calls `highlight_shoulder(x)` — identity below a 0.80
   knee, then a C1-continuous asymptotic rolloff mapping `[knee, +inf)` into `[knee, 1.0)`,
   replacing the old per-channel hard clamp to 1.0. It feeds both the 8-bit and 16-bit output LUTs
   and compiles clean. HDR-B (`decodeWhole`'s 8-bit hardcode) remains open and now gates whether
   the recovered gradient is visible. Per standing rule this is **not** claimed fixed — it must be
   measured on real sky shots in the user's own viewer.

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

1. Re-enter worktree: `git worktree list` → `C:\Foo\raw-converter-wasm\.worktrees\jxl-pyramid-warm-pool`
2. Pick fix scope (recommend: critical + high + 16-bit propagation chain first)
3. Skill resume not native — dispatch fixers manually from `fix_briefs/*.json`

Stash carrying parked HANDOFF docs on the original branch: `stash@{0}: epiccodereview: park HANDOFF docs`

---

# Multi-Agent Implementation Plan (Grok 1-4)

This implementation plan coordinates four specialized agents (**Grok 1, Grok 2, Grok 3, and Grok 4**) to systematically implement the code fixes, refactors, and performance enhancements outlined in this review. Tasks are grouped strictly by the files they touch to avoid overlapping modifications or concurrency merge conflicts. 

Within files, responsibilities are distributed round-robin style to ensure efficient execution.

## Global Mandates & Rejection Protocol

Every agent must strictly adhere to the following rules:
1. **Validation & Type Safety:** Maintain strict TypeScript typing. Never use `any` or cast types unless absolutely required by a third-party boundary. Never use bracket notation `obj["private_field"]` to bypass type accessibility constraints.
2. **Rejection Clause / Posture:** If an assigned task or optimization would result in a net-negative impact (e.g., increased memory footprint, higher CPU overhead, API degradation, thread safety risks, or unnecessary complexity without empirical performance benefits), **reject the task immediately**. The agent must document the rejection by appending the proposal name, file, and concrete empirical/architectural reasons to:
   `c:\Foo\raw-converter-wasm\docs\rejected optimizations.md`
3. **No Direct Commits:** Implement the changes in the designated code workspace. Do not stage or commit files unless explicitly directed in a downstream agent prompt.
4. **Validation Suite:** Run the active unit tests and compilation checks (`npm run build`, `npm run test` or package-specific runners) to verify correctness after every modification.

---

## Agent: Grok 1
### Focus Files & Boundaries
*   `packages/jxl-pyramid/src/tiled-decode-pool.ts` (Core Pool Infrastructure, Lifecycle, and Memory Transport)

### Assigned Tasks (Round-Robin)

#### Task G1-A: Pool Lifecycle & Public Teardown API (High / Lens 2-A / RESIL-D)
*   **Context:** `PyramidWorkerPool` currently has no public teardown API, and its `destroyed` flag is dead code (never set to `true`). This leaks workers and active idle timers across SPA navigation, test suites, and hot module reloading.
*   **Instructions:**
    *   Export two clean, public lifecycle functions from `tiled-decode-pool.ts`: `prewarmPyramidPool(factory, opts?)` and `disposePyramidPool()`.
    *   Implement a public `destroy()` / `dispose()` method in `PyramidWorkerPool` that flips the `destroyed` flag to `true`, terminates all active and idle workers, clears all pending `armIdleTimer` timeout handles, and clears/nulls the process-wide module singleton.
    *   Update `acquire` and `prewarm` to immediately short-circuit with an error if the pool is in a destroyed state.
    *   *Rejection Check:* If a public teardown increases overhead or disrupts the process-wide singleton model unnecessarily, reject to `docs\rejected optimizations.md`.

#### Task G1-B: Encapsulation & Bracket-Access Cleanup (Low / Lens 2-A / Lens 2-B)
*   **Context:** Sibling methods in `tiled-decode-pool.ts` access private fields of `PyramidWorkerPool` using bracket notation (e.g., `pool["destroyed"]` and `p["minIdle"]`), defeating TypeScript’s compiler access checks and introducing fragile points that break during code refactoring.
*   **Instructions:**
    *   Refactor the class and helpers to eliminate all string bracket access to private members.
    *   Expose appropriate read-only public getters or package-internal access channels if these fields must be inspected by module-scoped factory functions.
    *   *Rejection Check:* If this cleanup degrades performance of the hot lookup path, reject to `docs\rejected optimizations.md`.

#### Task G1-C: Worker ID Routing & Collision Resolution (Medium / Lens 4-D)
*   **Context:** The `nextWorkerId` is module-scoped, global, and monotonic. Under dual-bundle loads or HMR, the counter resets, risking ID collisions and message mis-routing across separate active pool sessions.
*   **Instructions:**
    *   Scope the transaction/worker ID counter directly to the `PyramidWorkerPool` instance (re-initialized to zero upon pool instantiation/re-creation).
    *   Alternatively, manage routing by keeping a per-handle `Map<id, {resolve, reject}>` on each active worker handle, isolating the transaction space.
    *   *Rejection Check:* If localizing IDs adds measurable microtask latency on the hot decode path, reject to `docs\rejected optimizations.md`.

#### Task G1-D: Optimized Container Transport via Slicing or SAB (High / Lens 5-C / Lens 6-B / Lens 9-A / SEC2-B)
*   **Context:** Currently, the entire JXTC container bytes array is structured-cloned once per tile via `postMessage` (N times per viewport), introducing an extremely heavy O(N · containerBytes) memory and copy cost that often causes Out-Of-Memory (OOM) failures.
*   **Instructions:**
    *   Inspect `canUseParallelTileWorkers()`: if `crossOriginIsolated` is available and SharedArrayBuffer is permitted, share the container buffer once in place across workers.
    *   If SharedArrayBuffer is unavailable, slice the JXTC container per tile using `containerBytes.subarray(tileOffset, tileOffset + tileLength)` and include the slice in the `postMessage` transferable list. This reduces copy volume from N× full container to approximately 1× full container across the boundary.
    *   *Rejection Check:* If buffer slicing degrades the synchronous slicing cost on the main thread more than it saves on cloning overhead, reject to `docs\rejected optimizations.md`.

#### Task G1-E: Backpressure & Wait Queue on Acquire (Medium / Lens 2-A / TRUST-D)
*   **Context:** The pool has no queue mechanism when acquiring workers. If the active workers count reaches `maxSize`, the pool returns fewer/no workers, causing the caller to silently degrade immediately to single-WASM decode on the main thread.
*   **Instructions:**
    *   Add a FIFO waiter queue (`Promise`-based deferrals) to the `acquire` path of `PyramidWorkerPool`.
    *   Instead of immediate silent fallback to single-WASM main-thread decoding, allow callers to wait on available workers up to a configurable millisecond timeout.
    *   *Rejection Check:* If wait-queues introduce deadlocks or increase interactive frame latency during fast scrolling, reject to `docs\rejected optimizations.md`.

---

## Agent: Grok 2
### Focus Files & Boundaries
*   `packages/jxl-pyramid/src/tiled-decode-pool.ts` (Worker Concurrency, Safety, and Control)
*   `web/lightbox/tiled-decode-worker.js` (Worker Target Implementation)

### Assigned Tasks (Round-Robin)

#### Task G2-A: End-to-End 16-Bit Parallel Worker Decoding (Critical / Lens 1-C / Lens 6-C)
*   **Context:** The parallel worker path silently corrupts 16-bit tiled containers. The worker (`tiled-decode-worker.js`) unconditionally calls 8-bit decoding (`decodeTileContainerRegionRgba8`), and the stitch path defaults to a hardcoded 4-bytes-per-pixel stitch buffer.
*   **Instructions:**
    *   Update `tiled-decode-worker.js` to inspect the incoming tiles’ required bit depth (`bitsPerSample` / 16-bit flag) and execute `decodeTileContainerRegionRgba16` when appropriate.
    *   Update the worker message payload to carry a clear bit depth or bytes-per-pixel (`bpp`) indicator.
    *   Update the receiving stitch buffer allocation in `tiled-decode-pool.ts` to dynamically calculate buffer size and offsets based on the actual bytes-per-pixel (8 bpp for 16-bit; 4 bpp for 8-bit).
    *   *Rejection Check:* If 16-bit routing increases latency of the 8-bit happy path by more than 2%, reject to `docs\rejected optimizations.md`.

#### Task G2-B: Single-State Liveness Mapping & TOCTOU Race Prevention (High / Lens 4-A / SEC2-C)
*   **Context:** A worker handle's state is scattered across several booleans (`terminated`, `bad`) and three disjoint arrays (`all`, `idle`, `active`), which can lead to invalid states. Furthermore, an idle reaper timer can terminate a worker right as `acquire` is selecting it, causing messages to be posted to dead workers.
*   **Instructions:**
    *   Consolidate the liveness representation into a single, strongly-typed state field on the handle: `state: "idle" | "active" | "dead"`.
    *   In `decodeTilesParallel` coroutines, track the worker **handle** instead of the raw `WorkerLike` object, and verify that `handle.state !== "dead"` before dispatching each tile task.
    *   During `acquire()`, atomically pop the worker from the `idle` array and cancel its idle reaper timer immediately to prevent a Time-of-Check to Time-of-Use (TOCTOU) race.
    *   *Rejection Check:* If state consolidation introduces synchronization overhead or memory churn, reject to `docs\rejected optimizations.md`.

#### Task G2-C: Worker Death Rejection & watchdog Timeout (High / OWL-B / RESIL-B)
*   **Context:** Currently, if a worker crashes or hangs in WASM mid-decode, its pending promise never settles, causing `Promise.all` in `decodeTilesParallel` to hang indefinitely with no console errors or user feedback.
*   **Instructions:**
    *   Add proper `onerror` and `onmessageerror` event listeners to every spawned worker.
    *   Upon detecting worker death, error, or pool-enforced reaping, immediately locate and reject all pending tile promises associated with that worker.
    *   Implement a robust per-tile watchdog timer (e.g., 5-second deadline) in `decodeTileWithWorker`. If the worker fails to reply within the deadline, reject the promise, mark the handle `dead` / `bad`, and terminate the worker.
    *   *Rejection Check:* If watchdog timers introduce noticeable garbage collection pressure or overhead under rapid viewport updates, reject to `docs\rejected optimizations.md`.

#### Task G2-D: Viewport Abort & Concurrency Preemption (High / Lens 4-B / SEC2-E)
*   **Context:** Viewport decodes cannot be aborted. Fast panning or zooming causes older, superseded tile decodes to run to completion, clogging pool workers and degrading frame rates.
*   **Instructions:**
    *   Thread a standard `AbortSignal` parameter from `decodeTiledViewportPooled` through to `decodeTilesParallel` and `decodeTileWithWorker`.
    *   On abort, immediately stop scheduling any new tiles, reject all active/in-flight tile promises with a distinct `AbortError`, and release pool workers.
    *   Only return workers to `idle` once their active jobs have been confirmed as aborted or fully settled to prevent corrupted messages from bleeding into subsequent decodes.
    *   *Rejection Check:* If AbortSignal listener management causes memory leaks or delays worker reuse, reject to `docs\rejected optimizations.md`.

#### Task G2-E: Worker Message Verification (Medium / Lens 6-C / TRUST-B)
*   **Context:** Worker replies are trusted blindly. A compromised, out-of-sync, or buggy worker returning dimensions that disagree with the requested region can trigger out-of-bounds writes or RangeErrors in the stitch loop.
*   **Instructions:**
    *   Upon receiving a worker message, explicitly validate its parameters: assert `ok === true`, check that `width` and `height` match the requested region's expected dimensions, and assert `pixels.byteLength === width * height * bpp`.
    *   Reject the promise immediately if any boundary contract is violated.
    *   *Rejection Check:* If message assertion adds measurable latency to fast tile decoding, reject to `docs\rejected optimizations.md`.

---

## Agent: Grok 3
### Focus Files & Boundaries
*   `packages/jxl-pyramid/src/decode-level.ts` (Decode Spine, Stitching, and Format Transport)
*   `packages/jxl-pyramid/src/choose-level.ts` (Level Ranking and Zoom Selection)
*   `packages/jxl-pyramid/src/level-source.ts` (Level Source Types)

### Assigned Tasks (Round-Robin)

#### Task G3-A: 16-Bit Whole-Frame Support (High / Lens 2-G / DARK1-A)
*   **Context:** `decodeWhole` always hardcodes `format: "rgba8"` when creating the WASM decoder, which silently discards 16-bit detail and quantizes high-precision whole-level frames down to 8-bit.
*   **Instructions:**
    *   Carry `bitsPerSample` (or `bits: 8 | 16`) in the `"whole"` variant of `LevelSource` defined in `level-source.ts`.
    *   Refactor `decodeWhole` to accept a `bits` parameter, dynamically requesting `"rgba16"` when bits=16.
    *   Ensure the whole path in `decodeLevel` routes correct bit-depth options through to the WASM facade.
    *   *Rejection Check:* If 16-bit whole-level decoding degrades performance of the dominant 8-bit thumbnail path, reject to `docs\rejected optimizations.md`.

#### Task G3-B: Invariant try/finally Decoder Disposal (High / Lens 4-F / OWL-A / RESIL-A)
*   **Context:** In `decodeWhole`, the awaits on `push`, `close`, and `drain` occur in a flat sequential chain. If any throw an error (e.g., malformed JXL input), the function rejects before reaching `decoder.dispose()`, permanently leaking the WASM session state and heap memory.
*   **Instructions:**
    *   Wrap the entire decoder lifecycle inside `decodeWhole` within a strict `try/finally` block.
    *   Ensure that `await decoder.dispose()` is unconditionally invoked inside the `finally` block.
    *   Ensure any async errors thrown during the IIFE `drain` are caught and handled safely without leaving active Promises in-flight.
    *   *Rejection Check:* If try/finally structures introduce measurable microtask overhead on rapid, tiny thumbnail decodes, reject to `docs\rejected optimizations.md`.

#### Task G3-C: Stitching Deduplication, Export & Strength-Reduction (Medium / Lens 1-D / Lens 5-A / Lens 12-B)
*   **Context:** Sibling modules duplicate the entire stitching copy algorithm (`stitch` in `tiled-decode-pool.ts` vs `stitchTileDecodes` in `decode-level.ts`). Additionally, both loops perform expensive multiplications per row to calculate source and destination offsets.
*   **Instructions:**
    *   Deduplicate the logic. Export `stitchTileDecodes`, `pickRegionDecoder`, and `bppFor` from `decode-level.ts` (or place them in a small, shared internal `tile-geom.ts` module) and import them for reuse inside `tiled-decode-pool.ts`.
    *   Optimize the inner stitch copy loop using strength reduction: accumulate offsets sequentially with additive strides (`dstOff += dstStride; srcOff += srcStride`) instead of running per-row multiplications (`row * stride`) inside the tight loop.
    *   *Rejection Check:* If the shared geometry function adds call-stack overhead that slows down stitching, reject to `docs\rejected optimizations.md`.

#### Task G3-D: In-Thread Parallel Fan-Out Elimination (High / Lens 1-B / Lens 6-E)
*   **Context:** `decodeTiledViewport` implements an in-thread `Promise.all` parallel tile fan-out when workers are disabled. Because the synchronous WASM decoder is single-threaded, this parallel branch merely serializes the execution while adding heavy re-entry, allocation, and stitching overhead, making it strictly slower than a single-ROI decode.
*   **Instructions:**
    *   Remove the in-thread `Promise.all` fan-out branch entirely from `decodeTiledViewport`.
    *   Ensure the non-worker path always executes a single-ROI whole-viewport decode.
    *   *Rejection Check:* If removing in-thread tile slicing breaks backward-compatibility with custom region-decoder injectors, reject to `docs\rejected optimizations.md`.

#### Task G3-E: Level Selection Ranking & Jitter Hysteresis (High / Lens 1-E / Lens 9-B / SRCH-A / Lens 12-C)
*   **Context:** `chooseLevelForTarget` sorts the levels array by pixel area but queries by long edge, returning incorrect levels when area and long edge order disagree. It also copies, sorts, and linear-scans on every single pan/zoom frame, creating extreme GC churn.
*   **Instructions:**
    *   Align the sorting key with the query predicate: sort the levels array ascending by `longEdge` (and precompute/cache this sorted view instead of re-sorting on every call).
    *   Implement binary search over the pre-sorted `longEdge` array to find the smallest level where long edge >= target in O(log N) time.
    *   Add a simple `{ lastTarget, lastLevel }` memoization fast-path to immediately return the previously selected level if the target remains identical across frame ticks, bypassing the search entirely.
    *   *Rejection Check:* If caching or binary searching slows down static, non-scrolling level queries, reject to `docs\rejected optimizations.md`.

---

## Agent: Grok 4
### Focus Files & Boundaries
*   `packages/jxl-pyramid/src/tiling.ts` (Tiling Arithmetic and Format Header Parsing)
*   `packages/jxl-pyramid/src/manifest.ts` (Pyramid Manifest Structures)
*   `packages/jxl-pyramid/src/grid-layout.ts` (CSS Grid Calculations)
*   `packages/jxl-pyramid/src/fixtures.ts` (Fixtures and Package Exports)
*   `web/pyramid-gallery/image-store.js` (Web Boundary and Gallery State Store)
*   `packages/jxl-pyramid/test/...` (Pyramid Verification Test Suite)

### Assigned Tasks (Round-Robin)

#### Task G4-A: Boundary Hardening & Adversarial Header Parsing (Critical / Lens 37-51 / DARK2-A / DARK2-B / DARK2-C / SEC2-A / SEC2-D)
*   **Context:** `parseJxtcHeader` accepts arbitrary `uint32` fields (tileSize, dimensions, offsets) from raw, untrusted container bytes. A crafted container claiming `tileSize === 0` triggers division-by-zero, infinite loops, or OOM-inducing allocations (`new Array(Infinity)` or massive buffers) upon region clamping.
*   **Instructions:**
    *   Implement strict validation checks immediately within `parseJxtcHeader` at the boundary.
    *   Assert that `tileSize > 0`, image dimensions are positive, and total pixel count `w * h * bpp` is a safe, finite integer below a strict device-appropriate cap (e.g., 2^30).
    *   Ensure `bitsPerSample` is strictly verified as `8` or `16`.
    *   Ensure that all inputs to the `region` parameter of `decodeLevel` (`region.x`, `region.y`, `region.w`, `region.h`) are validated as finite, non-negative integers before clamping math is executed.
    *   *Rejection Check:* If validation checks add more than 1ms of overhead to standard header parsing, reject to `docs\rejected optimizations.md`.

#### Task G4-B: Grid Layout Aspect Ratio Guard & RowSpan Correction (Medium / Low / grid-layout.ts)
*   **Context:** `layoutFromIndex` divides by aspect ratios without checking if they are positive, finite numbers, causing divisions by zero or NaN to propagate. Additionally, the CSS rowSpan calculation contains a bug where base column width cancels itself out, leading to broken gallery grid proportions.
*   **Instructions:**
    *   Add defensive guards in `grid-layout.ts` to assert that `entry.aspect` is a finite number greater than zero. Fall back gracefully to `1.0` if invalid.
    *   Refactor the `rowSpan` formula so that base column width (`columnWidthPx`) is correctly factored into row dimensions rather than being mathematically canceled out.
    *   *Rejection Check:* If layout checks cause measurable lag when loading extremely large galleries (10,000+ items), reject to `docs\rejected optimizations.md`.

#### Task G4-C: Absolute Developer Path Removal (Medium / fixtures.ts)
*   **Context:** `fixtures.ts` exports absolute Windows directories (`c:\Foo\...`), leaking local development machine file paths into the public package bundle and types.
*   **Instructions:**
    *   Remove all hardcoded absolute Windows machine paths from `fixtures.ts`.
    *   Convert fixtures to use relative paths resolved dynamically at runtime, or feed paths through environment-aware configuration parameters.
    *   *Rejection Check:* If removing these fixtures breaks internal testing configurations, reject to `docs\rejected optimizations.md`.

#### Task G4-D: Web Gallery Manifest Schema Validation (High / web/... / image-store.js)
*   **Context:** `image-store.js` executes raw `JSON.parse` or fetches responses at the boundaries, casting them directly to `PyramidManifest` without runtime verification, leaving the web client vulnerable to unvalidated data schemas.
*   **Instructions:**
    *   Incorporate Zod or a lightweight, zero-dependency schema validation check at the manifest loading boundary in `image-store.js`.
    *   Assert structural integrity of the manifest properties (`levels`, `schema` version, image dimensions) before pushing the manifest into the active gallery state store.
    *   *Rejection Check:* If schema checks increase manifest loading times by more than 5%, reject to `docs\rejected optimizations.md`.

#### Task G4-E: Property-Based and Contract Verification (Medium / test/...)
*   **Context:** The existing tests in `packages/jxl-pyramid/test` utilize hardcoded values and lack property-based test suites to verify edge-case tile geometry, coordinate ranges, or end-to-end manifest-to-decode workflows.
*   **Instructions:**
    *   Add fast-check or custom property-based test cases in the test files to assert correctness of `tilesOverlappingRegion` and `chooseLevelForTarget` across randomly generated viewports, aspect ratios, and tile sizes.
    *   Write a robust, end-to-end contract test: generate a mock manifest via `pyramid-ingest`, read and parse it through `jxl-pyramid`, and execute a simulated tiled viewport decode using mock worker hooks, asserting pixel and alignment integrity.
    *   *Rejection Check:* If property tests increase CI execution times by more than 10 seconds, reject to `docs\rejected optimizations.md`.

