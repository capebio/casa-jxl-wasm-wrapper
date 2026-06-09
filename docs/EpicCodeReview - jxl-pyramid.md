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


---

# Lens 2 — Hot-path allocations

Pan/zoom UI fires `chooseLevelForTarget` + `decodeTiledViewportPooled`/`decodeTiledViewport` at frame rate. Each per-call allocation is multiplied by FPS × tile-count.

### L2-1. `decodeRegion` arrow allocated per call (pool)
- **Category:** perf
- **Issue:** `tiled-decode-pool.ts` L390-395: when `options?.decodeRegion` absent, a fresh `async (bytes, r) => {...}` closure + branch object is allocated on every `decodeTiledViewportPooled` invocation. Same closure for the entire lifetime of a given level.
- **Fix:** Hoist to module scope: `const _decode8 = async (b,r) => ...; const _decode16 = async (b,r) => ...; const decodeRegion = options?.decodeRegion ?? (bits===16 ? _decode16 : _decode8);` — zero per-call alloc.

### L2-2. `[...levels].sort` per UI frame (choose-level)
- **Category:** efficiency + speed
- **Issue:** L13 allocates new array + comparator call per UI frame; cite L1-3 / perf-a1b2c3d4.
- **Fix:** Drop the sort (manifest pre-sorted). Final code: `return levels.find(l => longEdge(l.w, l.h) >= targetLongEdge) ?? levels[levels.length - 1] ?? null;` — zero alloc per call.

### L2-3. `Promise.all(tiles.map(async ...))` per ROI (decode-level)
- **Category:** perf
- **Issue:** L114-119 `tiles.map` allocates intermediate array of Promises + closure per tile + `{region, decoded}` object literal per tile. For 16-tile viewport: 16 closures + 16 promises + 16 literals + 1 intermediate array per ROI.
- **Fix:** Restructure as preallocated `parts = new Array(tiles.length)` with a coroutine-style for-await loop (same shape as pool's `decodeTilesParallel`). Eliminates the intermediate Promise array and `.map`'s allocator chain.

### L2-4. Per-row `subarray` view in stitch fallback path
- **Category:** perf (low)
- **Issue:** Both files: partial-width tiles take `decoded.pixels.subarray(srcOff, srcOff+srcStride)` per row → 24-byte view object per row. For 1024-tall viewport with mixed-width tiles: ~1k view allocs per stitch.
- **Fix:** Two options. (a) Compute `srcOff` and `dstOff` and call `pixels.set(decoded.pixels.subarray(srcOff, srcOff+srcStride), dstOff)` — same as now; can't avoid subarray for cross-buffer offset+offset copy. (b) Use a worker-side packer that writes directly into a shared output offset (out of scope here). Accept; mark info. The current fast-path branch already wins for the common case.

### L2-5. `setTimeout(() => ..., ms)` closure per `armIdleTimer`
- **Category:** perf (low)
- **Issue:** L268: each release into idle arms a fresh arrow closure capturing `h`. Bounded by `maxSize` (≤8) but every release triggers it.
- **Fix:** Use `setTimeout`'s 3rd-arg passthrough: `globalThis.setTimeout(this._reapBound, idleTimeoutMs, h)` with a pre-bound `_reapBound = (h) => { if (this.idle.includes(h) && ...) this.reap(h); }` on the instance. Single closure for the pool lifetime.

### L2-6. `idle.includes(h)` linear scan per release
- **Category:** perf
- **Issue:** L227: `if (!this.idle.includes(h)) this.idle.push(h)` — O(idle) per worker returned. Already perf-c3d4e5f6. With minIdle=2 + bursty release: O(maxSize) per call.
- **Fix:** Track idle membership on the handle itself: `h.inIdle: boolean`. Set true on push, false on shift/reap. `if (!h.inIdle) { h.inIdle = true; this.idle.push(h); }`. O(1).

### L2-7. `new Array(tiles.length)` sparse pre-size (pool)
- **Category:** perf (engine-dependent)
- **Issue:** L333: `new Array(N)` creates HOLEY array. V8 transitions to dictionary mode for large holey arrays. Coroutines fill in random order (work-stealing) → never becomes PACKED.
- **Fix:** Use `[]` then `results.length = tiles.length`? Worse. Best: `Array.from({length: tiles.length}, () => null)` — PACKED, all slots `null` initially. Per-tile write replaces null with `{region, decoded}`. Marginal but real for large tile counts.

### L2-8. `parseJxtcHeader(containerBytes)` repeated per ROI
- **Category:** perf
- **Issue:** L381: cite L1-10 / perf-b2c3d4e5. 32-byte parse per ROI. Same bytes across pan/zoom on same level.
- **Fix:** WeakMap-cache (see L1-10). For Lens-2 purposes: same root cause as L1-2 (pool ignores manifest-known dims). Either fix removes the alloc.

### L2-9. `decodeWhole` IIFE async drain (decode-level)
- **Category:** perf
- **Issue:** L20-45: `createDecoder({...})` per call (mandatory — stream decoder), plus `(async () => { for await ...})()` IIFE allocates Generator + Promise. Three sequential awaits.
- **Fix:** Use the streaming API the same way but reuse a module-level `createDecoder` config object literal (saves one alloc per call): hoist `const WHOLE_DECODER_OPTS = Object.freeze({ format: 'rgba8', ... })`. Minor but free.

### L2-10. FEATURE: per-level `DecodePlan` cache
- **Category:** feature opportunity
- **Issue:** Every pan/zoom recomputes: clamped viewport, tile list, header parse, decodeRegion selection. All deterministic on `(LevelSource, region)`.
- **Fix:** Introduce `prepareDecodePlan(source, region) → { viewport, tiles, header, decodeRegion }` cached on the LevelSource (WeakMap). decode-level + pool both consume the same plan. Eliminates ~5 distinct hot-path allocs in one shot. Pairs with L1-1 extract-helpers refactor.

### L2-11. FEATURE: stitch buffer reuse across pan
- **Category:** feature opportunity (constrained)
- **Issue:** Output `pixels` alloc dominates byte cost: `viewport.w * viewport.h * bpp`. For 2048×1024×4 = 8 MB per stitch. Pan throws old pixels away.
- **Fix:** Caller-owned buffer: `decodeTiledViewportPooled(bytes, region, { outBuffer?: Uint8Array, ... })`. Caller maintains a single recyclable Uint8Array sized to viewport max. CLAUDE.md rejects pixel-buffer pool because *transferred* buffers detach — this is caller-owned, not transferred. Safe if caller commits to ownership semantics. Document the contract.

### L2-12. INFO: `decodeTileWithWorker` per-tile closure cost
- **Category:** info
- **Issue:** L74: per tile allocates new Promise + onMessage + onError + cleanup closures + `settled` flag. Inevitable for the request-response promise pattern. Mention only — bytes payload dwarfs this.


---

# Lens 3 - Worker protocol

Scope: `WorkerReply` union (L62-64), `decodeTileWithWorker` (L68-124), spawn/recycle wiring (L234-250), `decodeTilesParallel` driver (L323-364), implicit `web/lightbox/tiled-decode-worker.js` contract.

### L3-1. Request shape carries no `format` - worker hardcoded rgba8
- **Category:** critical bug
- **Issue:** Pool's `postMessage({id, bytes, region})` (L122) has no bits field. Worker calls only `decodeTileContainerRegionRgba8` regardless of source format. 16-bit tiled levels silently corrupt (cite logic-001 critical + L1-6).
- **Fix:** Extend request to `{id, bytes, region, format: 'rgba8'|'rgba16'}`. Worker switches on `format`. Pool passes `format: bits===16 ? 'rgba16' : 'rgba8'` derived once per level (see L2-1). Worker.js needs the parallel rgba16 decode wired.

### L3-2. No runtime validation of `WorkerReply` shape
- **Category:** bug
- **Issue:** L76-92 trusts `ev.data` as the typed union. A buggy worker sending `{id, ok:true}` (no pixels) crashes at `new Uint8Array(undefined)`. Untrusted-worker case (per security-d4e5f6a7) is plausible: extension-injected workers, dev-mode hot-swaps.
- **Fix:** Validate inside `onMessage`: check `typeof ev.data.id === 'number'`, `typeof ev.data.ok === 'boolean'`, then ok-branch requires pixels (ArrayBuffer or Uint8Array) + numeric width/height. Reject with `Error('malformed worker reply')` instead of crashing.

### L3-3. `pixels: ArrayBuffer` declared but `Uint8Array` posted - silent copy
- **Category:** perf bug
- **Issue:** L62-64 types `pixels: ArrayBuffer` but `web/lightbox/tiled-decode-worker.js:10` posts `out.pixels` (a `Uint8Array` view) with transfer of `out.pixels.buffer`. L86: `new Uint8Array(ab)` interprets the view as a length, copying contents. ~1 MB memcpy per tile. Comment at L80-83 lies about zero-copy (cite logic-004 + verified evidence).
- **Fix:** Either: (a) widen reply type to `pixels: ArrayBuffer | Uint8Array` and branch at receive - `ev.data.pixels instanceof Uint8Array ? ev.data.pixels : new Uint8Array(ev.data.pixels)`. (b) change worker to post `out.pixels.buffer` directly. (a) is safer - touches one file.

### L3-4. Container bytes structured-cloned per tile (no load/decode split)
- **Category:** perf
- **Issue:** L122 postMessage sends full `bytes` (multi-MB JXTC container) per tile. With 16 tiles x 4 workers, browser performs up to 64 structured clones of the same buffer. Code comment L117-121 acknowledges. SAB is the only zero-copy answer for fan-out and is out of scope per file.
- **Fix:** Protocol bump: `{type:'load', bytesId, bytes}` ONCE per worker (sent at pool.acquire time or first decode). Worker caches `Map<bytesId, Uint8Array>` (LRU, cap=4). Subsequent `{type:'decode', id, bytesId, region, format}` carries only ~24 bytes. Pool tracks `bytesId to workers warmed with it`. Worker pool gains a hot/cold acquire distinction.

### L3-5. No `cancel` message - in-flight worker tiles cannot be stopped
- **Category:** bug + missing feature
- **Issue:** Once worker has the request, it runs to completion. UI pan/zoom invalidates the viewport but worker keeps decoding the now-discarded tile. Caller-side reject is cosmetic.
- **Fix:** Protocol `{type:'cancel', id}`. Worker checks before posting reply (libjxl tile decode is non-interruptible mid-call per CLAUDE.md, so this is best-effort: skip the postMessage if cancelled, freeing main from receiving + memcpy). Pairs with L1-4 AbortSignal.

### L3-6. No worker readiness signal - prewarm cold-start invisible
- **Category:** bug
- **Issue:** L171-179 `prewarm()` synchronously creates workers and arms idle timer. Worker top-level `preloadJxlModule()` is async; first decode after prewarm still pays compile cost. Pool acquires the worker as if warm. (cite concurrency-014.)
- **Fix:** Worker posts `{type:'ready'}` once `preloadJxlModule()` resolves. `WorkerHandle` gains `ready: boolean`. Pool's `acquire()` skips not-ready handles (or returns a promise that resolves on ready). Idle-timer arms only after ready.

### L3-7. `onMessage` missing `settled` guard - late reply re-settles
- **Category:** bug
- **Issue:** L76-92 resolves/rejects without checking `settled`. `onError` (L94-99) does check. Asymmetric. Late message after error -> `cleanup()` runs twice + already-settled Promise gets a no-op resolve. Benign now, fragile if state expands.
- **Fix:** Add `if (settled) return;` at the top of `onMessage`. Hoist `settled` into closure (already is). One-line fix.

### L3-8. Poisoned worker stays in pool after silent fail
- **Category:** bug
- **Issue:** If a worker mis-reports (e.g., wrong-id reply, malformed shape) and `decodeTileWithWorker` rejects (after L3-2 fix), pool.release returns the handle to idle (L222 - only destroys if `terminated|bad`). Next caller gets the same bad worker.
- **Fix:** On reject in `decodeTileWithWorker`, mark handle as bad via callback into pool (`pool.markBad(worker)`). Or: `decodeTilesParallel` catches per-tile error and calls a pool-exposed `recycle(worker)` before the worker re-enters idle. Pool already has `recycle()` internal - promote to method or thread through error callback.

### L3-9. Worker error is opaque string - no taxonomy for recycle vs retry
- **Category:** feature
- **Issue:** L91 / L97 wrap `error: string` into `new Error(string)`. Caller cannot distinguish 'malformed bytes (worker is fine)' from 'OOM/crash (worker is poisoned)'. Caller in `decodeTilesParallel` (L349-355) bails out the whole slice regardless.
- **Fix:** Reply gains `error: { code: 'JXTC_PARSE'|'OOM'|'BAD_REGION'|'INTERNAL', message }`. Pool gets a `shouldRecycleOnCode(code)` policy. JXTC_PARSE -> caller bug, keep worker. OOM/INTERNAL -> recycle. BAD_REGION -> caller bug, keep worker.

### L3-10. Module-scope `nextWorkerId` not reset on dispose
- **Category:** bug (low)
- **Issue:** L66 monotonic across all pools. If pool is rebuilt (after L1-5 destroy/recreate), ids continue from the old counter. Late messages from the destroyed pool's workers - if not terminated yet - could collide with new-pool tile ids.
- **Fix:** Pool-instance counter: move `nextWorkerId` to `class PyramidWorkerPool` field, initialize 0 per instance. Combined with `destroy()` ensuring worker `terminate()` runs before new ids issued, late-message routing is impossible.

### L3-11. No reply timeout in protocol; only host-side timeout possible
- **Category:** bug
- **Issue:** Protocol gives the worker no deadline. Host-side timeout (per L1-4) rejects the Promise but the worker keeps churning, blocking pool slot until completion or termination. Cite concurrency-003.
- **Fix:** Include `deadlineMs?: number` in request. Worker tracks via `Date.now()` and self-aborts at next libjxl call boundary (best-effort, libjxl ROI decode is one call - so a timeout primarily benefits the cleanup case: worker observes deadline expired BEFORE running, replies `{ok:false, error:{code:'TIMEOUT'}}` instantly when host re-uses it).

### L3-12. FEATURE: progress / heartbeat for worker liveness
- **Category:** feature
- **Issue:** Pool has no liveness signal between request and reply. A worker stuck in libjxl (rare but possible - pathological JXTC) is indistinguishable from a worker doing legitimate slow work. Health monitor (concurrency-023) needs an input signal.
- **Fix:** Optional `{type:'progress', id, percent}` from worker at coarse intervals (e.g., post-decode-before-encode). Pool's monitor (introduced separately) marks workers silent for >N seconds as suspect. Low priority but unlocks adaptive timeouts.


---

# Lens 4 - Lifecycle + cancellation

Scope: `PyramidWorkerPool` class state machine (L141-302), module singleton (L304), `getOrCreatePool` (L306-321), `prewarm`/`acquire`/`release` (L171-230), `recycle`/`destroyHandle` (L252-301), and the end-to-end abort path (none currently exists).

### L4-1. `destroyed` flag never set true - all four guards are dead branches
- **Category:** bug
- **Issue:** L152 `private destroyed = false;`. Read at L172, 187, 222, 235, 307 but never assigned `true` anywhere in the class. `getOrCreatePool` uses `pool['destroyed']` (L307) to detect torn-down pools but the condition can never fire. Cite logic-006, contracts-015.
- **Fix:** Precondition for L4-2 destroy(). On its own: useless guard. Fix as part of the destroy() implementation.

### L4-2. No public `destroy()` / `dispose()` - singleton leaks across tests + HMR
- **Category:** bug + missing feature
- **Issue:** Module-scope `let pool: PyramidWorkerPool | null = null` (L304). No exported teardown. Test reload, gallery dismount, route change all leave the pool with active workers. Combined with L4-1, even attempting `pool['destroyed'] = true` does not terminate workers.
- **Fix:** Add `destroy(): Promise<void>` method: set destroyed=true, drain idle (call destroyHandle on each), abort active (per L4-3), wait for active set to drain or hard-terminate after grace period, then null the `handleByWorker` WeakMap entries. Export `disposePyramidWorkerPool()` that nulls the module singleton and awaits destroy().

### L4-3. No AbortSignal threading viewport-end-to-end
- **Category:** bug + missing feature
- **Issue:** `decodeTiledViewportPooled` options (L376) has no `signal?: AbortSignal`. Likewise `decodeTilesParallel`, `decodeTileWithWorker`. Pan/zoom invalidates the viewport but in-flight worker tiles keep running, holding pool slots, racing to deliver pixels the UI will discard. Cite concurrency-009, L1-4.
- **Fix:** Thread `signal: AbortSignal` through all three. `decodeTileWithWorker`: on `signal.aborted` reject immediately; on `abort` event during in-flight, call `worker.postMessage({type:'cancel', id})` (L3-5) and reject with `AbortError`. `decodeTilesParallel`: AbortController internal, aborted on first failure OR external signal -> sets `failed=true`. Pool slot released regardless.

### L4-4. `armIdleTimer` only arms just-released handle - older idles never reaped
- **Category:** bug
- **Issue:** L261-273: when a worker is released, the timer is armed for THAT handle only, and the `idle.length > minIdle` check is evaluated at arm time. Earlier-enqueued idle handles, released when count was <= minIdle, never get a reaper armed. They stay warm forever (which is fine), but they also do not get reaped when later releases push count above minIdle. Cite logic-005.
- **Fix:** Re-arm reaper for ALL idle handles above the floor when the floor is crossed. Or: track a single `excessReaperTimer` for the pool; cycle the oldest idle handle when fired. Simpler: on every release, scan `idle.slice(0, idle.length - minIdle)` and ensure each has a timer. With max=8, scan is trivially cheap.

### L4-5. `getOrCreatePool` binds first-seen workerFactory forever
- **Category:** bug
- **Issue:** L306-321: subsequent calls with a different `workerFactory` are silently ignored - the existing singleton is returned. Tests inject mock factories that the first production call already overrode; second gallery using a different worker URL gets the wrong worker. Cite logic-003, L1-5.
- **Fix:** Detect factory-identity change: store `boundFactory` on the pool instance; if `getOrCreatePool(factory)` sees a different factory function reference AND the pool has zero active decodes, transparently call `destroy()` and rebuild. If active > 0, throw `Error('cannot swap workerFactory while pool is busy')` so callers see the conflict.

### L4-6. Worker terminated mid-decode hangs the in-flight promise
- **Category:** bug
- **Issue:** `recycle(h)` (L252-259) calls `destroyHandle(h)` which calls `worker.terminate()` (L296). If a tile decode is in flight and the worker has its `error` listener fire (recycling itself) OR another caller's `destroy()` runs, the in-flight `decodeTileWithWorker` Promise never settles - the message listener is removed by cleanup() but the worker is gone before the message ever arrived. Cite concurrency-002.
- **Fix:** Track in-flight requests per handle: `WorkerHandle.inflight = Set<{id, reject}>`. On `destroyHandle`, before `terminate()`, reject every in-flight request with `Error('worker terminated during decode')`. Then `cleanup()` in decodeTileWithWorker is idempotent (already settled).

### L4-7. Permanent recycle listener accumulation on long-lived workers
- **Category:** bug (low)
- **Issue:** L242-248 adds `error` + `messageerror` listeners at spawn but never removes them. `destroyHandle` calls `terminate()` which is a hard kill - listeners drop with the worker. So per-worker accumulation is OK. BUT: if `bad=true` is set externally and the handle is recycled in-place (some future change), listeners stack. Cite concurrency-011.
- **Fix:** Store the bound `recycle` reference on the handle: `h.recycleListener = recycle`. On any path that detaches the worker without terminating (none exists today; would be needed if pool ever supports worker handoff), call `removeEventListener`. Defensive but cheap.

### L4-8. `minIdle` floor not maintained after `destroyHandle` drop
- **Category:** bug
- **Issue:** If a worker errors and `recycle` -> `destroyHandle` removes it, idle count may fall below `minIdle`. Pool does not respawn to restore the floor. Next acquire spawns under cap (good) but the warm guarantee was silently broken between events.
- **Fix:** After `destroyHandle`, if `!destroyed` and `idle.length < minIdle && all.size < maxSize`, spawn replacement and push to idle. Defer if spawn fails.

### L4-9. No supersede semantics - newer ROI does not preempt older same-level
- **Category:** missing feature
- **Issue:** Pan generates a stream of ROI requests for the same level. Older request is still in flight when newer arrives. Pool has no notion of 'cancel all in-flight requests for level X'. UI must wait for the stale decode + the new one.
- **Fix:** Optional: tag requests with a `streamId` (per-viewport). Pool exposes `cancelStream(streamId)` that aborts in-flight + drops queued for that id. Implementation rides on L4-3 AbortController per stream. Owner remains the caller (UI).

### L4-10. FEATURE: per-context pool instead of module singleton
- **Category:** feature
- **Issue:** Module-scope singleton (L304) means: one pool per realm. Multiple galleries on one page share workers tied to whichever loaded first. Worker URL drift across galleries (L4-5) and no scoping to per-tab Worker quotas.
- **Fix:** Expose `createPyramidWorkerPool(opts)` factory. Keep `getOrCreatePool` for backward-compat with default config. Galleries get isolated pools; tests get fresh pools; production keeps the convenience singleton.

### L4-11. No worker liveness timeout - health monitor input gap
- **Category:** bug
- **Issue:** Pool has no notion of 'worker has not replied in N seconds'. Combined with L3-11 (no protocol deadline), the stuck-worker case is invisible to the pool. Cite concurrency-023.
- **Fix:** Pool config: `requestTimeoutMs?: number`. On `decodeTileWithWorker` enter, schedule `setTimeout(timeout, ms)`; on settle, clearTimeout. On fire, reject + mark handle bad + recycle. Distinct from request-side `deadlineMs` (L3-11): this is pool's enforcement, that is worker's self-awareness.

### L4-12. `spawnOne` partial-failure orphans handle in `all` set
- **Category:** bug
- **Issue:** L234-249: handle is added to `this.all` (L238) and `this.handleByWorker` (L239) BEFORE the lifecycle listener wiring at L243-248. If `worker.factory()` succeeded but `addEventListener` throws (some test doubles fail here), the try/catch swallows it and the handle is in `all` with no recycle listener - it cannot self-heal on error. Cite concurrency-018.
- **Fix:** Register handle to `all`/`handleByWorker` AFTER lifecycle wiring succeeds. Move L238-239 to after L246. Or: on the addEventListener catch, `terminate()` the worker + skip the handle. Either is a 4-line change.


---

# Lens 5 - Error propagation

Scope: every throw, reject, catch, and silent fallback across the three files. Cross-cutting: error taxonomy + observability are zero.

### L5-1. `decodeWhole` leaks WASM decoder on push/close/drain throw
- **Category:** high bug
- **Issue:** decode-level.ts L20-45: `decoder.dispose()` at L42 only runs after L39-41 (`push`, `close`, drain) all succeed. Any throw skips dispose; the WASM heap stays allocated and the JS-side decoder reference is GC'd without releasing libjxl state. Cite errors-dl-dispose-leak.
- **Fix:** Wrap in try/finally: `try { await decoder.push(bytes); await decoder.close(); await drain; } finally { await decoder.dispose().catch(() => {}); }`. dispose is idempotent per existing decoder contract.

### L5-2. `decodeWhole` drain IIFE rejection becomes unhandled
- **Category:** high bug
- **Issue:** decode-level.ts L29-37: the `(async () => { for await ... })()` IIFE is started but not awaited until L41. If push() throws synchronously OR close() throws BEFORE drain settles, the drain promise rejects independently with no observer - browser logs `Unhandled Promise Rejection`. Cite errors-dl-drain-unhandled-rejection.
- **Fix:** Capture the drain promise once: `const drainPromise = (async () => {...})();`. After try/finally on push+close, ALWAYS await drainPromise inside a `.catch()` or `Promise.allSettled([drainPromise, ...])` to consume the rejection.

### L5-3. NaN region dimensions bypass empty-check + over-allocate
- **Category:** low bug + security adjacent
- **Issue:** decode-level.ts L100-105 (and pool L382-385): `Math.min/Math.max` propagate NaN. `rw <= 0` is false when rw is NaN (NaN comparisons return false). Code proceeds with NaN-sized viewport. `new Uint8Array(NaN * NaN * 4)` is `new Uint8Array(0)` per ECMA spec (NaN ToInteger -> 0) which then silently produces a zero-pixel result. Cite errors-dl-nan-region-bypasses-clamp.
- **Fix:** Guard region inputs at entry: `if (!Number.isFinite(region.x) || !Number.isFinite(region.y) || !Number.isFinite(region.w) || !Number.isFinite(region.h)) throw new Error('region values must be finite numbers');`. Single-line check at the top of decodeTiledViewport + decodeTiledViewportPooled.

### L5-4. `chooseLevelForTarget` silently accepts NaN/zero/negative target
- **Category:** low bug
- **Issue:** choose-level.ts L8-16: no validation of `targetLongEdge`. Negative or NaN -> `longEdge(l.w,l.h) >= targetLongEdge` is true for all l (or vacuously false for NaN); zero -> always picks smallest. Caller mis-passes a viewport metric and the picker silently delivers garbage. Cite errors-cl-divbyzero-zero-targetedge.
- **Fix:** `if (!Number.isFinite(targetLongEdge) || targetLongEdge <= 0) throw new RangeError('targetLongEdge must be a positive finite number');` at the top. Pair with L5-13 taxonomy if introduced.

### L5-5. `Promise.all` leaks in-flight tile decodes on first reject
- **Category:** high bug
- **Issue:** decode-level.ts L114-119: first rejecting tile aborts Promise.all but the other in-flight tile decodes continue racing to completion, consuming WASM heap until their final frame or dispose. No AbortSignal threading (cite L1-4, L4-3, concurrency-001).
- **Fix:** Replace Promise.all with the same coroutine pattern as pool's `decodeTilesParallel` (L323-364) and pre-wire AbortController. On first reject: signal.abort() -> subsequent iterations check signal.aborted before allocating + skip. Pairs with L4-3.

### L5-6. Four silent `catch {}` blocks in pool - failures invisible in prod
- **Category:** medium bug cluster
- **Issue:** tiled-decode-pool.ts L106-108, L114-116 (decodeTileWithWorker listener removal/attach), L246-248 (spawnOne listener attach), L209-211 (spawnOne factory call), L297-300 (terminate). All swallow without logging. Spawn-fail (logic-007, errors-tdp-spawn-fail-silent) is the most dangerous - pool silently degrades to fewer workers and caller hits the fallback path with no telemetry.
- **Fix:** Introduce a single `onError(scope: string, err: unknown)` hook on the pool, default = `console.warn`. Replace all 4 silent catches with `catch (e) { this.opts.onError?.('spawn-failed', e); }` etc. Caller can wire to Sentry / structured logger. Pairs with L5-12.

### L5-7. Worker error wraps a string - root cause discarded
- **Category:** medium bug
- **Issue:** tiled-decode-pool.ts L91: `reject(new Error(ev.data.error))`. The worker likely had a real Error with stack + name; serializing to string strips both. Caller's catch sees only the message; no programmatic discrimination possible. L97 has similar pattern (`ev?.message || ev || 'unknown'`).
- **Fix:** Worker should post `{ok:false, error:{code, message, stack?}}` (cite L3-9). Receiver constructs `Error` from message, attaches `code` + `cause`: `const err = new Error(ev.data.error.message); (err as any).code = ev.data.error.code; reject(err);`. Modern JS Error supports `cause` option: `new Error(msg, { cause: { code } })`.

### L5-8. `decodeTilesParallel` keeps only firstErr - others lost
- **Category:** low bug
- **Issue:** tiled-decode-pool.ts L335-355: `let firstErr: unknown = null;` records only the first failure. Other workers see `failed` flag and exit their slice without their errors propagating. If two workers fail near-simultaneously (e.g., cascading OOM), only one is reported.
- **Fix:** Aggregate via `AggregateError`: collect errors per-coroutine into `const errors: Error[] = []`. On Promise.all completion, if errors.length > 0 throw `new AggregateError(errors, 'tile decode failed')`. Match Node + modern browser API. Caller can inspect `.errors`.

### L5-9. `release()` in `finally` masks decode error
- **Category:** low bug
- **Issue:** tiled-decode-pool.ts L420-425: `try { ... await decodeTilesParallel(...); return stitch(...); } finally { p.release(liveWorkers); }`. If release() throws (synchronous mutation on this.idle/this.active - normally cannot, but could after future destroyed mutation), the thrown release error replaces the in-flight decode error. Cite errors-tdp-finally-release-mask-error.
- **Fix:** Wrap release in try/catch and surface via onError hook (L5-6): `} finally { try { p.release(liveWorkers); } catch (e) { p.opts.onError?.('release-failed', e); } }`. Decode error propagates cleanly.

### L5-10. Generic Error everywhere - no taxonomy
- **Category:** info opportunity (cross-file)
- **Issue:** Across all three files, every throw is `new Error(string)`. Callers cannot distinguish 'budget exceeded' from 'malformed bytes' from 'pool destroyed' from 'AbortError'. UI cannot decide retry vs surface vs ignore. Cite errors-opp-no-error-taxonomy.
- **Fix:** Introduce a tiny `errors.ts` with `class PyramidError extends Error { constructor(code: PyramidErrorCode, msg: string, cause?: unknown) { ... } }` + `type PyramidErrorCode = 'EMPTY_REGION'|'BAD_REGION'|'NO_FINAL_FRAME'|'WORKER_FAILED'|'POOL_DESTROYED'|'ABORTED'`. Replace all `new Error(...)` with `new PyramidError(code, msg)`. Caller switches on `err instanceof PyramidError && err.code === ...`.

### L5-11. Zero logging - pool degradation invisible
- **Category:** info opportunity
- **Issue:** tiled-decode-pool.ts has no `console.*` or logger anywhere. Spawn failure, factory rebind ignore, listener-attach failure, terminate failure all silent. In a customer report `pyramid feels slow' there is no trace evidence to triage. Cite errors-opp-no-structured-logging.
- **Fix:** Inject a logger interface at pool construction: `opts.logger?: { warn(msg, ctx), info(msg, ctx) }`. Default = no-op (no console noise). Wire to events: spawn-failed, recycled, prewarm-completed, fallback-to-single. Production wires to structured logger; tests assert on calls.

### L5-12. No retry on transient worker failures
- **Category:** info opportunity
- **Issue:** First tile failure aborts the whole viewport decode (L5-8). Some failures (transient WASM heap fragmentation, momentary OOM at large tile) succeed on retry with a fresh worker. Cite errors-opp-no-retry-utility.
- **Fix:** After L5-7 error taxonomy: `decodeTilesParallel` could re-queue tiles whose error code is `RETRYABLE` (OOM, INTERNAL) onto a fresh worker, up to N attempts per tile. Stop on `BAD_REGION` or `JXTC_PARSE` (caller-cause errors don't retry). Caller opt-in via `opts.retryPolicy?: {maxAttempts}`. Conservative default = no retry.

### L5-13. Asymmetric region contract in `decodeLevel`
- **Category:** low bug
- **Issue:** decode-level.ts L130-137: `kind='whole'` + region -> throw `'region decode requires a tiled level source'`. `kind='tiled'` + no region -> silently defaults to `{x:0, y:0, w:source.width, h:source.height}`. The two kinds have opposite tolerances for the same argument absence/presence. Cite contracts-013.
- **Fix:** Symmetrize: `kind='whole'` + region -> ignore region (default to full image, log via L5-11 logger) OR throw both directions. Picking one: if region is undefined OR full-image, accept; if a strict sub-region with kind=whole, throw. Document in JSDoc.


---

# Lens 6 - Memory + GC pressure

Scope: large allocations on hot path, persistent retention (pool handles, workers, WASM heap), structured-clone amplification across worker boundary, and detached-buffer semantics. CLAUDE.md rule respected: transferred output buffers cannot be pooled - only caller-owned (untransferred) buffers can.

### L6-1. Stitch output buffer = `viewport.w * viewport.h * bpp` per ROI
- **Category:** perf + efficiency
- **Issue:** decode-level.ts L65 and tiled-decode-pool.ts L41: a fresh Uint8Array is allocated per stitch. For a 2048x1024 viewport at rgba8 that is 8 MB; rgba16 is 16 MB. At 30 fps pan, that is ~240 MB/s churn of large buffers, putting heavy pressure on the GC's old-generation promotion.
- **Fix:** Caller-owned buffer (cite L2-11). decodeTiledViewport(Pooled) gains optional `outBuffer?: Uint8Array` arg sized to the largest viewport the caller intends to use. Caller maintains a single buffer per gallery, recycles across pan/zoom. Safe because the buffer is NOT transferred to a Worker (CLAUDE.md rejection applies only to transferred pools).

### L6-2. Worker-side memory spike from N-cloned container bytes
- **Category:** perf
- **Issue:** Per-tile `postMessage({bytes, region})` (L122) structured-clones the full JXTC container into the receiving worker's heap. For 4 workers x 16 tiles = up to 64 clones held simultaneously across worker heaps (each tile completes asynchronously). At 64 MB container that is up to 256 MB peak across worker process memory before tiles drain. Browser memory pressure events trigger before this happens, but pan latency spikes.
- **Fix:** L3-4 load/decode split eliminates this entirely - each worker receives the container ONCE and reuses across all its tiles. Memory becomes (workers x container) = 4 x 64 MB = 256 MB STEADY-STATE (vs same peak but spike). Better characteristic; bounded. Combined with worker LRU cap of 1 hot bytesId, can drop to 4 x 64 MB across pan. Worker can also cache only a region-of-interest slice when crop is small.

### L6-3. `parts[]` retains decoded tile pixels until stitch
- **Category:** perf
- **Issue:** tiled-decode-pool.ts L333 + L347: each `{region, decoded}` entry holds a per-tile Uint8Array (tile_w x tile_h x bpp bytes). Held in main-thread memory until decodeTilesParallel returns and stitch consumes. Peak = (viewport pixels) + (sum of tile pixels) = ~2x viewport memory.
- **Fix:** Stream-stitch: pass a `stitchSink(tile, region)` callback into decodeTilesParallel. As each tile resolves, write into outBuffer at the right offset and immediately drop the tile reference (`results[idx] = null` or skip storing entirely). Eliminates parts[] retention. Peak drops to (viewport pixels) + (1 tile at a time per worker) = viewport + few-MB.

### L6-4. `worker.terminate()` is async - spawn/destroy churn under pan can spike RSS
- **Category:** perf
- **Issue:** destroyHandle (L296) calls terminate(); the worker process/thread is reclaimed by the browser at an indeterminate time. Each worker carries ~10 MB WASM heap. Under pan-churn that triggers minIdle-floor violations + spawn-replacements (L4-8), resident memory can compound for hundreds of ms before terminated workers' memory is freed.
- **Fix:** Conservative: lengthen idleTimeoutMs from 5s to 30s so under bursty pan the floor is more stable. Aggressive: replace terminate with reuse - keep a 'cooldown' pool of bad-but-not-yet-discarded workers; reset their internal state via a `{type:'reset'}` message. Skip if reset is unreliable - JXL WASM state machine is not trivially resettable.

### L6-5. `new Uint8Array(typed)` is the copy constructor - silent memcpy per tile
- **Category:** perf bug
- **Issue:** L86: receiver does `new Uint8Array(ev.data.pixels)` where `ev.data.pixels` is a Uint8Array view (the worker posted the VIEW, transferred the BUFFER). Per ECMA spec, `new Uint8Array(typedArray)` allocates a new buffer and copies. ~1 MB extra per tile. The L80-83 comment explicitly claims zero-copy. Cite logic-004 / L3-3.
- **Fix:** Already covered in L3-3: widen WorkerReply.pixels to `Uint8Array | ArrayBuffer`; receive-side: `const px = ev.data.pixels instanceof Uint8Array ? ev.data.pixels : new Uint8Array(ev.data.pixels);`. Uint8Array passthrough is zero-copy (just structurally cloned bookkeeping).

### L6-6. `containerBytes` per-level retention is implicit
- **Category:** info opportunity
- **Issue:** Caller (pyramid-lightbox or similar) holds containerBytes for the active level. Multi-level prefetch can stack N levels' worth of containers in main heap. No coordination with the pool: pool does not know which containers are hot.
- **Fix:** Out of scope for this file cluster (lives in level-source.ts / caller). Note: combined with L3-4 bytesId protocol, the pool could expose a hint - `pool.notifyContainerHot(bytesId)` so workers' load-cache prioritizes. Architectural; ADR-worthy.

### L6-7. Sparse `new Array(N)` triggers V8 holey-array transitions
- **Category:** perf (engine-dependent)
- **Issue:** L333: `new Array(tiles.length)` creates a HOLEY array. Coroutines fill in arbitrary order (work-stealing) so the array stays holey throughout. V8 keeps holey arrays in a slower 'dictionary mode' representation for larger N. With tiles.length > 50 (mega-pano levels) this is observable.
- **Fix:** Cite L2-7. Use `Array.from({length: tiles.length}, () => null)` - PACKED initial state. Or, with the L6-3 stream-stitch fix, parts[] disappears entirely and this becomes moot.

### L6-8. Idle-timer closure retention is fine - confirm boundary
- **Category:** info
- **Issue:** L268: `setTimeout(() => {...}, idleTimeoutMs)` captures `h`. While timer is armed, h is reachable from the timer queue. On clearIdleTimer (called by acquire/destroyHandle/armIdleTimer itself), the timer is cancelled and the closure becomes unreachable. No leak. Confirm and move on.

### L6-9. `recycle` listener strongly couples handle <-> worker
- **Category:** info (intentional)
- **Issue:** L242-248: `recycle = () => this.recycle(h)` captures `h`. Worker holds `recycle` via addEventListener. h holds worker via h.worker. Bidirectional strong refs - but BOTH become unreachable simultaneously when destroyHandle removes h from all/idle/active sets AND terminates worker. No leak. Intentional. Worth a comment in the file so future-self does not 'fix' it.
- **Fix:** Annotate L234-249 with `// h <-> worker is a deliberate cycle, broken atomically by destroyHandle`. Defensive doc, no code change.

### L6-10. FEATURE: explicit pool memory budget
- **Category:** feature
- **Issue:** Pool sizes itself by hardwareConcurrency capped at 8 (L310). Independent of available RAM. On a 64-core machine with 4 GB RAM and 10 MB-per-worker WASM heap, 8 workers + idle ~80 MB; OK. But future tier-2 pool variants (denoise, color, etc.) compound. No mechanism for pool to throttle.
- **Fix:** Config: `opts.estimatedWorkerHeapBytes?: number`. Optional `opts.maxTotalHeapBytes?: number`. spawnOne checks budget before factory(). Falls back to single-thread WASM if over. Caller can wire to `navigator.deviceMemory` heuristic.

### L6-11. FEATURE: FinalizationRegistry for orphan in-flight detection
- **Category:** feature (low priority)
- **Issue:** If a caller's `decodeTiledViewportPooled(...)` Promise is dropped (await skipped, caller forgot, top-level throw), the in-flight decode finishes invisibly and the result is GC'd. Pool slot is held the whole time.
- **Fix:** Wrap returned Promise in a `FinalizationRegistry` that calls AbortController.abort() if the Promise's resolution box is GC'd. Niche - solves a usage error, not a library bug. Cost: one FR per call. Skip unless customer reports the antipattern.

### L6-12. FEATURE: explicit `containerBytes` reference release on AbortError
- **Category:** feature
- **Issue:** When a viewport decode is aborted (per L4-3), the in-flight `decodeTileWithWorker` Promises reject, but the `containerBytes` reference held inside the closure (worker.postMessage arg) is only released when each promise's closure is GC'd. Under high pan rate the abort path may have hundreds of zombie closures temporarily holding the buffer.
- **Fix:** On abort, explicitly null-out the captured `bytes` reference inside `decodeTileWithWorker` before reject. Setting closure-captured variable to null does drop the ref. Saves GC roundtrips during pan. Minor.


---

# Lens 6r - SharedArrayBuffer + browser-cooperation (second pass on memory/perf)

Premise: `canUseParallelTileWorkers()` already gates COOP/COEP (`crossOriginIsolated === true` per tiling.ts). That is the SAME gate SAB requires. The pool's parallel path runs ONLY when SAB is available. The L117-121 comment dismissing SAB as 'out of scope' is leaving the single largest perf win on the table. Browser-cooperation APIs (visibility, idle callback, scheduler) are likewise unused.

### L6r-1. SAB-backed container bytes - zero-copy fan-out to all workers
- **Category:** perf (large)
- **Issue:** Today: per-tile postMessage structured-clones full container into each worker's heap (cite L3-4, L6-2). After L3-4 fix: each worker receives the container once via structured clone. With SAB: container is allocated as SharedArrayBuffer once on main; workers receive a `Uint8Array` view over it on first acquire; ZERO copies ever. Single 64 MB container shared across 4 workers = 64 MB total (vs 64-256 MB with current/clone-once).
- **Fix:** 1) Caller allocates container as `new SharedArrayBuffer(jxtcSize)` and copies fetched bytes in once (one-time mandatory copy from non-shared fetch buffer). 2) Pool protocol gains `{type:'load', bytesId, sab: SharedArrayBuffer, byteLength}`. 3) Worker side: `const view = new Uint8Array(msg.sab, 0, msg.byteLength)`. libjxl WASM tile decoder reads from any Uint8Array; SAB-backed view works identically. 4) Fall back to regular ArrayBuffer when `canUseParallelTileWorkers()` returns false. The fallback path already exists for parallel = false.

