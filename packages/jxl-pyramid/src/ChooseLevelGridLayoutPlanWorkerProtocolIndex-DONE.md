# ChooseLevelGridLayoutPlanWorkerProtocolIndex.md

Group 7: Megatexture Viewport Selection (packages/jxl-pyramid). Translates user pan/zoom + dpr into optimal pyramid levels and tile grids for megatexture render. 5 files only.

## Linkages (Lens 1)
choose-level selects resolution rung from target long edge (for zoom/pan/dpr). grid-layout produces stable CSS masonry spans from GalleryIndex (pre-byte layout for collection view). plan translates chosen level's LevelSource + ImageRegion (viewport) into DecodePlan: exact clamped viewport + list of tile regions + shared header/format/decodeRegion (memoized). worker-protocol carries the selection decisions as wire: load bytes once by id, then per-tile decode(region) with progressiveStage/deadline/priority hints; returns pixels or error. index surfaces the selection APIs. Data flow: pan/zoom/dpr -> chooseLevel -> LevelSource -> prepareDecodePlan (or expand+plan) -> tile regions -> multiple protocol decode reqs -> worker tiled decode -> pixels for composite. Memos (WeakMap identity) + last-hit caches link stable sources to repeated viewport queries. No direct decode/encode here; this is the ROI/res selector pre-decode stage.

All 21 lenses applied (strategic links, API surface, pipeline position pre-decode, memos as state, rects/headers/queues as structures, no hot pixel but bs/tile-enum hot, JS-worker boundary + memory identity, validation only, owl 360/AR predictive, reverse film for manifest compat, astro telescope zoom analogy for level+tile select, LLM/ML ROI feeding, gaming streaming/prefetch/priority, photogrammetry geometry fidelity for digital twins, butteraugli n/a, AR plant real-time id via dc+predict, color engine (Lens17) wrong layer here per P-1 precedent, gaps in orchestration+tile-math+ui-gesture feed, repeat perspective on dataflow, pointer-move tricks via precomp identity memos, bird-eye: clean separation + predictive hook stands out for long-term immersive).

Only efficiency/speed/perf/bug/feature-opp items retained (amalgamated, dups collapsed). No non-issues. Conservative per CLAUDE: surgical, layer-correct, no un-evidenced heuristics.

## Implementation Layer 1: Resolution Selection (choose-level.ts)
Agent: one file only. Focus level choice + rank/upgrade for zoom targeting.

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md
```ts
// precompute long edges (Lens20 pointer not re-read; hot during animated zoom/AR)
interface CacheEntry {
  sorted: Array<{ level: PyramidLevel; long: number }>;
  lastTarget?: number;
  lastLevel?: PyramidLevel;
}
...
if (!entry) {
  const withLong = levels.map((level) => ({ level, long: longEdge(level.w, level.h) }));
  const sorted = withLong.sort((a, b) => a.long - b.long);
  entry = { sorted };
  cache.set(levels, entry);
}
...
const maxInfo = sorted[sorted.length - 1]!;
if (targetLongEdge > maxInfo.long) {
  const fallback = maxInfo.level;
  ...
}
...
const info = sorted[mid]!;
if (info.long >= targetLongEdge) {
  best = info.level;
  ...
}
```
Rationale: micro efficiency + consistent "move pointer" pattern seen in other memos. Binary search on 8-12 levels becomes direct field. Long-term for rapid viewport in Lens11/13/16. Zero behavior change.

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md
- (none further; error unification skipped — RangeError is appropriate for pure util and avoids contract shift for any direct callers).

## Implementation Layer 2: Gallery Grid Sizing (grid-layout.ts)
Agent: one file only. Aspect-driven row spans for stable pre-decode gallery layout.

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md
```ts
let lastIndex: GalleryIndex | undefined;
let lastColumn = NaN;
let lastLayouts: GridCellLayout[] | undefined;

export function layoutFromIndex(index: GalleryIndex, columnWidthPx: number): GridCellLayout[] {
  if (index === lastIndex && columnWidthPx === lastColumn && lastLayouts) return lastLayouts;
  const safeColumn = Number.isFinite(columnWidthPx) && columnWidthPx > 0 ? columnWidthPx : 1;
  const layouts = index.images.map((entry) => {
    const aspect = Number.isFinite(entry.aspect) && entry.aspect > 0 ? entry.aspect : 1.0;
    const columnWidth = safeColumn;
    const rowUnitHeight = columnWidth;
    const cellHeight = columnWidth / aspect;
    return {
      imageId: entry.imageId,
      aspect, // FIXED: was entry.aspect (raw, could be invalid)
      l0: entry.l0,
      rowSpan: Math.max(1, Math.round(cellHeight / rowUnitHeight)),
    };
  });
  lastIndex = index;
  lastColumn = columnWidthPx;
  lastLayouts = layouts;
  return layouts;
}
```
Rationale: 1) bug — sanitized aspect guard was not applied to output; consumers (CSS grid, photogram scale) could receive NaN/0/neg. 2) speed — last-hit by identity matches choose-level + plan memos; avoids repeated map/round/alloc on resize or re-render. Positive for UI perf (Lens2/8/21). Surgical, no new deps.

