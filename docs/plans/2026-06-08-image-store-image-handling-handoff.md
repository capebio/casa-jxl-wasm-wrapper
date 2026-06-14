# Handoff — ImageStore + Image Handling (S1 -> S3 -> S2)

**Date:** 2026-06-08
**Branch:** feat/fast-jpeg
**Context:** Post M0 native+ WASM pyramid primitives, M1 ingest partial + grid+lightbox demo in web/pyramid-gallery/. Duplicated fetchManifest/fetchLevelBytes + manifest load logic in grid-controller.js and pyramid-lightbox.js. Goal: central ImageStore for acquisition (manifests + level bytes via JxlCacheBrowser + fetch), eliminate dupe, keep scheduler/cache/dedup invariants.

## Order: S1 -> S3 -> S2
Execute in strict sequence to validate API before grid (which is simpler caller).

### S1: Core ImageStore (image handling abstraction)
- New file: `web/pyramid-gallery/image-store.js`
- `export function createImageStore({ cache, galleryBase })`
  - `async getManifest(imageId): Promise<PyramidManifest>` — in-mem cache + fetch `images/{id}/manifest.json`; throw on !ok
  - `async getLevelBytes(contenthash): Promise<Uint8Array>` — `level:${hash}` via cache.get/set (ArrayBuffer), else fetch `levels/{hash}.jxl`; same error shape
  - `clearManifest(imageId)`, `clearAll()` for invalidation on preset/16bit flip (mirrors existing screenCache clears)
  - Import type: `import type { PyramidManifest } from '../../packages/jxl-pyramid/dist/manifest.js'` (or .js per node style)
  - Pure; no ctx, no decode. Content-addressed + cache reuse per design §5, §9.
- Add to pyramid-gallery importmap if needed? No (relative local import).
- Guard: no new backpressure; no per-image sourceKey changes (contenthash stays).

### S3: Wire Lightbox (complex consumer first)
- Edit `web/lightbox/pyramid-lightbox.js`
- Accept `imageStore` in createPyramidLightbox opts (alongside or replacing cache+galleryBase).
- Delete/replace: fetchLevelBytes, loadManifest with delegates to `imageStore.get*`
- In open: `state.manifest = await imageStore.getManifest(imageId); ...`
- All `await fetchLevelBytes(...)` → `await imageStore.getLevelBytes(...)`
- Keep internal screenCache, state, paint, refreshView, exportRoi, 16bit toggle, ROI, histogram, adjustments. They clear screenCache on changes (store clear optional but call clearManifest if image changes).
- Update callers later; preserve return shape.
- No change to decode paths (still use pyramid-decode + decodePyramidLevel/Region).

### S2: Wire Grid (simpler consumer second)
- Edit `web/pyramid-gallery/grid-controller.js`
- Accept `imageStore` (drop or keep galleryBase/cache if exposed; prefer store).
- Replace fetchManifest/fetchLevelBytes with store calls.
- decodeForLevel uses `imageStore.getLevelBytes(level.contenthash)`
- paintCell uses `imageStore.getManifest(imageId)`
- Keep: manifests? no, paintedRank, inflight, choose/shouldUpgrade (from jxl-pyramid), IntersectionObserver logic, monotonic, prefetch ring, abort, paintCanvas.
- Return shape: can drop fetchManifest from export if unused, or proxy `fetchManifest: imageStore.getManifest` for compat (current external use is zero).
- Update observe/paint paths.

### Wiring + Glue (during/after S3/S2)
- Edit `web/pyramid-gallery/pyramid-gallery.js`
- `import { createImageStore } from './image-store.js';`
- After `const cache = ...; await cache.init();`
- `const imageStore = createImageStore({ cache, galleryBase: ... wait, construct after load? No: create with base once url known, or recreate on loadGallery.`
- Pass `imageStore` to `createGridController({ ctx, cache?, imageStore, galleryBase?, ... })` and to `createPyramidLightbox({ ctx, cache?, imageStore, ... })`
- On loadGallery(base): can keep one store or new per base (store holds base).
- Remove any remaining direct fetches for manifests/levels in gallery root.

### Tests + Verification
- Edit `web/pyramid-gallery/pyramid-gallery.test.js`
- Add asserts: galleryJs + gridJs + lightboxJs contain 'image-store' or 'getManifest'/'getLevelBytes' or 'createImageStore'.
- Keep existing shape checks (sourceKey etc still true; fetch index remains in gallery.js for index.json).
- Run: `bun test web/pyramid-gallery/pyramid-gallery.test.js`
- Lint/type: no ts here (plain js demo); visual via page if serve.
- No dupe code left: grep -r fetchLevelBytes or inline manifest fetch in pyramid* should only hit store or index fetch.
- Update any M1 status in FEATURE_PARITY_MATRIX.md, TauriWasmParity.md if grid is M1 client slice.
- Commit only the delta (no node_modules, no dist unless forced by build).

## Success Criteria
- Grid + lightbox both consume ImageStore; zero duplicated fetch+cache level/manifest logic.
- Behavior identical: L0 seed, monotonic upgrade, DPR choose, 16bit toggle+WebGL+export, crossfade, histogram, cancel on scroll, cache hits, error shapes.
- Tests pass (source shape + any runtime).
- Store is thin acquisition layer only — decode/scheduler/cache policy untouched (CLAUDE.md layer rule).
- Handoff doc written at requested path; todos closed.

Refs: docs/superpowers/specs/2026-06-07-pyramid-gallery-design.md (esp §5 storage, §6 grid, §7 lightbox, §9 reuse), web/pyramid-gallery/*, packages/jxl-pyramid/src/* (choose-level, manifest), CLAUDE.md (no new dedup/backpressure in session/facade; cache content-agnostic).

Handoff payload: image-store.js + 3 edited .js + updated test + this doc + parity note.
Ready for review + next M (lightbox polish or M2).