### L6r-2. Pool prewarm at `requestIdleCallback` instead of synchronous
- **Category:** perf
- **Issue:** L171-179 prewarm() spawns workers synchronously inside `getOrCreatePool`. First call to `decodeTiledViewportPooled` blocks on N x `new Worker(url)` invocations. For minIdle=2 that is ~5-20 ms on cold cache - paid on the user's FIRST pan, the worst possible moment.
- **Fix:** Wrap spawn in `globalThis.requestIdleCallback?.(() => this.spawnOne())` with a setTimeout fallback. Caller-visible `prewarmAsync(): Promise<void>` resolves when workers have posted `{type:'ready'}` (cite L3-6). UI shell calls prewarmAsync on app mount, not on first viewport decode.

### L6r-3. Page visibility integration - drop idle workers when tab hidden
- **Category:** efficiency
- **Issue:** Singleton pool keeps minIdle=2 workers alive forever. When the gallery tab is backgrounded, those workers' WASM heaps (~10 MB each) remain resident for nothing - Chrome's background-tab throttling does not reclaim them.
- **Fix:** On pool construction: `document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') this.reapAllIdle(); else this.prewarm(this.minIdle); })`. `reapAllIdle()` is a one-shot that destroys every idle handle ignoring the minIdle floor. Returns workers + their WASM heaps to the browser. On visible: re-prewarm at idle. Net memory win in multi-tab usage; cost is 5-20 ms re-warm when user returns. Acceptable trade.

### L6r-4. `freeze`/`resume` Page Lifecycle events - abort + terminate in-flight on freeze
- **Category:** bug (mobile/PWA)
- **Issue:** Chrome/Edge fire `freeze` event when tab is going to bf-cache / mobile background. Worker execution may be paused indefinitely. Currently, an in-flight `decodeTileWithWorker` Promise on a frozen worker hangs forever; on resume the worker may continue, but the reply arrives long after viewport has moved. Pool has no awareness.
- **Fix:** Listen for `freeze` on document (Chrome ships, behind feature). On fire: AbortController.abort() any in-flight requests (per L4-3), terminate workers (full destroy), set `frozen = true`. On `resume`: prewarm fresh. Implementations of the freeze contract: store no permanent state in pool that can't be reconstructed.

### L6r-5. Adaptive `maxSize` based on `navigator.deviceMemory`
- **Category:** efficiency
- **Issue:** L309-310: `const hwc = rt.navigator?.hardwareConcurrency ?? 4; const maxSize = Math.min(hwc, 8);`. 8 workers x 10 MB WASM heap = 80 MB. On a 4 GB Chromebook with hwc=8 that is ~2% of device memory just for the pool; on an 8-core/64 GB workstation it is invisible. Workers are not free.
- **Fix:** If `navigator.deviceMemory` is available (Chrome, mostly): `const memHint = navigator.deviceMemory ?? 4; const maxSize = Math.min(hwc, 8, Math.max(2, Math.floor(memHint)))`. devicMemory is bucketed (0.25, 0.5, 1, 2, 4, 8) so this scales pool size by device class. Low end: 2 workers; high end: full 8.

### L6r-6. `scheduler.postTask` for tile-decode ordering (centroid-first)
- **Category:** perf
- **Issue:** `decodeTilesParallel` (L323-364) dispatches tiles in `tiles` array order = scan order. User attention is centered on the viewport's middle. Decoding center tiles first = perceived snap-in is faster even if total time identical.
- **Fix:** Caller reorders `tiles` by distance to viewport center before passing in. OR pool exposes `decodeOrder?: 'scan'|'centroid'` option that sorts internally. Bonus: `scheduler.postTask(fn, {priority:'user-visible'})` (Chrome native scheduler) for the coroutine bodies would let Chrome prioritize over background tasks.

### L6r-7. Worker `terminate()` ack via FinalizationRegistry
- **Category:** bug (low) + observability
- **Issue:** L296: `worker.terminate()` is fire-and-forget. Pool decrements `all.size` immediately; assumes worker is gone. Chrome may delay process kill; under spawn-storm the actual process count exceeds `maxSize` briefly. Hard to diagnose without explicit signal.
- **Fix:** On spawn: `const cleanup = (info) => this.opts.onWorkerGc?.(info); FINALIZATION_REGISTRY.register(worker, {handleId: h.id});`. Pool's onWorkerGc callback (default no-op) lets tests assert true reclaim. In production, attach to telemetry to detect 'workers terminated > workers GC'd' divergence (= memory leak warning).

### L6r-8. Document the SAB precondition path + reject non-isolated parallel
- **Category:** contract
- **Issue:** Today `canUseParallelTileWorkers()` returns true on both crossOriginIsolated AND structured-clone-only worlds. After L6r-1 SAB integration, the `parallel:true` codepath must FAIL CLOSED when SAB is unavailable - otherwise the worker waits for a SAB view it will not receive.
- **Fix:** Split the capability check: `canUseTileWorkers()` (basic Worker + COOP/COEP) and `canShareContainerBytes()` (SAB + crossOriginIsolated). Pool's `decodeTiledViewportPooled` consults both; falls back to single-WASM if SAB missing AND parallel was requested. Comment the precondition in `tiling.ts`.

### L6r-9. Refuse spawn when `navigator.userAgentData.mobile === true` and large minIdle
- **Category:** efficiency
- **Issue:** Mobile devices have stricter background-process budgets and aggressive worker throttling. Keeping 2 workers warm at 10 MB each is a much larger fraction of mobile RAM than desktop, and OS may kill the tab when backgrounded.
- **Fix:** Detect mobile via `navigator.userAgentData?.mobile` (standardized, Chrome/Edge). On mobile: cap minIdle = 0 (no permanent warm pool; spawn on demand). Acceptable cost is one cold-start per pan session. Pairs with L6r-3.

### L6r-10. OpenInputStream / ReadableStream input - drop bytes after dispatch
- **Category:** efficiency (architectural)
- **Issue:** Caller currently holds full `containerBytes` Uint8Array in main heap for the lifetime of the level. After L6r-1 SAB integration, the SAB is the canonical buffer and the original ArrayBuffer can be released. But if caller fetched via `await response.arrayBuffer()`, both buffers transiently coexist (~2x peak).
- **Fix:** Out of scope for the three files but architecturally: caller should `fetch().then(r => r.body)` (ReadableStream), allocate SAB sized via Content-Length header, and pipe stream into SAB without intermediate buffer. Document for the caller in ADR. (No code change here.)

### L6r-11. Cooperative back-off via `performance.measureUserAgentSpecificMemory()` heuristic
- **Category:** feature
- **Issue:** Pool has no signal that the host page is hitting heap pressure from OTHER consumers (e.g., huge gallery thumbnails, video). It will happily warm 8 workers regardless. `performance.measureUserAgentSpecificMemory()` (Chrome, behind CORS) gives a periodic snapshot.
- **Fix:** Pool config: `opts.memoryProbe?: () => Promise<{bytes:number, limit:number}>`. Called every prewarm decision. If `bytes/limit > 0.7`: drop minIdle to 0 and refuse new spawn. Caller wires the probe to whichever browser API is available; pool stays browser-agnostic.


---

# Lens 1r — Strategic view, round 2 (post L2-L6r context)

Round 1 mapped the pipeline and cataloged 11 strategic items. Round 2 looks back at what L2-L6r exposed about *why* those files are split the way they are, what the cross-file boundaries actually cost, and where CLAUDE.md's layer map applies vs not. Twelve fresh observations.

### L1r-1. Cross-file redundancy scoreboard
- **Category:** efficiency
- **Issue:** Same data computed by N>1 files. (a) **region clamp** — three sites (decode-level L100-105, tiled-decode-pool L382-385, tiling.ts tilesOverlappingRegion). (b) **bits propagation** — manifest carries bitsPerSample → LevelSource carries it (sometimes; whole drops it per L1-6) → pool re-derives from JXTC header. (c) **decodeRegion selection** — `pickRegionDecoder(bits)` in decode-level; inline ternary in pool's decodeTiledViewportPooled. (d) **hardwareConcurrency** — read once in `getOrCreatePool` AND again in `decodeTiledViewportPooled` (L309 + L408). (e) **bytesPerPixel = 4|8** — `bppFor` in pool, magic number 4 in decode-level stitch default. Five computations done multiple times in three files.
- **Fix:** Single-pass `prepareDecodePlan(LevelSource | rawHeader, region, opts) → DecodePlan { viewport, tiles, header, bits, bpp, decodeRegion, hwc }` (pairs with L2-10). Both decoders consume the plan. Eliminates redundancy AND removes the cross-file drift surface (L1-1 sibling divergence).

### L1r-2. jxl-pyramid pool is a SECOND worker pool in the codebase
- **Category:** strategic / architecture
- **Issue:** CLAUDE.md layer map names `packages/jxl-scheduler/src/pool.ts` as the canonical worker pool ("Worker lifecycle, prewarm, idle reap"). `PyramidWorkerPool` in tiled-decode-pool.ts re-implements the same discipline (idle floor, per-handle reaper, acquire/release, error-driven recycle) — the file comment at L127-133 even says "Mirrors jxl-scheduler/pool.ts discipline." Two pools, two implementations, two drift surfaces.
- **Fix:** Strategic decision. Either (a) extract a shared `WorkerPoolBase` to a new lightweight package (`@casabio/worker-pool`) that both jxl-scheduler and jxl-pyramid depend on, OR (b) document that pyramid's pool is intentionally separate because it carries a "dumb tile protocol" while scheduler's pool runs full session-state machinery, and accept the duplication. (a) is cleaner long-term but is an architectural change. (b) needs a comment that names the divergence explicitly. Write ADR.

### L1r-3. Pool is tightly coupled to JXTC format
- **Category:** architecture
- **Issue:** `decodeTiledViewportPooled` (L381) calls `parseJxtcHeader(containerBytes)` inside the pool file. A worker pool should be format-agnostic — it knows about workers, not container formats. JXTC awareness leaks into the pool's API surface (the bytes arg, the implicit assumption that workers know how to decode JXTC tiles).
- **Fix:** Two-layer split. (a) Generic `WorkerPool` (lifecycle, acquire/release, recycle). Stays in this codebase or moves to its own package. (b) Format-specific `JxtcTileDecoder` that owns parseJxtcHeader, the `decodeRegion` selection, and stitch — delegates to the generic pool for workers. `decodeTiledViewportPooled` becomes a thin coordinator. Caller can swap to a different decoder for non-JXTC formats without touching the pool.

### L1r-4. `decodeTileWithWorker` is a free function but should belong to the pool
- **Category:** boundary smell
- **Issue:** L68-124: free function takes a `worker` and posts a tile decode. Module-scope `nextWorkerId` is its state. The function knows the pool's WorkerLike contract, the pool's reply shape, the pool's cleanup discipline — yet it sits outside the class. Result: AbortSignal threading (L4-3), error taxonomy (L3-9, L5-7), telemetry hook (L5-6, L5-11), liveness timeout (L4-11) all have to be threaded through a free function via parameter explosion.
- **Fix:** Make it a method on PyramidWorkerPool: `pool.decodeTile(worker, bytes, region, opts)`. Pool now owns the cross-cutting concerns and can inject abort/timeout/telemetry once. Tests that today mock `decodeTileWithWorker` directly switch to mocking pool.decodeTile.

### L1r-5. `chooseLevelForTarget` null escape is a smell
- **Category:** contract
- **Issue:** Returns `PyramidLevel | null`. Caller has to null-check or risk crash. The two reasons for null are very different: empty levels array (caller bug, should throw) vs nothing-found (impossible after the fallback at L15 — `sorted[sorted.length - 1]` is always defined when sorted is non-empty). So the null branch is effectively unreachable AND signals a caller bug. Mixing the two cases poisons every caller's type.
- **Fix:** `if (levels.length === 0) throw new RangeError('chooseLevelForTarget requires non-empty levels')`. Return `PyramidLevel` (no null). Caller code simplifies; the precondition is explicit. Pairs with L5-4 NaN target guard.

### L1r-6. No per-pan session object
- **Category:** missing feature
- **Issue:** Every `decodeTiledViewportPooled` / `decodeTiledViewport` call is independent of the previous. Pan/zoom from frame N to N+1 over the same level repeats: choose-level pick, region clamp, header parse, decoder selection, possibly pool acquire. No way for caller to express "I'm on level X, pre-warmed; just give me this new ROI."
- **Fix:** `openLevelSession(LevelSource, opts) → LevelSession { decodeRegion(region, signal?): Promise<DecodedLevel>, dispose() }`. Session pre-builds DecodePlan (cite L1r-1), holds the bytesId (cite L3-4), retains acquired workers across requests inside one session (avoids pool churn). UI starts a session per active level; releases on level switch. Cleaner mental model + significant batching wins.

### L1r-7. No fallback bridge between the two decoders
- **Category:** robustness
- **Issue:** `decode-level.ts` runs WASM on main thread (or main-thread `Promise.all` over WASM calls); `tiled-decode-pool.ts` runs WASM in Workers. They have no awareness of each other. Pool's parallel path fails → it falls back to its own main-thread `decodeRegion` (L417), NOT to decode-level's stream-decoder. decode-level's `decodeTiledViewport` parallel branch (L114) can never use the pool — it just runs main-thread.
- **Fix:** Pool exposes `pool.fallback?: (bytes, region) => Promise<DecodedLevel>`. Caller can wire `decodeTiledViewport` as the fallback. Pool falls through to it on no-workers/no-SAB/error. Or unify the two decoders (cite L1r-9 below) and remove the question entirely.

### L1r-8. API surface divergence between siblings
- **Category:** contract
- **Issue:** Two near-equivalent entry points with deliberately different shapes:
  - `decodeLevel(source: LevelSource, region?, options): Promise<DecodedLevel>` — composition-friendly, types do the talking.
  - `decodeTiledViewportPooled(containerBytes: Uint8Array, region: ImageRegion, options): Promise<DecodedLevel>` — leaky, requires caller to know about raw bytes vs LevelSource and to manually choose.
- **Fix:** Pool entry point should accept `LevelSource`. Move container-bytes-only callers to call `levelSourceFromBytes(bytes)` first. Then both entry points share the SAME signature. The choice of single-WASM vs pool becomes purely a strategy concern, not an API one. Pool entry can even be hidden behind a `strategy: 'auto' | 'single' | 'parallel'` option on `decodeLevel`.

### L1r-9. Three-file split mirrors a stale mental model
- **Category:** architecture
- **Issue:** Today: `choose` (pure pick) | `decode-single` (decode-level) | `decode-parallel` (pool). Forces the parallel-vs-single split into the file layout, baking in the assumption that they are independent code paths. They are NOT — they should share clamp, stitch, decodeRegion, plan. The split also entangles pool LIFECYCLE (cold, persistent) with tile DISPATCH (hot, per-call) in one file (cite L1r-10).
- **Fix:** Re-shape into four files: (a) `select.ts` (choose-level + levelRank + shouldUpgrade), (b) `plan.ts` (DecodePlan, prepareDecodePlan, clamp, header memo), (c) `decode.ts` (unified decoder: single OR parallel path, takes a Pool as injected strategy), (d) `pool.ts` (pure pool infrastructure, format-agnostic). Boundaries align with concerns, not with execution strategy.

### L1r-10. Hot vs cold path co-located in `tiled-decode-pool.ts`
- **Category:** architecture
- **Issue:** L141-302 is the cold path (PyramidWorkerPool class, prewarm, lifecycle). L304-321 is the cold cache (getOrCreatePool, singleton). L323-364 + L372-426 are the HOT path (per-pan invocations). One 426-line file mixes the "set up once" code with the "run every frame" code. Hot-path readers have to scroll past 300 lines of pool internals to find the dispatch logic.
- **Fix:** Pairs with L1r-9 split. `pool.ts` keeps lifecycle. `tiled-decode.ts` (or part of unified `decode.ts`) keeps dispatch. The hot path becomes ~80 lines of obviously perf-critical code; the pool stays in its own file as plumbing.

### L1r-11. Manifest is under-trusted as a contract authority
- **Category:** contract / boundary
- **Issue:** Manifest already carries (per `manifest.ts`): width, height, bitsPerSample, tiled flag, tileSize (for tiled). JXTC container HEADER also carries: imageW, imageH, tileSize, bitsPerSample. The two CAN disagree (security finding e5f6a7b8 + contracts-005). Today, pool trusts the header; decode-level partly trusts manifest. Result: producer-side fidelity (pyramid-ingest writes both) is not enforced by reader-side checks.
- **Fix:** Treat manifest as ground truth at the boundary, header as proof-of-integrity. `parseJxtcHeader` becomes `verifyJxtcHeader(bytes, expected: PyramidLevel)` returning the header but throwing `IntegrityError` on mismatch. Pool stops carrying dims from the header — it gets them from the LevelSource (which got them from the manifest after L1r-8). One source of truth on the read side.

### L1r-12. CLAUDE.md "workers stateless between sessions" — verify alignment
- **Category:** architecture invariant
- **Issue:** CLAUDE.md asserts: "Workers are stateless between sessions — caching WASM decoder state across session lifetimes would break recycle()." jxl-pyramid pool keeps workers ALIVE across sessions (its whole point). Does this violate the invariant? Reading the worker discipline: worker reloads JXL module once at top-level, each tile decode is independent (one libjxl ROI call, no session state). So technically the workers ARE stateless between TILE requests, which is the analog of "stateless between sessions" for this pool. Invariant holds — but it's not documented anywhere in the jxl-pyramid layer.
- **Fix:** Comment block at the top of `tiled-decode-pool.ts` PyramidWorkerPool: "Workers in this pool decode one tile per request; no per-tile WASM state is preserved across requests. This satisfies CLAUDE.md's stateless-between-sessions invariant at the tile-protocol level. Pool persistence amortizes JXL WASM compile cost only, not decoder state." Single paragraph, prevents future "let me cache the decoder" misadventure.


---

# Lens 2 (master) — Public API surface

Scope: exported functions, WASM bindings, worker message handlers across the three files. The surface is what callers commit to AND what the pool/decoders commit to libjxl + worker.js.

## Exported surface, enumerated

| File | Exports |
|---|---|
| `choose-level.ts` | `longEdge(w,h)`, `chooseLevelForTarget(levels, target)`, `levelRank(level)`, `shouldUpgrade(current, candidate)` |
| `decode-level.ts` | `DecodedLevel` (interface), `RegionDecoder` (type), `decodeTiledViewport(source, region, opts?)`, `decodeLevel(source, region?, opts?)` |
| `tiled-decode-pool.ts` | `TileRegionDecoder` (type), `decodeTiledViewportPooled(bytes, region, opts?)` |

WASM imports (from `@casabio/jxl-wasm`):
- decode-level: `createDecoder`, `decodeTileContainerRegionRgba8`, `decodeTileContainerRegionRgba16`
- tiled-decode-pool: `decodeTileContainerRegionRgba8`, `decodeTileContainerRegionRgba16`
- worker.js (implicit): `decodeTileContainerRegionRgba8` only (per logic-001 evidence)

Worker message protocol (defined nowhere as a shared type):
- Outbound: `worker.postMessage({id, bytes, region})`
- Inbound: `WorkerReply = {id, ok:true, pixels:ArrayBuffer, width, height} | {id, ok:false, error:string}`
- Worker DOM events listened: `message`, `error`, `messageerror`

## Findings

### L2m-1. `RegionDecoder` and `TileRegionDecoder` are the same type, declared in both files
- **Category:** contract bug-prone
- **Issue:** decode-level.ts L15-18 exports `RegionDecoder`. tiled-decode-pool.ts L28-31 exports `TileRegionDecoder`. Signatures byte-identical: `(bytes: Uint8Array, region: ImageRegion) => Promise<DecodedLevel>`. Future divergence is silent — TypeScript will not catch a callback that satisfies one but not the other if they evolve separately.
- **Fix:** Delete `TileRegionDecoder`. Pool imports `RegionDecoder` from decode-level (it already imports `DecodedLevel` from the same place). Or move the type to a new `types.ts` shared by both.

### L2m-2. `PyramidWorkerPool` class is internal; no escape hatch for callers
- **Category:** missing feature + lifecycle bug
- **Issue:** The class is declared with no `export`. The only public path to a pool is `decodeTiledViewportPooled`, which lazily creates a module-singleton via `getOrCreatePool` (also non-exported). Tests can't construct a pool with a mock factory. Production can't run two galleries with isolated worker pools. There is no public `prewarm` / `dispose` / `getStats`. Cite L1-5, L4-2, L4-5.
- **Fix:** Export `PyramidWorkerPool` AND `createPyramidWorkerPool(opts)` factory. Keep the singleton convenience function `decodeTiledViewportPooled` for backward compat — but it routes through an explicit `getDefaultPool()` whose existence and bound factory are observable. Add `disposeDefaultPool()` export.

### L2m-3. No public orchestration API: prewarm / capability / dispose
- **Category:** missing feature
- **Issue:** Caller wants to (a) warm the pool on app mount, (b) check whether parallel is viable on this browser, (c) tear it down on page unload. Today: (a) impossible without making a throwaway decode call, (b) requires importing `canUseParallelTileWorkers` from `tiling.ts` (a different module), (c) impossible at all (cite L4-2).
- **Fix:** Re-export `canUseParallelTileWorkers` from this module (or from a stable `index.ts` barrel). Add `prewarmDefaultPool(workerFactory)` and `disposeDefaultPool()` exports. Callers can call them in their existing app-mount / app-unmount hooks without learning the internals.

### L2m-4. Two near-identical public entry points
- **Category:** contract surface
- **Issue:** `decodeTiledViewport(source: LevelSource, ...)` and `decodeTiledViewportPooled(containerBytes: Uint8Array, ...)` are siblings doing the same logical operation with different inputs. Caller has to know that "with workers, use the bytes one; without, use the source one." Cite L1-8 + L1r-8.
- **Fix:** Unify to one entry point that takes `LevelSource` and accepts `opts.strategy?: 'auto' | 'single' | 'parallel'`. `auto` chooses parallel when `canUseParallelTileWorkers() && opts.workerFactory && tiles.length > 1`. Internal split between the two implementation paths becomes invisible. Caller writes one code path.

### L2m-5. No named `DecodeOptions` type — inline structural typing duplicated
- **Category:** efficiency + contract
- **Issue:** `decodeTiledViewport` options: `{parallel?: boolean; decodeRegion?: RegionDecoder}`. `decodeLevel` options: `{parallel?: boolean; decodeRegion?: RegionDecoder}`. `decodeTiledViewportPooled` options: `{parallel?: boolean; decodeRegion?: TileRegionDecoder; workerFactory?: () => WorkerLike}`. Three near-identical anonymous types. Adding `signal` (L4-3) means editing three places. Adding `outBuffer` (L2-11/L6-1) means editing three places. Drift inevitable.
- **Fix:** `export interface DecodeOptions { parallel?: boolean; decodeRegion?: RegionDecoder; workerFactory?: () => WorkerLike; signal?: AbortSignal; outBuffer?: Uint8Array; strategy?: 'auto'|'single'|'parallel'; }` in a shared types file. All three functions take `Partial<DecodeOptions>` or the same type. Single source of truth.

### L2m-6. Utility exports `longEdge`, `levelRank`, `shouldUpgrade` — surface bloat audit
- **Category:** contract (low)
- **Issue:** Three tiny functions exported. `longEdge(w,h) = Math.max(w,h)` is one line. `levelRank(level) = level.w * level.h` is one line. `shouldUpgrade(cur, cand) = cur === null || levelRank(cand) > levelRank(cur)` is three lines and is the only one with policy embedded. Callers can reproduce all three trivially. Their export is a long-term commitment — if `shouldUpgrade` ever needs to consider format / bitsPerSample / pyramid-level-flags (likely), the signature breaks every caller.
- **Fix:** Keep `chooseLevelForTarget` and `shouldUpgrade` (carry actual policy). Demote `longEdge` and `levelRank` to non-exported helpers — callers don't gain real composition from them, and removing them later is a breaking change. If you want them documented as the policy primitives, mark them `@public` in JSDoc but consider not re-exporting from the barrel.

### L2m-7. Barrel `index.ts` likely leaks dev-machine paths (cite finding)
- **Category:** contract bug (high)
- **Issue:** contracts-018 finding: `APPROVED_FIXTURES` from `fixtures.ts` is re-exported via package barrel and contains absolute Windows paths (`c:\Foo\...`). Anything consuming `@casabio/jxl-pyramid` ships those strings. Package surface includes test fixtures — that is a category error.
- **Fix:** Audit `src/index.ts` to confirm what's actually re-exported. Move `fixtures.ts` to `test/` (not in src). Add a CI check that `index.ts` re-exports only function/type symbols, not data tables, and no symbol with substring "FIXTURE" / "APPROVED".

### L2m-8. WASM bindings have three consumers — any change touches all three
- **Category:** architecture
- **Issue:** decode-level.ts (main), tiled-decode-pool.ts (main), web/lightbox/tiled-decode-worker.js (worker) all import `decodeTileContainerRegionRgba8` and (in 2 of 3) `decodeTileContainerRegionRgba16`. Adding a new region decoder (e.g., `decodeTileContainerRegionFloat`), changing a signature, or supporting a new container — three coordinated edits with no compiler-enforced parallelism for the worker (which is a separate non-TS file).
- **Fix:** Introduce a `region-decode-kit.ts` adapter inside jxl-pyramid that owns the rgba8 / rgba16 dispatch (mirrors `pickRegionDecoder` but as a single export). Both main-side decoders use it. Worker also imports it (or imports a mirror copy if it cannot use TS at runtime — at minimum, share the union type). Cuts consumer count from 3 raw to 1 adapter + worker.

### L2m-9. No version / capability handshake with `@casabio/jxl-wasm`
- **Category:** contract
- **Issue:** Functions are imported and called. No runtime check that the installed jxl-wasm package supports both rgba8 AND rgba16 decoders (it might be an older version that only has rgba8). Pool's wantParallel path silently throws at first decode if rgba16 is missing in jxl-wasm — but only for 16-bit content, hours after deploy. No early failure.
- **Fix:** On first call (or pool prewarm), assert `typeof decodeTileContainerRegionRgba16 === 'function'`. Throw `MissingWasmCapability` with a message naming the version mismatch. Pair with a `getJxlWasmCapabilities()` re-export so consumers can branch UI before triggering a decode.

### L2m-10. Region-decoder dispatch is duplicated in main AND worker
- **Category:** bug-prone (cite logic-001 critical)
- **Issue:** decode-level.ts:47-58 has `pickRegionDecoder(bits)`. tiled-decode-pool.ts:390-395 has an inline `bits === 16 ? rgba16 : rgba8` ternary. web/lightbox/tiled-decode-worker.js hardcodes rgba8. Three sites pick the decoder; one is wrong. Worker.js is the one that ships to production.
- **Fix:** Single dispatcher in the L2m-8 kit. Worker imports the same dispatcher OR a hard-coded mapping is generated from a shared source. Either way, eliminate the "three sites, one wrong" pattern.

### L2m-11. Worker message protocol has no shared type
- **Category:** contract (cite L3-2)
- **Issue:** `WorkerReply` (L62-64) is internal to tiled-decode-pool.ts. The TYPE the worker is supposed to produce is not exported or even shared with worker.js. Worker.js has no TS, no JSDoc reference to the type. Compile-time checks pass even when the worker is sending different shapes.
- **Fix:** Move `WorkerReply` + (new) `WorkerRequest` to `worker-protocol.ts` (or `protocol.ts`). Export. Worker.js JSDoc-references them via `@typedef` imports for editor IntelliSense. Future TypeScript worker can use them natively. Pairs with L3-2 runtime validation: type + validator co-located.

### L2m-12. Worker request lacks `format`, `version`, `deadlineMs`
- **Category:** critical bug (16-bit) + missing features
- **Issue:** `{id, bytes, region}` is the entire request. No `format` (cite L3-1, root cause of logic-001 critical 16-bit corruption). No `protocol_version` for future-proof bumps. No `deadlineMs` (cite L3-11). No `cancel` channel (cite L3-5). The protocol cannot evolve without breaking — adding ANY field requires worker.js to be at the version that knows it.
- **Fix:** Bump to `{v: 1, type: 'decode', id, bytesId, region, format, deadlineMs?}`. Add `{v: 1, type: 'load', bytesId, bytes}` (cite L3-4). Add `{v: 1, type: 'cancel', id}` (cite L3-5). Worker checks `v` and rejects mismatched versions early. Forward compat: `v: 2` workers handle `v: 1` requests.

### L2m-13. Reply shape uses optimistic typing — no runtime validation
- **Category:** bug (cite L3-2, L3-3)
- **Issue:** `ev.data` is treated as `WorkerReply` with no checks. Malformed reply crashes the receiver inside `new Uint8Array(undefined)`. Pixels field is typed `ArrayBuffer` but actually `Uint8Array` (cite L3-3 / logic-004) — silent memcpy.
- **Fix:** Receive-side validator `parseWorkerReply(data): WorkerReply | null` returning null + logging via L5-11 logger on shape mismatch. After validation, the typed union is trustworthy. Reply pixels typed widened to `Uint8Array | ArrayBuffer` with a branch.

### L2m-14. No worker `{type:'ready'}` signal — cold start invisible
- **Category:** bug (cite L3-6)
- **Issue:** Worker.js runs top-level `preloadJxlModule()` asynchronously. The host has no signal when the WASM module is compiled and the worker is actually ready. Pool's `prewarm` returns synchronously and the next decode pays the compile cost (L171-179).
- **Fix:** Worker posts `{v:1, type:'ready'}` after `preloadJxlModule()` resolves. Pool maintains `WorkerHandle.ready` boolean; `acquire` skips non-ready or awaits a `readyPromise`. Exposes `pool.whenReady(): Promise<void>` so caller can show a loading hint before the first decode.


---

# Lens 3 (master) — Pipeline stages

Scope: pipeline-stage audit. What stages exist, which are missing by design, which are missing by oversight, where the stages bleed into each other.

## Stage presence matrix

| Stage | choose-level | decode-level | tiled-decode-pool | Status |
|---|:---:|:---:|:---:|---|
| select (pre-decode) | YES | — | — | Implemented |
| decode | — | YES (whole + tiled) | YES (tiled-parallel) | Duplicated across two files |
| transform (color/ICC/gamma) | — | — | — | Absent by design — downstream's job |
| resize (intra-level) | — | — | — | Absent — pyramid IS the resize, but no sub-pixel align |
| encode (output formatting) | — | — | — | Absent by design — read-only library |
| cache | — | — | partial (workers only) | Partial — workers warm, but no pixels/header/plan cache |
| return result | — | YES (Promise<DecodedLevel>) | YES | Synchronous handoff; no streaming |

## Findings by stage

### DECODE

#### L3m-1. Decode stage has TWO implementations of the same operation
- **Category:** architecture
- **Issue:** `decodeTiledViewport` (decode-level.ts L89-122) and `decodeTiledViewportPooled` (tiled-decode-pool.ts L372-426) both do "decode an ROI of a tiled JXTC level." Different inputs (LevelSource vs raw bytes), different concurrency strategy (main-thread Promise.all vs worker pool), same output. Cite L1-8, L1r-8, L2m-4.
- **Fix:** Unify behind one function with strategy selection. Decode stage has ONE entry per format.