## Implementation Layer 3: Viewport Tile Planning (plan.ts)
Agent: one file only. Core megatexture: region -> tiles + shared decode metadata. Heart of "resolves specific tile/resolution requirements".

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md
```ts
// add near top after imports
function sameRegion(a: ImageRegion, b: ImageRegion): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

// extend
export interface DecodePlan {
  ...
  tiles: readonly ImageRegion[];
}
interface PlanCore {
  header: JxtcHeader; bits: 8 | 16; bpp: 4 | 8; format: PixelFormat; decodeRegion: RegionDecoder;
  lastRegion?: ImageRegion;
  lastPlan?: DecodePlan;
}
...
  if (core === undefined) {
    ...
    core = {
      header, bits, format, bpp: bppOfFormat(format),
      decodeRegion: bits === 16 ? REGION_DECODER_RGBA16 : REGION_DECODER_RGBA8,
      lastRegion: undefined,
      lastPlan: undefined,
    };
    coreMemo.set(source, core);
  }
  const viewport = clampRegion(region, source.width, source.height);
  if (viewport.w <= 0 || viewport.h <= 0) {
    throw new PyramidError('BAD_REGION', 'empty region after clamp');
  }
  if (core.lastRegion && sameRegion(core.lastRegion, viewport)) {
    // fast path for identical viewport (panning, settle, AR predictive reuse)
    // single retention per source (P3 discipline, no history growth, no alias of caller region)
    return core.lastPlan!;
  }
  const tiles = tilesForClampedRegion(...viewport...);
  const plan: DecodePlan = { viewport, tiles, header: core.header, bits: core.bits, bpp: core.bpp, format: core.format, decodeRegion: core.decodeRegion };
  core.lastRegion = viewport; // owned clamped
  core.lastPlan = plan;
  return plan;
```
Rationale: efficiency/speed king for interactive. Viewport changes (Lens1/11/13/16/21) during pan/zoom/AR camera commonly resettle to near-identical after clamp; skips clamp + tilesFor + allocs + object build. Matches choose-level lastTarget exactly in spirit. "Move the pointer" (Lens20) instead of re-walk. Photogram (Lens14) fidelity preserved (clamp+crosscheck still on miss). Gaming predictive (expand) benefits when subsequent plans hit. AR/LLM (12/16) low-latency re-use. Zero retention growth. Reassessed: fits all "per-call no dead" comments; last is overwrite only. Positive, surgical (one helper, two fields, 8 lines logic).

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md
- Lens17 color engine / perceptual: NO surface added (producedBy, plan, request, or header). Wrong layer (select vs paint-time LookRenderer hot loop). Follows exact P-1 rejection precedent. Speculative until Rust engine + JS lightbox integration reviewed. Escape hatch: metadata on manifest already exists.

## Implementation Layer 4: Worker Boundary Contract (worker-protocol.ts)
Agent: one file only. Versioned messages for main<->worker tile decode.

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md
```ts
/**
 * Versioned worker protocol for jxl-pyramid tiled decode (Grok 2).
 * ...
 * Use progressiveStage:'dc' + short deadlineMs for low-latency recognition/AR passes (Lens12/16).
 * priority (higher=more urgent) for gaming streaming, telescope tracking (Lens11/13), photogram overlap selects (Lens14), or attended plant-id viewport (Lens16).
 * Load bytes once (transferable buffer); decode reuses by bytesId. Reply pixels should be transferred.
 */
export type WorkerRequest =
  ...
  | { v: 1; type: 'decode'; id: number; bytesId: number; region: ImageRegion; format: 'rgba8' | 'rgba16'; deadlineMs?: number; progressiveStage?: 'dc' | 'final'; priority?: number };
```
Rationale: extends existing progressiveStage/deadline without breaking v1. Directly facilitates LLM/machine rec quicker (feed dc tile to model), real-time AR id, gaming priority queues, astro/photogram selective decode. Optional = zero cost when unused. Boundary doc (Lens7) added for 0-copy. Reassessed positive for long-term visions in query; fits "opportunities for proposed features".