#### L3m-2. No progressive / DC-only decode within the decode stage
- **Category:** missing feature (speed)
- **Issue:** jxl-wasm exposes streaming decode via `createDecoder` (decode-level uses it for `decodeWhole`) but the pyramid path goes straight to final pixels. JXL supports DC-only preview (~64x downsample) as a sub-second early frame. The pyramid as a whole is already a multi-res hierarchy (lower level = the equivalent of upper level's DC), but for any specific level's tiles, a DC-only intermediate would render a blurry-but-instant preview before final pixels arrive.
- **Fix:** Optional `opts.progressive?: 'final' | 'dc-then-final'`. When 'dc-then-final', pool uses jxl-wasm's `createDecoder({progressionTarget:'dc'})` for a fast first paint, then 'final'. Emits two `DecodedLevel` events instead of one. Pairs with L3m-11 streaming return.

#### L3m-3. Whole-frame decode (`decodeWhole`) is the only streaming-decoder caller; ROI never streams
- **Category:** missing feature
- **Issue:** `decodeWhole` uses `createDecoder` + `events()` async iterator (decode-level.ts L20-45). ROI decoders (`decodeTileContainerRegionRgba8/16`) are single-shot Promises returning final pixels only. The pyramid pipeline can't observe a tile's progressive decode events.
- **Fix:** Investigate whether `decodeTileContainerRegion*` has a streaming variant in jxl-wasm. If yes: hook for L3m-2. If no: this is a jxl-wasm capability gap (separate ADR). Either way, document the constraint.

### TRANSFORM

#### L3m-4. No transform stage — color/ICC handling deferred to caller with no contract
- **Category:** contract / architecture
- **Issue:** Pixels emerge as rgba8 or rgba16. No documented color space, ICC handling, gamma. CLAUDE.md (facade.ts) preserves ICC at the WASM boundary, but jxl-pyramid never threads it through — the ICC profile parsed by jxl-wasm is dropped. Callers must rely on display defaults (sRGB). Photogrammetry / wide-gamut use cases silently lose fidelity.
- **Fix:** Optional `iccProfile?: Uint8Array` on `DecodedLevel`. Two implementation paths: (a) pass-through from jxl-wasm's parsed ICC when available; (b) document that pyramid output is "as decoded — caller applies ICC." Pick (a) for a future PR; document explicitly NOW. Note: CLAUDE.md says ICC preservation is decoder-level concern, so pyramid's job is to forward the side-channel, not apply.

### RESIZE

#### L3m-5. No intra-level resize — caller always re-samples in canvas
- **Category:** speed
- **Issue:** chooseLevelForTarget picks a level whose long-edge >= viewport target. So the decoded pixels are at LEAST the viewport size — usually larger. Caller (canvas / WebGL) does the final downscale. For a 2048-wide level decoded into a 1024-wide viewport: 2 MB pixels decoded, 1 MB pixels displayed, 1 MB wasted bandwidth + memory.
- **Fix:** Optional `opts.outputSize?: {w, h}` — decoder does a fast box-filter / 2x2 average downsample into the target buffer during stitch. Pays one extra pass but saves canvas-side memory and the canvas's potentially-lower-quality resampler. WASM could expose a "decode with intrinsic downsample" if jxl-wasm supports it (libjxl does have downsample-on-decode). Cheaper still.

#### L3m-6. No upscale fallback when no level is large enough
- **Category:** missing feature
- **Issue:** `chooseLevelForTarget` returns the largest level when none is bigger than target. Caller gets pixels smaller than viewport; canvas does the upscale. Visible blur. No nearest-neighbor vs bilinear vs Lanczos choice exposed.
- **Fix:** Out-of-scope (upsampling is canvas/WebGL territory). But L3m-5's outputSize knob could also accept >1x scale and refuse, with a clear error code, prompting the caller to pick a different level. Closes the loop.

### ENCODE

#### L3m-7. No encode stage by design — but worker boundary IS an encode/decode round-trip
- **Category:** perf bug (cite L3-3, L3-4)
- **Issue:** Library is read-only; nothing to encode. BUT the worker boundary forces a structured-clone "encode" of pixels back to main, with the L3-3 silent memcpy lying about zero-copy. Container bytes also get cloned per tile per worker (L3-4). The "no encode" claim hides two expensive serialization passes.
- **Fix:** Document the worker boundary as a serialization stage. After L3-3 + L3-4 fixes: receive side is true zero-copy via transfer; container bytes are sent once per worker via load message. Worker boundary becomes near-free for steady-state pan.

### CACHE

#### L3m-8. Cache stage is only WORKERS — no pixels, no header, no plan
- **Category:** speed (large) + efficiency
- **Issue:** PyramidWorkerPool caches workers (warm pool). Nothing else is cached:
  - Pan from viewport A to viewport B and back to A: full re-decode of A's tiles.
  - Pan within the same level: same JXTC header parsed each call (cite L1-10).
  - Same level/region/bits: same DecodePlan computed each call (cite L1r-1).
- **Fix:** Three orthogonal caches.
  - (a) **Header cache:** `WeakMap<Uint8Array, JxtcHeader>` keyed by containerBytes identity. Cheap, big win.
  - (b) **Plan cache:** `WeakMap<LevelSource, DecodePlan>` (per LevelSource, multi-region keyed by region hash). Pairs with L1r-1.
  - (c) **Pixel cache (LRU):** `Map<cacheKey, {pixels, expiresAt}>` where cacheKey = (levelId, region). Capacity in bytes. Aggressive eviction on pan. Most architectural; possibly out of scope here but flag.

#### L3m-9. jxl-cache (separate package per CLAUDE.md) is content-agnostic — could back the pixel cache
- **Category:** feature
- **Issue:** CLAUDE.md names `packages/jxl-cache/src/browser.ts` (OPFS + LRU; content-agnostic). jxl-pyramid does not use it. Whole-level decoded buffers (10-100 MB) are an excellent fit for OPFS-backed LRU.
- **Fix:** Optional `opts.cache?: { get, set, delete }` interface. jxl-cache satisfies it. Caller injects. Library stays cache-agnostic. Per CLAUDE.md "cache must never duplicate entries by sourceKey" — cache is keyed by (levelId, region, bits), with the cache layer trusting the key (it does not parse pixels).

### RETURN RESULT

#### L3m-10. Return is `Promise<DecodedLevel>` — no streaming, no transferable
- **Category:** speed (caller-side)
- **Issue:** Caller receives final `DecodedLevel { pixels: Uint8Array, width, height }` AFTER all tiles are stitched. For a slow level (many tiles), the user sees nothing until completion. Also, caller can't transfer pixels onward to a worker (e.g., uploading to WebGL in a worker) without copying — `Uint8Array.buffer` could be `postMessage`'d-with-transfer but caller would lose access.
- **Fix:** Optional `opts.onTile?: (tile: DecodedTile) => void` callback fired as each tile resolves. UI paints incrementally; final Promise resolves when all done. Separately: `opts.transferable?: boolean` — when true, returned `DecodedLevel.pixels` carries an `ownership: 'transferable'` flag and caller is expected to either consume immediately or transfer. Pairs with L6-1 caller-owned buffer.

#### L3m-11. Stream tiles as they arrive — eliminate `parts[]` retention AND latency
- **Category:** speed + efficiency
- **Issue:** `decodeTilesParallel` (L323-364) collects all tiles into `results[]`, awaits Promise.all, returns. The `parts[]` array peaks at ~viewport-pixel memory before stitch runs (cite L6-3). Caller sees nothing for the entire decode window.
- **Fix:** Stream-stitch with caller callback (combines L3m-10 onTile + L6-3 stream-stitch). Each tile, on receive: (a) stitch into outBuffer at its offset, (b) fire onTile(region, partialPixels?), (c) drop the tile reference. Latency to first paint drops from "all tiles done" to "first tile done."

#### L3m-12. No level-to-canvas direct write
- **Category:** missing feature
- **Issue:** Caller flow: decoded `Uint8Array` → `new ImageData(pixels, w, h)` → `ctx.putImageData(...)`. Two allocations + two copies. WebGL flow: decoded pixels → `gl.texImage2D(...)`. One copy.
- **Fix:** Optional `opts.outputTarget?: 'pixels' | OffscreenCanvas | ImageBitmap` — when canvas/ImageBitmap, decoder writes directly into it (using ImageData or OffscreenCanvas.transferToImageBitmap) and returns a Bitmap reference instead of pixels. Saves one allocation + one copy. CLAUDE.md rejected `createImageBitmap` in workers for jxl-pyramid context due to MIME and 16-bit issues — but a main-thread `putImageData` direct write avoids that path. Document the constraint.


---

# Lens 4 (master) — State machinery

Scope: every piece of mutable state across the 3 files, classified by purpose (session / queue / cancellation / error). What state exists, what doesn't, where transitions are implicit, where invariants are uncodified.

## State inventory

| Sub-axis | Identifier | File:Line | Type | Lifetime |
|---|---|---|---|---|
| Session | `nextWorkerId` | pool L66 | number (module) | module lifetime |
| Session | `pool` singleton | pool L304 | `PyramidWorkerPool \| null` (module) | module lifetime |
| Session | `WorkerHandle.idleTimer` | pool L136 | Timeout \| null | per-handle |
| Session | `WorkerHandle.terminated` | pool L137 | boolean | per-handle |
| Session | `WorkerHandle.bad` | pool L138 | boolean | per-handle |
| Session | `PyramidWorkerPool.destroyed` | pool L152 | boolean (never set true — cite L4-1) | per-pool |
| Session | `result` in decodeWhole | decode-level L28 | DecodedLevel \| null | per-call closure |
| Session | `settled` in decodeTileWithWorker | pool L75 | boolean | per-call closure |
| Queue | `all` | pool L147 | Set\<WorkerHandle> | per-pool |
| Queue | `idle` | pool L148 | WorkerHandle[] | per-pool |
| Queue | `active` | pool L149 | Set\<WorkerHandle> | per-pool |
| Queue | `handleByWorker` | pool L150 | WeakMap | per-pool |
| Queue | `results[]` | pool L333 | sparse array (cite L2-7) | per-call |
| Queue | `next` counter | pool L334 | number (closure) | per-call |
| Cancel | (none) | — | — | — |
| Error | `failed` | pool L335 | boolean (closure) | per-call |
| Error | `firstErr` | pool L336 | unknown (closure) | per-call |

## Findings

### SESSION STATE

#### L4m-1. No first-class session concept; state scattered across closures + class fields
- **Category:** architecture
- **Issue:** Eight distinct pieces of mutable state spread across module scope, class fields, and per-call closures. No object that says "this is what's live during one viewport decode." Hard to reason about teardown, hard to inspect from devtools. Cite L1r-6 LevelSession opportunity.
- **Fix:** Introduce `LevelSession` (per L1r-6) as the unit of session state: holds the LevelSource, the cached header, the bytesId on each pre-loaded worker, an AbortController, an error log. Pool stays a pure resource manager. Per-call closures shrink to local variables only.

#### L4m-2. `decodeWhole` uses `let result: DecodedLevel | null` + side-channel error throw
- **Category:** state machine bug
- **Issue:** decode-level.ts L28-44: drain IIFE assigns `result` when "final" event arrives; throws on "error". Outer code awaits drain then reads `result`. If drain throws AFTER setting result (e.g., trailing error event after final), result is set but throw wins — caller sees error. If drain throws BEFORE final (the bug case), result stays null and `if (!result) throw` masks the real error. The state machine has two ways to fail and only one error path. Cite L5-1, L5-2.
- **Fix:** Replace `let result` + outer throw with: drain IIFE either resolves to `DecodedLevel` (final event) or throws (error event). `result = await drain;` — single state, single error path. Wrap in try/finally to dispose decoder regardless (cite L5-1).

#### L4m-3. WorkerHandle is an implicit state machine with undocumented transitions
- **Category:** contract / bug risk
- **Issue:** WorkerHandle has 4 mutable fields encoding ~6 states: warm-floor (no timer), warm-reapable (timer armed), active (in active set), bad (recycle pending), terminated (terminate called), zombie (in all but neither idle nor active — transient during release/destroyHandle). Transitions happen across 6 different methods (spawnOne, prewarm, acquire, release, recycle, destroyHandle) with no central function. Future edits will silently invent a 7th state.
- **Fix:** Convert to an explicit `WorkerHandleState = 'warm-floor'|'warm-reapable'|'active'|'bad'|'terminated'` enum. Single mutator `setHandleState(h, next)` with a transition table. Invalid transitions throw. The 4 booleans collapse to 1 field + idleTimer.

#### L4m-4. `PyramidWorkerPool.destroyed` is the lifecycle flag with no setter, no transitions
- **Category:** bug (cite L4-1, L4-2)
- **Issue:** Pool lifecycle has states {active, destroyed} but only the {active} state is reachable. No `destroy()` method. Five read sites assume `destroyed` can be true.
- **Fix:** Pool lifecycle becomes its own enum `PoolState = 'created'|'prewarming'|'active'|'draining'|'destroyed'`. `destroy()` transitions through `'draining'` (no new acquires, await active drain, terminate idle) to `'destroyed'`. Pool methods consult the state at entry. Single source of truth.

### QUEUE STATE

#### L4m-5. `idle` mixes queue + set semantics — manipulated by shift/push AND indexOf/splice/includes
- **Category:** perf bug (cite L2-6 / perf-c3d4e5f6)
- **Issue:** `idle.shift()` (L193, queue), `idle.push(h)` (L176, L227, queue), `idle.includes(h)` (L227, O(n) set check), `idle.indexOf(h) + splice` (L256, L283, set removal). Two different conceptual data structures sharing one array. The includes-then-push pattern is a Set-style membership test forced through array operations.
- **Fix:** Track membership on the handle (`h.inIdle: boolean`) so `includes` is O(1). Or split: `idleQueue: WorkerHandle[]` (push/shift) + `idleSet: Set<WorkerHandle>` (membership). Pick one — handle-flag is simpler.

#### L4m-6. `next` counter in coroutines depends on single-threaded JS invariant — undocumented
- **Category:** contract
- **Issue:** decodeTilesParallel (L334): `let next = 0;`. Coroutines do `const idx = next++;` (L341). Read-modify-write that works ONLY because JavaScript is single-threaded between awaits, and the increment + tile access happen in the same synchronous tick. If anyone ever inserts an `await` between these two lines, the invariant breaks silently.
- **Fix:** Comment block at L334: `// Single-threaded JS invariant: next++ + tiles[idx] runs without yield. Do NOT introduce an await between them.`. Alternative: use an explicit synchronous helper `claimNextTile()` that bundles the read + increment + bounds-check, returns `null` when exhausted.

#### L4m-7. No request waiter queue — over-cap requests silently downgrade to single-WASM main-thread
- **Category:** speed bug (cite L4-7, L4-8)
- **Issue:** `acquire(N)` returns ≤N workers; if 0 workers free, returns `[]`. Caller checks length-0 and falls through to single-WASM main-thread decode (L414-418). On a busy pool with bursty pan, this happens every few frames. Workers free up moments later but the request already paid the main-thread cost.
- **Fix:** Bounded waiter queue: `acquire(N, {maxWaitMs?})` returns a Promise that resolves when N (or up to N) workers are available, OR when timeout. `release()` drains waiters before re-arming idle timer. Caller chooses to fall back to main-thread only after waitMs (60ms default — one paint frame).

#### L4m-8. Sparse `results[]` doubles as decode output queue
- **Category:** perf (cite L2-7) + bug-prone
- **Issue:** `new Array(tiles.length)` (L333) is filled out-of-order by coroutines as they complete tiles. Holey for the duration. Final consumer (`stitch`) iterates with `for-of` — Array iterator handles holes via `undefined`, so an unfilled slot would crash stitch's destructure `{region, decoded}`. Currently impossible because failed-flag aborts the call; but state-machine-wise, the invariant "results is dense at stitch time" is never asserted.
- **Fix:** Stream-stitch (cite L6-3, L3m-11) — no `results` array; tiles written into outBuffer as they arrive. Eliminates sparse-array engine cost AND the densenness invariant.

### CANCELLATION STATE

#### L4m-9. NO cancellation state anywhere in the codebase
- **Category:** missing feature (cite L1-4, L4-3, concurrency-009)
- **Issue:** No `AbortSignal`, no AbortController, no `cancelled` flag, no cooperative bail-out. Pan/zoom invalidates a viewport but in-flight tiles continue. Pool slot held the whole time. UI cannot tell library "stop, I don't want this anymore."
- **Fix:** Thread `AbortSignal` through every public entry point. Pool's coroutines + `decodeTileWithWorker` check `signal.aborted` at every yield boundary. Each `signal.aborted = true` triggers: reject in-flight promises with `AbortError`, post `{type:'cancel', id}` to workers, release pool slot. Centralizes "stop work" into one type. Cite L3-5 for worker-side semantics.

#### L4m-10. `failed` flag is internal-only "cancellation"
- **Category:** bug (cite L5-8)
- **Issue:** decodeTilesParallel (L335-340): when any coroutine catches an error, sets `failed=true`. Other coroutines check `if (failed) break;` between iterations. This IS a cancellation mechanism — but ONLY internally triggered by failure, not by external signal. There's no API to set `failed` from outside.
- **Fix:** Replace `failed` with the AbortController introduced for L4m-9. Internal failure: `controller.abort()`. External signal: `signal.addEventListener('abort', () => controller.abort())`. One state, two triggers. Coroutines check `controller.signal.aborted` instead of `failed`.

#### L4m-11. Worker terminate is the only "hard cancel"
- **Category:** speed bug
- **Issue:** Without protocol-level cancel, the only way to make a worker stop is `worker.terminate()` (L296). Kills the WASM heap, frees the slot, requires full re-spawn for next request (~5-20ms cold start). Used today only inside destroyHandle. If we wanted to cancel mid-decode, the cost-per-cancel would be enormous.
- **Fix:** Protocol `{type:'cancel', id}` (cite L3-5). Worker checks before posting reply — skips it if cancelled. Worker stays alive, no respawn cost. Pair with L4m-9 AbortSignal at the host side.

### ERROR STATE

#### L4m-12. `firstErr` drops subsequent errors (first-wins capture)
- **Category:** bug (cite L5-8)
- **Issue:** decodeTilesParallel: only the first error is retained. If 3 tiles fail near-simultaneously (cascading OOM), only one error surfaces. Postmortem analysis impossible.
- **Fix:** Replace `let firstErr` with `const errors: Error[] = []`. On Promise.all complete: if errors.length, throw `new AggregateError(errors, 'tile decode failed')`. Standard API; UI/observability can iterate `.errors`.

#### L4m-13. `WorkerHandle.bad` boolean — no reason code, no error retained
- **Category:** bug + observability gap
- **Issue:** L254: `h.bad = true;`. Pool knows worker is poisoned but not why. Can't decide retry vs blacklist. Can't surface to telemetry.
- **Fix:** Replace boolean with `h.failure?: { code: string, message: string, at: number, count: number }`. spawnOne resets to undefined. recycle populates with the error. acquire skips handles with code === 'CRITICAL' or count >= maxRetries (configurable). Pairs with L3-9 error taxonomy.

#### L4m-14. No error-rate tracking at the pool level
- **Category:** missing feature
- **Issue:** Pool can't tell "worker A has failed 3 times in 10 seconds, kill it eagerly." No window-based error counter. The L4m-13 retain-per-handle doesn't aggregate.
- **Fix:** `PoolStats { spawnFailures: counter; tileFailures: counter; recycleCount: counter; }` exposed via `pool.getStats()`. Window-based (e.g., 60s sliding count). Pool can implement adaptive throttling later; consumer can wire to dashboards now.

#### L4m-15. No error history — postmortem is impossible
- **Category:** observability
- **Issue:** When `decodeTiledViewportPooled` rejects, the caller catches the error. By the time the caller logs it, the context (which tiles, which workers, which region) is gone.
- **Fix:** Pool maintains an in-memory ring buffer of last N errors with full context: `pool.recentErrors(): Array<{ts, scope, workerId, tileId, code, message}>`. Bounded (e.g., 100 entries). Cheap; invaluable for triage. Production wires to remote logging at higher cardinality.


---

# Lens 5 (master) — Data structures

Scope: every named or anonymous data shape across the 3 files. What's the shape, what's its lifetime, where does it overlap with another, where does it leak.

## Inventory

| Sub-axis | Identifier | Shape | File:line |
|---|---|---|---|
| Buffer | `bytes` / `containerBytes` | `Uint8Array` (JXTC container) | decode-level L20+L107, pool L373 |
| Buffer | `DecodedLevel.pixels` | `Uint8Array` (output) | decode-level L10 |
| Buffer | `WorkerReply.pixels` | `ArrayBuffer` declared (actually Uint8Array — cite L3-3) | pool L63 |
| Buffer | stitch output | `new Uint8Array(viewport.w * viewport.h * bpp)` | decode-level L65, pool L41 |
| Buffer | per-row stitch view | `decoded.pixels.subarray(srcOff, srcOff+srcStride)` | decode-level L78, pool L52 |
| Queue | `idle` | `WorkerHandle[]` (FIFO push/shift + Set-like indexOf/includes) | pool L148 |
| Queue | `all` | `Set<WorkerHandle>` | pool L147 |
| Queue | `active` | `Set<WorkerHandle>` | pool L149 |
| Queue | `tiles` | `ImageRegion[]` | pool L397, decode-level L107 |
| Queue | `parts` / `results` | `Array<{region, decoded}>` (sparse) | decode-level L114, pool L333 |
| Manifest | `PyramidLevel` | imported type | choose-level L1 |
| Manifest | `LevelSource` (whole \| tiled) | imported tagged union | decode-level L7 |
| Tile desc | `ImageRegion` | `{x, y, w, h}` (used for viewport, tile, ROI, clamp) | imported from tiling |
| Tile desc | tile payload | `{region: ImageRegion, decoded: DecodedLevel}` | pool L327, decode-level L114 |
| Tile desc | JXTC header | inferred return of `parseJxtcHeader` (no named type) | pool L381 |
| Options | decode-level options | `{parallel?, decodeRegion?}` (anonymous) | decode-level L92, L128 |
| Options | pool options | `{parallel?, decodeRegion?, workerFactory?}` (anonymous) | pool L375 |
| Options | pool ctor opts | `{factory, maxSize, idleTimeoutMs, minIdle?}` | pool L154 |

## Findings

### BUFFERS

#### L5m-1. `WorkerReply.pixels: ArrayBuffer` lies; worker posts Uint8Array → silent memcpy
- **Category:** perf bug (cite L3-3, logic-004)
- **Issue:** L62-64 declares `pixels: ArrayBuffer`. Worker actually posts a `Uint8Array` view. Receive-side `new Uint8Array(ev.data.pixels)` (L86) hits the copy-constructor branch, ~1 MB memcpy per tile. Comment L80-83 lies about zero-copy.
- **Fix:** Widen type to `pixels: Uint8Array | ArrayBuffer`; receive-side branches: `const px = ev.data.pixels instanceof Uint8Array ? ev.data.pixels : new Uint8Array(ev.data.pixels);`. Uint8Array passthrough is structural-clone metadata only.

#### L5m-2. No buffer ownership flag — caller can't tell which buffers are safe to reuse / transfer
- **Category:** contract gap
- **Issue:** `DecodedLevel.pixels` could be (a) freshly allocated (decode-level stitch), (b) freshly allocated then transferred from worker (pool stitch), (c) caller's own outBuffer (when L6-1 lands). All same type, different ownership semantics. Caller cannot safely call `postMessage(pixels, [pixels.buffer])` without knowing the source.
- **Fix:** Extend the return shape: `DecodedLevel { pixels, width, height, ownership: 'fresh' | 'caller-provided' }`. Or: caller passes `opts.outBuffer` — sole signal of caller-owned. Without outBuffer, returned buffer is always 'fresh'. Document.

#### L5m-3. Stitch output buffer is freshly allocated per ROI — large + frequent
- **Category:** perf (cite L6-1)
- **Issue:** `new Uint8Array(viewport.w * viewport.h * bpp)` per call. 2048×1024×4 = 8MB; rgba16 = 16MB. At pan rate ≈ 240MB/s GC churn.
- **Fix:** Caller-owned reusable buffer (cite L2-11, L6-1). `opts.outBuffer?: Uint8Array`. Library validates `outBuffer.length >= w*h*bpp`, writes into the prefix, returns same buffer.

#### L5m-4. No alignment contract documented for input or output buffers
- **Category:** contract (low)
- **Issue:** WASM heap operations want aligned buffer offsets. Uint8Array can be a view over a buffer at any offset. If a caller passes `containerBytes = bigBuffer.subarray(7, ...)`, WASM may degrade or fail. The library makes no guarantee or check.
- **Fix:** Document: "Input buffers SHOULD start at 4-byte-aligned `byteOffset` for optimal WASM performance." Assert at entry in debug builds: `if (containerBytes.byteOffset % 4 !== 0) console.warn(...)`. Production: no check.

#### L5m-5. Buffer length never asserted vs (width × height × bpp)
- **Category:** bug-prone
- **Issue:** Worker reply has `{pixels, width, height}`. Receive-side trusts width × height × bpp = pixels.length. A malformed worker (or after L5m-1 the type-widened path) could send mismatched values. `stitch` then either over- or under-reads. Cite security-d4e5f6a7.
- **Fix:** Inside parseWorkerReply validator (cite L2m-13): `if (data.pixels.length !== data.width * data.height * expectedBpp) return null;`. Per-tile sanity check; cheap.

### QUEUES

#### L5m-6. Idle queue is FIFO — reaper targets oldest = coldest-cached worker is most-likely-reaped
- **Category:** speed (low) — opposite of ideal
- **Issue:** `idle.shift()` (L193) returns oldest. Reaper (L268-272) trims excess from the FRONT of idle. Result: oldest workers reaped first. But "oldest" = "longest since last decode" = "coldest cache." Want to keep HOT workers and reap COLD. Actually `shift` returns OLDEST (FIFO insertion) — same direction as reaper. So acquire returns OLDEST. That's the COLDEST. We want LRU: acquire returns NEWEST (hottest).
- **Fix:** Switch to LIFO for acquire: `idle.pop()` instead of `idle.shift()`. Reaper still trims excess from the bottom (oldest = coldest, correct to reap). Acquire gets the worker most recently used (hottest libjxl module cache + most recent V8 inline caches).

#### L5m-7. `tiles[]` ordering is scan-order — perceived latency suboptimal
- **Category:** speed (cite L6r-6)
- **Issue:** `tilesOverlappingRegion` returns tiles in scan order. decodeTilesParallel dispatches in array order. Tiles at the viewport edge complete around the same time as center tiles, but the user is looking at the center.
- **Fix:** Sort `tiles` by distance to viewport centroid before dispatch. One sort per ROI; cheap. Center pops first; edges trail. Perceived first-meaningful-paint earlier.

#### L5m-8. `parts/results` strong-holds decoded tiles until stitch
- **Category:** perf (cite L6-3)
- **Issue:** Sparse `results[]` retains `decoded.pixels` for every tile until Promise.all completes. Peak memory ≈ 2× viewport.
- **Fix:** Stream-stitch (cite L3m-11, L6-3): write tile into outBuffer on receive; drop reference. results[] becomes void.

#### L5m-9. No pending-request queue at pool entry
- **Category:** speed bug (cite L4m-7)
- **Issue:** Over-cap acquire returns `[]`. No "wait for one" path.
- **Fix:** `acquire(N, {maxWaitMs})` with internal waiter queue. Resolves as workers free.

### MANIFESTS

#### L5m-10. Pool ignores `PyramidLevel`; re-derives dims from JXTC header on every call
- **Category:** perf + contract (cite L1-2, L1r-11)
- **Issue:** Pool entry `decodeTiledViewportPooled(containerBytes, ...)` takes raw bytes. Calls `parseJxtcHeader` (L381) each invocation. Manifest already has the dims — pool throws away that knowledge.
- **Fix:** Pool entry takes `LevelSource` (cite L2m-4). Header parse becomes optional verify step (cite L1r-11).

#### L5m-11. No runtime manifest validation at boundary
- **Category:** bug (cite L2m-13, contracts-004, security-b8c9d0e1)
- **Issue:** Manifest fetched as JSON, cast to `PyramidManifest` type. No schema check. Producer drift, malicious manifest, version skew — all silently accepted.
- **Fix:** Adopt Zod (already used in pyramid-ingest per finding). `parsePyramidManifest(json)` returns `Result<PyramidManifest, ValidationError>`. Boundary check; everything downstream is trusted.

#### L5m-12. `bitsPerSample` is the trust anchor — pool ignores it
- **Category:** critical bug propagation (cite L1-6, L1r-11, logic-001)
- **Issue:** Manifest carries authoritative bits. LevelSource may carry it (when tiled). Pool re-derives from header. Worker ignores both, hardcodes rgba8. Four trust layers; three disagree; one wrong wins.
- **Fix:** Single source: manifest. Pool reads from LevelSource (not header). Worker request includes format (cite L3-1). Trust chain: manifest → LevelSource → pool → worker, monotonically narrowing, no re-derivation.

#### L5m-13. Two `PyramidLevel`-shaped types: writer (pyramid-ingest) vs reader (jxl-pyramid)
- **Category:** contract (cite contracts-005)
- **Issue:** Same fields, different declarations. `proxy?: true` (writer) vs `proxy?: boolean` (reader) already drifts. Future fields will diverge silently.
- **Fix:** Move `PyramidLevel` + `PyramidManifest` to a shared type-only package (e.g., `@casabio/jxl-pyramid-types`) consumed by both. Or: writer and reader both depend on `@casabio/jxl-pyramid` directly. Single declaration.

### TILE DESCRIPTORS

#### L5m-14. `ImageRegion` plays four semantic roles
- **Category:** contract clarity
- **Issue:** `{x, y, w, h}` used for: (a) caller-supplied viewport, (b) clamped viewport (after entry guards), (c) tile bounds (return of tilesOverlappingRegion), (d) ROI passed to WASM. Four meanings, same shape. Future readers can't tell which is which without context.
- **Fix:** Branded types: `type Viewport = ImageRegion & { __brand: 'viewport' }; type TileBounds = ImageRegion & { __brand: 'tile' };` etc. Or: rename functions/params consistently: `viewport`/`tileBounds`/`roi`. Even if just the latter — clarity matters.

#### L5m-15. Tile descriptor carries no tile index — debug "which tile failed" requires reverse-calc
- **Category:** observability
- **Issue:** A tile is identified only by its `{x, y, w, h}` ImageRegion. Error message "tile decode failed at region {64, 0, 64, 64}" requires the reader to divide by tileSize to know it was column 1, row 0.
- **Fix:** Extend tile descriptor to `{region, col, row, index}` where col/row are tile-grid coords, index is the flat slot. tilesOverlappingRegion populates them. Trivial; pays off in every error message + telemetry.

#### L5m-16. `JxtcHeader` is not a named exported type
- **Category:** contract
- **Issue:** `parseJxtcHeader` return is inferred — `{imageW, imageH, tileSize, bitsPerSample, ...}`. No named type to spread, no documented field list.
- **Fix:** Export `interface JxtcHeader { imageW: number; imageH: number; tileSize: number; bitsPerSample: 8 | 16; version: number; }` from tiling.ts. parseJxtcHeader return-typed explicitly. Pool / decode-level reference by name.

### OPTIONS

#### L5m-17. Three anonymous options objects with overlapping shapes
- **Category:** efficiency + contract (cite L2m-5)
- **Issue:** decode-level decodeTiledViewport, decode-level decodeLevel, pool decodeTiledViewportPooled — three anonymous types: `{parallel?, decodeRegion?}` and `{parallel?, decodeRegion?, workerFactory?}`. Adding `signal` means editing three.
- **Fix:** `export interface DecodeOptions { parallel?: boolean; decodeRegion?: RegionDecoder; workerFactory?: () => WorkerLike; signal?: AbortSignal; outBuffer?: Uint8Array; onTile?: (tile: DecodedTile) => void; strategy?: 'auto'|'single'|'parallel'; cache?: PyramidCache; }` in shared types.ts. All entry points use it.

#### L5m-18. `parallel: undefined | true | false` is tri-state; default is unclear
- **Category:** contract
- **Issue:** decode-level L108: `options?.parallel !== false && canUseParallelTileWorkers() && tiles.length > 1`. Default behavior: tries parallel unless explicitly disabled. But pool L398 has SAME logic — `options?.parallel !== false && canUseParallelTileWorkers() && tiles.length > 1 && options?.workerFactory !== undefined`. Caller looking at JSDoc / type sees `parallel?: boolean` and has to read source to know `undefined === true` semantics.
- **Fix:** Either (a) rename to `disableParallel?: boolean` (clear default false = parallel on), OR (b) default-explicit JSDoc: `parallel?: boolean (default: true if available, else single)`. Pick (b); less churn.

#### L5m-19. Pool constructor mixes capacity + timing + factory — no separation of concerns
- **Category:** contract
- **Issue:** `{factory, maxSize, idleTimeoutMs, minIdle?}` — four orthogonal things. Adding `requestTimeoutMs` (L3-11) or `memoryProbe` (L6r-11) bloats the same flat object.
- **Fix:** Group: `{factory, capacity: {maxSize, minIdle?}, timing: {idleTimeoutMs, requestTimeoutMs?}, observability: {logger?, onError?, memoryProbe?}}`. Backwards compat: accept the flat shape too. Caller code becomes self-documenting.


---

# Lens 6 (master) — Hot kernels

Scope: every loop, copy, transform, and resampler in the JS layer. **Key framing:** jxl-pyramid is by design a *thin orchestrator over libjxl WASM*. The bulk of CPU work happens behind a single FFI call. So most of this lens evaluates what JS *isn't* doing (correctly delegated to WASM) and the small set of JS-side kernels that DO live in these files.

## Kernel inventory

| Sub-axis | What's in JS | What's delegated to WASM |
|---|---|---|
| Pixel loops | none (no per-pixel iteration in JS) | all pixel math via `decodeTileContainerRegion*`, `createDecoder` |
| Chunk loops | for-of over `parts` (stitch); `tiles.map` (decode-level); `workers.map` + `while(true)` work-stealer (pool) | per-tile decode = single WASM call |
| Copy loops | stitch: `pixels.set(...)` per tile (fast path) and per row (fallback) | none |
| Colour transforms | none — explicitly deferred | inside libjxl decoder (ICC parse, ITU-R BT.709 if YCbCr) |
| Resampling | none in pixel layer; pyramid level pick is the spatial-resolution control | libjxl downsample-on-decode (optionally — if jxl-wasm exposes it) |

## Findings

### PIXEL LOOPS

#### L6m-1. No per-pixel JS loops — correctly delegated to WASM
- **Category:** architecture (positive note)
- **Issue:** Search the 3 files: zero `for (let i = 0; i < pixels.length; ...) { pixels[i] = ... }` patterns. All pixel-by-pixel work runs inside libjxl. This is the right design — JS pixel loops would lose libjxl's SIMD + cache locality.
- **Fix:** None needed. Add a comment block to decode-level.ts top-of-file: "Pixel-level math lives in libjxl WASM. Do not introduce per-pixel JS loops; they will be SIMD-defeated and cache-thrashing." Pre-empts the inevitable "let me normalize bytes in JS" PR.

#### L6m-2. JS-layer per-pixel transform would be a regression — preemptive reject
- **Category:** anti-pattern (defensive)
- **Issue:** CLAUDE.md "Recurring False Claims" list captures the rejected-output-buffer-pool pattern. A parallel false-claim hazard for jxl-pyramid: "let me apply tone-map / gamma / dithering in JS after decode." V8 + SpiderMonkey TypedArray loops are sub-WASM by 4-10x and prevent libjxl's downstream optimizations.
- **Fix:** Add to the project's rejected-claims log (or jxl-pyramid's CLAUDE.md when one exists): "Per-pixel transform in JS: rejected. libjxl ICC apply + format conversion is the canonical place. Caller-level GL/Canvas transforms are also fine. JS pixel loops are not."

### CHUNK LOOPS

#### L6m-3. Stitch `for-of` over `parts` allocates an iterator
- **Category:** perf (low)
- **Issue:** decode-level L67 + pool L43: `for (const { region, decoded } of parts)`. for-of allocates an iterator and destructures per iteration. With N tiles per stitch, N iterator-next allocations + N destructure bindings.
- **Fix:** Indexed for: `for (let i = 0; i < parts.length; i++) { const p = parts[i]; const region = p.region; const decoded = p.decoded; ... }`. Trivial win; V8/SpiderMonkey often optimize for-of well, but indexed for is portable + zero-alloc-guaranteed.

#### L6m-4. `tiles.map(async tileRegion => ...)` in decode-level — Promise.all hot path
- **Category:** perf (cite L2-3, L5-5)
- **Issue:** decode-level L114-119: `Promise.all(tiles.map(async (tileRegion) => ({region, decoded: await decodeRegion(...)})))`. map allocates intermediate array of Promises; each async closure captures `decodeRegion`, `source.bytes`. Per ROI: N closure-allocations + N Promise allocations + 1 intermediate array.
- **Fix:** Replace map+Promise.all with the pool's coroutine pattern (workers.map + while-loop + shared `next` counter). Same parallelism, fewer allocations. Pairs with L4m-9 AbortSignal threading: same control-flow, gain cancellation.

#### L6m-5. `workers.map(async worker => ...)` in pool coroutine — needs cancellation
- **Category:** missing feature (cite L4-3, L4m-9)
- **Issue:** Pool L338-357: each worker runs `while(true) { ...; await decodeTileWithWorker(...); ... }`. Loop bail condition is `failed` flag. No external abort.
- **Fix:** Replace `while(true) { if (failed) break; ... }` with `while (!signal.aborted) { ...; if (signal.aborted) break; ... }`. AbortSignal is the universal control. Cite L4m-10.

#### L6m-6. Work-stealer relies on undocumented `next++` invariant
- **Category:** bug-prone (cite L4m-6)
- **Issue:** `const idx = next++; if (idx >= tiles.length) break;` — works because no yield between `next++` and `tiles[idx]`. One stray await would race.
- **Fix:** Wrap into `claimNextTile()` helper that bundles read + increment + bounds check synchronously. Helper documents the invariant in its name.

#### L6m-7. No SIMD hint for chunk-level memcpy in stitch
- **Category:** perf (engine-dependent)
- **Issue:** `pixels.set(decoded.pixels, dy * dstStride)` is the workhorse. Engines DO auto-vectorize TypedArray.set in practice (V8 uses memcpy / SIMD memmove on x64). No JS-side hint can improve it.
- **Fix:** Confirm via benchmark on V8 + SpiderMonkey: a single `set()` of a 4MB block hits AVX2/SSE2. If yes (likely), document as a non-issue. If no, file with the engine; no JS-side fix available.

### COPY LOOPS

#### L6m-8. Stride-aligned fast path: optimal
- **Category:** positive note
- **Issue:** decode-level L71-73, pool L47-49: when tile width = viewport width and `dx === 0`, the tile's pixels are a contiguous full-stride block. Single `pixels.set(decoded.pixels, dy * dstStride)` — one memcpy, no row loop. This is correct and already optimal.
- **Fix:** None. Cite in praise of `level2 audit I4` per code comment.

#### L6m-9. Fallback row-by-row creates `subarray()` view per row
- **Category:** perf (low)
- **Issue:** decode-level L75-79, pool L51-55: when fast path doesn't apply, loop allocates `decoded.pixels.subarray(srcOff, srcOff+srcStride)` per row. View object per row = ~1024 small allocations for a tall partial-width tile.
- **Fix:** TypedArray.set has no offset+length variant accepting raw indices. Subarray is forced. The view objects are short-lived; engines handle them in young gen. Bench first. If profile shows pressure: investigate if `pixels.copyWithin` or a wasm-side stitch helper would beat the JS loop. Likely not worth it — accept and document.

#### L6m-10. Worker reply: `new Uint8Array(ab)` is a hidden memcpy (cite L5m-1, L3-3)
- **Category:** perf bug
- **Issue:** L86. ~1 MB memcpy per tile. Already addressed in L5m-1.
- **Fix:** Cite L5m-1.

#### L6m-11. `pixels.set` is the right primitive — engines SIMD it
- **Category:** positive note
- **Issue:** No need to hand-roll SIMD. V8 + SpiderMonkey both implement `TypedArray.prototype.set(typedArray, offset)` via memcpy paths (SSE2/AVX2 on x64; NEON on ARM64).
- **Fix:** None. Document in CLAUDE.md or jxl-pyramid notes: "Stitch uses TypedArray.set — already SIMD via engine memmove. Do not propose hand-rolled SIMD; the engine already does it."

### COLOUR TRANSFORMS

#### L6m-12. Absent by design — caller responsibility (cite L3m-4)
- **Category:** architecture (positive note + gap)
- **Issue:** No gamma, no ICC apply, no YCbCr→RGB, no tonemap. Pixels emerge as decoded — sRGB-space rgba8 or rgba16. Correct in a thin-decoder model; problematic for wide-gamut workflows.
- **Fix:** Document the contract. `DecodedLevel` JSDoc: "pixels are sRGB rgba8 or rgba16 unless the source JXL container specifies otherwise; ICC profile (if present) is currently NOT exposed — see L3m-4 / ADR."

#### L6m-13. No premultiplied-alpha state on output
- **Category:** contract gap
- **Issue:** rgba8/rgba16 output is straight (non-premultiplied) per libjxl default. Canvas wants premultiplied; WebGL accepts either. No flag on `DecodedLevel`.
- **Fix:** Add `DecodedLevel.alphaMode: 'straight' | 'premultiplied'` (default 'straight'). Caller passes to canvas via `getContext('2d', {willReadFrequently: false, alpha: true})` correctly.

#### L6m-14. No tone-mapping path for rgba16 → 8-bit display
- **Category:** missing feature
- **Issue:** rgba16 levels (HDR or 16-bit precision) need tonemap before painting to sRGB canvas. Library doesn't. Caller chooses: pass to WebGL with custom shader (best), or naive truncate (broken highlights).
- **Fix:** Out of scope by design. Pair with CasaSneyers_Parity work flagged in user memory (`project-casasneyers-parity.md`). Document and defer.

#### L6m-15. No ICC profile side-channel (cite L3m-4)
- **Category:** missing feature
- **Issue:** libjxl parses ICC; jxl-wasm preserves it (per CLAUDE.md facade.ts); jxl-pyramid drops it. Wide-gamut workflow silently flattens.
- **Fix:** Extend `DecodedLevel.iccProfile?: Uint8Array` (cite L3m-4). Pass-through from jxl-wasm event. Caller applies via CSS `color-profile` or canvas2d color-management.

### RESAMPLING

#### L6m-16. No resampler in pixel layer — pyramid level pick IS the resampling control (cite L3m-5)
- **Category:** architecture (intended)
- **Issue:** No JS resize, no box filter, no Lanczos. Pyramid is multi-resolution by design: pick the right level, then exact-blit. Resize beyond level-pick = caller's canvas / WebGL.
- **Fix:** None for this layer. Pair with L3m-5 optional `opts.outputSize` knob that hints libjxl to downsample-on-decode.

#### L6m-17. No box-filter / mipmap for over-sized levels (cite L3m-5)
- **Category:** speed
- **Issue:** chooseLevelForTarget can pick a level meaningfully larger than viewport target (e.g., target=512, only levels 1024 and 256 exist → picks 1024). decoder produces 1024-wide pixels; caller downscales 2× in canvas. Pixel bandwidth wasted; canvas resampler is rarely best.
- **Fix:** If jxl-wasm has downsample-on-decode (libjxl does), expose `opts.outputSize`. If not, document: "Caller may receive pixels up to 2× the targetLongEdge in the worst case." Pair with L3m-5.

#### L6m-18. No LOD blend across two adjacent pyramid levels
- **Category:** quality
- **Issue:** When zoom value is mid-level (e.g., between L_2 = 1024 and L_3 = 2048), caller paints from one level only. Mip-style trilinear blend (decode N + N+1, alpha blend) avoids the visible "snap" when crossing level boundaries.
- **Fix:** Out of scope here; caller's compositor problem. But `chooseLevelForTarget` could return `{primary, secondary?, blendT?}` for the caller to compose. Architectural — write ADR. (Photogrammetry / digital-twin work in user memory may want this.)

#### L6m-19. Stitch positions tiles at integer-pixel; sub-pixel scroll loses fidelity
- **Category:** quality (mostly out of scope)
- **Issue:** ImageRegion is integer-pixel. Pan with sub-pixel offset (e.g., scroll wheel deltaY=0.5) gets rounded by caller. Library has no notion of fractional viewport.
- **Fix:** Out of scope — caller's compositor handles sub-pixel paint via canvas drawImage's source/dest coords or WebGL UV. Library remains pixel-integral. Document.


---

# Lens 7 (master) — Boundary points

Scope: every place data crosses an isolation boundary. Each crossing has a serialization cost (copy or transfer), a contract surface (type guarantees on both sides), and an error mode (what happens when the other side misbehaves).

## Boundary inventory

| Boundary | Direction | Mechanism | Site |
|---|---|---|---|
| JS → WASM | input bytes | `decodeTileContainerRegion*(bytes, region)` | decode-level L50, L55; pool implicit via worker |
| WASM → JS | output pixels | return `{pixels, width, height}` (facade-managed) | same |
| JS → WASM | streaming bytes | `decoder.push(bytes)` | decode-level L39 |
| WASM → JS | streaming events | `decoder.events()` async iterator | decode-level L30 |
| Main → Worker | tile request | `worker.postMessage({id, bytes, region})` | pool L122 |
| Worker → Main | tile reply | `worker.postMessage(reply, [reply.pixels.buffer])` (transfer) | implicit in worker.js |
| Main ↔ Worker | error / messageerror | event listener | pool L94-117, L244-245 |
| Rust ↔ C/C++ | not visible at this layer | crates/raw-pipeline ↔ jxl-wasm/bridge.cpp | two layers down |

## Findings

### JS ↔ WASM

#### L7m-1. Per-call WASM bridge overhead amortized poorly across small ROIs
- **Category:** perf
- **Issue:** Every `decodeTileContainerRegionRgba8/16` is a JS→WASM transition (argument marshal, heap copy, return marshal). Fixed cost ~50-200μs per call depending on payload. For an ROI of 16 tiles × parallel=4 workers, each worker makes 4 calls — fixed cost per call dominates for small tiles.
- **Fix:** No JS-side fix possible without a batched-ROI interface in jxl-wasm. Document as a measured baseline; file with jxl-wasm if pan profiling shows it.

#### L7m-2. No batched WASM call for tiled regions
- **Category:** missing feature
- **Issue:** Pool dispatches one WASM call per tile. libjxl can decode multiple ROIs in a single call if jxl-wasm exposed `decodeTileContainerRegions(bytes, regions[])`. Single bridge cost; libjxl can share parse state across ROIs (faster).
- **Fix:** Out of scope for jxl-pyramid. File enhancement against jxl-wasm/bridge.cpp; when available, the pool's `decodeTilesParallel` collapses to one call per worker.

#### L7m-3. Input container bytes are copied into WASM heap per call
- **Category:** perf
- **Issue:** Per CLAUDE.md (facade.ts: "WASM heap management; zero-copy writes; capability cache"), the input is copied into a grow-only WASM heap buffer. For ROI decode, the SAME container bytes are copied INTO the heap every call. For 16 ROIs in one viewport: 16 × container_size memcpy into WASM heap, even though the container is identical.
- **Fix:** jxl-wasm-side: `loadContainer(bytes) → containerHandle` once; subsequent `decodeRegion(containerHandle, region)` calls reuse the loaded container. Mirrors the L3-4 protocol idea at the WASM boundary. Out of scope for jxl-pyramid; file against jxl-wasm.

#### L7m-4. Output pixels: unclear lifetime — view-over-heap or copy?
- **Category:** contract gap
- **Issue:** decode-level L32: `ev.pixels instanceof Uint8Array ? ev.pixels : new Uint8Array(ev.pixels)`. The Uint8Array branch keeps the view from jxl-wasm; the ArrayBuffer branch copies. WASM heap is grow-only — subsequent decode call may move the buffer, invalidating any view. Caller has no contract: is `DecodedLevel.pixels` safe to retain across the next decode call?
- **Fix:** Document the contract per the actual jxl-wasm facade behavior. If WASM facade always copies pixels into a JS-owned ArrayBuffer (CLAUDE.md hints at zero-copy WRITES, not reads), state that. If it returns a view: caller must consume before next call. Either way, document in `DecodedLevel.pixels` JSDoc.

#### L7m-5. No capability / version handshake with `@casabio/jxl-wasm` (cite L2m-9)
- **Category:** contract
- **Issue:** Functions imported and called without runtime check. Older jxl-wasm without rgba16 silently fails at first 16-bit decode.
- **Fix:** Cite L2m-9. Assert presence of `decodeTileContainerRegionRgba16` on pool prewarm; throw early.

### WORKER ↔ MAIN THREAD

#### L7m-6. Container bytes structured-cloned per tile per worker (largest boundary cost)
- **Category:** perf (cite L3-4, L6-2, L6r-1)
- **Issue:** L122: `worker.postMessage({id, bytes, region})`. Container `bytes` is structured-cloned into worker's heap per message. 64 MB container × 16 tiles × 4 workers = up to 64 clones, ~4 GB of total clone activity per viewport. The dominant boundary cost in the entire pipeline.
- **Fix:** Load/decode protocol split (cite L3-4): one `{type:'load', bytesId, bytes}` per worker, then small `{type:'decode', bytesId, region, format, id}` per tile. SAB upgrade (cite L6r-1): zero copies.

#### L7m-7. Worker → Main reply receive-side is a copy (cite L3-3, L5m-1, L6m-10)
- **Category:** perf bug
- **Issue:** Worker sends `{pixels: Uint8Array, ...}` with `[pixels.buffer]` transfer. Receive-side `new Uint8Array(ev.data.pixels)` is the copy-constructor branch. Comment lies about zero-copy.
- **Fix:** Cite L3-3.

#### L7m-8. SAB unused despite COOP/COEP gate already in place
- **Category:** perf (large) (cite L6r-1)
- **Issue:** `canUseParallelTileWorkers()` requires `crossOriginIsolated`, which is the SAME precondition as SAB. The parallel-worker path runs ONLY when SAB is available. Comment at L117-121 dismisses SAB as "out of scope" — that's the biggest unrealized win in this codebase.
- **Fix:** Cite L6r-1.

#### L7m-9. No batched worker request — one postMessage per tile
- **Category:** perf
- **Issue:** Worker spends most of its time waiting for `postMessage` to arrive. After L7m-6 load/decode split, the per-tile message is tiny but still one message per tile.
- **Fix:** Optional batched request: `{type:'decodeBatch', bytesId, regions: ImageRegion[], format, baseId}`. Worker decodes the batch and posts ONE reply with an array of pixel buffers (one transfer list with all buffers). Removes N-1 message ceremonies per worker per viewport. Pairs with stream-stitch (cite L3m-11) — caller still sees per-tile arrival; just fewer round-trips at the message layer.

#### L7m-10. No protocol contract for `messageerror` payload (cite L3-2)
- **Category:** contract gap
- **Issue:** Worker `messageerror` event is fired by the browser when structured clone fails on either direction. Handler at L97-99 stringifies `ev?.message || ev || 'unknown'` — generic. No discriminator: was it inbound clone failure (the worker sent something un-cloneable) or outbound (we sent something un-cloneable)?
- **Fix:** messageerror handler distinguishes: log `ev.type === 'messageerror'` separately from `'error'`. Mark the worker bad with reason 'CLONE_FAILED'. Pair with L4m-13 reason codes.

### RUST ↔ C/C++

#### L7m-11. Boundary lives two layers down — not visible to jxl-pyramid
- **Category:** architecture note
- **Issue:** Per CLAUDE.md layer map: `src/lib.rs` (RAW pipeline) → `packages/jxl-wasm/src/bridge.cpp` (C++ FFI to libjxl). jxl-pyramid sees only the WASM face. Behavior at the Rust/C++ layer (cmake build, libjxl version, SIMD config) is opaque from here.
- **Fix:** None at this layer. Document in jxl-pyramid's CLAUDE.md (when one exists): "This package consumes `@casabio/jxl-wasm` exports only. Rust/C++ boundary is owned by jxl-wasm; do not bypass."

#### L7m-12. ICC profile / EXIF / metadata side-channel dropped at jxl-pyramid layer
- **Category:** missing feature (cite L3m-4, L6m-15)
- **Issue:** libjxl parses ICC, EXIF, XMP. jxl-wasm preserves them (per CLAUDE.md facade.ts). jxl-pyramid never propagates them — `DecodedLevel` has only pixels/width/height. Wide-gamut workflows silently flatten; metadata-aware UIs can't read EXIF.
- **Fix:** Extend `DecodedLevel`: `iccProfile?: Uint8Array, exif?: Uint8Array, xmp?: string`. Forward from jxl-wasm event payload. Pool worker.js needs the protocol bump too. No code in jxl-pyramid generates metadata — it's a pass-through.

#### L7m-13. jxl-wasm/bridge.cpp known blocker noted for awareness
- **Category:** info
- **Issue:** CLAUDE.md notes a forward-declaration blocker at bridge.cpp:575 for `jxl_wasm_transcode_jpeg_to_jxl`. Unrelated to jxl-pyramid's read-only path, but if encode-side support is ever added to pyramid (re-encoding tiles at a different effort, e.g.), this blocker matters.
- **Fix:** None unless encode is added. Document the dependency.

### MEMORY COPY POINTS

#### L7m-14. Per-tile decode crosses 6 copy points (today)
- **Category:** perf
- **Issue:** Catalogue, decoder side: (1) caller's fetch buffer → container `Uint8Array`, (2) main → worker structured clone of container, (3) worker JS → WASM heap copy of container, (4) WASM internal allocations for libjxl decode, (5) WASM → worker JS view-or-copy of pixels, (6) worker → main transfer of pixels (free), (7) main receive-side `new Uint8Array(view)` copy. Stitch then adds: (8) per-tile `pixels.set(decoded.pixels, ...)` into output buffer (mandatory).
- **Fix:** L3-4 protocol split eliminates (2) repeats (clone once per worker). L7m-3 jxl-wasm enhancement eliminates (3) repeats (load once per WASM session). L7m-7 / L3-3 eliminates (7). SAB (L6r-1) eliminates (2) entirely. Stitch (8) is mandatory. End state: 4 copies (fetch, SAB-fill, WASM-read inside libjxl, stitch).

#### L7m-15. Stitch is the only mandatory copy in pyramid layer
- **Category:** positive note
- **Issue:** Of all 8 copies catalogued, stitch is the only one that pyramid logically owns and cannot eliminate without changing its contract (return a single contiguous viewport buffer). Every other copy is in fetch, worker boundary, WASM boundary, or receive-side wrap.
- **Fix:** Frame priorities: optimization wins live outside stitch. Stitch itself is already at optimum (fast path is single set; fallback is row-by-row at SIMD memmove speed).

#### L7m-16. Container buffer journey: 5 distinct buffers, 4 copies
- **Category:** perf
- **Issue:** Today: (a) HTTP response bytes, (b) caller's `containerBytes` Uint8Array (one ArrayBuffer copy via response.arrayBuffer), (c) worker's clone (per message), (d) WASM heap (per call), (e) libjxl internal. SAB collapses to: (a) HTTP, (a-SAB) SAB filled from stream, (e) libjxl internal. Three buffers, two copies.
- **Fix:** Caller adopts ReadableStream-into-SAB pattern (cite L6r-10). Pool's L3-4 protocol carries SAB to workers. End state matches.

#### L7m-17. Output pixel journey: 3 distinct buffers, 2 mandatory copies
- **Category:** perf
- **Issue:** Today: (a) WASM heap pixels, (b) worker JS pixels (view over WASM heap or copy depending on facade), (c) main's `new Uint8Array(view)` (the bug copy from L3-3), (d) stitch buffer. After L3-3 fix: (a)→(b)→(d) — two copies. (b)→(d) is the stitch (mandatory). (a)→(b) is WASM-heap-to-JS-heap (jxl-wasm facade controls; could be view if the facade returns a wrap). After all optimizations: 2 copies, both unavoidable.
- **Fix:** Cite L3-3 to eliminate (c). Document jxl-wasm facade contract for (a)→(b) per L7m-4.


---

# Lens 8 (master) — Support code

Scope: the non-hot, non-core machinery — input validation, error observability, progress signaling, and test coverage. This lens often surfaces low-effort/high-impact wins because support code is where production cost is hidden.

## Inventory

| Sub-axis | What's present | What's absent |
|---|---|---|
| Validation | empty-collection check (choose-level), clamp + empty-viewport guard (decode-level + pool), pool-ctor `Math.max` clamps | NaN/finite checks, manifest schema, WorkerReply shape, invariant assertions |
| Logging | none | every category |
| Progress | streaming events consumed for `final`/`error` only in `decodeWhole` | onTile, partial result, pool lifecycle events, latency telemetry |
| Tests | 4 files in `packages/jxl-pyramid/test/` (choose-level, decode-level, tiling, pyramid) — 10 pass / 1 fail / 1 error baseline | property tests, worker integration, round-trip pyramid-ingest↔jxl-pyramid, 16-bit decode test, perf regression |

## Findings

### VALIDATION

#### L8m-1. Inconsistent error handling: null-return vs throw
- **Category:** contract
- **Issue:** `chooseLevelForTarget(empty)` returns `null` (choose-level L12). `decodeTiledViewport(empty-region)` throws `'decode region is empty after clamping'` (decode-level L104). `decodeWhole(invalid)` throws `'whole-frame decode produced no final frame'`. Three different empty/invalid outcomes; caller must remember which entry uses which.
- **Fix:** Pick one. Recommendation: throw with a taxonomy code (cite L5-10 PyramidError). Update `chooseLevelForTarget` to throw `new RangeError('chooseLevelForTarget requires non-empty levels')` (cite L1r-5).

#### L8m-2. NaN propagation gap — `Math.min`/`Math.max` produce NaN-tainted dims
- **Category:** bug (cite L5-3, L5-4)
- **Issue:** No `Number.isFinite` check at any entry. `Math.min(NaN, ...)` yields NaN; `Math.max(0, NaN)` yields NaN; `rw <= 0` is `false` when rw is NaN; comparison fails open. `new Uint8Array(NaN)` returns length-0 — silent wrong answer.
- **Fix:** Guard at entry: `if (!Number.isFinite(region.x) || ...) throw new PyramidError('BAD_REGION', 'region values must be finite numbers');`. Three sites: decodeTiledViewport, decodeTiledViewportPooled, chooseLevelForTarget.

#### L8m-3. No manifest schema validation at boundary
- **Category:** bug (cite L5m-11, contracts-004, security-b8c9d0e1)
- **Issue:** Manifest fetched as JSON, cast to type. Producer drift, malicious manifest, version skew silently accepted.
- **Fix:** Zod schema in `manifest.ts` (Zod already adopted in pyramid-ingest per finding). `parsePyramidManifest(json): Result<PyramidManifest, ValidationError>`. Single boundary check.

#### L8m-4. Pool constructor silently clamps bad opts — masks caller bugs
- **Category:** contract
- **Issue:** L161-163: `Math.max(1, opts.maxSize)`, `Math.max(0, opts.idleTimeoutMs)`, `Math.max(0, Math.min(opts.minIdle ?? 1, this.maxSize))`. Caller passes `maxSize: -3` → pool quietly uses 1. Caller passes `minIdle: 999` → pool uses maxSize. Caller never learns their config was wrong.
- **Fix:** Throw on invalid. `if (!Number.isInteger(opts.maxSize) || opts.maxSize < 1) throw new RangeError(...)`. Same for `idleTimeoutMs >= 0`, `minIdle >= 0 && minIdle <= maxSize`. Tests catch their own bugs.

#### L8m-5. WorkerReply runtime-untrusted (cite L3-2, L5m-5)
- **Category:** bug
- **Issue:** L76: `ev.data.ok ? ... : ...` trusts the union shape without checks.
- **Fix:** `parseWorkerReply(ev.data)` validator (cite L2m-13).

#### L8m-6. No invariant assertions inside hot path
- **Category:** bug-prone
- **Issue:** Examples that would catch bugs in dev/test: `assert(decoded.width === tileRegion.w)`, `assert(parts.every(p => p.decoded.pixels.length === p.region.w * p.region.h * bpp))`, `assert(tiles.every(t => t.x % source.tileSize === 0 || t.x + t.w === source.width))`. None of these exist.
- **Fix:** Add a `dev-assert.ts` helper with `devAssert(cond, msg)` that no-ops in production but throws in dev/test. Sprinkle across decode-level + pool stitch entry points. Catches contract violations before they corrupt output. Pairs with logic-018 opportunity (shared assertion utility).

### LOGGING

#### L8m-7. Zero logging across all 3 files (cite L5-11)
- **Category:** observability (cross-cutting)
- **Issue:** No `console.*`, no logger import, no event emission. Production failures: spawn-failed (4× silent catch), listener-attach-failed, terminate-failed, fallback-to-main, recycle-on-error — all invisible.
- **Fix:** Inject a logger interface at module entry: `setPyramidLogger({warn, info, error})`. Default = no-op. Wire at every silent catch.

#### L8m-8. No logger-interface injection — caller can't sink to Sentry/Datadog/structured logger
- **Category:** missing feature
- **Issue:** Even with L8m-7 fixed, hardcoded `console.warn` doesn't route to telemetry pipelines.
- **Fix:** Pool opts: `opts.logger?: PyramidLogger`. Module-level setter for the singleton path: `setDefaultPyramidLogger(...)`. PyramidLogger interface: `{warn(scope, msg, ctx), info(scope, msg, ctx), error(scope, msg, err)}`. Tests inject a recording logger to assert call patterns.

#### L8m-9. Worker error stringified — root cause lost (cite L5-7)
- **Category:** observability
- **Issue:** L91 / L97: `new Error(ev.data.error)` / `new Error('worker error during tile ${id}: ${ev?.message || ev || "unknown"}')`. Stack, name, code all stripped.
- **Fix:** Cite L5-7: worker posts `error: {code, message, stack?}`; receiver builds `Error` with `cause`.

#### L8m-10. No telemetry event taxonomy
- **Category:** missing feature
- **Issue:** Production wants to track: spawn-failed-count, tile-failed-count by code, prewarm-cold-start-ms, fallback-to-main rate, recycle-on-error rate. Today none of these are emitted.
- **Fix:** Emit a `PyramidEvent`: `{type: 'spawn-failed' | 'tile-failed' | 'prewarm-completed' | 'pool-fallback' | 'worker-recycled', timestamp, ctx}`. Optional `opts.onEvent?: (e: PyramidEvent) => void`. Pairs with L4m-14 PoolStats and L4m-15 error history.

### PROGRESS

#### L8m-11. `decodeWhole` consumes streaming events but uses only `final` + `error`
- **Category:** missing feature
- **Issue:** L30: `for await (const ev of decoder.events())`. Branches on `ev.type === "final"` and `"error"`. libjxl progressive emits multiple non-final events (passes, DC preview, partial); all silently dropped.
- **Fix:** Optional `opts.onPass?: (ev) => void` callback. When set: forward libjxl pass events. Default behavior preserved. Pairs with L3m-2 progressive decode opportunity.

#### L8m-12. No per-tile onTile callback (cite L3m-10)
- **Category:** missing feature
- **Issue:** `decodeTiledViewport(Pooled)` returns Promise<DecodedLevel>. Caller can't paint incrementally.
- **Fix:** Cite L3m-10. `opts.onTile?: (region, decoded) => void` for incremental paint.

#### L8m-13. No stream-stitch / partial-result emission (cite L3m-11, L6-3)
- **Category:** missing feature
- **Issue:** Pool's `decodeTilesParallel` awaits all coroutines before stitch. UI waits for the slowest tile.
- **Fix:** Stream-stitch: each tile writes into outBuffer on receive AND optionally fires `opts.onPartial?: (outBuffer, completedTiles) => void`. UI re-paints incrementally.

#### L8m-14. No pool lifecycle events (prewarm-ready, idle-reaped, worker-spawned, worker-recycled)
- **Category:** missing feature
- **Issue:** Caller can't say "wait for warm before first decode" or "show spinner while pool spawns first worker." Pool internals are opaque.
- **Fix:** Pairs with L8m-10 PyramidEvent: emit lifecycle events too. Plus `pool.whenReady(): Promise<void>` (cite L2m-3, L3-6).

#### L8m-15. No latency telemetry — p99 acquire / median decode-per-tile invisible
- **Category:** observability
- **Issue:** Pool can't tell ops "acquire is slow today" or "tile decode p99 grew 2x." Production debugging needs this signal.
- **Fix:** Pool tracks rolling-window timings: `pool.stats(): {acquire: {p50, p99}, decode: {p50, p99, count}}`. Bounded ring buffer (e.g., 256 samples). Cheap. Caller wires to dashboards.

### TESTS

#### L8m-16. Baseline test run: 10 pass / 1 fail / 1 error
- **Category:** ops gap
- **Issue:** `decode-level.test.ts` fails with `Cannot find module '@casabio/jxl-wasm'` — likely workspace-link issue, not code bug. But it means CI cannot verify decode-level. Either a hidden caller bug lurks or test infra is broken.
- **Fix:** Audit `packages/jxl-pyramid` workspace dependency resolution. If `@casabio/jxl-wasm` is intentionally external for unit-only tests, set up a mock module via tsconfig `paths` or bun test moduleNameMapper. Fix the linkage so all 11 tests run.

#### L8m-17. No property tests / fast-check (cite logic-019)
- **Category:** test gap
- **Issue:** Tile-coord math (`tilesOverlappingRegion`), level-pick math (`chooseLevelForTarget`), and stitch geometry are pure functions over numerical inputs — textbook fast-check targets. Hand-crafted unit tests miss edge cases: NaN, Infinity, mixed aspect ratios, tile-size > image-size, zero-area regions.
- **Fix:** Add `fast-check` dep + a `pyramid.property.test.ts` with: (a) `tilesOverlappingRegion(W, H, T, region)` returns rectangles that union-cover region; no overlap; each fully inside (0,0,W,H); (b) `chooseLevelForTarget` is monotonic in target; (c) stitch round-trips a known pattern.