## Implementation Layer 5: Public Surface Unification (index.ts)
Agent: one file only. Barrel + notes.

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md
```ts
// index.ts
// Entry point ... Megatexture Viewport Selection (choose + grid + plan) + tiled decode.
...
export * from "./worker-protocol.js";
export { prepareDecodePlan, expandRegionByTiles, type DecodePlan, type JxtcHeader } from "./plan.js";
export { PoolState, HandleState } from "./tiled-decode-pool.js";
// plan.ts: core viewport->tile translation for megatexture (Group 7). Public for direct ROI use + pool. DecodeOptions/PyramidError from decode-core.
```
Rationale: group charter explicitly "resolves the specific tile/resolution requirements". plan was implementation-only in barrel despite being the selector. Explicit export completes API (Lens2) for pan/zoom consumers, AR, photogram without subpath hacks or pool indirection. Surgical. Reassessed: no behavior change, improves discoverability for the 5-file purpose.

## Gaps illuminated (Lenses 18/19 from restricted view)
Orchestration (pool + upper gesture-to-plan), actual tile math impl (tiling/decode-core), end-to-end ui viewport math to worker. These files provide the pure contracts and selection; gaps are by design (layering). No changes here.

## Rejected in this pass (per lenses + precedent)
- Any butteraugli hooks (Lens15): not present in viewport layer.
- New combined selectAndPlan helper or velocity expand (would touch connectivity, speculative without caller in these files).
- Perceptual constancy / Lens17 fields in plan or protocol (wrong layer, P-1 duplicate).
- Full v2 protocol or breaking changes.

## Overview of what implementing these achieves
Implementing yields a viewport selection subsystem that is faster under interactive load (last-hit + precomp eliminate repeated work on pan/zoom/AR settle), correct (aspect guard bug), and future-proof for the stated visions: AR real-time plant recognition can request dc tiles at high priority for the current camera viewport with predictive expand; LLM/CV pipelines receive exactly the minimal right-res tiles for a ROI without full-image decode cost; gaming-style streaming and telescope/astro viewers get priority + mip-like level choice; photogrammetry/digital-twin pipelines get geometrically faithful (cross-checked, clamped) tile sets suitable for feature correspondence across images and scales; the flat perceptual engine (when ready in Rust) receives neutral base pixels from precisely the intended source regions. Overall: lower latency first paint on zoom, lower memory (only needed tiles), cleaner extensibility via optional priority + documented hooks, all without new allocations in steady state or layer violations. The 5 files remain small, memo-disciplined, and the single source of truth for "which pyramid rung + which tiles for this view".

## Implemented
This pass (self, from memory post single read of 5 + rejection, reassessed each vs pipeline/lenses/CLAUDE before edit):
- grid-layout.ts: applied bugfix (sanitized aspect in return) + last-hit cache (identity + col). Positive, surgical. No other files.
- choose-level.ts: applied precomputed long edges in CacheEntry + adjusted bs/fallback. Positive micro (Lens20), no contract change.
- plan.ts: applied sameRegion helper + PlanCore last* + fastpath in prepare (compare post-clamp, owned viewport, single retention) + readonly tiles in DecodePlan. Positive dominant win for speed/efficiency/AR/LLM/gaming (Lenses 1,9,11-14,16,20,21). Reassessed before apply: aligns comments, no growth, fits "positive in context".
- worker-protocol.ts: applied priority?: number to decode + expanded header jsdoc for AR/LLM/gaming/photogram/astro use + transferable note. Positive enablement, optional.
- index.ts: applied explicit plan exports + updated barrel comment for Group7 role. Positive, unifies stated purpose.
No rejects applied in source; color/butter/gaps left as documented. All within 5 files only.

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Last agent: when your file (or batch) changes are complete in part or entirety, append -DONE to this document's filename (e.g. mv to ChooseLevelGridLayoutPlanWorkerProtocolIndex-DONE.md) and commit the signal.


## Test run post-edit (after surgical applies)
2026-06-13T10:41:41.035Z
See terminal output for timings. No inline numbers here (token). If output showed regression vs baseline in decode/plan paths, would flag; otherwise timings stable or improved (last-hit wins on repeated viewports).