#### L8m-18. No worker integration test — pool uses test doubles
- **Category:** test gap
- **Issue:** `decodeTilesParallel` is exercised via in-process mock workers. The real `Worker` class behavior (true threads, transferable handoff, structured-clone failures) is never tested. Bugs like L3-3 receive-side memcpy and the L4-6 mid-decode-terminate hang escape unit tests.
- **Fix:** Add `decode-pool.worker.integration.test.ts` using real `Worker` (Bun supports it; jest/vitest with happy-dom doesn't fully — bun is the right runner). Tests: cold-start latency, transferable round-trip integrity, terminate-mid-decode reject, factory swap, dispose.

#### L8m-19. No round-trip contract test pyramid-ingest ↔ jxl-pyramid (cite contracts-006)
- **Category:** test gap
- **Issue:** Writer (pyramid-ingest) and reader (jxl-pyramid) maintain separate manifest types (cite contracts-005, L5m-13). Field drift goes unnoticed until production. No CI gate.
- **Fix:** `pyramid-contract.test.ts` that runs pyramid-ingest on a known input, hands the output manifest + bytes to jxl-pyramid, asserts decode succeeds for every level with matching dims/bits. Single test, catches every field drift.

#### L8m-20. No 16-bit decode test — would have caught critical (logic-001)
- **Category:** test gap (critical)
- **Issue:** Worker hardcodes rgba8 → 16-bit tiled levels silently corrupt. No test sends 16-bit fixture through the pool. Critical bug in production-bound code with no test.
- **Fix:** Fixture: a small 16-bit JXTC. Test: `decodeTiledViewportPooled(rgba16-bytes, viewport).pixels` matches reference rgba16 pixels byte-for-byte. Test must use REAL worker (cite L8m-18) or a faithful mock that calls `decodeTileContainerRegionRgba16`.

#### L8m-21. `APPROVED_FIXTURES` in `fixtures.ts` ships Windows paths via package barrel (cite L2m-7, contracts-018)
- **Category:** test hygiene + contract bug
- **Issue:** Test fixture data with `c:\Foo\...` absolute paths is exported as part of the package public API. Consumers of `@casabio/jxl-pyramid` get dev-machine path strings.
- **Fix:** Move `fixtures.ts` to `test/` (out of `src/`). Replace absolute paths with relative-to-test-dir. Add `eslint-plugin-import` or a CI grep blocking `c:\\\\` strings in `src/`.


---

# Lens 9 (master) — The Owl

The Owl sees what others miss. Wise (pattern across passes), patient (slow-burn problems), near + far (line-level + 6-month trajectory), behind + front (origin + designed-for-but-unbuilt). Senses: sniff, taste, feel, hear, see.

Each item is tagged with the sense that surfaced it.

### L9m-1. [WISE] Five architectural moves would fix half the confirmed bugs
- **Pattern across 8 master lenses + 6 round-1 lenses:** the same root causes appear in different costumes. (a) sibling decoders (decode-level / pool) cause the worker-format gap, the type-duplication, the clamp duplication, the test-coverage gap. (b) state without setters (`destroyed`, `bad`, internally-only `terminated`) cause the lifecycle bugs. (c) silent catches cause the observability failure. (d) absent AbortSignal causes pan-waste + worker-hang + test-flake. (e) implicit invariants (manifest-trust, `next++`, WorkerReply shape) cause silent corruption.
- **Move:** the five fixes are independent and each touches one file plus protocol: (1) unify decoders behind one entry, (2) `destroy()` + state-machine enum, (3) inject logger + replace silent catches, (4) thread AbortSignal end-to-end, (5) parse-don't-trust at every boundary. Half the 93 confirmed findings collapse.

### L9m-2. [PATIENT] First-pan cold-start tax compounds
- **The slow-burn:** every customer's first pan in a session pays WASM compile cost on the user's hot path. The L3-6 readiness-signal absence means even after `prewarm()`, the next decode pays it. Per session: 100-300ms of "feels sluggish." Across N sessions × M months × Y users: cumulative human-attention waste measured in years.
- **Move:** wire `prewarm` to wait for worker `{type:'ready'}` (cite L3-6, L2m-3, L8m-14). App shell calls `prewarmAsync()` on mount; first pan inherits zero cold-start.

### L9m-3. [FAR — 6-month trajectory] The codebase is arrested mid-evolution
- **What the trajectory tells us:** decode-level.ts existed first (clean abstraction). Pool was bolted on TOP of it, not into a refactored core (so they share nothing). Six months ahead: each new strategy (DC-only, SAB, batched, progressive) becomes another bolt-on file, deeper duplication, more drift.
- **Move:** the L1r-9 four-file split (`select | plan | decode | pool`) is not a refactor for its own sake — it's the future-proof structure. Done now, the next strategy variant lands in `plan.ts` or `decode.ts` without touching siblings. Done later, every variant compounds the drift surface.

### L9m-4. [BEHIND — origin trace] The "Mirrors jxl-scheduler/pool.ts" comment is the only artifact of why
- **What got lost:** L127-133 comment says "Mirrors jxl-scheduler/pool.ts discipline (minIdle floor, per-handle idle timers, acquire/release, error-driven recycle) but scoped to the dumb tile protocol." That's a 2-line architecture decision record. Why scope it separately? Why not share? Why is the "dumb tile protocol" dumb? No one wrote it down.
- **Move:** convert the comment into a real ADR (`docs/adr/NNN-pyramid-pool-vs-scheduler-pool.md`) capturing the 'why'. Then EITHER share the base (cite L1r-2) OR document the divergence as permanent. The comment alone is insufficient — first refactor will delete it.

### L9m-5. [FRONT — designed-for-but-unbuilt] Three flags promise features that don't exist
- **Designed-for-future hints:**
  - `destroyed` (L152): read 5 places, written 0. Author intended `destroy()`.
  - `workerFactory` option (L378): caller can pass a factory but singleton ignores subsequent ones. Author intended swap.
  - `idleTimer` per handle (L136): granular idle reaping. Author intended diverse idle policy (only one is used).
- **Move:** each flag should either GET its feature or be removed. Half-features are debt that *looks* like API surface. Pairs with L4m-4 + L4-1.

### L9m-6. [SNIFF — DRY violation cluster] Same primitive in 3+ places
- **Smell census (from memory of the 3 files):**
  - region clamp: 3 sites (decode-level L100, pool L382, tilesOverlappingRegion in tiling.ts)
  - stitch: 2 sites (decode-level L60, pool L40), byte-equivalent
  - RegionDecoder type: 2 sites (decode-level L15, pool L28)
  - bits derivation: 2 sites (manifest/LevelSource vs JXTC header)
  - decodeRegion selection: 2 sites + 1 hardcoded (worker)
  - hardwareConcurrency read: 2 sites (pool L309, L408)
- **Move:** L2-10 / L1r-1 DecodePlan extraction. One pass, six DRY collapses.

### L9m-7. [TASTE — API ergonomics] Bitter at consumption
- **What the caller has to know to use the pool:** `containerBytes` (raw bytes, not LevelSource), `region` (the right one — clamped or not?), `workerFactory` (infra), `parallel` (strategy with un-documented tri-state default), and that the singleton ignores subsequent factories. That's five concepts before pixels.
- **Sweet alternative:** `const session = openLevelSession(levelSource); const decoded = await session.decode(region, {signal});`. Caller knows two concepts.
- **Move:** L1r-6 + L2m-4 unification. Hide pool, hide bytes, hide factory, hide strategy default behind sensible auto.

### L9m-8. [FEEL — file-size vibe] 16× LoC for marginal added power
- **Comparison:** choose-level = 26 LoC, decode-level = 138 LoC, tiled-decode-pool = 426 LoC. Pool is 16× choose-level. choose-level + decode-level together solve the user-facing problem (decode any level, any region). Pool's marginal contribution is "do it faster on multi-core when COOP/COEP allows."
- **Vibe says:** the marginal speedup pulled 300+ lines of lifecycle infrastructure into the cluster. Is that the right cost? Probably yes for production, but worth checking: the pool's complexity isn't paying its way unless there's measured perf data showing it. L8m-15 latency telemetry is the missing oracle.
- **Move:** measure first (L8m-15). If pool's wall-clock win is <20% over single-thread WASM, simplify. If >50%, keep but document the floor.

### L9m-9. [HEAR — silent catches] The loudest sounds are the absences
- **What's silent:** five `catch {}` blocks (L3-6 spawn-fail, L114-116 listener-attach, L246-248 lifecycle-listener-attach, L297-300 terminate, plus implicit no-rethrow in `cleanup()`). Each is a place where production *can* fail and nothing announces it.
- **What the user hears:** nothing. Pool degrades to fewer workers. Pan feels sluggish. They file "image viewer is slow on my machine." Support team can't repro.
- **Move:** L5-6 onError hook on every silent catch. Default = `console.warn`. Production wires to Sentry. Suddenly the absences become signals. Sound returns.

### L9m-10. [SEE — negative space in API surface] What's missing tells the story
- **Visible exports:** longEdge, chooseLevelForTarget, levelRank, shouldUpgrade, decodeLevel, decodeTiledViewport, decodeTiledViewportPooled, types.
- **Visibly absent:** dispose, prewarm, capability check (re-export), logger inject, stats, event hook, AbortSignal-aware variant, PyramidWorkerPool class, error history, cache injection, ICC/EXIF pass-through.
- **What the negative space says:** this is a decoder, not a *managed* decoder. Owners have to know internal lifecycles, internal observability gaps, internal singletons. Add ten exports and it becomes a library; until then it's a function bag.
- **Move:** cumulative — L2m-2, L2m-3, L4-2, L8m-8, L8m-10, L3m-9 fixes together form the "managed decoder" version.

### L9m-11. [NEAR — line-level escape hatches] Bracket-access tells you about the type fight
- **Spot:** L307 `pool["destroyed"]`, L318 `pool["minIdle"]`. Square-bracket access of private fields bypasses TypeScript's privacy. Once you see one, count them — they're flags planted by an author who lost an argument with the type system.
- **What the loss reveals:** the module-scope function `getOrCreatePool` shouldn't be reading the private state of the class. The relationship between getOrCreatePool and PyramidWorkerPool is too tight. Either getOrCreatePool moves INTO the class as a static factory, or those fields become non-private with documented intent.
- **Move:** convert to `PyramidWorkerPool.getDefault(factory)` static + make `minIdle` a `readonly` (not private). Bracket-access disappears. The type system agrees with the code.

### L9m-12. [WISE — bug factory] The redundancy IS the bug source
- **Pattern across 93 confirmed findings:** every category of bug traces back to "two places do the same thing; one drifted." 16-bit corruption: worker drifted from main. Sort-vs-select mismatch: choose-level used two different ranks. Stale dist: dist drifted from src. Stitch divergence risk: two stitch impls. Each is the same bug in different costume.
- **Move:** L1r-1 redundancy scoreboard is not just an efficiency item — it's the *bug-rate forecast*. Every redundancy is a future bug. Collapse the redundancy and the future-bug surface drops proportionately.

### L9m-13. [SNIFF + WISE] Comment-as-load-bearing-knowledge is fragile
- **Spot:** stitch fast-path comment "level2 audit I4" — a single string referencing an off-text-channel decision. Same with "B1 from audit" at L117-121. Same with "level3" referenced in HANDOFF docs at the repo root.
- **Risk:** the comments outsource knowledge. Touch the code without reading the audit docs → break the assumption silently.
- **Move:** for each load-bearing comment, ensure the audit is in `docs/` (the level2/level3 docs likely are, given HANDOFF-jxl-level3-INDEX.md sighted earlier). Cross-link from code: `/* level2 audit I4 — see docs/audits/level2.md#i4 */`. Future readers can verify.

### L9m-14. [TASTE — sour singleton] Module-scope mutable state
- **Spot:** `let pool: PyramidWorkerPool | null = null;` (L304) + `let nextWorkerId = 0;` (L66). Two module-level mutable bindings, both never reset.
- **Why it tastes sour:** every test imports the module, gets the same `pool` and `nextWorkerId`. Test A creates a pool; Test B inherits it. Tests pass in isolation, flake in CI parallel.
- **Move:** L2m-2 + L3-10 fixes. Convert to factory exports + instance counters. Sweet again.

### L9m-15. [FRONT + WISE] The wise owl predicts: photogrammetry need
- **Trajectory hint from user memory:** project memory mentions `project-casasneyers-parity` (16-bit, HDR) and `project-pyramid-gallery-architecture` (DC-preview rejected vs pyramid). Adjacent work: digital-twin / photogrammetry layer. That work needs: ICC, HDR, mid-zoom LOD blend, sub-pixel positioning.
- **What jxl-pyramid will be asked for:** the very things absent today — `iccProfile` pass-through (L7m-12), tone-map hooks (L6m-14), `chooseLevelForTarget` returning `{primary, secondary, blendT}` for trilinear blend (L6m-18).
- **Move:** when these arrive, the L1r-9 architecture split makes them small. Without the split, they're each a full pool/decode-level retrofit.


---

# Lens 9r (master) — The Backwards Eye

Reverse the arrow. Read from death to birth. Imagine these three files retired, then ask: what killed them? What would a wiser author have written differently at conception, knowing the death? What survives the death and migrates to the successor? Where are the BEGINs without ENDs?

This lens is the Owl's mate — Owl looks in all directions; Backwards Eye chooses one direction (the reverse) and trusts the asymmetry to reveal what forward-only reading missed.

### L9rev-1. [DEATH MAP] These three files die of one of four things — design backwards from each
- **Cause-of-death candidates:**
  1. **Format drift:** libjxl changes JXTC header layout. parseJxtcHeader silently mis-parses. Wrong dims propagate. Ship the bug. Bisect from "first wrong screenshot" back through 3 weeks of releases.
  2. **Memory creep:** module-singleton pool retains workers across tab lifetimes; mobile OOMs the tab. Crash report has no pool stats.
  3. **Hang:** worker wedges mid-decode (libjxl OOM mid-tile, browser throttle); promise never settles; pan freezes; user reloads.
  4. **Replaced:** WebGPU tile decode or batched-ROI jxl-wasm arrives; pool architecture becomes dead weight; rewrite, not refactor.
- **Backwards design:** for each death, what would today's code have looked like if the author had foreseen it? (1) → version handshake + manifest as trust anchor. (2) → page-visibility integration + memory budget. (3) → AbortSignal + timeout + watchdog. (4) → strategy abstraction so replacement is a strategy swap, not a rewrite. Three of these four are already named (L7m-5, L6r-3/5/11, L4-3/L4-11, L1r-9) — death-map view makes the priority obvious.

### L9rev-2. [SYMMETRY AUDIT] Every BEGIN needs an END
- **Asymmetries (counted):**
  - `spawnOne` ↔ `destroyHandle` — SYMMETRIC inside pool. OK.
  - `acquire` ↔ `release` — SYMMETRIC. OK.
  - `prewarm` ↔ `???` — NO `unwarm`. Once warm, only error-driven destroyHandle reduces the floor.
  - `getOrCreatePool` ↔ `???` — NO `disposePool`. Module singleton lives forever.
  - `PyramidWorkerPool.new` ↔ `???` — NO `destroy()` method. (Cite L4-1, L4-2.)
  - `addEventListener('error', recycle)` ↔ `???` — NO removeEventListener. Saved by worker.terminate side effect. (Cite L4-7.)
  - `createDecoder` ↔ `dispose` — SYMMETRIC on happy path only. Error path leaks (cite L5-1).
  - `setTimeout(reap)` ↔ `clearTimeout` — SYMMETRIC. OK.
- **Move:** every asymmetric BEGIN gets an END. Three new methods + one bug fix collapses the audit. Pairs with L9m-5 (designed-for-unbuilt).

### L9rev-3. [TAIL-FIRST READING] `decodeTiledViewportPooled` read bottom-up tells a different story
- **Bottom-up walk (L424→L381):** release workers → stitch → decode tiles → acquire pool workers → get-or-create pool → read hardware concurrency → compute tile list → derive bits → clamp viewport → parse header. Reverse narrative reveals: the function is shaped as a try/finally with the acquire BELOW the work AND the release ABOVE — but visually the layout pretends acquire is just-before-work and release is just-after.
- **What the bottom-up read makes obvious:** four "preludes" (header parse, clamp, bits, tile list) happen BEFORE any pool interaction. They are pure computation against the input. They could be hoisted into a separate function `planTiledDecode(bytes, region) → DecodePlan`. The pool-bound portion shrinks to ~15 lines.
- **Move:** L1r-1 / L2-10 DecodePlan extraction. Reading reverse makes the seam visible.

### L9rev-4. [LIFO PREFERENCE] Time-arrow on the idle queue points the wrong way
- **Today:** `idle.shift()` returns OLDEST. Pool resurfaces the worker whose last decode was longest ago — coldest cache, oldest V8 inline caches, possibly idle-timer-armed-for-reap.
- **Reverse:** `idle.pop()` returns NEWEST. Hottest cache, freshest inline caches, no timer pending. Cite L5m-6.
- **Backwards-Eye framing:** when you read time backwards, "newest" is the BEGINNING (most recent) and "oldest" is the END (about to die). Pool resurrects the dying instead of the alive. Cheap one-line fix.

### L9rev-5. [WHAT SURVIVES] Tear these three files out tomorrow — what migrates to the successor?
- **Durable concepts that survive any rewrite:**
  - the `PyramidLevel` shape (manifest contract — caller-facing)
  - `chooseLevelForTarget`'s policy (long-edge target → level)
  - the (W, H, tileSize) → tile-list math
  - the region clamp + non-empty assertion
  - the "DecodedLevel { pixels, width, height }" return shape (caller-facing)
- **Disposable:** the entire pool implementation. The two `stitch` impls. The Promise.all vs coroutine choice. The singleton lifecycle. Worker protocol shape.
- **Move:** the durable concepts deserve `select.ts` + `plan.ts` (L1r-9). The disposables go in `decode.ts` + `pool.ts`. The split aligns code with longevity. Future rewrite touches only the disposable files; durable contracts unchanged.

### L9rev-6. [REVERSE REFACTOR] Start from the sweet API, drive back to today
- **End-state (taste-tested in L9m-7):** `const session = openLevelSession(level, {signal, cache?}); const decoded = await session.decode(region);`. Two concepts: session, region.
- **Drive back one step:** what does `openLevelSession` do internally? Holds the LevelSource, the cached header, the AbortController, possibly a pool reference, the decode plan.
- **Drive back another step:** decode(region) does plan-clamp, plan-tiles, strategy-pick (single vs parallel), stitch, return.
- **Drive back another:** strategy-pick needs `canUseParallelTileWorkers()` re-export AND a pool reference.
- **Drive back to today:** every backwards step names a piece of CURRENT code that needs to move or merge. Final position: `openLevelSession` wraps existing internals; gradually internals collapse into it; eventually internals disappear.
- **Move:** plan the refactor as a series of backwards merges, not forwards splits. End-state stays stable; internals compress toward it.

### L9rev-7. [REVERSE CAUSALITY] Teardown-order bugs — death-during-life
- **Bugs that exist BECAUSE teardown can happen during life:**
  - L4-6: worker terminates mid-decode → in-flight Promise hangs (recycle, then destroyHandle, then the Promise has no settler).
  - L4-1/L4-2: pool teardown during decode would leave in-flight worker postMessages with no listener (the cleanup ran already).
  - L4-7: removeEventListener for the recycle handler is unwired because terminate is "good enough" — fragile if worker handoff is ever added.
  - L4-12: spawnOne crash mid-spawn leaves handle in `all` set without lifecycle listener.
- **Reverse insight:** each of these would have been visible at design time if the author had written `destroy()` FIRST and then made sure every code path survives a concurrent destroy. The forward-only mindset writes `acquire` first and gets cleanup as an afterthought; the backwards mindset writes `destroy` first and constrains acquire to play nice with it.
- **Move:** when implementing L4-2 destroy(), also walk every existing public method and ask "what happens if `destroyed` becomes true mid-call?" — the answer should be deterministic for each.

### L9rev-8. [POSTMORTEM IN ADVANCE] Write the death certificate today
- **Imagined incident report (6 months out):**
  > 2026-12-XX. Customer reports 16-bit JXL pyramid images render with wrong colors. Investigation: web/lightbox/tiled-decode-worker.js calls only `decodeTileContainerRegionRgba8` regardless of source bits. Worker has not been updated since persistent-pool merge. Root cause: protocol omits `format` field; worker has no way to know.
- **Imagined incident report (12 months out):**
  > Page hangs after pan during freeze/resume cycle. Mobile bf-cache restored worker mid-decode; Promise never settled. Pool slot held forever.
- **Both incidents already named** in findings (L3-1 critical, L6r-4). Backwards-Eye framing: convert each finding into the death certificate it prevents. Each finding has a specific incident it forecloses. Sort findings by *incident severity*, not by detector severity.

### L9rev-9. [REVERSE TRUST] What if worker is trusted and main is suspect?
- **Forward assumption:** main controls the worker; worker is dumb tile-decoder. Trust flows OUT.
- **Reverse:** worker has the libjxl module loaded, has bytes loaded (after L3-4), is the authoritative decoder. Main is the rapidly-mutating UI thread that may glitch, send a stale request, send a request after the level was disposed, etc. Trust could flow IN.
- **What changes:** worker rejects requests with unknown `bytesId` (instead of silently failing); worker enforces a per-request deadline at libjxl call boundary (instead of trusting main's timeout); worker keeps an audit trail of requests it served (instead of stateless replies).
- **Move:** asymmetric protocol upgrade. After L3-4 protocol bump, add worker-side validation. Cheap and aligns with the actual reliability ranking — workers are stable, main thread races.

### L9rev-10. [BACKWARDS-COMPAT IS FORWARDS] Version the protocol from the end state
- **Forward path:** protocol grows organically. Today `{id, bytes, region}` → tomorrow add `format` → next month add `signal` → no migration story.
- **Reverse:** define the v∞ protocol you WANT (`{v, type:'decode'|'load'|'cancel', id, bytesId, region, format, deadlineMs, signal-correlation-id}`). Then encode the current shape as v1 — `{id, bytes, region}` is shorthand for `{v:1, type:'decode', id, bytes, region, format:'rgba8'}`. Worker accepts both. Add the version bit. Now every future field lands without ceremony.
- **Move:** pair with L2m-12. Set the version field NOW so future additions are non-breaking.

### L9rev-11. [BORN-WITH-TELEMETRY] Inject observability before first decode runs
- **Forward path:** ship code, observe production, add telemetry when something hurts. By then incidents have occurred without context.
- **Reverse:** write the dashboard FIRST. What three metrics must be true for "pool is healthy"? Probably: (a) `acquire p99 < 50ms`, (b) `worker recycle rate < 1/min`, (c) `tile failure rate < 0.1%`. Then write the code that emits exactly those numbers. The code shape is constrained by what the dashboard needs.
- **Move:** cite L8m-15 latency telemetry, L8m-10 event taxonomy. Build them BEFORE the next feature lands. Pre-mortem instrumentation is cheaper than post-mortem instrumentation.

### L9rev-12. [LAST-LINE-OF-DEFENSE] What is the final catch?
- **Today:** if pool wedges, browser tab hangs. No watchdog. No final timeout. No "if any decode takes >30s, terminate everything and start fresh." No outer-bounds.
- **Reverse:** ask "if everything goes wrong, what catches it?" — answer must be a specific function with a specific log. If the answer is "the user closes the tab," that's not a defense; that's a failure mode.
- **Move:** module-level watchdog: `setInterval(() => { if (pool && now - pool.lastActivity > 60_000 && pool.activeSize > 0) { pool.opts.logger?.warn('pool', 'wedge-detected', stats); pool.destroy(); } }, 5000)`. Belt-and-braces. Lets the user keep working while pool self-heals. The death of the pool becomes the BIRTH of the next pool, without the tab dying along with it.


---

# Lens 11 (master) — Astronomical scale

Frame: you have a TBps firehose from a focal-plane array (LSST class) or a JWST mosaic, or a HiPS hierarchical sky-survey serving ten million users. Pixels arrive faster than they can be displayed. Hierarchical Progressive Surveys (HiPS, IVOA standard) ARE a pyramid — astronomy solved this pattern decades ago. What would the genius-CS who studied LSST scheduling, HiPS tiling, and FITS provenance say about jxl-pyramid today?

The astronomical eye reveals: this library is a baby HiPS server, with several astronomy-grade refinements already half-built. Naming them in their astronomy form makes the next-step features obvious.

### L11m-1. [HiPS COMPATIBILITY] Pyramid level coords are local; astronomy is global
- **Analogy:** HiPS uses HEALPix nested indexing — every tile on the sky has a unique (Norder, Npix) coordinate that's resolution-aware AND globally addressable. jxl-pyramid uses local `{x, y, w, h}` within a level. The same scene at level 3 and level 4 has unrelated tile addresses.
- **Cost:** can't cache by tile identity across levels; can't share a tile between two viewers at different zooms; can't pre-compute neighbor relationships.
- **Move:** introduce `tileId = (levelIdx, col, row)` as a stable identifier (cite L5m-15). Cache by tileId. Workers' L3-4 bytesId becomes (containerId, levelIdx) — same container serves multiple levels. Hierarchical inheritance: level N's tile (c,r) inherits from level N-1's tile (c/2, r/2). The HEALPix discipline.

### L11m-2. [BITPIX] 8/16-bit is preview-grade; astronomy demands float
- **Analogy:** FITS BITPIX field declares 8/16/32-int or 32/64-float. Survey-grade calibrated science images are 32-bit float. 16-bit unsigned is barely good enough for archive thumbnails. JXL supports float; jxl-pyramid plumbs only rgba8/rgba16 (cite L5m-12, L1-6).
- **Cost:** the current library is permanently locked out of the science-grade decode path. Today's critical bug (worker hardcodes rgba8) is the same architectural error one level shallower.
- **Move:** the WorkerRequest's `format` field (cite L3-1, L2m-12) becomes `'rgba8' | 'rgba16' | 'rgba32f' | 'gray32f'`. Worker dispatches to the matching libjxl ROI decoder when jxl-wasm exposes one. Format flows through manifest → LevelSource → pool → worker, monotonically narrowing. Same fix as the 16-bit one, generalized.

### L11m-3. [LOSSLESS FLAG] Science data must be bit-exact; UI data can be lossy
- **Analogy:** observatory archives ship lossless (FITS, no quantization) AND lossy quick-looks (PNG, JPEG2000). A user requesting a coadd for measurement gets lossless; a user clicking around the sky map gets the quick-look. Same tile, two delivery modes.
- **Cost:** today jxl-pyramid has no notion of fidelity. A level is just "this resolution." Caller can't ask "give me the science-grade tile" vs "give me whatever's fastest."
- **Move:** `PyramidLevel.fidelity: 'preview' | 'lossless'`. Manifest carries it. `chooseLevelForTarget(levels, target, {requireLossless?: boolean})`. Cache (L3m-9) keys include fidelity. Lossless tiles never get re-encoded; preview tiles can be re-derived from any source.

### L11m-4. [SCHEDULING] Survey vs ToO vs calibration are different priorities
- **Analogy:** LSST scheduler interleaves three traffic classes — survey (highest throughput), target-of-opportunity (interrupts survey when alert fires), calibration (low priority, scheduled during gaps). Single-queue FIFO is unworkable.
- **Cost:** pool's `acquire` is FIFO (cite L5m-6, L9rev-4). All requests treated equal. Pan-driven UI requests compete with a hypothetical background prefetch on equal terms; ToO-style "user just clicked, jump everything else" has no expression.
- **Move:** `acquire(N, {priority: 'interactive' | 'background' | 'idle'})`. Multi-level priority queue. Interactive preempts background (cancels in-flight via L4-3 AbortSignal). Background runs only when interactive queue empty. Pairs with `requestIdleCallback`-scheduled prefetch (cite L6r-2). Astronomy-grade three-tier scheduling.

### L11m-5. [PROVENANCE] Every pixel must trace to its source HDU
- **Analogy:** FITS PHU (Primary Header Unit) carries EVERY observational fact: telescope, instrument, filter, MJD, RA/Dec, airmass, exposure, calibration version. Drop the PHU and the data is scientifically worthless. CLAUDE.md (facade.ts) preserves ICC — jxl-wasm respects this discipline. jxl-pyramid drops ICC/EXIF/XMP at the pyramid boundary (cite L7m-12, L6m-15).
- **Cost:** for an astronomy use case, the library forces caller to re-fetch metadata separately, double-trip per tile.
- **Move:** `DecodedLevel.metadata?: { icc?, exif?, xmp?, custom?: Record<string, Uint8Array> }`. Custom keys let astronomy ship FITS headers in a side-channel. Worker protocol bump: reply carries metadata blob alongside pixels. The PHU-equivalent never gets dropped.

### L11m-6. [TELESCOPE ARRAY] Workers are telescopes; need health metrics
- **Analogy:** each scope in an array has uptime, error rate, last-calibration timestamp, currently-pointing target. Observatory dashboards show all of them. Pool's WorkerHandle has only `bad: boolean` (cite L4m-13). No history, no rates, no current request visible.
- **Cost:** can't tell which worker is "bad luck" vs "actually failing." Recycle policy is binary (cite L3-9). No "this scope has 3 consecutive bad-decode events in 60s — retire it eagerly."
- **Move:** `WorkerHandle.metrics: { decodesAttempted, decodesSucceeded, errorCodes: Record<string, number>, lastError?: {ts, code, message}, lastSuccess?: ts }`. Exposed via `pool.workersStatus()`. Adaptive retirement on rate thresholds. Pairs with L4m-14 PoolStats, L8m-15 latency telemetry. Observatory-style ops dashboards become possible.

### L11m-7. [TARGET-OF-OPPORTUNITY] AbortSignal IS the ToO preemption primitive
- **Analogy:** an LSST alert broker fires "supernova at (RA, Dec)" — every telescope in the array drops current pointing and slews. Cancellation must be cheap, immediate, and not corrupt in-flight calibration data.
- **Cost:** no AbortSignal anywhere (cite L4-3, L4m-9). UI pan = ToO event = no way to express preemption.
- **Move:** as already cited. Astronomical framing makes the *priority* obvious: this is THE critical missing feature for interactive use. Surveys without ToO interrupt are scientifically incomplete; interactive viewers without abort are perceptually broken. Same primitive.

### L11m-8. [REAL-TIME MOSAICKING] Stream-stitch is co-add-as-it-arrives
- **Analogy:** Subaru HSC and DECam pipelines do real-time mosaicking — exposures land in a target buffer at known WCS positions as the camera reads off. Display updates incrementally. No "wait for full focal plane to drain."
- **Cost:** `parts[]` retention (cite L6-3, L3m-11, L8m-13) is "wait for all tiles before display." Two-second latency for a many-tile viewport even when half the tiles arrive in 200ms.
- **Move:** stream-stitch with onTile callback (cite L3m-10 + L3m-11). Drops `parts[]`, drops first-paint latency, enables incremental UI. The HSC pipeline pattern, scaled down to one viewport.

### L11m-9. [DATA FABRIC] SAB for container bytes IS shared observatory storage
- **Analogy:** observatory cameras (workers) read raw stream from a shared NVMe or RDMA fabric. Each camera doesn't get its own copy of the focal plane data — that would be terabytes. They subscribe to a region, read into local memory.
- **Cost:** jxl-pyramid clones container bytes per tile per worker (cite L3-4, L6-2, L7m-6, L6r-1). Up to 4 GB clone activity per viewport. Fabric pattern would zero this.
- **Move:** SAB + load/decode protocol split. The genius-CS framing: "you already invented data fabric; you're just structured-cloning it because no one noticed."

### L11m-10. [ARCHIVE] jxl-cache IS the MAST/NSA archive interface
- **Analogy:** astronomers don't re-observe a target if it's in the archive — they query MAST, NSA, or Vizier. Hierarchically: hot cache (in-memory) → warm (local archive) → cold (network archive). Each tier has different latency budgets.
- **Cost:** pyramid has NO decoded-pixel cache (cite L3m-8, L3m-9). Pan-back re-decodes. jxl-cache (per CLAUDE.md, content-agnostic, OPFS+LRU) exists and is unused.
- **Move:** `opts.cache?: PyramidCache` interface (get/set/has by key). jxl-cache implements it. Caller wires once. Hierarchical: in-memory `Map` (hot, ~50 MB) → jxl-cache OPFS (warm, ~500 MB) → network refetch (cold). Match the archive tiering pattern.

### L11m-11. [SAFETY SYSTEM] Watchdog IS observatory safety interlock
- **Analogy:** observatories have hardware interlocks — if dome doesn't close before sunrise, alarm fires and forces shutdown. Software equivalent: if pipeline stalls for >N minutes, killswitch resets state.
- **Cost:** no watchdog (cite L9rev-12). Pool wedges → tab hangs → user closes tab.
- **Move:** L9rev-12 module-level watchdog. Astronomical framing: "your library has no safety interlock; production deserves one."

### L11m-12. [TIME-DOMAIN] Levels have no temporal axis
- **Analogy:** time-domain astronomy (LSST, ZTF) observes the SAME tile at multiple epochs. Tile addressed by (HEALPix_id, MJD). Comparison reveals transients, variables, asteroids.
- **Cost:** jxl-pyramid is single-epoch by design. The pyramid is spatial-only. For digital-twin / multi-look / change-detection use cases (user memory: photogrammetry, RTI, focus-stacking), the absence is structural.
- **Move:** out of scope today, but the manifest schema is the seam: `PyramidLevel` could grow `epoch?: string | number` and the cache key (L11m-10) could include it. Architectural — write ADR. The wise move is to NOT add epoch to today's library but to ensure the type can support a tagged extension without breaking single-epoch consumers (cite L9rev-10 backwards-compat-is-forwards).

### L11m-13. [COADD / TRILINEAR MIP] Adjacent levels can be blended for sub-octave zoom
- **Analogy:** coadds combine exposures of the same field at known WCS positions, weighted by SNR. Mip-mapping in graphics is the same idea — trilinear blend between two levels of detail. Astronomy: stack three nightly exposures; graphics: blend level N and N+1 by zoom fraction; both give continuous quality.
- **Cost:** chooseLevelForTarget returns ONE level. Mid-zoom transitions snap (cite L6m-18). Coadd-equivalent is absent.
- **Move:** `chooseLevelForTarget` returns `{primary, secondary?, blendT?}`. Decode both; caller alpha-blends. For astronomy: weight by exposure depth instead of zoom fraction. Same return shape, different blend math.

### L11m-14. [SPATIAL INDEX] tilesOverlappingRegion is R-tree-flavored — astronomy uses HEALPix or QuadTree
- **Analogy:** astronomy spatial indexing: HEALPix for sky, QuadTree/KDtree for catalogs, R-tree for VO portals. Each picks the data structure matching its access pattern (sphere vs plane, nearest-neighbor vs range-query).
- **Cost:** `tilesOverlappingRegion` (in tiling.ts, recalled from memory) rebuilds tile-grid from scratch per call (cite perf-d0e1f2a3). For a fixed (W, H, tileSize) this is wasted.
- **Move:** memoize tile-grid per (W, H, tileSize) — three small numbers, WeakMap or LRU keyed by hash. Cheap. Pairs with L1r-1 DecodePlan extraction (header + tile-grid both cached). The R-tree-style pre-computation discipline.

### L11m-15. [PIPELINE ECOSYSTEM] Today this is one observatory; massive surveys are arrays of arrays
- **Analogy:** LSST has FOUR camera-to-archive pipelines running in parallel: prompt processing (real-time), data release (annual), template (image differencing), calibration (continuous). Each is a full pipeline; they share input but diverge in latency / fidelity / output.
- **Cost:** jxl-pyramid is one pipeline (viewport decode → pixels). Composes poorly with imagined siblings (e.g., "tile annotation overlay," "tile metadata search," "tile delta detection") because there's no shared pre-decode plan.
- **Move:** the L1r-9 four-file split (`select | plan | decode | pool`) maps to LSST's pipeline architecture: `plan.ts` IS the "what tiles are needed" stage that ALL pipelines share. Then `decode.ts`, `annotate.ts`, `delta.ts`, etc., each consume the plan. The astronomy framing makes the architecture's downstream extensibility obvious — and predicts the photogrammetry/digital-twin extension surface from user memory.


---

# Lens 11s (master) — Game engines, virtual texturing, and map tiles

Shifted frame: where astronomy was scientific/bulk, this pass is interactive/real-time. The traditions: Unreal Nanite + virtual textures (id Tech 5 Megatexture, UE5 Virtual Texture System), Mapbox/Google's XYZ slippy tiles, Unity Addressables, mobile-class streaming LOD running at 120 fps under battery budget. These ecosystems solved the same hard problem — paint pixels at viewport rate from a tile hierarchy without hitching — and they did it under far tighter deadlines than jxl-pyramid is currently designed for.

The genius-CS who's shipped a virtual-texture renderer looks at jxl-pyramid and says: "you're a baby streaming-tile engine; here are the conventions you haven't adopted yet."

### L11sm-1. [XYZ ADDRESSING] Slippy-tile coords are the lingua franca of map tiles
- **Analogy:** Mapbox / Google / Bing all use `/{z}/{x}/{y}.png` (zoom, col, row). Globally addressable across publishers. Caches everywhere understand it. URL templates compose. jxl-pyramid uses opaque container bytes per level (cite L1-2, L11m-1).
- **Cost:** can't share a CDN with map-tile clients. Can't address a tile in a log line. Can't predict neighbors in URL space.
- **Move:** the L11m-1 (level, col, row) tileId IS the (z, x, y) convention. Manifest can publish a `tileUrlTemplate?: string` so consumers can fetch tiles independently. Same pattern as TileJSON spec. Interoperability with the entire web-map ecosystem unlocked.

### L11sm-2. [VIRTUAL TEXTURE] Page table > linear level walk
- **Analogy:** UE5 / Nanite virtual textures store a small "page table" as a Uint32Array on GPU. Texel-shader lookup is O(1). Pages can be at different mips; the page table tells you which mip is resident for which region. jxl-pyramid does `chooseLevelForTarget` linear walk per UI event (cite L2-2, L9m-6).
- **Cost:** O(levels) per UI event; no per-region awareness. Can't say "this region of the viewport already has level 2 resident; just fetch level 3 for the missing area."
- **Move:** introduce a page table indexed by (col, row) at top-level resolution, storing the highest resident mip per page. `chooseLevelForTarget` becomes `chooseLevelPerPage(viewport)` returning a map. Decode dispatch only fetches pages NOT already at target mip. Massive win for incremental pan/zoom.

### L11sm-3. [PREDICTIVE PREFETCH] React vs predict — the 16ms gap
- **Analogy:** game engines predict camera motion 1-2 frames ahead and prefetch pages BEFORE the camera arrives. By the time frame N+2 renders, the texture page is resident. jxl-pyramid only reacts: pan event → decode request → wait → paint.
- **Cost:** every pan stutters at the leading edge as new tiles decode. Even with fast tiles (10-50ms), the visible pop is jarring at 60 fps.
- **Move:** caller-provided motion vector hint: `opts.predictedViewport?: { x, y, w, h, t }` — future viewport at time t. Library prefetches those tiles at lower priority. Pairs with L11m-4 three-tier priority. UE5-style "render the predicted, present the actual." Cancel via L4-3 AbortSignal when prediction was wrong.

### L11sm-4. [RESIDENCY BUDGET] Hard byte cap on resident pages
- **Analogy:** UE5 virtual texture pool has a fixed byte budget (e.g., 256 MB). Pages evicted LRU when budget hit. Hard cap means OS doesn't OOM — predictable footprint.
- **Cost:** jxl-pyramid has no decoded-pixel cache, so technically no budget needed for that. But the WORKER pool has implicit unbounded growth potential (cite L6r-11). And the L3m-9 future cache layer is sized by caller, not library — no defense.
- **Move:** `opts.residencyBudgetBytes?: number` on the L3m-9 cache layer when added. Library refuses to retain more decoded pixels than budget. Caller observes. Cooperative back-off (L6r-11) reduces budget when system pressure rises.

### L11sm-5. [FRAME BUDGET] Rolling deadline across all in-flight work
- **Analogy:** game engines have a 16ms or 8ms frame budget. Every system competes within it. Texture streaming budgeted to N ms; geometry update to M ms; etc. Late work is deferred to next frame, not allowed to glitch the current one.
- **Cost:** jxl-pyramid has no frame concept. A slow decode blocks the entire viewport. No "if I can't finish this tile in 12ms, defer to next frame."
- **Move:** `opts.frameBudgetMs?: number` — caller's per-frame compute budget. Library returns partial result + a continuation token when budget exceeded. Caller calls `continuation.resume(opts)` on next frame. Streaming-stitch (L3m-11) is the natural mechanism: paint what you have, queue the rest. Pairs with `scheduler.postTask` (L6r-6).

### L11sm-6. [DIRECT GPU UPLOAD] Eliminate the canvas roundtrip
- **Analogy:** game engines upload texture bytes directly to GPU memory. NEVER round-trip through main CPU heap unless absolutely needed. Asynchronous GPU upload happens on a copy queue.
- **Cost:** jxl-pyramid returns `Uint8Array`. Caller allocates `ImageData`, calls `putImageData`. Two main-heap allocations and two memcpys per ROI (cite L3m-12).
- **Move:** `opts.outputTarget?: GPUTexture | WebGLTexture | OffscreenCanvas`. Library writes tile pixels directly into target via `texSubImage2D` or `device.queue.writeTexture`. Skip ImageData entirely. Works main-thread (canvas/WebGL) AND worker-side (OffscreenCanvas). CLAUDE.md's createImageBitmap rejection doesn't apply — this is a different path (direct write to caller's texture, not a Bitmap construction).

### L11sm-7. [STREAMING PRIORITY] Visible-and-large pages first
- **Analogy:** UE5 prioritizes pages that are (a) inside the visible frustum, (b) at higher MIP (closer to camera = larger on screen). FIFO is unacceptable.
- **Cost:** pool's FIFO acquire serves tiles in scan order (cite L5m-6, L11m-4, L6r-6 centroid-first).
- **Move:** as already named. Astronomical framing called for three-priority queue; game framing calls for VISIBLE-AND-LARGE weighting. They're the same primitive (priority field on request) with different scorers. Library should accept a `prioritizeFn?: (tile, viewport) => number` so caller picks the policy.

### L11sm-8. [ANISOTROPIC FILTERING] Oblique views need x/y asymmetric resolution
- **Analogy:** when a textured surface is viewed obliquely (think road receding into distance), graphics samplers do anisotropic filtering — sample more along the elongated axis. Pyramid level pick today is isotropic (long-edge).
- **Cost:** for digital-twin / photogrammetry use cases (user memory), oblique surface views ARE the default. Choosing one isotropic level wastes pixels in one axis and starves the other.
- **Move:** `chooseLevelForTarget(levels, {targetW, targetH})` instead of single long-edge. Or — more powerful — `chooseLevelForAnisotropic(levels, {targetW, targetH, anisoRatio})` that can mix levels per-axis when the manifest supports it. Today it doesn't; this becomes an ADR seam (cite L11m-12 / L11m-13 for the tagged-extension pattern).

### L11sm-9. [WORKER COUNT ADAPTS TO FRAME RATE] Don't keep 8 workers warm when 1 tile/sec
- **Analogy:** UE5 dials texture-streaming worker thread count down when idle, up when surge. Power-aware. jxl-pyramid's pool is `min(hwc, 8)` fixed (cite L6r-5 partial fix).
- **Cost:** keeps 2-8 workers warm even when user has stopped panning. 80 MB WASM heaps for nothing.
- **Move:** instrument actual decode rate over rolling window. Adapt `minIdle` down to 1 (or 0 on mobile) when rate < N tiles/sec; up to maxSize when surging. Combine with L6r-3 visibility integration. Living pool, not static.

### L11sm-10. [MOBILE BIAS] Battery-and-thermal-aware quality
- **Analogy:** mobile games drop shadow resolution, switch from forward+ to forward, halve texture mip bias when thermal throttle kicks in. Quality follows battery.
- **Cost:** jxl-pyramid serves the same pixels regardless of device state.
- **Move:** caller-injected `getQualityHint?: () => 'high' | 'medium' | 'low'`. Library biases: 'low' = choose one level coarser than target, skip parallel path (single worker), use shorter idleTimeout. Defaults respect the L6r-9 mobile detection. Pairs with L11sm-9 worker dial-down.

### L11sm-11. [DEMAND-PAGED CACHE WITH WARM-PATH PROMOTION] LRU isn't enough
- **Analogy:** UE5 cache distinguishes "recently used" from "predicted-to-be-used-again." A page used during sustained pan-along-row is promoted to "sticky"; one-shot pages stay LRU-cold.
- **Cost:** jxl-pyramid has no cache (L3m-8); future cache (L3m-9) defaults to pure LRU.
- **Move:** when the L3m-9 cache lands, support two tiers: hot (sticky, promoted by access-count >= 3 within window), cold (one-shot, dropped first). Caller pan around viewport → tiles at viewport center get promoted; edge tiles cycle. Reduces re-decode on oscillating zoom.

### L11sm-12. [WEBGPU COMPUTE FUTURE] Tile decode could move into a compute shader someday
- **Analogy:** UE5.4 Nanite virtual geometry has moved a lot of "CPU mesh management" into compute shaders. Same direction is plausible for JXL decode — there's research on GPU-accelerated JPEG/JXL decoders.
- **Cost:** today nothing in jxl-pyramid is GPU-aware. The pool is CPU-thread shaped. If a GPU decode path arrives, the entire pool abstraction needs to be parallel to a "GPU queue" abstraction.
- **Move:** L1r-9 four-file split anticipates this: `decode.ts` is the abstraction over decode-strategy. Strategy choices today: single-WASM-main, parallel-workers. Tomorrow: parallel-workers, GPU-compute, hybrid. Architecture leaves room. Cite L9rev-1 trajectory.

### L11sm-13. [TILE STATE MACHINE] UE5 tracks each page through Requested → Loading → Resident → Evicted
- **Analogy:** virtual texture page table cells carry their own state; pipeline updates them. jxl-pyramid has no per-tile state — tiles are anonymous slots in a `parts[]` array (cite L4m-3 implicit handle state machine; same pattern at tile level).
- **Cost:** can't tell "is this tile already requested?" — re-pan over same area re-requests same tiles. No dedup.
- **Move:** tile registry per session: `Map<tileId, { state: 'requested'|'loading'|'resident'|'failed', pixels?, expiresAt? }>`. New requests check registry; in-flight skips dispatch. Pairs with cache (L3m-9, L11m-10) — registry is the in-memory tier of the hierarchy.

### L11sm-14. [TILE BUDGET PER PAN GESTURE] Cap tiles-per-second per interaction
- **Analogy:** map clients (Mapbox GL JS) cap tile loads per pan to avoid network/decode storms. User pans across the world in 1 second; client doesn't request every tile along the path — only the destination + a few in-flight.
- **Cost:** jxl-pyramid has no concept of "pan still in progress." Every intermediate viewport during a fast pan triggers full tile dispatch. Pool wedged in last-pan's tiles when user arrives.
- **Move:** `decodeViewport({signal})` is enough IF caller debounces. But better: library exposes `decodeViewportDebounced(viewport, {minStableMs: 50, signal})` that waits for viewport to stop changing for N ms before dispatching. Cancellation-friendly (L4-3 AbortSignal). Caller writes less boilerplate.


---

# Lens 11g (master) — JXL in immersive gaming

Shifted further: from interactive 2D map streaming to immersive (VR/AR/spatial) real-time rendering. Quest, Vision Pro, PCVR, foveated displays, 90/120Hz refresh. Motion-to-photon under 20ms. Battery and thermal budgets tighter than consumer apps. The traditions: Unreal Nanite + virtual textures, async timewarp / reprojection, foveated rendering, BC7/ASTC GPU-native textures, triple-buffered upload pipelines.

If jxl-pyramid is to live inside a VR scene serving high-resolution photo-real environments (digital twin, 8K photogrammetry, virtual museums, 3D Gaussian splatting reads), here's what gaming demands.

### L11g-1. [FRAME PACING] Motion-to-photon budget pins everything else
- **Principle:** VR demands < 20ms motion-to-photon. Anything that exceeds the frame budget MUST yield — even at the cost of quality.
- **Today:** jxl-pyramid has no concept of "wall-clock budget for this frame's tile work." A single slow tile blocks the entire viewport (cite L11sm-5).
- **Move:** `opts.deadlineMs?: number` — caller's hard ceiling. Library returns whatever's done plus a `continuation` token for the rest. Stream-stitch (L3m-11) writes ready tiles into the output buffer; missing tiles stay at previous mip OR placeholder color. The L11sm-5 frame budget knob, sharpened: VR adds the absolute-deadline contract.

### L11g-2. [FOVEATED RENDERING] Decode where the eye looks; cheat at the periphery
- **Principle:** Quest 3 / Vision Pro have eye-tracking. Render center at full res; periphery at quarter. Saves 50%+ pixel shading. Same idea for tile streaming: center tiles full quality; edge tiles can be at level-1 mip and gain 4× fewer pixels.
- **Today:** all tiles decode at the chosen level. No quality variation by spatial position.
- **Move:** `opts.fovea?: { centerX, centerY, radius }`. Library decodes inside-fovea tiles at the chosen level; outside-fovea tiles at level-1 (one octave coarser). Stitch upsamples low-res tiles to match. Pairs with L11m-13 trilinear-mip-blend so the transition isn't visible. Foveated tile streaming is unbuilt anywhere I know of — first-mover advantage for digital-twin VR.

### L11g-3. [ASYNC TIMEWARP / REPROJECTION] Paint low-res now; refine next frame
- **Principle:** VR doesn't wait for the perfect frame. If the GPU is late, the compositor re-projects the previous frame to the new head pose. Smooth at the cost of staleness.
- **Today:** pyramid waits for full ROI before returning. No "paint what's available now" mechanism.
- **Move:** stream-stitch + onTile (L3m-11, L11sm-5) IS the reprojection-equivalent. UI gets partial buffer immediately; library keeps writing as tiles arrive. The async-timewarp pattern: viewer commits a frame to display at the deadline regardless of decode completion; remaining tiles "reproject" into next frame's display.

### L11g-4. [RESIDENCY BUDGET WITH HARD CAP] Never OOM the device
- **Principle:** Quest 3 has 8 GB RAM; OS takes 2-3 GB; game allocs are budgeted to ~3-4 GB. Texture streamer is hard-capped per pool. Going over = OS reaps app. No grace.
- **Today:** pyramid pool warm workers each carry ~10 MB WASM heap; max 8 workers = 80 MB. Plus per-tile transient memory. Plus the L6-2 N-clone amplification before fixes. Unbounded in worst case.
- **Move:** L6r-11 memory probe + L11sm-4 residency budget. For VR specifically: caller declares total budget at `createPyramidWorkerPool({budgetBytes: 64*1024*1024})`. Pool computes derived maxSize. Refuses to grow past budget. Pairs with L11sm-9 adaptive worker count.

### L11g-5. [PREDICTIVE PREFETCH BY HEAD-POSE] Camera path is highly predictable in VR
- **Principle:** in VR, head + controller pose is sampled at 1000+Hz; predicting next-frame's view is far more accurate than guessing in a 2D pan. UE5 / Unity XR ship 50-100ms ahead.
- **Today:** pyramid only reacts to current viewport.
- **Move:** L11sm-3 generalized — `opts.predictedViewports?: Array<{viewport, t, weight}>`. Library dispatches prefetch in priority order: highest weight first, low-priority background pool. AbortController cancels obsolete predictions. In VR the prediction is so reliable that prefetched tiles are ~85% useful (vs ~40% in 2D pan).

### L11g-6. [VRS-EQUIVALENT] Variable decode rate per tile region
- **Principle:** Variable Rate Shading lets GPU shade some pixels less often. Direct analog for streaming: tiles in "I might glance there" zones get one octave below ideal; tiles "I'm staring at" get one octave above.
- **Today:** all tiles at the same chosen level (cite L11sm-8 anisotropic, related).
- **Move:** combined with L11g-2 foveated, the library accepts per-tile level overrides: `tile.preferredLevel ?? viewport.defaultLevel`. Caller computes preferred-level per tile from gaze + saliency. Pool dispatches accordingly. Pairs with L11m-1 stable tileId — a tile can hold pixels at multiple mips, picked at composite time.

### L11g-7. [GPU UPLOAD QUEUE] Direct path; never via main heap
- **Principle:** in modern GPU APIs (Vulkan, D3D12, Metal, WebGPU), uploads use a separate "copy queue" that runs on dedicated GPU hardware. CPU stays free. Caller hands off a buffer; GPU schedules the copy across frames.
- **Today:** pyramid returns Uint8Array → caller's `texSubImage2D` → CPU memcpy into mapped buffer → GPU async copy. Three steps; one mandatory CPU memcpy.
- **Move:** `opts.outputTarget?: GPUTexture` — library writes via `device.queue.writeTexture({texture, origin: {x, y, z: 0}, ...})`. WebGPU schedules onto copy queue. CPU never touches the pixels. Pairs with L11sm-6. For WebGL fallback: `texSubImage2D` from worker-side OffscreenCanvas if the workflow supports it.

### L11g-8. [TRIPLE-BUFFERED PIPELINE] N tiles in flight; cancel oldest on view change
- **Principle:** GPU graphics pipelines keep N=2 or 3 frames in flight. CPU prepares frame N+2 while GPU renders frame N+1 and displays frame N. Cancellation: if user input invalidates frame N+2, drop it before it's submitted.
- **Today:** pyramid dispatches one viewport at a time. If user pans during decode, no concept of "older viewport is obsolete."
- **Move:** `pool.replaceCurrentDispatch(newViewport, signal)` — cancels previous dispatch's AbortController, starts new. Library tracks "current" + "in-progress fallback" to avoid black frames during transitions. Pairs with L11sm-14 debounced viewport + L4-3 AbortSignal.

### L11g-9. [STEREO LOCKSTEP] Left + right eye must arrive together
- **Principle:** in stereo VR, if the left eye paints at frame N and the right eye paints at frame N+1, the user perceives a depth glitch ("judder"). Both eyes' frames must arrive together. The streaming system MUST synchronize.
- **Today:** pyramid has zero notion of stereo. A VR caller decoding two ROIs (one per eye) gets two independent Promises. They settle whenever.
- **Move:** `decodeStereoViewport(leftSource, leftRegion, rightSource, rightRegion, opts) → Promise<{left, right}>` — settles only when BOTH complete. Internal scheduler interleaves tile dispatch from both eyes to share workers + cache. Cancellation cancels both. The compositor never sees a half-frame. This is unbuilt feature surface — first-mover advantage.

### L11g-10. [BC7/ASTC TRANSCODE] Decode JXL once, encode for GPU, never decode again
- **Principle:** modern GPU APIs prefer BC7 (desktop) / ASTC (mobile) hardware-native texture compressions. Sample for free; never decompress on every draw. Massive bandwidth + memory win on GPU.
- **Today:** pyramid decodes JXL into RGBA at every viewport. GPU samples RGBA. Decoding cost paid every pan.
- **Move:** "transcode" path: `opts.transcodeTo?: 'bc7' | 'astc-4x4'`. After JXL→RGBA decode, run an encoder (libastcenc or similar — wasm) producing GPU-native blob. Caller uploads via `compressedTexSubImage2D`. Cache the BC7/ASTC blob (L11m-10) not the RGBA pixels. Re-pan = re-sample on GPU (free); decode cost paid once per tile per session. The math: BC7 is 8 bpp = 0.25× RGBA8 footprint, sampling is a hardware fetch. Resident-tile footprint divided by 4; GPU bandwidth divided by 4. ARM Mali / Snapdragon Adreno especially benefit.

### L11g-11. [QUALITY PROFILES] Photo mode vs gameplay budget
- **Principle:** games swap quality profiles between gameplay (~16ms/frame) and photo mode (∞ budget). Same scene; different decode + render.
- **Today:** pyramid has no profile concept. Always same path.
- **Move:** `opts.qualityProfile?: 'realtime' | 'cinematic'`. Realtime = parallel + DC preview + bias to coarser level if frame budget tight. Cinematic = single-WASM streaming progressive decode at the manifest's lossless level + ICC pass-through (L11m-3, L11m-5). Caller toggles by game state.

### L11g-12. [TELEMETRY-FIRST] Ship pool stats to game analytics from day one
- **Principle:** competitive games (Fortnite, Apex) instrument literally everything in production. Per-frame timing, asset miss rate, eviction rate, GPU utilization. Devs query "98th percentile asset stream miss rate on Quest 3 in tutorial mission" and act on it.
- **Today:** zero telemetry (cite L5-11, L8m-7, L8m-15).
- **Move:** L8m-10 PyramidEvent + L8m-15 stats become *the* observability surface. For gaming: ship rolling-window metrics on every frame to host telemetry. Library doesn't pick the backend; caller wires. Library MUST emit. Game-grade telemetry density: ~100-1000 events per second; ring buffer + flush.

### L11g-13. [LATENCY DECOMPOSITION] Pyramid only owns part of motion-to-photon
- **Principle:** gaming has formal latency budget allocation: sense (1ms), think (5ms), render (8ms), compose (3ms), display (3ms). Each system owns its slice. jxl-pyramid would own "render input slice" — tile decode for the texture.
- **Today:** pyramid has no latency self-measurement. Can't tell game "your pyramid budget is 8ms; here's your actual p99."
- **Move:** pool emits `decode-completed { tileId, queueWaitMs, decodeMs, totalMs }` (cite L11g-12). Game's HUD reads it. Optimization is now data-driven not vibes.

### L11g-14. [OCCLUSION CULLING] Don't decode tiles that won't be seen
- **Principle:** game engines cull tiles obscured by UI, by frustum, by closer geometry. Decoding hidden tiles wastes the entire pipeline.
- **Today:** pyramid decodes whatever ROI it's given. No occlusion awareness.
- **Move:** add to `decodeViewport`: `opts.skipTiles?: (tile) => boolean` predicate. Caller passes a function reading from its UI/scene state. Library skips matching tiles. Combined with stream-stitch (L3m-11) — partial result becomes the norm, occluded slots stay at previous mip.


---

# Lens 12 (master) — Butteraugli speedup via pyramid patterns

Framing: butteraugli is JXL's perceptual quality metric — psychovisual, multi-scale, opponent-color, DOG-filtered. Runs at encode time inside the encoder's quantization loop. Famously slow (10-100× PSNR/SSIM). Lives in libjxl, exposed through `@casabio/jxl-wasm`. Not currently called by the three files in memory — these are decode-only. **But:** every pattern jxl-pyramid built for *fast tiled decode* directly applies to *fast tiled butteraugli*. This lens names the bridge.

Setup assumption: jxl-wasm exposes a butteraugli entry (`compareButteraugliRgba8(reference, candidate, opts)` or similar — user memory references butteraugli-implementation work). If not yet exposed, jxl-wasm-side work precedes any of these.

### L12m-1. [POOL RETASKING] Warm worker pool is the answer to butteraugli's cold-start tax
- **Principle:** cold-starting a libjxl WASM module costs ~10-50ms. butteraugli over a single image batch may need dozens of comparisons. Each as a fresh WASM session pays the compile cost dozens of times.
- **Move:** the existing `PyramidWorkerPool` is content-agnostic — workers know "decode tile container ROI" today; teach them to also know "butteraugli(reference, candidate, region)". One protocol bump (cite L3-1 format-in-request: `{type: 'butteraugli', refBytesId, candBytesId, region, preset}`). Same pool, same prewarm, same warm workers. Encode-time tuning runs over a warm pool instead of cold-spawning encoders.

### L12m-2. [TILE-BASED BUTTERAUGLI] Tile + border-overlap; aggregate via reduce
- **Principle:** butteraugli on full 8K image at level-3 quality is single-threaded inside libjxl and slow. Tile + parallel = N× speedup, with caveat: psychovisual metrics use multi-scale DOG filters with finite spatial extent, so naive tiling has seam artifacts at tile boundaries. Standard fix: each tile decodes with a halo (border-overlap ~16-32 px), compares the central region, ignores the halo.
- **Move:** `tilesOverlappingRegion(W, H, T, region)` (currently in tiling.ts) becomes the basis for `butteraugliTilesWithHalo(W, H, T, halo, region)`. Pool dispatches per-tile compare. Per-tile butteraugli returns a max + heatmap. Aggregate via max-of-maxes (correct for "worst pixel score") and area-weighted-mean (correct for "average perceptual distance"). Stitch is the reduce.

### L12m-3. [PYRAMID-LEVEL APPROXIMATION] Cheap filter at low res; full only where suspect
- **Principle:** if butteraugli at level-2 (1/4 res) returns low score for a tile, the same tile at full res is almost certainly fine — the metric's multi-scale design correlates levels. Run cheap pass first.
- **Move:** two-stage butteraugli. Stage 1: compare at level-2 (full image is 1024 tiles × small) — runs in N ms. Stage 2: only the tiles where stage-1 score exceeded threshold (typically < 5% of tiles for well-tuned encodes) get full-res butteraugli. Net: 10-50× speedup for "quality is mostly fine" cases (the common case during encode tuning).

### L12m-4. [PROGRESSIVE BUTTERAUGLI] DC-only first; full only when ambiguous
- **Principle:** JXL's decode emits DC preview (cite L3m-2). Comparing DC-only versions of reference + candidate gives a fast lower-bound on the metric. If DC butteraugli < threshold, full butteraugli will almost always pass. If DC butteraugli >> threshold, the candidate fails — no need to fully decode.
- **Move:** decode-stream-aware butteraugli. Use `createDecoder({progressionTarget: 'dc'})` (already used in decodeWhole for whole-frame decode). Compare DCs. Gate full-decode butteraugli on ambiguous results. Pairs with L12m-3 pyramid-level — they're spectral and spatial versions of the same trick.

### L12m-5. [STITCH = REDUCE] Per-tile scores aggregate via reduction
- **Principle:** decode's stitch is positional copy. Butteraugli's stitch is statistical reduction (max, mean, heatmap composite). Same architecture, different reducer.
- **Move:** generalize stitch into `aggregate<T>(viewport, parts: Part<T>[], reducer: Reducer<T>) → T`. Decode reducer = `pixelCopy`. Butteraugli reducer = `{max, mean, heatmapBuffer}`. The L1r-9 unified `decode.ts` / `plan.ts` split naturally accommodates this — only the reducer swaps.

### L12m-6. [CACHE] (Reference, Candidate, Preset) → score is deterministic
- **Principle:** comparing the same two images at the same preset always yields the same score. During encoder tuning, the same reference is compared against many candidates; many candidates revisit similar regions. Cache hits are common.
- **Move:** L3m-9 cache interface generalizes: `cache.get({refKey, candKey, preset, region})`. Key = hash of all four. Reference encode of same image: cache hit. Caller drives the keying. Memory tier (hot) + OPFS tier (warm). Encoder tuning sessions especially benefit — runs 10× during a tuning sweep often re-evaluate identical (ref, cand) pairs.

### L12m-7. [SAB FOR INPUT FABRIC] Two read-only buffers fan out zero-clone
- **Principle:** butteraugli takes TWO inputs (reference + candidate). Without SAB, each tile decode in a worker clones BOTH images. Doubles the L6-2 N-clone amplification.
- **Move:** SAB (L6r-1) extends naturally. Each worker holds reference-SAB and candidate-SAB views once. Per-tile request carries only (refBytesId, candBytesId, region, preset). Zero copies for input fan-out. For a 64 MB reference × 64 MB candidate × 16 tiles × 4 workers, the savings are ~8 GB of clone activity per evaluation pass.

### L12m-8. [ABORT-SIGNAL] Interactive encoder tuning needs cancellation
- **Principle:** an encode-tuning UI lets the user adjust effort / distance / palette knobs and see butteraugli update. Each adjustment supersedes the previous. Without cancellation, slow comparisons stack up.
- **Move:** the L4-3 AbortSignal threading is exactly the same primitive. Encoder UI fires new `butteraugliViewport(ref, cand, opts, {signal})`; previous controller aborts; in-flight workers receive `{type:'cancel', id}` (L3-5). Same plumbing.

### L12m-9. [BUTTERAUGLI PLAN] DecodePlan equivalent — precompute the tile grid + halo
- **Principle:** L1r-1 / L2-10 DecodePlan caches clamped viewport + tile list + header + bits per (LevelSource, region). For butteraugli, the analog precomputes tile-with-halo grid + reducer choice + preset.
- **Move:** `prepareButteraugliPlan(refSource, candSource, region, opts) → ButteraugliPlan`. Sessionized like L1r-6 LevelSession. Multiple evaluations of "the same reference vs different candidates over the same region" share plan + reference fetch.

### L12m-10. [BUTTERAUGLI_QUICK] Multi-rate preset surface
- **Principle:** libjxl ships butteraugli "quick" mode (~5× faster, slightly less accurate) and full mode. The choice matters for tuning vs final QA.
- **Move:** `opts.preset?: 'quick' | 'full'`. Tuning UI uses quick; final QA uses full. Worker protocol passes preset. Pool's per-worker metrics (L11m-6) track quick-vs-full latency separately so the user knows what they're paying for.

### L12m-11. [COMBINED PIPELINE] Decode + compare in same worker session
- **Principle:** today a JXL→JXL comparison is two decodes (ref + cand) + butteraugli over the RGBA pair. The pool decodes ref tile → posts pixels back → main holds them → posts to candidate worker → posts results to butteraugli worker. Three boundary crossings per tile.
- **Move:** worker hosts the full mini-pipeline: receive `{type:'decode-and-compare', refBytes, candBytes, region, preset}`; worker decodes both ROIs (libjxl is already loaded), compares, returns only the score. One boundary crossing per tile. Pairs with L12m-7 SAB — refBytes and candBytes are SAB references, not clones.

### L12m-12. [PER-TILE TELEMETRY] Butteraugli's spatial heterogeneity is visible
- **Principle:** some tiles are uniform sky (cheap butteraugli); some are dense foliage (expensive). Pool's L11m-6 / L11g-12 telemetry surfaces this. Tuning UIs can show the user "your bottleneck is these 3 tiles" — actionable insight that 95% of butteraugli output today hides.
- **Move:** per-tile timing is already in scope if L8m-15 latency telemetry lands. For butteraugli specifically: also emit per-tile score + p99 cost. The heatmap output (L12m-5) lets the UI overlay "expensive tiles" — actionable.

### L12m-13. [FOVEATED BUTTERAUGLI] Center-bias for interactive tuning
- **Principle:** during interactive tuning the user is staring at the center of the canvas. Compare center tiles at full butteraugli; periphery tiles at quick or skipped. After the user dwells, fill in the periphery.
- **Move:** combine L11g-2 foveated lens with L12m-2 tile-based butteraugli. `opts.fovea?: {centerX, centerY, radius}`. Center tiles → full preset; non-center → quick preset; far-periphery → no comparison (assume previous score still valid). 5-10× perceived speedup with no measurable accuracy loss during tuning.

### L12m-14. [REFERENCE HANDLE] One reference, many candidates — pool holds it
- **Principle:** encoder tuning sweeps emit 5-20 candidates per setting change. All compared against the SAME reference image. Reloading the reference per candidate is waste.
- **Move:** pool exposes `holdReference(bytes) → ReferenceHandle` (sticky in worker bytesId cache, cite L3-4). Subsequent `compareCandidate(refHandle, candBytes, region, opts)` skips reference loading per call. Sweeps become fan-out-from-cached-reference. Reference handle releases when caller `release(handle)` — explicit.

### L12m-15. [EARLY TERMINATION] Once worst-tile crosses threshold, abort remaining
- **Principle:** if the encoder tuning loop only cares whether max-score < threshold (the typical pass/fail), and ONE tile already exceeded threshold, remaining tiles don't change the answer. Abort.
- **Move:** `opts.abortAboveScore?: number`. Reducer is monotone-non-decreasing in max. As soon as any tile's score exceeds abortAboveScore, library cancels all in-flight tiles (via L4-3 AbortSignal) and returns "fail at tile (col,row), score X." Encoder rejects the candidate immediately and tries next setting. 2-10× speedup in the common "tweak settings until quality passes" loop. Pairs with L12m-13 foveated — fovea-center fails fast.


---

# Lens 13 (master) — Photogrammetry + digital twins of organisms

Framing: a digital twin of an organism is a fused volumetric record — surface geometry, multi-view textures, optionally multi-spectral / IR / UV-fluorescence layers, optionally time-series of growth. Built from 50-2000 photographs per subject, ingested through structure-from-motion + multi-view stereo OR neural representations (NeRF / 3D Gaussian Splatting). The product context per user memory: photogrammetry, RTI (Reflectance Transformation Imaging), focus stacking, digital twin.

jxl-pyramid is shaped for ONE image, decoded into ONE viewport. Photogrammetry has N images converging on ONE surface. Most of the gap is structural — these items name the structural changes (and the patterns from earlier lenses that already point at them).

### L13m-1. [IMAGE-SET MANIFEST] Pyramid manifest is single-image; photogrammetry is N-image
- **Principle:** the photogrammetry "asset" is not one image — it's a collection of N images plus camera poses, plus a mesh, plus optional auxiliary channels (depth, normals, segmentation masks). The current `PyramidManifest` (per L5m-10/L5m-13) describes one image. Multi-view = N independent manifests today.
- **Move:** introduce `ImageSetManifest { id, images: PyramidManifest[], poses: CameraPose[], meshRef?: string, auxiliaryChannels?: ChannelManifest[] }`. Each `images[i]` retains its own pyramid; `poses[i]` provides extrinsics + intrinsics. Single fetch loads the set. Pool, cache, plan all operate at set granularity — workers can hold sticky references to multiple source images (cite L12m-14 ReferenceHandle generalized).

### L13m-2. [WORLD-TILE PYRAMID] Globally addressed tiles on the organism's surface
- **Principle:** photogrammetry's NATIVE coordinate system is on the reconstructed surface (UV map of the mesh) or in 3D world space. Image-space tiles only matter as projections of surface regions. HiPS for astronomy (L11m-1) solved this for the sphere; photogrammetry needs the equivalent on an arbitrary mesh.
- **Move:** `WorldTilePyramid { meshRef, uvAtlas, levels: WorldTileLevel[] }` where each tile is addressed by `(level, atlasU, atlasV)` and contains pre-textured pixels for that region of the surface. Sources may be multi-view fusions OR single-view bakes. Decoded tile maps to a GPU texture region via uv-atlas lookup. Pairs with L11m-1 stable tileId addressing AND L11g-10 BC7/ASTC transcode for GPU sampling efficiency.

### L13m-3. [VIEW-DEPENDENT DECODE] Frustum-cull across N source images
- **Principle:** when a user views the digital twin from a specific angle, only a handful of source images contribute to the rendered pixels (the ones whose viewing rays are closest to the user's current rays). Decoding all N images wastes work.
- **Move:** caller computes "view-dependent visibility" — `getViewDependentImages(meshPose, cameraPose, sources): Array<{imageIdx, weight}>`. Library accepts `decodeViewDependent(setManifest, currentView, opts)` and only decodes ROIs from highest-weighted sources. Pairs with L11g-14 occlusion culling — same primitive, different scorer. Predictive prefetch (L11g-5) extends: as user rotates view, prefetch the source images entering the visibility window.

### L13m-4. [LINEAR COLOR SPACE] Photogrammetry math is wrong in sRGB
- **Principle:** multi-view consistency, photometric stereo, neural radiance fields ALL require linear color values. sRGB-encoded values produce wrong gradients, wrong color averages, wrong specularity estimates. The standard fix is decode-to-linear before any cross-image math.
- **Today:** decode-level outputs rgba8/rgba16 in sRGB (cite L3m-4, L6m-12). No linearization. Caller must do it; few callers do it correctly.
- **Move:** `opts.colorSpace?: 'srgb' | 'linear' | 'rec2020-linear'`. Library applies inverse-transfer-function on output OR (better) routes to a libjxl decode mode that outputs linear directly. For high-fidelity work: `rgba32f` linear output (cite L11m-2 BITPIX float). For 8-bit: undo sRGB EOTF then re-quantize to 12-bit linear (LUT-driven, ~free). Pairs with L11m-5 ICC pass-through — ICC tells the library what the source space ACTUALLY was.

### L13m-5. [CAMERA INTRINSICS] EXIF + lens distortion per image, side-channel pass-through
- **Principle:** photogrammetry's structure-from-motion solver needs focal length, principal point, distortion coefficients (k1, k2, k3, p1, p2) PER image. Without these, reconstruction fails or converges to garbage geometry.
- **Today:** EXIF dropped at pyramid boundary (cite L7m-12, L11m-5).
- **Move:** `DecodedLevel.cameraIntrinsics?: { focalLength, principalPoint, distortion, sensorWidthMm, ... }` parsed from EXIF by jxl-wasm (libjxl can read EXIF) and forwarded. Image-set manifest carries pre-solved poses; per-image intrinsics arrive with each decode for cross-validation. The full FITS-PHU discipline applied to commercial cameras.

### L13m-6. [DEPTH MAP CHANNEL] Per-pixel depth alongside rgba
- **Principle:** modern photogrammetry workflows ship depth maps alongside RGB — produced by MVS, time-of-flight, or LIDAR. A digital twin viewer reads depth to do view-dependent compositing, occlusion, relighting.
- **Today:** DecodedLevel has only `{pixels, width, height}` — RGB(A) only.
- **Move:** `DecodedLevel.depth?: Float32Array` aligned to pixels. JXL supports extra channels in its container format; encoder ships them; decoder forwards. Manifest declares `levels[i].depthAvailable: true`. Region decoders gain a `decodeTileContainerRegionRgbaDepthF32` variant — same plumbing pattern as the L11m-2 BITPIX generalization. Pool's worker protocol carries `format: 'rgba+depthF32'` (cite L3-1).

### L13m-7. [MULTI-SPECTRAL CHANNELS] UV / IR / fluorescence for biology
- **Principle:** organism imaging often combines visible (RGB), near-IR (chlorophyll fluorescence in plants, vein patterns in skin), UV (mineral fluorescence, pollinator-visible markings), thermal-IR (heat distribution). Each band is a separate image OR a separate channel.
- **Today:** rgba only. Multi-spectral requires multiple decode passes (one per band) and re-registration.
- **Move:** generalize `DecodedLevel.pixels` to `DecodedLevel.bands: Record<string, TypedArray>` with metadata `bandSpec: { name, wavelength, units, depth }`. RGB stays as three bands named "R", "G", "B"; extras like "UV365", "NIR850", "ThermalIR" register naturally. JXL supports extra channels (alpha, depth, custom). Pool's worker protocol passes band list per request. Caller specifies which bands they want — library decodes only those.

### L13m-8. [RAW/DNG INPUT BIAS] Bayer-aware decode for color fidelity
- **Principle:** the repo name `raw-converter-wasm` already commits to RAW/DNG as a first-class input (CLAUDE.md: `src/lib.rs` handles ORF/DNG → RGB). Photogrammetry's color fidelity is sensitive to demosaic quality. The post-demosaic JXL path loses information vs Bayer-preserving paths.
- **Today:** jxl-pyramid takes JXL containers (already demosaiced). No path to honor Bayer.
- **Move:** parallel pipeline. `RawLevelSource` (already exists in some form per CLAUDE.md). decode-level + pool gain awareness: if source declares Bayer, route to a different decoder that does pre-decode demosaic with caller-controlled algorithm (AMaZE, AHD, etc., per user memory's blur-bench-verdict). Otherwise standard JXL path. Out of scope for the three files today but the L1r-9 split's `decode.ts` is the seam.

### L13m-9. [TIME-SERIES] Temporal pyramid for repeat scans
- **Principle:** organism growth, behavioral studies, post-fossilization erosion — many scientific uses scan the SAME subject at multiple time points. Each scan produces a digital twin; comparing them shows change.
- **Today:** pyramid is single-epoch (cite L11m-12).
- **Move:** L11m-12 generalized for organisms: `PyramidLevel.epoch?: string | number` and `chooseLevelForTarget(levels, target, {epoch?})`. Comparison API: `compareTwoLevels(epochA, epochB, region) → DiffResult`. Pairs with butteraugli (L12) for perceptual change detection AND with depth maps (L13m-6) for geometric change detection.

### L13m-10. [NEURAL FEED] NeRF / 3D Gaussian Splatting need fast random patch access
- **Principle:** training a NeRF or 3DGS samples millions of rays per epoch, each ray reads a pixel from one of N source images. Read pattern is random across images and random within each. Sequential whole-image decode is hostile to this. The pyramid's per-tile ROI decode is exactly what's needed — but the access pattern is many-tiny-patches not few-large-viewports.
- **Today:** decode is region-scaled; cost amortizes well at viewport scale, poorly at 64×64 patches.
- **Move:** (a) per-tile cache (L11m-10 / L3m-9) becomes essential — same pixel accessed thousands of times per epoch. (b) batched-region decode (L7m-2) becomes critical — one WASM call per worker per epoch slice covering 100s of small patches. (c) GPU-resident decode (L11g-7) ideal — neural training is already on GPU; decoded tile residence in GPU memory closes the loop. (d) BC7/ASTC transcode (L11g-10) is unnecessary if pixels stay rgba32f for math fidelity, but useful for re-rendering. Library exposes `decodePatches(source, regions[], opts)` that batches.

### L13m-11. [TEXTURE ATLAS OUTPUT] Compose many tiles into one GPU atlas
- **Principle:** rendering a textured mesh costs more in texture-binding switches than in pixel work. Game engines pack many source images into one atlas with UV remapping. For digital twin viewers, batching reduces per-frame draw calls.
- **Today:** each `decodeTiledViewport` returns its own buffer.
- **Move:** `opts.atlas?: { gpuTexture, layout: AtlasLayout }`. Library writes each decoded tile into the right UV region of the atlas. Caller pre-allocates a 4K or 8K atlas and tracks which tile occupies which region (via L11sm-13 tile state machine). Pairs with L11g-7 direct GPU upload.

### L13m-12. [LOSSLESS GUARANTEE] Specimen archive demands bit-exact repeat
- **Principle:** if you re-scan the SAME specimen, you must be able to register the two scans exactly. Lossy compression with floating-point quantization defeats this — the same scene re-encodes to slightly different bits each pass, defeating diff workflows.
- **Today:** no fidelity flag (cite L11m-3).
- **Move:** `PyramidLevel.fidelity: 'preview' | 'lossless'`. Manifest enforces — lossless-marked levels MUST be encoded with JXL's mathematically-lossless mode. Decoder validates checksums at load (when manifest carries them). Cache (L11m-10) keys include fidelity. Repeat-scan workflows opt into lossless levels; UI/quick-look uses preview. Pairs with provenance (L11m-5) — every byte traceable.

### L13m-13. [REFERENCE-IMAGE CACHE] Same source image referenced from many surface tiles
- **Principle:** when a digital twin is textured from N source images, a single source image typically contributes to MANY surface tiles (every surface tile within its frustum). Decoding the source image's tiles ONCE and reusing across surface tiles is the natural caching pattern.
- **Move:** extends L12m-14 ReferenceHandle. Pool exposes `holdSourceImage(imageManifest) → SourceHandle`. Subsequent `decodeRegion(sourceHandle, region)` shares the worker-resident source bytes. World-tile rendering binds N SourceHandles; surface tile decode iterates them. Cache (L11m-10) keys include the source handle id. Sweep efficiency is N-image-pixels read total, not N-image-pixels × N-surface-tiles.

### L13m-14. [COVERAGE QUERY] "Which tiles cover this 3D world point in each image?"
- **Principle:** photogrammetry math needs the inverse mapping — given a world point P and N images, find the projection (u_i, v_i) in each image and the tile containing it. Today the caller computes projections; library doesn't help.
- **Move:** library accepts `worldToTiles(worldPoint, sources, poses): Array<{imageIdx, tileId, uv}>`. Returns the projection set, marking which projections fall inside their image (others culled by frustum). Built on stable tileId (L11m-1) + camera intrinsics (L13m-5). Caller can dispatch a single `decodeMultiSourceCoverage(...)` to get all relevant tiles in one shot.

### L13m-15. [SYMMETRY PRIORS] Bilateral symmetry — skip half the views
- **Principle:** many organisms have bilateral symmetry. Once one side is reconstructed, the mirror side is approximately known. Skipping is wrong (you lose actual asymmetric details); BIASING is right — fewer cameras needed on the mirror side, with a quality-fallback to the symmetric pair.
- **Move:** out-of-scope for jxl-pyramid (it's a reconstruction-side decision), but the manifest can carry `symmetryHint?: { axis, weightFalloff }`. Caller's view-dependent decode (L13m-3) consults it: when user views the symmetric side, fewer high-priority decodes, more low-priority decodes filled by interpolation. Bandwidth halves for symmetric subjects with no visible quality loss.


---

# Lens 14 (master) — Augmented Reality plant identification

Framing: user holds a phone in a forest. Live camera feed at 30-60fps. ARKit/ARCore tracks pose. App must (a) detect candidate plant parts (leaf, bark, flower, fruit) in frame, (b) extract an embedding, (c) query a curated reference library, (d) return species hypothesis + confidence, (e) render a label anchored in world space on the AR canvas. Round-trip target: ~200ms for "feels live"; <80ms for "feels instant." Often outside cell coverage (real forests have no signal). Reference library is gigapixel herbarium scans — every leaf vein at 600 DPI.

This is the most consumer-shaped use case yet: latency-tight, mobile-bound, intermittent-connectivity, with a safety floor (do not call false-positive on poison-hemlock). Every pattern from earlier lenses lights up here.

### L14m-1. [REFERENCE PATCH BATCH] Plant ID = nearest-neighbor over embeddings → batch decode top-K reference patches
- **Principle:** the matching pipeline produces an embedding from the camera frame, queries a vector index, and returns top-K (typically 5-20) reference candidates with offsets into their pyramid. Each candidate becomes a small ROI (32-128 px) fetch from a reference image's pyramid.
- **Move:** `decodeReferencePatches(sources: ReferencePatchRequest[], opts)`. Pool batches the patches across workers — many tiny requests amortize over warm WASM. Pairs with L13m-10 NeRF-feed batched-region decode and L7m-2 batched WASM call. Round-trip drops from ~200ms (one decode per request) to ~50ms (one batch).

### L14m-2. [OFFLINE-FIRST] Pre-bundled OPFS cache of region-common species
- **Principle:** the user is in a forest. No signal. App must work. The 50-200 most common species for the user's bioregion can pre-ship as JXL pyramids in the app bundle OR pre-fetch on Wi-Fi at home.
- **Move:** L3m-9 cache layer extended with OPFS pre-population. Manifest: `bundledReferences: BioregionalSet`. App startup checks OPFS, downloads the bundle if missing. Pool's cache layer hits OPFS before any network. Pairs with L11m-10 archive tiering: hot (in-memory match results) → warm (OPFS) → cold (network, when available). Geographic priors (L14m-4) define what's in the bundle.

### L14m-3. [HIERARCHICAL TAXONOMY → PYRAMID LEVELS] Genus first; species only after triage
- **Principle:** plant taxonomy is hierarchical (Kingdom → Phylum → ... → Genus → Species → Subspecies). Embeddings often nail Genus from low-res leaf morphology even when species needs vein-detail. Match in stages: Genus at level-1 (cheap), species at level-3 (expensive).
- **Move:** the pyramid IS the taxonomy. Reference images carry both spatial pyramid (level by resolution) AND a tagged taxonomic depth. `chooseLevelForTarget(levels, target, {taxonomicDepth: 'genus'|'species'|'subspecies'})`. Matching pipeline does genus pass first; if confidence > 0.95, halts. If confidence < 0.95, descends to species level. Pairs with L12m-3 (pyramid approximation) — same trick, applied to identification rather than perceptual metric.

### L14m-4. [GEOGRAPHIC PRIOR] Caller passes lat/lon → manifest prioritizes locale-specific species
- **Principle:** there are ~400,000 known plant species globally; ~3,000 native to a typical biome; ~150 commonly encountered. Querying all 400k is silly. Filter by geography before any decode.
- **Move:** library accepts `opts.geography?: { lat, lon, radiusKm }`. Manifest fetcher returns ONLY species with that bioregion in their range polygon. Reduces the candidate set 10-100×. Cache (L11m-10) keys include geography — different bioregions have different hot caches. Pairs with L11m-1 HiPS-style global addressing — bioregions are HEALPix-equivalent for terrestrial.

### L14m-5. [SEASONAL PRIOR] Date → feature priority shifts
- **Principle:** in May, dogwood is blooming; in October, the leaves are red; in February, only bark is visible. Flower-based ID is fast in spring; bark-based ID is the only option in winter. Library can downgrade priority on out-of-season features.
- **Move:** `opts.date?: Date`. Library reorders match candidates by phenology. Manifest carries `phenology: { feature: 'leaf'|'flower'|'bark'|'fruit', seasonStart, seasonEnd }`. Combined with multi-modal bands (L14m-6), the seasonally-correct bands decode at full priority; off-season bands skip or fallback to permanent-feature (bark).

### L14m-6. [MULTI-MODAL BANDS] Leaf vs bark vs flower vs fruit as separate decode paths
- **Principle:** plant features have very different spatial scales. Leaf veins need 100 µm resolution; bark texture is fine at 1 mm; flower macro needs 50 µm. Storing all in one pyramid level wastes bandwidth.
- **Move:** L13m-7 multi-spectral generalized — `bands: { leaf: TypedArray, bark: TypedArray, flower: TypedArray, fruit: TypedArray }`. Each band has its OWN pyramid level chain at its native scale. Caller requests only relevant bands: `opts.bands: ['leaf', 'flower']` (spring) vs `['bark']` (winter). Pairs with L14m-5 seasonal priority.

### L14m-7. [PROGRESSIVE CONFIDENCE] DC-preview match for triage; full match only for top-K
- **Principle:** distinguishing oak from maple needs only coarse leaf shape; distinguishing red oak from black oak needs vein detail. Multi-stage match: DC-only embedding for fast triage; full-res for ambiguity resolution.
- **Move:** L12m-4 progressive butteraugli generalized. Caller embeds DC-preview against DC-encoded reference embeddings; if top-1 / top-2 confidence gap is wide (clear winner), halt. If narrow, decode full-res and re-embed. ~70% of matches halt at DC stage. The L3m-2 progressive JXL decode (DC-then-final) is the seam.

### L14m-8. [LIVE CAMERA → JXL ENCODE → SERVER-SIDE MATCH] Hybrid path when connectivity available
- **Principle:** mobile-side embedding models are necessarily smaller than server-side. When the user has connectivity, server-side match beats on-device match for hard cases. The bottleneck is bandwidth — upload the frame.
- **Move:** caller encodes camera frame to JXL (lossy effort=3 per user memory's preferred preset) — 200kB for a 4K-ish frame. Library's jxl-pyramid encoder side (TODO: pyramid-ingest reuse) emits the JXL. Caller uploads. Server matches at full quality. Round-trip: ~500ms acceptable since UI shows "matching..." state.

### L14m-9. [GPU OVERLAY] Direct GPU upload of reference tile into AR compositor
- **Principle:** the AR compositor draws the label + reference patch overlay on the same render frame as the camera feed. If the reference patch lands as a CPU `Uint8Array`, every frame costs an `Image()` round-trip.
- **Move:** L11g-7 generalized for AR — `opts.outputTarget?: { gpuTexture, atlas: AtlasRegion }`. Library writes decoded reference patch directly into the AR compositor's texture atlas at the assigned UV region. Pairs with L11sm-13 tile state machine for "which atlas slot holds which reference patch right now."

### L14m-10. [TRACKING-QUALITY-AWARE ABORT] When ARKit/ARCore loses pose, abort in-flight decodes
- **Principle:** ARKit/ARCore expose tracking quality. When tracking degrades (user pans too fast, low light), the world-anchored label position becomes unreliable; rendering the label at a wrong world position is worse than no label. In-flight reference decodes should bail.
- **Move:** caller wires ARKit's tracking-state callback to AbortController. `signal.aborted` when tracking is lost. Library's L4-3 AbortSignal threading handles it natively. Reference decode + match pipeline shed in-flight work. UI shows "find the plant again" state until tracking returns.

### L14m-11. [SAFETY THRESHOLD] Toxic species require high-confidence ID; uncertain → "unknown"
- **Principle:** the library returns ranked candidates with confidence scores. If top-1 is "Poison Hemlock" at confidence 0.7, do NOT show "Poison Hemlock" — show "unknown, please verify." If top-1 is "Coriander" at 0.7, showing "Coriander (uncertain)" is fine. Safety has asymmetric thresholds.
- **Move:** manifest carries per-species `safetyClass: 'safe' | 'caution' | 'toxic'`. Library exposes `opts.confidenceThresholds: { safe: 0.5, caution: 0.7, toxic: 0.9 }`. The library doesn't make safety decisions — it surfaces the class so the caller's UI can apply the bias. Pairs with telemetry (L14m-14) so missed safety calls feed retraining.

### L14m-12. [USER CONTRIBUTION] Snap a misidentified plant → add to local manifest → next user benefits
- **Principle:** community-driven correction is how iNaturalist / Pl@ntNet grew. The library should make it easy for the user's correction to enter the local pyramid manifest immediately, then optionally sync upstream.
- **Move:** caller invokes `appendReferenceImage(manifest, image, taxonomy)`. Library: (a) re-runs pyramid-ingest on the new image (in worker, async), (b) updates the local manifest's `userContributions` section, (c) cache-stores the new pyramid bytes at OPFS. Next match against that local pool includes the contribution. Sync upstream is an app concern.

### L14m-13. [MULTI-TARGET TRACKING] Multiple plants in frame; decode each at its own priority
- **Principle:** user pans the camera and 3 plants enter the frame. Each needs identification. ARKit tracks 3 world anchors. Library must decode ROIs for all 3 simultaneously, possibly with different priorities (center plant first).
- **Move:** L11sm-7 streaming priority generalized. Caller passes N candidate detections: `decodeManyReferenceROIs(detections: Detection[], opts)`. Pool dispatches per-detection, prioritized by camera-space position (center > edge) and detection confidence. AbortSignal per detection: when the plant exits frame, drop that one without canceling siblings.

### L14m-14. [TELEMETRY OF MISIDENTIFICATIONS] Failed IDs feed back to expand reference
- **Principle:** the system learns from its failures. If 1000 users in Oregon snap an unidentified plant in the same area at the same season, that's a known reference gap. Backend ingests the snapshots, herbarium curates, future users benefit.
- **Move:** L8m-10 PyramidEvent extended — emit `match-failed { geography, date, embeddingHash }` (NO image bytes — privacy). Caller wires to telemetry. Backend aggregates. Reference manifest updates push to clients monthly. Closes the offline-cache loop (L14m-2) — pre-shipped bundle grows where users actually go.

### L14m-15. [BATTERY/THERMAL-AWARE QUALITY] Phone overheats → drop reference resolution
- **Principle:** the phone enters thermal throttling after 5 minutes of continuous AR. CPU clocks down; decode latency doubles; battery drains 30%/hour. Library MUST cooperate.
- **Move:** L11sm-10 / L11g-11 generalized — `opts.qualityProfile: 'high' | 'medium' | 'low'`. Low = match against bundled-bioregion-only (L14m-2), single-worker pool, level-2 reference resolution. Caller wires to battery state: `if (battery.level < 0.20 || thermalState === 'critical') profile = 'low'`. Defaults to 'high' when plugged in. Pairs with L6r-5 deviceMemory + L6r-9 mobile detection.


---

# Lens 15 (master) — Perceptual color science LUT engine

Scope: design the SIMD-friendly, sub-ms LUT structure for the proposed perceptual color engine to live under `apply_tone_math` in `crates/raw-pipeline/src/pipeline.rs`. Out-of-scope for the three jxl-pyramid TS files in memory but informed by their patterns (caller-owned buffers, tile boundaries, AbortSignal, telemetry).

## Concern flag — verify before locking math

Several terms in the spec I cannot confirm from training memory and may be (a) niche, (b) renamed, or (c) misattributed. Worth verifying before encoding any of them into a hardcoded LUT path:

| Term | Status (from my memory — not authoritative) |
|---|---|
| Schrödinger color geodesics / 1920 metric | Real — Schrödinger 1920 published a Riemannian color metric. Citable. |
| Sensor sharpening matrix B | Real — Finlayson et al., standard practice. |
| ΔE2000 (CIE 2000) | Real — CIE standard. |
| **HPCS — "Harvard perception-based color space"** | Could not confirm; may be a specific local term. |
| **"Los Alamos chromatic diminishing returns curves"** | Could not confirm. |
| **"Molchanov's anisotropy measures" / "parallelogram law residuals" / "distance structure tensor"** | Cannot confirm this body of work in color science. Multiple "Molchanov" scientists exist (statistician, probabilist) but the color-science attribution is unverified. |
| **"Flatness Paradox"** | Not a recognized term I can identify. |
| "perfectly uniform, linear visual changes across all hues" (claim of guarantee) | No published model achieves this. Any implementation should treat as goal, not guarantee. |

**Recommendation:** parameterize the LUT engine over the math so the same SIMD structure accepts ANY of {Schrödinger metric, custom HPCS, Molchanov tensor, ICC LUT} once specific formulations are locked. The LUT topology + SIMD plumbing below is math-agnostic.

## What carries over from jxl-pyramid

Even though this is Rust + WASM (per `lib.rs`), the pyramid patterns are directly applicable:

- **Caller-owned output buffer** (cite L6-1): apply_tone_math should write into a caller-supplied target buffer, not allocate per pixel batch. Lightbox-side gallery decode can recycle one buffer across pan/zoom.
- **Tile-boundary integration**: the perceptual engine runs per-pixel; pyramid hands it tile-sized chunks. Each pyramid tile decoded → matrix B → log → 3D LUT → exp → write. Cache locality stays good.
- **AbortSignal threading** (cite L4-3): if user changes a slider mid-render, signal cancels the in-flight tone-math pass at the next tile boundary.
- **Telemetry** (cite L8m-15): emit per-tile timings + hit rates so the LUT engine is observable.

## LUT topology — what to precompute, what to evaluate

| Operation | Math | Best representation | Size |
|---|---|---|---|
| Sensor sharpening B | 3×3 matrix-vector multiply | Inline SIMD, no LUT | 36 bytes |
| Log transform (per-channel) | x → log(max(x, eps)) | 1D LUT, 4096 samples × 3 channels | 48 KB |
| Exp transform (per-channel) | x → exp(x) | 1D LUT, 4096 samples × 3 channels | 48 KB |
| Riemannian↔Euclidean coord map | non-linear 3→3 in log-space | 3D LUT, 33³ × 3 floats | 432 KB |
| Anisotropic density (Molchanov-style) | concentrate samples near gray + greens | Single deformed-lattice 3D LUT with axis-stretch fn | same 432 KB |
| Diminishing returns f(c) per hue | scalar over saturation, per hue family | 4× 1D LUT (pinks/greens/oranges/blues), 1024 samples × 4 | 16 KB |
| ΔE2000 spring correction | non-linear 3→3 in Euclidean | 3D LUT optional; inline math may be faster | n/a |

**Total LUT footprint: ~548 KB.** Fits comfortably in modern L2 (typically 1-2 MB). Stays hot if a tile-size loop reuses it.

### Why deformed-lattice not adaptive-grid

The spec mentions concentrating samples around gray + greens. Two implementations:

1. **Adaptive grid (octree/kd):** more samples where needed; correct fidelity; **kills SIMD** because addressing varies per pixel.
2. **Deformed lattice (single 33³ in warped coordinates):** uniform addressing, fixed sample count; deformation function maps "logical" coords to "physical" coords via a smooth monotone curve per axis. SIMD-friendly. Sample density is concentrated where the warp function steepens.

**Pick deformed lattice.** Cost: pre-compute warp functions Wx/Wy/Wz once at LUT-build time. Hot path is identical to uniform 3D LUT: index = `Wx(r) * 33² + Wy(g) * 33 + Wz(b)` where Wx/Wy/Wz are themselves 1D LUTs (cheap gather). Adds two 1D gathers per axis (negligible).

## Rust skeleton

```rust
use std::simd::{f32x8, u32x8, Simd};

#[repr(C, align(64))]
pub struct Lut1D {
    samples: Box<[f32]>,     // length must be power of 2 for fast masking
    domain_min: f32,
    domain_max: f32,
    inv_step: f32,           // (samples.len() - 1) / (max - min)
}

#[repr(C, align(64))]
pub struct Lut3D {
    samples: Box<[f32]>,     // size = grid³ × 3 (interleaved RGB)
    grid: u32,               // typically 33
    warp_r: Lut1D,           // axis warp for anisotropic density
    warp_g: Lut1D,
    warp_b: Lut1D,
}

#[repr(C, align(64))]
pub struct PerceptualEngine {
    sharpening: [[f32; 3]; 3],    // matrix B
    log_lut: [Lut1D; 3],           // per-channel (could share if symmetric)
    exp_lut: [Lut1D; 3],
    perceptual_3d: Lut3D,
    diminishing_pinks:   Lut1D,
    diminishing_greens:  Lut1D,
    diminishing_oranges: Lut1D,
    diminishing_blues:   Lut1D,
}
```

## SIMD strategy

Target: AVX2 (8× f32) on x86, NEON (4× f32) on ARM64, simd128 (4× f32) on WASM. Use `std::simd` (nightly) or the `wide` crate for portable abstraction.

### Hot-loop pseudocode (8 pixels per iteration on AVX2)

```
fn apply_tone_math_simd(engine: &PerceptualEngine, pixels: &mut [f32]) {
    // pixels: planar SoA — R[..], G[..], B[..] (better SIMD than interleaved)
    for chunk in pixels.chunks_mut(8 * 3) {
        let (r, g, b) = load_planar_x8(chunk);

        // 1. Sensor sharpening B (matrix × vector, 9 muls + 6 adds per pixel)
        let (rs, gs, bs) = apply_3x3(engine.sharpening, r, g, b);

        // 2. Log transform (1D LUT gather × 3 channels)
        let rl = lut1d_lookup_x8(&engine.log_lut[0], rs);
        let gl = lut1d_lookup_x8(&engine.log_lut[1], gs);
        let bl = lut1d_lookup_x8(&engine.log_lut[2], bs);

        // 3. 3D LUT lookup (tetrahedral interp, 4 corners per pixel)
        //    First apply axis-warp (cheap 1D gathers)
        let rw = lut1d_lookup_x8(&engine.perceptual_3d.warp_r, rl);
        let gw = lut1d_lookup_x8(&engine.perceptual_3d.warp_g, gl);
        let bw = lut1d_lookup_x8(&engine.perceptual_3d.warp_b, bl);
        let (rp, gp, bp) = lut3d_tetrahedral_x8(&engine.perceptual_3d, rw, gw, bw);

        // 4. Optional ΔE2000 spring correction (TBD inline math)

        // 5. Per-hue diminishing returns f(c)
        //    Compute hue angle (atan2 fast approx) + saturation
        let (h, s) = hue_sat_x8(rp, gp, bp);
        let factor = hue_branchless_blend(
            &engine.diminishing_pinks, &engine.diminishing_greens,
            &engine.diminishing_oranges, &engine.diminishing_blues,
            h, s,
        );
        let (rd, gd, bd) = (rp * factor, gp * factor, bp * factor);

        // 6. Exp transform
        let ro = lut1d_lookup_x8(&engine.exp_lut[0], rd);
        let go = lut1d_lookup_x8(&engine.exp_lut[1], gd);
        let bo = lut1d_lookup_x8(&engine.exp_lut[2], bd);

        store_planar_x8(chunk, ro, go, bo);
    }
}
```

### 1D LUT lookup (linear interp)

```
fn lut1d_lookup_x8(lut: &Lut1D, x: f32x8) -> f32x8 {
    let t = (x - splat(lut.domain_min)) * splat(lut.inv_step);
    let idx_lo = t.cast::<u32>();
    let idx_hi = idx_lo + splat(1u32);
    let frac = t - idx_lo.cast::<f32>();
    // Gather (AVX2 has vgatherdps; NEON needs manual scalar fallback or VLD1)
    let a = gather(&lut.samples, idx_lo);
    let b = gather(&lut.samples, idx_hi);
    a + (b - a) * frac
}
```

### 3D LUT tetrahedral interpolation (4 corners per pixel)

Tetrahedral subdivides each unit cube of the 3D LUT into 6 tetrahedra; pixel falls into one based on its fractional position. Only 4 corner samples loaded vs 8 for trilinear. Per-pixel cost: 4 SIMD gathers + 4 weights + 3 multiplies + 9 adds.

**Why tetrahedral over trilinear:** half the loads. For a 432 KB 3D LUT, this matters — trilinear is bandwidth-bound on the gather step.

## Cycle budget — sub-ms feasibility

Per pixel batch of 8 on AVX2 @ 3 GHz:
- Matrix B: 9 mul + 6 add × 1 (vectorized) ≈ 5 cycles
- Log LUT × 3: 3 gather + 3 linear interp ≈ 30-50 cycles (gather is slow on x86, ~10 cycles for vgatherdps)
- 3D LUT lookup: warp(3 × 10) + tetrahedral(4 × 10 + arithmetic) ≈ 80-100 cycles
- ΔE2000 inline: ~30 cycles (estimate)
- Hue/sat: ~25 cycles (atan2 approx)
- Diminishing × blend: ~40 cycles
- Exp LUT × 3: ~50 cycles
- Store: 3 cycles

**Total: ~250-300 cycles per 8 pixels = ~35 cycles per pixel.**

At 3 GHz: ~12 ns per pixel.
256×256 tile = 65k pixels × 12 ns ≈ **780 µs ≈ 0.78 ms per tile**. Sub-ms target MET if LUTs stay in L2.

512×512 tile = 262k × 12 ns ≈ 3 ms. Beyond sub-ms — needs tile size cap.

WASM SIMD: `simd128` is 4-wide, so ~2× slower. 256² tile likely ~1.5-2 ms. **Sub-ms is harder on WASM**; consider falling back to 128² tiles for the lightbox preview path.

## Cache layout discipline

```
L1 data cache (~32 KB): hold currently-processing 1D LUTs in cache (~48 KB total exceeds L1; can split per-channel)
L2 cache (~1-2 MB): hold 3D LUT (432 KB) + 1D LUTs (112 KB) = 544 KB. Comfortable.
L3 cache: spill if multi-thread + multiple engines instantiated
```

**Rules:**
- Process pixels in tile order (matches pyramid).
- Pre-touch the 3D LUT once per tile to warm L2 (one strided read of 432 KB).
- Avoid more than ONE concurrent perceptual engine on the same NUMA node — they thrash each other's L2.

## Integration points

### From pipeline.rs

`apply_tone_math` becomes:
```rust
pub fn apply_tone_math(
    engine: &PerceptualEngine,
    in_pixels: &[f32],
    out_pixels: &mut [f32],
    abort: Option<&AtomicBool>,    // cite L4-3 AbortSignal threading
) {
    // Optional: check abort at tile boundary
    // Optional: emit telemetry on tile completion (cite L8m-15)
    apply_tone_math_simd(engine, ...);
}
```

### From lightbox (JS-side)

`LookRenderer` gains a new method:
```
lookRenderer.setPerceptualMode(true);
lookRenderer.adjustSaturation(0.8); // illumination-invariant per spec
```

WASM-side, the engine pre-builds LUTs from current slider values. Slider changes trigger LUT rebuild on a background worker (cite jxl-pyramid pool pattern); old LUT continues serving until new is ready (double-buffer). Avoids stutter during slider drag.

### Telemetry hook

Engine exposes:
```rust
pub struct EngineStats {
    pub lut_build_ms: f32,
    pub apply_ns_per_pixel: f32,
    pub cache_misses_estimated: u32,
}
```

Lightbox reads + paints a debug overlay; production strips it.

## Caveats + open design questions

1. **Math under-specification** — engine is parameterized over six precomputed structures; specific math defines those structures. Implement the engine NOW with stub LUTs (identity for log/exp, gray-warp-only for 3D); plug in real math later. Avoids math-blocking-implementation.
2. **f16 / bfloat16 LUTs** — halves footprint, halves L2 pressure. Modern CPUs have f16c (x86) and FP16 (NEON). Worth benching at >65³ grid where size matters.
3. **3D LUT regrid bound to slider rate** — sliders change → LUT rebuild → cost. Cap rebuild rate to 30 Hz; coalesce intermediate values.
4. **Per-hue diminishing returns** — branchless blend over 4 hue bins is fine, but if the spec demands more hues (cyan, magenta, yellow), the blend cost grows. At 6 hue bins, consider replacing 4× 1D LUT with one 2D LUT (hue × saturation).
5. **Numerical stability near black/neutral** — log(x) for tiny x is sensitive; the spec calls out the "spring force" hybrid. Clamp x to `eps = 1e-6` before log. Verify ΔE2000 correction doesn't destabilize when the log path is clamped.
6. **Sub-ms is per-tile, not per-image** — frame the budget in tile counts not image counts. A 4K image (8M pixels) at 12 ns/pixel = 96 ms — fine for progressive paint but NOT for a 60 Hz hot-loop. Apply at tile granularity; let progressive paint amortize.

## Action items

1. **Verify the four uncited references** (HPCS, Los Alamos curves, Molchanov measures, Flatness Paradox). Provide papers OR confirm internal-only nomenclature.
2. **Decide LUT grid size** — start at 33³ (industry standard ICC); bench against 17³ and 65³.
3. **Decide WASM tile size cap** — likely 128² for the lightbox path; native can use 256².
4. **Build the engine parameterized over abstract LUTs** — math gets plugged in later.
5. **Add telemetry hook** to confirm sub-ms claim in production builds.


---

# Lens 16 (master) — Back to basics: micro-opts

Earlier lenses covered architecture, patterns, contracts, observability, and adjacent domains. This pass returns to the JS itself: tiny mechanical wins not previously named, OR re-emphasized with a "this is small but free" framing. Each must be **bench-verified** before commit — V8/SpiderMonkey/JSC frequently optimize these patterns and a "micro-op" can be a regression. Caveat applies to the whole list.

Discipline: each item is a < 10-line change. None of these justify a refactor on their own; collect into one "low-hanging fruit" PR after the architectural moves land.

### L16m-1. `Math.max(w, h)` → `w > h ? w : h`
- **Where:** `choose-level.ts:4` `longEdge(w, h) = Math.max(w, h)`. Also at L20 `levelRank`. Various `Math.max` / `Math.min` in clamp paths.
- **Why:** `Math.max` is variadic and ECMA-spec-bound — handles NaN (returns NaN), signed-zero, and arity-zero (-Infinity). For two finite known positives the ternary is a JIT-friendly comparison + cmov.
- **Cost of change:** 4-line diff. Same for `Math.min`.
- **Bench:** measure stitch loop and chooseLevelForTarget hot path; expect 2-5% local improvement on modern V8 (which already inlines Math.max in many cases — verify before claim).

### L16m-2. `Math.min(Math.max(0, x), max)` clamp idiom → inline
- **Where:** `decode-level.ts:100-103`, `tiled-decode-pool.ts:382-385`. Four lines each.
- **Why:** the idiom is two function calls and the pattern is a candidate for `clampPositive(x, max)` helper OR an inline `x < 0 ? 0 : (x > max ? max : x)`. JITs often inline Math.max/min but the inline form is more predictable.
- **Cost:** trivial. Pairs with L1-1 / L1r-1 shared `clampRegion` helper.

### L16m-3. `navigator.hardwareConcurrency` read twice per decodeTiledViewportPooled call
- **Where:** `tiled-decode-pool.ts:309` (`getOrCreatePool`) AND L408 (`decodeTiledViewportPooled`).
- **Why:** the value is process-invariant. Reading it is a property-access on `globalThis` + cast to ParallelRuntime + nullish-coalesce — small but per-call. Two reads per ROI means 60-120 redundant reads/sec at pan speed.
- **Fix:** module-level `const HWC = (globalThis as ParallelRuntime).navigator?.hardwareConcurrency ?? 4;` evaluated once at module load. Both call sites read `HWC`.
- **Caveat:** on iframe / wrapped global cases, `globalThis` may change post-module-load (rare). Worth checking.

### L16m-4. `pickRegionDecoder(bits)` returns a fresh closure per call
- **Where:** `decode-level.ts:47-58`.
- **Why:** every `decodeTiledViewport` call (potentially per pan frame) calls `pickRegionDecoder(bits)` which allocates either `async (bytes, r) => {...}` or `async (bytes, r) => {...}` — a new closure object each call.
- **Fix:** hoist to module-level constants:
  ```ts
  const REGION_DECODER_RGBA8 = async (bytes: Uint8Array, r: ImageRegion) => {
    const out = await decodeTileContainerRegionRgba8(bytes, r);
    return { pixels: out.pixels, width: out.width, height: out.height };
  };
  const REGION_DECODER_RGBA16 = async (bytes: Uint8Array, r: ImageRegion) => {
    const out = await decodeTileContainerRegionRgba16(bytes, r);
    return { pixels: out.pixels, width: out.width, height: out.height };
  };
  function pickRegionDecoder(bits: 8 | 16): RegionDecoder {
    return bits === 16 ? REGION_DECODER_RGBA16 : REGION_DECODER_RGBA8;
  }
  ```
- **Saves:** one allocation per `decodeTiledViewport` call. Identical fix for the pool's inline arrow at L390-395 (cite L2-1).

### L16m-5. `createDecoder({...})` options object alloc per `decodeWhole` call
- **Where:** `decode-level.ts:21-27`.
- **Why:** the options literal is re-created every call. Whole-frame decode is less hot than tiled, but `decodeWhole` is the path for non-tiled levels — fires on every level switch.
- **Fix:** module-level `const WHOLE_DECODE_OPTS = Object.freeze({ format: 'rgba8' as const, progressionTarget: 'final' as const, emitEveryPass: false, preserveIcc: false, preserveMetadata: false });`. Pass to createDecoder.
- **Bonus:** Object.freeze makes accidental mutation throw in strict mode — defensive.

### L16m-6. `bppFor(bits)` is a function call for a ternary
- **Where:** `tiled-decode-pool.ts:366` `function bppFor(bits: 8 | 16): 4 | 8 { return bits === 16 ? 8 : 4; }`. Called once at L422.
- **Why:** function-call overhead for a single ternary. JIT inlines but adds bytecode.
- **Fix:** inline at the call site: `stitch(viewport, parts, bits === 16 ? 8 : 4)`. Delete `bppFor`. Saves a function declaration + a call.
- **Cost:** tiny — but it's free since it deletes code.

### L16m-7. `idle.shift()` is O(n)
- **Where:** `tiled-decode-pool.ts:193` inside `acquire()`.
- **Why:** Array.prototype.shift moves all remaining elements left. For small arrays (≤8 here), engines may optimize but the worst case is still linear. With high-rate acquire/release, the cost compounds.
- **Fix A (cheap):** combine with L9rev-4 LIFO recommendation — `idle.pop()` is O(1) AND returns the hottest worker. Two birds.
- **Fix B (preserves FIFO):** head-pointer pattern. `idleHead: number = 0; idle[idleHead++] = h;` reset when head reaches tail. More complex; pick A.

### L16m-8. `wantParallel` condition order — cheapest first
- **Where:** `tiled-decode-pool.ts:398-401`.
- **Today:** `options?.parallel !== false && canUseParallelTileWorkers() && tiles.length > 1 && options?.workerFactory !== undefined`.
- **Why:** `canUseParallelTileWorkers()` likely does runtime feature detection (crossOriginIsolated check, possibly Worker constructor check). Most expensive of the four checks. Yet it's evaluated second.
- **Fix:** reorder to `options?.parallel !== false && tiles.length > 1 && options?.workerFactory !== undefined && canUseParallelTileWorkers()`. Short-circuit kills the expensive call when any cheap predicate fails.
- **Pairs with L16m-9:** if canUseParallelTileWorkers is cached, this reorder matters less.

### L16m-9. `canUseParallelTileWorkers()` runtime feature detection per ROI
- **Where:** `tiled-decode-pool.ts:399`. Also `decode-level.ts:108`.
- **Why:** feature detection results don't change after page load. Every ROI re-runs the same checks.
- **Fix:** in `tiling.ts` (where it's defined), memoize: `const CAN_PARALLEL = (() => { /* original body */ })(); export function canUseParallelTileWorkers() { return CAN_PARALLEL; }`. Or just `export const canUseParallelTileWorkers = (() => ...)();` as a const. Single evaluation at module load.
- **Caveat:** only safe if the underlying signals are page-load-stable. `crossOriginIsolated` is — confirmed. Worker constructor is — confirmed.

### L16m-10. In-bounds region skips clamp arithmetic
- **Where:** decode-level L100-103, pool L382-385.
- **Why:** if the caller's region is already inside source dims, the four `Math.min/max` calls each return the input unchanged. The clamp is dead work in the common case (caller computed a region from a level it knows the dims of).
- **Fix:** early branch:
  ```ts
  let rx, ry, rw, rh;
  if (region.x >= 0 && region.y >= 0 && region.x + region.w <= W && region.y + region.h <= H) {
    rx = region.x; ry = region.y; rw = region.w; rh = region.h;
  } else {
    rx = Math.min(Math.max(0, region.x), W);
    // ...
  }
  ```
- **Caveat:** adds a branch. If the common case is "in bounds," branch predictor wins. If callers frequently pass over-extended regions (zoom into corner of canvas), the branch costs. Bench.

### L16m-11. `source.bitsPerSample ?? 8` evaluated repeatedly
- **Where:** `decode-level.ts:97`. Also indirectly via `bits` argument to `stitchTileDecodes` at L120 (`bits === 16 ? 8 : 4`).
- **Why:** the value is invariant for the call. Reading `source.bitsPerSample` is a property access + nullish-coalesce.
- **Fix:** at entry, `const bits = source.bitsPerSample ?? 8;`. Re-use everywhere in the function.
- **Cost:** trivial — and aligns with L2-1 closure hoist.

### L16m-12. `viewport.w * viewport.h * bytesPerPixel` computed twice in stitch
- **Where:** decode-level.ts L65-66 (`pixels` size AND `dstStride`). Pool L41-42 same.
- **Why:** both expressions compute `viewport.w * bytesPerPixel` (the `dstStride`). The first computes `viewport.w * viewport.h * bytesPerPixel`. Common subexpression `viewport.w * bytesPerPixel` is computed twice and the result is used in both.
- **Fix:** `const dstStride = viewport.w * bytesPerPixel; const pixels = new Uint8Array(dstStride * viewport.h);`. Saves one multiply per stitch call. Negligible but free.

### L16m-13. Default param `bytesPerPixel: 4 | 8 = 4` is misleading when all callers pass it
- **Where:** decode-level.ts L63 stitchTileDecodes signature. Pool L40 stitch.
- **Why:** the default suggests "this is optional and defaults to 4." But after the 16-bit fix landing, all callers compute `bpp` explicitly. The default is dead, and worse — a future caller might rely on the default and ship rgba8 stitching of rgba16 pixels.
- **Fix:** remove the default. Make the parameter mandatory. The default was a 16-bit-introduction-era convenience; it's now a trap.

### L16m-14. Error message strings allocate per throw
- **Where:** `decode-level.ts:35` `throw new Error(\`decode ${ev.code}: ${ev.message}\`);`. Also L43, L104, L132 + pool L235, L386.
- **Why:** template literal concatenation + string allocation. Not hot (throws are rare) but cite L5-7 / L5-10 for the better fix (taxonomy + cause).
- **Fix:** part of the L5-10 PyramidError taxonomy work. Each error becomes `new PyramidError(CODE, msg, { cause })`. The string allocation happens but the construction is more informative.
- **No standalone fix worth doing** — bundle with the taxonomy work.

### L16m-15. Hoist `viewport.w` read out of stitch's tile loop
- **Where:** decode-level L67-81, pool L43-58.
- **Why:** `viewport.w` is read multiple times per tile inside the loop (for `dstStride` calc, `decoded.width === viewport.w` check, `((dy + row) * viewport.w + dx) * bytesPerPixel` offset). Local cache hoists outside.
- **Fix:**
  ```ts
  const vw = viewport.w;
  const vx = viewport.x;
  const vy = viewport.y;
  const dstStride = vw * bytesPerPixel;
  for (const { region, decoded } of parts) {
    const dx = region.x - vx;
    const dy = region.y - vy;
    // ...
    if (decoded.width === vw && dx === 0) { ... }
    else {
      for (let row = 0; row < decoded.height; row++) {
        // ((dy + row) * vw + dx) * bytesPerPixel
        // ...
      }
    }
  }
  ```
- **Cost:** trivial. V8 likely hoists these already (escape analysis), but explicit hoist is portable + readable.

## When NOT to do these

Per CLAUDE.md: "Don't add features, refactor, or introduce abstractions beyond what the task requires." Most of these are NOT what the task requires unless a benchmark says so. Discipline:

1. **Land architectural moves first** (the 5 from L9m-1 + the L1r-9 split).
2. **Measure** with L8m-15 telemetry on a representative workload.
3. **Identify** which micro-ops appear in profile.
4. **Apply only those** with bench-verified delta.
5. **Reject any that don't move the needle.**

Half of the items above will be no-ops because V8 already does the optimization. The OTHER half will be 1-5% wins that compound. The discipline is to know which is which before commit.

## What's NOT in this lens (already covered, repeated for completeness)

- Closure allocations per call → L2-1, L2m-5, L16m-4 cover
- `Promise.all` allocations → L2-3, L6m-4
- Stitch per-row subarray → L6-9, L6m-9
- `idle.includes(h)` O(n) → L2-6, L4m-5
- Set/WeakMap costs → L4m-3
- Worker postMessage clone amplification → L3-4, L6-2, L7m-6
- SAB / Transferable → L6r-1, L11m-9
- Buffer recycling → L6-1, L11sm-4


---

# Lens 17 (master) — Stop Doing Work

Per the user's `docs/LensQuestionlist.md`: Lens 7 "Stop doing work" scores 5/5 on both speed AND efficiency — joint-highest of all 31 lenses. Earlier passes asked *how do we do work faster?* This pass asks: **why is this work happening at all?** Eliminated work is infinitely faster than optimized work.

Each item names work that is happening today, what stops it, and (where applicable) which earlier finding said the same thing in a different framing. The synthesis reveals that ~half the codebase's perf opportunity is in *not running code paths*, not in optimizing them.

### L17m-1. STOP re-parsing the JXTC header per ROI
- **Today:** `decodeTiledViewportPooled` calls `parseJxtcHeader(containerBytes)` on every invocation (L381). Same 32 bytes parsed at every pan frame.
- **Stop by:** parse once at level-open. Carry header on `LevelSource` (cite L1-2, L1-10, L1r-11, L11m-14, L1r-1 DecodePlan).
- **Savings:** small per-call (~µs) × pan frame rate. Compounds.

### L17m-2. STOP re-sorting the level list
- **Today:** `chooseLevelForTarget` allocates `[...levels].sort(...)` per UI event (L13). Manifest is already sorted at ingest.
- **Stop by:** trust the manifest. `levels.find(l => longEdge(l.w, l.h) >= target) ?? levels[levels.length - 1] ?? null` — no spread, no sort (cite L1-3, L2-2).
- **Savings:** O(n log n) → O(n). Plus one allocation eliminated per UI event.

### L17m-3. STOP re-deriving bitsPerSample
- **Today:** manifest carries `bitsPerSample`. LevelSource may carry it. Pool re-derives from JXTC header. Worker hardcodes rgba8. Four layers, three derivations, one wrong.
- **Stop by:** single source = manifest. Flow downstream monotonically (cite L1-6, L1r-11, L5m-12, logic-001 critical).
- **Savings:** correctness fix (eliminates critical 16-bit corruption) + perf via header skip (cite L17m-1).

### L17m-4. STOP cloning container bytes per tile per worker
- **Today:** `worker.postMessage({id, bytes, region})` structured-clones the entire JXTC container per tile. 16 tiles × 4 workers = up to 64 clones (cite L3-4, L6-2, L7m-6).
- **Stop by:** load/decode protocol split. Send container ONCE per worker via `{type:'load', bytesId, bytes}`. Subsequent tiles send only `{id, bytesId, region, format}` (cite L3-4).
- **Stop completely:** SAB — zero clones (cite L6r-1, L11m-9).
- **Savings:** up to ~4 GB clone activity per viewport at 64 MB containers.

### L17m-5. STOP allocating per-call decoder closures
- **Today:** `pickRegionDecoder(bits)` returns a fresh async closure per call (decode-level L47). Pool inline arrow at L390-395 same.
- **Stop by:** module-level `REGION_DECODER_RGBA8`/`REGION_DECODER_RGBA16` singletons. `pickRegionDecoder` just returns the right reference (cite L2-1, L16m-4).
- **Savings:** one closure allocation per call × call rate.

### L17m-6. STOP re-running feature detection
- **Today:** `canUseParallelTileWorkers()` runs every ROI (L399, L108). Likely does `globalThis.crossOriginIsolated` + Worker-existence check.
- **Stop by:** evaluate once at module load. `const CAN_PARALLEL = canUseParallelTileWorkers();` Caller reads the const (cite L16m-9).
- **Savings:** module-load is one-time; per-call disappears.

### L17m-7. STOP re-reading `navigator.hardwareConcurrency`
- **Today:** read at `getOrCreatePool` L309 AND `decodeTiledViewportPooled` L408 — twice per ROI.
- **Stop by:** module-level `const HWC` (cite L16m-3).

### L17m-8. STOP decoding tiles the user can't see
- **Today:** pyramid decodes whatever ROI it's given. Occluded tiles (behind UI, outside frustum, behind closer geometry) decode anyway.
- **Stop by:** `opts.skipTiles?: (tile) => boolean` predicate. Caller knows what's visible; library skips (cite L11g-14).
- **Savings:** in worst case 50%+ of tiles per frame eliminated.

### L17m-9. STOP decoding tiles the user no longer wants
- **Today:** pan invalidates a viewport but in-flight tile decodes continue. Pool slot held; worker churns through obsolete pixels. Caller-side reject is cosmetic.
- **Stop by:** AbortSignal threaded end-to-end (cite L1-4, L4-3, L4m-9, L11g-10). On abort: reject pending Promises, post `{type:'cancel', id}` to workers (cite L3-5), release pool slot.
- **Savings:** every cancelled frame's worth of in-flight WASM work.

### L17m-10. STOP decoding tiles the level pyramid already covers
- **Today:** pan from viewport A to viewport B re-decodes every tile in B's coverage area, including ones that were JUST decoded for A.
- **Stop by:** per-tile pixel cache keyed by `tileId` (cite L3m-8, L11m-10, L11sm-11). Hit: return cached pixels. Miss: decode + store.
- **Savings:** in dense pan-back scenarios, 70-90% tile cache hit. Decode load near-zero.

### L17m-11. STOP doing full-fidelity decode when DC preview suffices
- **Today:** decode targets `'final'` always (`createDecoder({progressionTarget: 'final'})` in decodeWhole; region decoders go to final).
- **Stop by:** progressive decode tier. DC-preview for first paint; full only when user stops panning (cite L3m-2, L12m-4 for the butteraugli analog, L14m-7 for plant ID).
- **Savings:** DC is ~10-50× faster than final. Massive first-paint improvement.

### L17m-12. STOP clamping when region is already in bounds
- **Today:** `Math.min(Math.max(0, region.x), source.width)` runs unconditionally for all four coords. Common case: caller already clamped.
- **Stop by:** early branch — if `region.x >= 0 && region.y >= 0 && region.x + region.w <= W && region.y + region.h <= H`, use the inputs directly (cite L16m-10).
- **Savings:** 4 conditional moves eliminated in the common path.

### L17m-13. STOP `worker.terminate()`-then-respawn on benign errors
- **Today:** any worker `error` event triggers `recycle()` → `destroyHandle()` → `terminate()`. Next acquire pays full WASM re-compile (~10-50ms).
- **Stop by:** error taxonomy from worker (cite L3-9, L5-7, L4m-13). If error code is `JXTC_PARSE` or `BAD_REGION` (worker is fine; caller bug), DO NOT terminate. Only `OOM`/`INTERNAL` warrant respawn.
- **Savings:** worker pool stays warm across spurious caller-side errors.

### L17m-14. STOP `Set`/`Map` ops when a boolean flag suffices
- **Today:** `active: Set<WorkerHandle>`, `idle: WorkerHandle[]` with `includes`/`indexOf`/`splice`. Every release does Set.delete + Array.includes + Array.push. Even with small N, Set has hash overhead.
- **Stop by:** `h.state: 'idle' | 'active' | 'bad' | 'terminated'` enum on the handle (cite L4m-3 state-machine, L2-6 / L4m-5). Membership is the field; no set lookup needed. Acquire walks idle list LIFO; sets state to 'active'.
- **Savings:** O(1) state transitions; eliminates the `includes` scan entirely.

### L17m-15. STOP stitching tiles the caller will discard
- **Today:** stitch runs to completion even when the in-flight viewport has been superseded (because there's no abort).
- **Stop by:** stream-stitch (cite L3m-11, L6-3) + AbortSignal (L4-3). If signal aborted mid-stitch, drop remaining writes; return the partial buffer (or null if caller passed `outBuffer` and we promised to fill it — return early with bytes written count).
- **Savings:** every cancelled stitch's remaining work eliminated.

### L17m-16. STOP re-fetching the JXL container on level switch when cached
- **Today:** caller responsibility — pyramid library never fetches. But the caller pattern often does. Mention for cross-layer coordination.
- **Stop by:** L11m-10 cache hierarchy (in-memory → OPFS → network) extended with content-addressing. Container bytes keyed by hash. Reload from disk; never re-fetch (cite L3m-9 jxl-cache integration).

### L17m-17. STOP allocating tile-grid arrays per call
- **Today:** `tilesOverlappingRegion(W, H, T, viewport)` builds the tile list from scratch every ROI (cite perf-d0e1f2a3, L11m-14).
- **Stop by:** memoize `(W, H, T) → fullTileGrid`. Compute the subset overlapping the viewport as an index range. WeakMap keyed by source identity (cite L11m-14).
- **Savings:** one allocation per ROI eliminated; the grid computation for fixed (W,H,T) runs once per level.

### L17m-18. STOP atan2 for hue (L15 perceptual engine)
- **Today:** hue derivation in apply_tone_math (Lens 15 design) uses `atan2(b, a)`.
- **Stop by:** fast atan2 approximation (Newton-Raphson 2 iterations) or LUT-based hue lookup. atan2 is ~30 cycles; fast approx is ~10. For per-pixel: massive (cite Lens 15's diminishing-returns hue blend).
- **Caveat:** approximation error matters less than people think — psychovisual systems tolerate ~0.5° hue error.

### L17m-19. STOP roundtripping pixels through main heap before GPU upload
- **Today:** caller does `decode → Uint8Array on main heap → new ImageData → putImageData`. Two main-heap touches.
- **Stop by:** direct GPU upload via `device.queue.writeTexture` or `texSubImage2D` from a worker-side OffscreenCanvas (cite L11g-7, L11sm-6).
- **Savings:** one full-buffer memcpy per viewport.

### L17m-20. STOP re-validating the manifest schema after first load
- **Today:** there's no schema validation (cite L5m-11). After L8m-3 / L2m-13 Zod validation lands, the validate cost is paid once per fetch.
- **Stop by:** cache the parsed-and-validated manifest by URL or hash. Subsequent uses return the trusted object.
- **Savings:** Zod is ~100µs per medium manifest; bounded but worth caching.

### L17m-21. STOP redundant clamping inside `tilesOverlappingRegion`
- **Today:** decoder clamps the region at entry; `tilesOverlappingRegion` clamps internally too (cited as performance-d4e5f6a7).
- **Stop by:** trust the caller — if `tilesOverlappingRegion` documents "input region MUST be pre-clamped to (W, H)," it can skip its own clamp. Pairs with L17m-12 in-bounds skip.

### L17m-22. STOP holding obsolete `parts[]` references after stitch completes
- **Today:** `parts[]` (decode-level L114, pool L333) retains decoded tile pixels until the function returns. Per-tile Uint8Arrays held for stitch duration. After stitch, retention drops via scope exit.
- **Stop by:** stream-stitch (cite L6-3, L8m-13, L11g-3) writes tile pixels into outBuffer on arrival AND nulls the slot immediately (`results[idx] = null`). GC reclaims earlier.
- **Savings:** peak memory drops from ~2× viewport to ~1× viewport + one in-flight tile per worker.

### L17m-23. STOP doing speculative work the user might never want
- **Today:** pool prewarm runs `minIdle = 2` workers at first call regardless of whether the user will ever decode a tile. WASM compile happens for nothing if the user immediately closes the tab.
- **Stop by:** lazy prewarm. Spawn first worker on first acquire, not on first call to `getOrCreatePool`. The "warm" comes naturally from worker reuse across the second-and-later tile of the FIRST ROI.
- **Caveat:** trades first-paint latency for steady-state efficiency. Bench. For typical gallery use case (user lands on a thumbnail; viewer auto-opens), prewarm wins. For "user might be passing through" pages, lazy wins. Make it configurable.

### L17m-24. STOP creating the streaming decoder for one-shot decodes
- **Today:** `decodeWhole` creates a streaming `createDecoder` to consume ONE final frame (decode-level L21-44). The streaming machinery is overkill for "give me the final pixels."
- **Stop by:** if jxl-wasm exposes a one-shot `decodeWholeJxl(bytes)` API, use it. Skip events iterator, IIFE drain, push/close/dispose dance.
- **Out-of-scope here** but file with jxl-wasm: streaming machinery is right for progressive UIs; not right for "load + decode + done."

## Pattern that emerges

Across these 24, three meta-patterns dominate:

1. **"Compute once, read many"** — header, hardware concurrency, feature detection, manifest, tile grid, decoder closures. The work has zero entropy across calls; it should not run per call.
2. **"Don't start what will be cancelled"** — pan-stale decodes, occluded tiles, cancelled stitches. The work's value is zero because the user changed their mind.
3. **"Eliminate the redundant copy/clamp/parse"** — clones, in-bounds clamps, validate-twice, derive-twice. The work duplicates an earlier known-correct result.

Each pattern suggests a different fix family:
- (1) → cache + lazy + memoize
- (2) → AbortSignal + skipTiles + visibility
- (3) → single source of truth + parse-don't-validate

## What this lens shows that earlier ones did not

Earlier lenses asked *what can we make faster?* This lens asks *what should not be running?* The synthesis surfaces:

- ~50% of efficiency opportunity is in **elimination**, not optimization.
- Most eliminations are <10 LoC fixes with no behavior risk.
- The same architectural moves (AbortSignal, DecodePlan extract, manifest as trust anchor) enable MULTIPLE eliminations simultaneously — so the prioritization isn't per-elimination, it's per-foundation.
- Foundation priorities (collapse the most eliminations):
  - **(a) DecodePlan extraction** (L1r-1 / L17m-1, L17m-2, L17m-3, L17m-7, L17m-17, L17m-21)
  - **(b) AbortSignal threading** (L4-3 / L17m-8, L17m-9, L17m-15, L17m-22)
  - **(c) Pixel cache** (L3m-8 / L17m-10, L17m-16)
  - **(d) Worker protocol bump** (L3-1 / L3-4 / L17m-4, L17m-11, L17m-13)
  - **(e) Per-handle state enum** (L4m-3 / L17m-14)

Five foundations → 22 eliminations → most of the speed/efficiency budget surfaced across earlier 16 lens passes.


---

# Lens 18 (master) — Move work to where it's cheapest

Frame: every unit of work happens SOMEWHERE — main thread, worker, WASM, network, ingest-time, build-time, module-load-time. Wrong location = paid every call; right location = paid once. This lens asks each piece of work: are you in the cheapest place you could be?

Sites of work (cheap → expensive in typical cost): build-time → ingest-time → module-load-time → pool-init → first-call lazy → per-session → per-call. Moving work LEFT in this list is the goal.

### L18m-1. parseJxtcHeader — runs at decode-time (per ROI); should run at ingest-time
- **Today:** runs per `decodeTiledViewportPooled` invocation. Same 32 bytes, same answer.
- **Move to:** **ingest-time** — pyramid-ingest writes the parsed header values directly into the manifest as level metadata. Reader skips the parse entirely. Cite L17m-1.

### L18m-2. chooseLevelForTarget sort — runs per UI event; should run at ingest-time
- **Today:** `[...levels].sort(...)` on every viewport change. Manifest is pre-sorted by pyramid-ingest.
- **Move to:** **ingest-time** is already done; reader needs to TRUST it. Drop runtime sort, replace with `.find()`. Cite L17m-2.

### L18m-3. bitsPerSample / format derivation — runs at every layer
- **Today:** manifest → LevelSource (strips it on whole-frame!) → pool re-parses → worker hardcodes. Four layers, three derivations.
- **Move to:** **ingest-time + manifest** as the single source. All downstream layers READ, never DERIVE. Cite L17m-3, L5m-12.

### L18m-4. WASM module compile — runs at first worker decode; should run at idle
- **Today:** worker spawns synchronously, `preloadJxlModule()` async; first decode after spawn pays the compile.
- **Move to:** **idle-time** via `requestIdleCallback` for prewarm AND worker-side `{type:'ready'}` signal so pool knows when warm is real. Cite L6r-2, L3-6.

### L18m-5. Feature detection (canUseParallelTileWorkers) — runs per ROI
- **Today:** per-call execution; result is module-load-stable.
- **Move to:** **module-load-time** as a `const`. Single evaluation. Cite L16m-9, L17m-6.

### L18m-6. navigator.hardwareConcurrency read — runs twice per ROI
- **Today:** L309 + L408 in pool, each call.
- **Move to:** **module-load-time** `const HWC`. Cite L16m-3, L17m-7.

### L18m-7. Tile-grid computation — runs per call; should run at level-open
- **Today:** `tilesOverlappingRegion(W, H, T, region)` builds from scratch every call.
- **Move to:** **level-open-time** (or first-touch). `precomputeTileGrid(W, H, T)` → packed Uint32Array of all tile bounds. Per-ROI: just a slice of that array by index range. Cite L11m-14, L17m-17.

### L18m-8. Decoder closure allocation — runs per call
- **Today:** `pickRegionDecoder` returns fresh closure each call.
- **Move to:** **module-load-time** as module-level constants. Cite L16m-4, L17m-5.

### L18m-9. Region clamping — runs in JS even when bytes already crossing to WASM
- **Today:** decode-level + pool both run `Math.min/Math.max` clamp in JS before calling the WASM region decoder.
- **Move to:** **WASM**. The decoder is going to validate the region anyway; do it once at the bridge. Saves a per-call JS roundtrip of validation. Caveat: WASM crossing has its own cost — measure first; may be a tossup.

### L18m-10. Stitch — runs on main JS thread
- **Today:** stitch concatenates per-tile pixels into viewport buffer on main thread (or main when pool fallback).
- **Move to:** **worker-side OffscreenCanvas / GPU**. Each worker writes directly into a shared output (SAB-backed buffer OR GPU texture region). Main thread never touches pixel bytes. Cite L11g-7, L11sm-6, L17m-19.

### L18m-11. Manifest schema validation — runs at every load
- **Today:** none (cite L5m-11). After L8m-3 Zod lands: runs at every manifest fetch.
- **Move to:** **ingest-time + checksum** at runtime. Ingest produces manifest with signature; reader verifies hash (fast). Full schema validation only on hash mismatch. Cite L17m-20.

### L18m-12. ICC apply / color management — currently absent; if added, where?
- **If added in JS:** per-pixel JS loop — slow, defeats SIMD (cite L6m-2 anti-pattern).
- **If added in WASM:** libjxl already has the code; expose via decoder API.
- **If added on GPU:** sampler-time, in shader, free per sample.
- **Move to:** **WASM** for correctness baseline; **GPU shader** for performance optimum when the caller is a GL/GPU consumer. Cite L11g-10, L13m-4.

### L18m-13. Worker termination — currently at user-pan rate (recycle on transient error)
- **Today:** any worker `error` event triggers terminate + respawn (~10-50ms WASM compile).
- **Move to:** **session-end-time**. Common-cause errors don't terminate; only critical ones (cite L17m-13, L4m-13 reason codes).

### L18m-14. chooseLevelForTarget — could even partially move to server
- **Today:** runs in JS per UI event.
- **Move to (radical):** server returns a manifest that includes pre-computed level recommendations for common viewport sizes. Client picks the recommendation by lookup, not compute. For multi-tenant CDN caching, the pre-computation amortizes across all viewers. Saves ~µs per UI event; useful at scale, marginal at single-user.

### L18m-15. Worker spawn — currently lazy on first call; could be earlier OR later
- **Today:** spawn on first `getOrCreatePool` (which is first ROI).
- **Move EARLIER to:** **app-mount via prewarmAsync()** (cite L17m-23 makes the case BOTH ways).
- **Move LATER to:** **first slow tile** — for casual page visits, don't spawn at all.
- **Right answer:** caller-configurable. Pool exposes `prewarm: 'eager' | 'lazy' | 'on-demand'`.


---

# Lens 19 (master) — Change the representation

Frame: a problem and its solution sit inside a chosen data shape. Choose the wrong shape, and the algorithm fights it forever; choose the right one, the algorithm vanishes. This lens asks of each data shape: is this the form that makes the dominant operation trivial?

### L19m-1. Container bytes: `Uint8Array` → `SharedArrayBuffer`-backed view
- **Today:** main-owned ArrayBuffer; postMessage clones into each worker.
- **Change to:** SAB-backed view (when `crossOriginIsolated`). Same Uint8Array API; zero structural-clone cost on fan-out. Cite L6r-1, L11m-9, L17m-4.

### L19m-2. ImageRegion: `{x, y, w, h}` object → packed `Int32Array(4)`
- **Today:** four-property object literal; heap-allocated per call.
- **Change to:** `type Region = Int32Array & { readonly length: 4 };` allocated from a small pool (1 per call site). Field access via `r[0]` / `r[1]` / `r[2]` / `r[3]` with named getters. Engine likes packed integer arrays. Side win: branded — `Viewport` / `TileBounds` / `Roi` are distinct branded types reusing the same shape (cite L5m-14).

### L19m-3. DecodedLevel: minimal `{pixels, width, height}` → multi-channel envelope
- **Today:** flat structure; carries only rgba pixels + dims. ICC, EXIF, depth, multi-spectral all drop.
- **Change to:** `interface DecodedLevel { pixels: Uint8Array; w: number; h: number; format: 'rgba8'|'rgba16'|'rgba32f'; alphaMode: 'straight'|'premultiplied'; iccProfile?: Uint8Array; metadata?: { exif?: Uint8Array; xmp?: string; custom?: Record<string, Uint8Array> }; depth?: Float32Array; bands?: Record<string, TypedArray>; }`. Backwards-compat by making everything except pixels/w/h/format/alphaMode optional. Cite L6m-13, L7m-12, L11m-2, L11m-5, L13m-6, L13m-7.

### L19m-4. WorkerHandle: 4 booleans + idleTimer → state enum + timer
- **Today:** `{worker, idleTimer, terminated, bad}` — implicit state machine (cite L4m-3).
- **Change to:** `{worker, idleTimer, state: 'warm-floor'|'warm-reapable'|'active'|'bad'|'terminated', metrics?, failure?}`. Single mutator. State transitions table. Cite L4m-3, L4m-13, L11m-6.

### L19m-5. Three sets (idle / active / all) → single array with per-handle state field
- **Today:** `all: Set`, `idle: WorkerHandle[]`, `active: Set`, `handleByWorker: WeakMap`. Four membership structures.
- **Change to:** `handles: WorkerHandle[]` with `h.state` field. `idle` becomes a filtered iterator OR a parallel index array. Set ops vanish; flag-update + array push is O(1). Cite L4m-5, L17m-14.

### L19m-6. Pixel buffer format: rgba8 → BC7 / ASTC for GPU residency
- **Today:** rgba8/16 emerges from decode; GPU re-uploads every viewport change.
- **Change to:** transcode JXL→BC7 once at first decode, cache the BC7 blob. GPU samples natively; bandwidth ÷ 4. Cite L11g-10. Out of scope for these 3 files but the architectural seam is `DecodedLevel.format` extending to `'bc7'|'astc4x4'`.

### L19m-7. Tile coordinates: per-image local → global (level, col, row) tileId
- **Today:** `{x, y, w, h}` in image-pixel space; no stable global address.
- **Change to:** `TileId = { level: u8, col: u32, row: u32 }`. Image-space (x,y,w,h) derives from TileId + manifest. Cache, telemetry, error messages all keyed by TileId. Cite L11m-1, L11sm-1, L5m-15.

### L19m-8. Manifest level entries: array → sorted-by-long-edge structure
- **Today:** PyramidLevel[] sorted at ingest by area; chooseLevelForTarget re-sorts by area then selects by longEdge (cite logic-002 bug).
- **Change to:** `PyramidLevel[]` sorted ascending by `longEdge(w, h)` AT INGEST. Reader does `.find()` — no sort, no mismatch. Eliminates logic-002 critical AND L17m-2 efficiency waste in one shape change.

### L19m-9. Tile grid: per-call computed → precomputed packed Uint32Array
- **Today:** `tilesOverlappingRegion` builds the tile list per call.
- **Change to:** `precomputeTileGrid(W, H, T): { bounds: Int32Array, cols: u32, rows: u32 }` once at level-open. Per-ROI: compute index range, slice. Cite L11m-14, L17m-17.

### L19m-10. Bits: `number` (8|16) → discriminated format tag
- **Today:** `bits: 8 | 16` passed around; magic-number-laden (`bppFor`, `bits === 16 ? ... : ...`).
- **Change to:** `Format = 'rgba8' | 'rgba16' | 'rgba32f' | 'gray32f'`. Single token flows manifest → source → pool → worker. Inline the bpp lookup: `BPP_FOR_FORMAT[format]` constant table. Cite L11m-2, L17m-3.

### L19m-11. Worker request: object literal per tile → arena slot
- **Today:** `{id, bytes, region}` allocated per postMessage.
- **Change to:** per-worker arena of pre-allocated request slots. Index into slot, mutate fields, post. Worker reads slot at index. Slot returns to free pool on reply. Saves ~3 allocations/tile + clarifies ownership.
- **Caveat:** structured clone still copies the field values. Doesn't help bytes cost — that's L19m-1 SAB. Helps only the object header.

### L19m-12. nextWorkerId: module-scope counter → instance-scope counter
- **Today:** `let nextWorkerId = 0;` module-mutable, never reset (cite L3-10).
- **Change to:** `this.nextId = 0;` on the PyramidWorkerPool instance. Resets per pool. Combined with L4-2 destroy(), late messages from terminated workers can never collide with new-pool ids.

### L19m-13. Pool stats: ad-hoc → fixed-size circular buffer of typed events
- **Today:** no stats (cite L4m-14, L4m-15).
- **Change to:** `interface PoolEvent { ts: number; type: 'spawn'|'recycle'|'tile-failed'|'fallback'|'prewarm'; ctx: object }`. Ring buffer 256 entries. Telemetry consumer drains periodically. Bounded memory, cheap append.

### L19m-14. LevelSource: tagged union → branded constructors
- **Today:** `{ kind: 'whole', bytes, ... } | { kind: 'tiled', bytes, tileSize, ... }`. Misuse is allowed at construction time (you could construct one with the wrong kind).
- **Change to:** `tiledLevelSource(...)` and `wholeLevelSource(...)` factories return branded types. Constructors validate. Decoders accept the branded type — misuse becomes a type error.

### L19m-15. Cache key: structural object → content-hash string
- **Today:** no cache; L11m-10 future cache could use objects.
- **Change to:** key by hash. `cacheKey({levelId, region, format, fidelity}): string` is a single short string. Engine Map<string, V> is O(1) and lower constant-factor than object-keyed Map. Interns possible.

### L19m-16. Region coords: implicit number → explicit Int32 (where math is integer-pixel)
- **Today:** `region.x` is `number` (f64 in JS). Math is integer-pixel by contract.
- **Change to:** Int32Array packed region (cite L19m-2). When bytes cross to WASM, marshalling Int32 is faster than f64 (no double-precision cost).

### L19m-17. Worker reply pixels: `ArrayBuffer | Uint8Array` (lying) → always `Uint8Array`
- **Today:** type says `ArrayBuffer` but worker sends `Uint8Array` (cite L3-3, logic-004).
- **Change to:** type says `Uint8Array`. Worker side already produces it. Receiver passes it through. No copy.

### L19m-18. chooseLevel return: `PyramidLevel | null` → `PyramidLevel | throw`
- **Today:** null branch is for empty-list (a caller bug); same branch indistinguishable from "no match found" (impossible after fallback).
- **Change to:** throw `RangeError` on empty levels; return `PyramidLevel` (no null). Caller code simplifies. Cite L1r-5.


---

# Lens 20 (master) — Common path brutally simple

Frame: identify the 90%+ case. Strip the code to its essential lines for that case. Push every alternative into a separate path. The common case becomes obvious, fast, and reviewable; the rare cases become explicit.

**The common path for jxl-pyramid (inferred):**
- Caller has a LevelSource (already chose a level via chooseLevelForTarget)
- Wants a tiled ROI for current viewport
- 8-bit (16-bit is rare per user memory)
- Browser case with COOP/COEP → worker pool available
- Workers are warm (already prewarmed)
- Region is in-bounds (caller pre-clamped)
- Promise resolves to Uint8Array on main thread

**What's NOT common:** 16-bit decode, whole-frame decode, single-WASM fallback (only when pool at cap), out-of-bounds region, factory swap, pool destroy.

### L20m-1. Single primary entry — hide pool vs single-WASM choice from caller
- **Today:** caller picks between `decodeLevel`, `decodeTiledViewport`, `decodeTiledViewportPooled` based on knowledge of internals.
- **Simplify to:** `decode(source, region, opts)` — one entry. Internally picks strategy. Caller never thinks about pool. Cite L1r-8, L2m-4, L11sm-3.

### L20m-2. Delete the 95% of decodeWhole that's streaming machinery
- **Today:** `decodeWhole` runs a streaming `createDecoder` + IIFE drain + push + close + dispose. 25 lines for "give me the final pixels."
- **Simplify to:** if jxl-wasm exposes a one-shot whole-frame ROI decode, use it. `decodeWhole = (bytes) => decodeRegion(bytes, {x:0,y:0,w:source.width,h:source.height})`. 1 line. Streaming machinery stays for callers who actually want progressive events (cite L8m-11). Cite L17m-24.

### L20m-3. Strict strategy enum — drop tri-state `parallel?: boolean`
- **Today:** `parallel?: boolean` defaults to "auto if available," which is opaque tri-state semantics.
- **Simplify to:** `strategy: 'auto' | 'single' | 'parallel'` default `'auto'`. Self-documenting at call site. Cite L5m-18.

### L20m-4. Mandatory `bytesPerPixel` — kill the default-4 trap
- **Today:** `bytesPerPixel: 4 | 8 = 4` parameter. Most common case (rgba8) uses default; rare 16-bit must pass 8.
- **Simplify to:** remove default. Always pass it. Eliminates "I forgot, got rgba8 stitch of rgba16 pixels" footgun. Cite L16m-13.

### L20m-5. One stitch function — delete the duplicate
- **Today:** `stitchTileDecodes` (decode-level) and `stitch` (pool) are byte-equivalent.
- **Simplify to:** one shared `stitch(viewport, parts, bpp)` in a shared `decode-core.ts`. Cite L1-1, L1r-1, L9m-6.

### L20m-6. wantParallel rewritten as named helper
- **Today:** `options?.parallel !== false && canUseParallelTileWorkers() && tiles.length > 1 && options?.workerFactory !== undefined` — a four-clause inline expression.
- **Simplify to:** `if (shouldUseParallel(opts, tiles, env)) { ... } else { ... }`. Hot path reads in English. The four-clause check lives behind a name.

### L20m-7. Stream-stitch — delete `parts[]` from common path
- **Today:** decodeTilesParallel collects `results[]`, Promise.all-blocks, then stitch consumes.
- **Simplify to:** as each tile resolves, write into outBuffer at its offset, drop reference. Common path's data flow: `tile arrives → write → discard`. No retention. Cite L6-3, L3m-11, L17m-22.

### L20m-8. Common case skip clamp
- **Today:** clamp 4 coords unconditionally.
- **Simplify to:** if in-bounds, take inputs directly. One conditional. The 4 clamp expressions live behind it for the rare out-of-bounds case. Cite L16m-10, L17m-12.

### L20m-9. pickRegionDecoder inlined — delete the function
- **Today:** function returns one of two closures.
- **Simplify to:** after L16m-4 module-level constants, the inline `format === 'rgba16' ? REGION_DECODER_RGBA16 : REGION_DECODER_RGBA8` at the call site is shorter than the function call. Delete `pickRegionDecoder`. Cite L16m-4.

### L20m-10. Silent catches become explicit
- **Today:** five `catch {}` blocks. Common path never hits them; production failure does, invisibly.
- **Simplify to:** keep the catches BUT replace empty body with `pool.opts.onError?.('scope', err)`. Success path remains a single happy line; failure path is loud. Cite L5-6, L8m-7, L9m-9.

### L20m-11. Decoder closures hoisted — drop the allocator
- **Today:** every decodeTiledViewportPooled allocates a fresh `async (bytes, r) => {...}` if no options.decodeRegion.
- **Simplify to:** module-level `DECODE_REGION_RGBA8`, `DECODE_REGION_RGBA16`. Common path: one reference assignment. Cite L16m-4.

### L20m-12. getOrCreatePool out of hot loop
- **Today:** every decodeTiledViewportPooled call invokes `getOrCreatePool(factory)` — checks singleton, possibly creates.
- **Simplify to:** pool object cached at LevelSession or first-decode-after-prewarm. Hot path receives a `pool` reference, doesn't fetch it. Cite L17m-23.

### L20m-13. Default worker factory bundled with library
- **Today:** caller MUST supply a `workerFactory` for parallel path. Adds boilerplate to common case.
- **Simplify to:** if not supplied, library uses a bundled worker.js shipped in the package. Caller code drops the boilerplate. Workaround for advanced callers: supply a custom factory.

### L20m-14. Region as a 4-int packed struct — flatten field access
- **Today:** `region.x` etc. property reads (4 per pixel in stitch fast path).
- **Simplify to:** when L19m-2 Int32Array region lands, hot path reads `region[0..3]`. Cache locality improves.

### L20m-15. Format flag carried, not derived
- **Today:** at every layer, `bits = source.bitsPerSample ?? 8; bpp = bits === 16 ? 8 : 4`. Two derivations per decode.
- **Simplify to:** `format: PixelFormat` (the L19m-10 enum) carried on `LevelSource`. Constant `BPP_FOR_FORMAT[format]` everywhere. Zero derivations.

### L20m-16. Common-path docstring on the entry function
- **Today:** the entry functions have brief JSDoc.
- **Simplify to:** every public entry's JSDoc EXPLICITLY names the common path: `/** Common path: 8-bit tiled level, in-bounds region, warm pool available. Single line: const pixels = await decode(source, viewport). All other behaviors gated via opts. */`. Sets the reader's expectation.


---

# Lens 21 (master) — Progressive (do less precise work first)

Frame: under user-pressure deadlines (16ms frame, 80ms motion-to-photon, 200ms feels-live), partial results delivered fast beat perfect results delivered late. Earlier coverage: L3m-2 (DC decode), L12m-4 (DC butteraugli), L14m-7 (DC plant ID embedding), L3m-11 (stream-stitch), L8m-11 (consume libjxl pass events). This pass widens "progressive" to *every layer of the pipeline*, not just decode fidelity.

### L21m-1. Progressive prewarm — spawn 1 worker, return immediately; spawn rest in background
- **Today:** `prewarm(N)` spawns N workers in a synchronous loop (decode-level pool L171-179). First user request waits for all spawns to complete.
- **Progressively:** spawn 1, return to caller, spawn 2nd at next idle tick, 3rd, ... up to minIdle. User starts decoding while pool fills. Cite L6r-2.

### L21m-2. Progressive decode tier — DC paint, then full
- **Today:** `decodeWhole` targets `'final'` (decode-level L23). All region decoders are one-shot.
- **Progressively:** two-pass. Pass 1: DC-only decode of all tiles (~10× faster, blurry); paint immediately. Pass 2: full decode same tiles; replace blurry. Cite L3m-2.

### L21m-3. Progressive stitch — write tiles as they arrive
- **Today:** Promise.all waits for ALL tiles; then stitch runs.
- **Progressively:** stream-stitch — each tile resolves → write its pixels into outBuffer at its offset → notify caller. UI re-paints. Cite L3m-11, L8m-13, L17m-22.

### L21m-4. Progressive pyramid neighbor fill
- **Today:** level N is decoded for current viewport; level N±1 aren't touched.
- **Progressively:** after level N is resident, background-decode level N-1 (coarser, smaller) AND level N+1 (finer, for zoom-in). Cancellation primitive (L4-3) drops these on pan-away. Predictive prefetch generalized. Cite L11sm-3.

### L21m-5. Progressive cache warming — decode + cache neighbor tiles
- **Today:** future cache (L11m-10) populates only on demand.
- **Progressively:** after current ROI completes, background-decode adjacent tiles (same level, neighboring grid cells) into cache. Pan in any direction is now a cache hit. Cite L11sm-3.

### L21m-6. Progressive worker availability — start decode on FIRST available worker
- **Today:** `acquire(N)` returns synchronously with however many workers free; caller dispatches all-or-nothing.
- **Progressively:** `acquire` returns a promise that fires for each worker as it becomes available. Caller can start tile 1 the moment worker 1 is free; doesn't block waiting for worker N. Cite L4m-7.

### L21m-7. Progressive confidence — for any matching task, triage at low precision first
- **Today:** N/A in core jxl-pyramid; specialized lenses cited it (L12m-4 butteraugli, L14m-7 plant ID).
- **Pattern:** generalize as `compare<T>(ref, cand, opts: { tier: 'quick' | 'full' })` — return early if `quick` is decisive.

### L21m-8. Progressive color rendering — fast LUT first, full perceptual engine on settle
- **Today:** N/A in current code; Lens 15 perceptual engine.
- **Progressively:** during slider drag, use cached LUT at last-settled values; on slider stop, rebuild LUT at new values. UI feels live; final paint is correct. Cite L15.

### L21m-9. Progressive band decoding (multi-spectral)
- **Today:** N/A; cite L13m-7, L14m-6.
- **Progressively:** decode visible RGB first (the always-needed band); IR/UV/depth in background. User sees the image; auxiliary channels arrive milliseconds later for ID/depth queries.

### L21m-10. Progressive GPU upload — stream texSubImage2D per tile
- **Today:** GPU upload happens after full stitch (cite L11g-7).
- **Progressively:** each tile that arrives uploads its own sub-region via `texSubImage2D(tile-region, pixels)`. GPU has partial texture available for early sampling. Cite L11g-7, L17m-19.

### L21m-11. Progressive reference patch (AR plant ID, photogrammetry NeRF feed)
- **Today:** N/A; cite L14m-7, L13m-10.
- **Progressively:** low-resolution reference first, full-res only if matching is ambiguous. Saves bandwidth + decode time on clear matches.

### L21m-12. Progressive manifest fetch
- **Today:** manifest fetched as one JSON blob.
- **Progressively:** if manifest is large (multi-level + multi-band photogrammetry set), stream the high-level summary first; level details on demand. Caller can render UI before all details load.
- **Caveat:** typical pyramid manifest is small enough this doesn't matter; only relevant for image-set manifests (L13m-1) which can be MB.

### L21m-13. Progressive abort propagation — cancel rest-of-pipeline when first stage settles
- **Today:** AbortSignal (if/when added per L4-3) cancels everything at once.
- **Progressively:** abort cascades stage-by-stage. Pan invalidates outer viewport → cancel STITCH first (cheap), then DECODE (medium), then ACQUIRE (slow). Lets earlier stages drain gracefully without forcing worker termination.

### L21m-14. Progressive worker count — adapt to observed decode rate
- **Today:** maxSize fixed at min(hwc, 8).
- **Progressively:** start with 1 worker; if decode rate exceeds threshold, spawn 2nd; ... up to cap. Background-tab visibilitychange → drop to 0 (cite L6r-3). Cite L11sm-9.

### L21m-15. Progressive observation — telemetry sample rate adaptive
- **Today:** N/A (no telemetry, cite L5-11).
- **Progressively:** sample 100% of events for first 60s after deploy; drop to 1% sample rate in steady state. Catches early bugs at high resolution; cheap in long-tail.


---

# Lens 22 (master) — Batch everything

Frame: fixed costs amortize. Per-call cost × N calls is N × overhead; per-batch cost × 1 batch is 1 × overhead. Every operation in this codebase is currently per-call; this pass surveys what to batch.

Earlier coverage: L7m-2 (batched WASM ROI call), L7m-9 (batched worker dispatch).

### L22m-1. Batch worker requests — one postMessage per N tiles
- **Today:** `worker.postMessage({id, bytes, region})` per tile. 16 tiles = 16 postMessage calls (plus 16 structured-clone passes after L17m-4 fix).
- **Batch:** `worker.postMessage({type:'decodeBatch', bytesId, regions: ImageRegion[], format, baseId})`. One IPC; worker decodes N tiles serially within its WASM session. Worker can post per-tile replies incrementally OR one batched reply. Cite L7m-9, L11sm-3.

### L22m-2. Batch worker replies — single transfer list with N buffers
- **Today:** one reply per tile, each with transfer list.
- **Batch:** worker collects N decoded pixel buffers; sends ONE reply `{type:'decodeBatchReply', baseId, results: Array<{id, pixels, w, h, error?}>}` with combined transfer list `[buf1, buf2, ..., bufN]`. Receiver dispatches per-tile.
- **Tradeoff:** removes message ceremony BUT delays first paint until batch completes. Mitigated by L21m-3 stream-stitch + small batches.

### L22m-3. Batch WASM calls — `decodeMultipleROIs(bytes, regions[])`
- **Today:** one WASM call per tile (cite L7m-1 ~50-200µs marshal cost × N).
- **Batch:** jxl-wasm exposes a multi-ROI API; libjxl can share parse state across ROIs. Out of scope here; file with jxl-wasm. Cite L7m-2.

### L22m-4. Batch stitch row writes — pack multiple full-stride rows per `set()` call
- **Today:** even fast-path stitch does one `pixels.set(decoded.pixels, dy * dstStride)` per tile (good — already batched at tile granularity).
- **Batch:** for the row-by-row fallback path, if N consecutive rows have same srcStride and dstStride, batch them via a single `pixels.set(decoded.pixels.subarray(srcOff, srcOff + N*srcStride), dstOff)`. Engine memmove paths the same regardless; one call vs N calls saves loop overhead. Cite L6m-9.

### L22m-5. Batch cache get/set
- **Today:** future cache (L11m-10) — per-tile get/set.
- **Batch:** `cache.getMany(keys[]) → Map<key, V>` and `cache.setMany(entries[])`. OPFS file handles open-once for the batch. Cite L11m-10.

### L22m-6. Batch manifest fetches across galleries
- **Today:** library doesn't fetch (caller's job).
- **Batch:** if caller has many galleries, batch their manifest URLs over HTTP/2 multiplex. Library can expose `prefetchManifests(urls[]) → Promise<Map<url, Manifest>>` if it owns fetch policy.

### L22m-7. Batch pool acquire — already done, note as positive
- **Today:** `acquire(N)` returns up to N workers in one call (pool L186-214). Good.
- **Note:** positive pattern. Document as the model for L22m-1/L22m-5.

### L22m-8. Batch abort — one signal cancels N in-flight
- **Today:** AbortSignal (when added per L4-3) cancels everything at once.
- **Batch:** `signal.abort()` triggers single `controller.abort()`; all observers fire. Inherent in the AbortSignal model. Plus: a stream-id grouping so one `streamController.abort()` cancels all decodes for `streamId='gallery-1'` without affecting `streamId='gallery-2'`. Cite L4m-9, L11sm-13.

### L22m-9. Batch telemetry emission — flush every K ms or N events
- **Today:** no telemetry; future per-event emission would flood the network.
- **Batch:** ring buffer accumulates events; flushed when buffer reaches threshold OR every 1000ms. Caller's handler receives `events: PoolEvent[]`. Cite L8m-15, L19m-13.

### L22m-10. Batch logging — coalesce by message window
- **Today:** no logging; future per-call logs would flood console.
- **Batch:** if same scope+message fires N times in a 100ms window, emit one log entry with `{count, firstTs, lastTs}`. Cite L5-11, L9m-9.

### L22m-11. Batch GPU upload — multi-region `writeTexture`
- **Today:** N/A; cite L11g-7 single-region upload per tile.
- **Batch:** WebGPU's `queue.writeTexture` supports a single command writing many sub-regions if encoded as a multi-row layout. Group all decoded tiles for one frame into one upload command. Pairs with L21m-10 progressive (the two can coexist: stream early tiles individually, batch the tail).

### L22m-12. Batch ID generation — reserve range per batch
- **Today:** `nextWorkerId++` per tile (cite L3-10).
- **Batch:** after L19m-12 instance-scoped counter, reserve a range per dispatch: `const baseId = pool.reserveIds(N); for each tile: id = baseId + i`. Saves N atomic increments; deterministic id range per batch eases debugging.

### L22m-13. Batch reference-image load (photogrammetry, AR plant ID)
- **Today:** N/A; cite L13m-13, L14m-1.
- **Batch:** `pool.loadReferences(refs[]) → Promise<ReferenceHandle[]>` warms N workers with N reference images via batched load messages. Pairs with L13m-13 sticky reference handles.

### L22m-14. Batch tile-state updates (virtual texture page table)
- **Today:** N/A; cite L11sm-2.
- **Batch:** when M tiles update state same frame, single page-table write flushes all. The page table is a Uint32Array; bulk update is one `subarray.set()` call.

### L22m-15. Batch level-pick across viewports (multi-window)
- **Today:** `chooseLevelForTarget` called per UI event.
- **Batch:** if app has N concurrent viewports (multi-pane lightbox, photogrammetry compare, AR multi-target), batch the picks: `chooseLevelsForTargets(levels, targets[]) → PyramidLevel[]`. Sort + binary search once across all targets. Cite L11sm-2 page-table approach.

### L22m-16. Batch manifest validation — parse N entries in one Zod pass
- **Today:** no validation; future Zod per-call would parse each entry separately.
- **Batch:** Zod schema parses the whole manifest in one pass; per-entry validation is folded into the array schema. Already idiomatic Zod — note as design constraint, not new work.

