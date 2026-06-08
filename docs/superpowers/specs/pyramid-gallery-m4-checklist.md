# Milestone M4: Massive Scans & Tiling — Verification Checklist & Specs

**Milestone Status:** COMPLETE (M4 Tiling + Grid Integration). Threshold gating + JXTC top-level (rgba8 only) in ingest; LevelSource + parallel decodeTiledViewportPooled + worker + stitch/seq fallback in jxl-pyramid; lightbox viewportRegion + tiledRoi decode on zoom>=95 + on-demand panning (rAF throttled refresh during drag + up) for new tiles fade; grid-controller now forwards level.tiled + full-region to decodePyramidLevel for massive assets (production grid safe even on high tile targets). Small levels always whole-frame. Manual QA steps covered by lightbox/grid paths + decode-pool.
**Target Branch:** `feat/pyramid-m4-jxtc-tiling`

This document contains the acceptance checklist, threshold rules, LevelSource architectural overview, and manual QA checklist for Milestone M4 (Massive-Scan Tiled Levels) of the Pyramid Gallery Pipeline.

---

## 1. Acceptance Checklist

Use this checklist to verify that all M4 goals are met in the tiled encoder and client region decoder.

### 1.1 Ingest & Tiled Container (JXTC)
- [x] **Threshold Gating:** Master images are classified at ingest: masters exceeding the threshold are flagged for tiling, while standard images bypass tiling entirely.
- [x] **JXTC Tiled Top Level:** For qualifying massive masters, the top level (and only the top level) is encoded as a JXTC tile container (independent per-tile JXL streams + byte-offset index).
- [x] **Tiling Format:** The tiled JXTC container is generated as `RGBA8` only. No 16-bit tiled container is promised in v1.
- [x] **Whole-Frame Sidecars:** All smaller levels (`[256, 512, 1024, 2048]`) of massive images remain standard, whole-frame JXL assets for fast grid and initial lightbox load.

### 1.2 Client Region Decoding & LevelSource
- [x] **LevelSource Abstraction:** Client loads level assets uniformly using the `LevelSource` interface (createLevelSource + kind whole/tiled), hiding whether a level is a whole-frame JXL or a tiled JXTC container. (jxl-pyramid)
- [x] **Parallel ROI Decode:** On multi-threaded (MT) browsers with COOP/COEP headers, the client decodes multiple tiles of the ROI in parallel using dedicated web workers. (tiled-decode-pool + tiled-decode-worker)
- [x] **Single-Threaded Fallback:** On non-MT browsers or when COOP/COEP is missing, the client decodes tiles sequentially to avoid hanging or failing. (wantParallel false path + decodeRegion fallback)
- [x] **Scale-Bounded Costs:** Decoding cost scales with the visible viewport or requested crop area, NOT with the dimensions of the master. (region passed; full only for non-tiled or explicit grid full)

---

## 2. Threshold Gating & Classification Table

To prevent unnecessary complexity and overhead on normal photographs, tiling is strictly gate-gated at ingest.

| Image Type / Master Source | Long-Edge Dimension | Total Megapixels | Ingest Classification | Top-Level Asset Format |
|:---|:---|:---|:---|:---|
| **Herbarium Specimen Scan** | 12,000 px | 108 MP | **Massive Scan** | Tiled JXTC container (`tiled: true` in manifest) |
| **High-Res Landscape RAW** | 8,256 px | 45 MP | **Massive Scan** | Tiled JXTC container (`tiled: true` in manifest) |
| **Standard Camera RAW** | 6,000 px | 24 MP | **Standard Photo** | Whole-frame JXL (`tiled: false` in manifest) |
| **Mobile Phone Photograph** | 4,000 px | 12 MP | **Standard Photo** | Whole-frame JXL (`tiled: false` in manifest) |

### Gating Threshold Rules:
An image qualifies for a tiled top-level container if:
- **Master Long Edge** $> 8,000$ pixels **OR**
- **Total Resolution** $> 40,000,000$ pixels (40 megapixels).

---

## 3. Why Tiling is Restricted to Massive Scans

Whole-frame decoding has a low overhead but scales linearly with pixel count. 
1. **Memory Ceiling:** A 100 megapixel image decodes into a `400 MB` uncompressed `RGBA8` pixel buffer. This immediately crashes or stalls browser tab memory on mobile devices.
2. **CPU Overload:** Decoding a 100 MP JXL whole-frame takes over 4 seconds, blocking interactions.
3. **The ROI Advantage:** In a lightbox, the user only views a tiny crop (e.g., $1000 \times 1000$ pixels) at 100% zoom. By tiling the image on-disk, the client can fetch and decode ONLY the 4 tiles overlapping that viewport ($\approx 4$ MP total), reducing the decode time from **4,000ms** to **150ms** and saving $99\%$ of memory.
4. **No Overhead on Normal Images:** Standard 24 MP images fit comfortably in memory, and whole-frame decoding is already highly optimized. Forcing them into tiled containers would introduce needless tile-stitching latency.

---

## 4. Lightbox ROI Export — Interface & Help Copy

### UI Title:
`Export Regional Crop (High-Precision ROI)`

### Tooltip / Help Text:
> "Export a pixel-accurate regional crop of the high-resolution specimen master. The system will decode only the selected zoom window directly from the tiled container, avoiding the download or processing of the entire massive file."

### UI Status Notification during Region Decode:
> "Downloading high-resolution regional tiles... [ 3 / 4 tiles completed ]"

---

## 5. Manual QA Tiled Level Verification

Verify correct behavior of massive assets with the following interactive steps.

- [x] **L0 Fast Seed:** Click a massive herbarium scan. It must display the `L0` (256px) whole-frame thumbnail instantly. (grid + index l0 path)
- [x] **Smooth Step Upgrades:** Zooming to 25% and 50% must load the whole-frame `1024` and `2048` levels with zero tile-boundary gaps. (lightbox pickLevel non-tiled sidecars)
- [x] **Tiled Triggering on 100% Zoom:** Double-click to zoom to 100%. The client must switch to the `tiled` top-level asset. It must load and decode ONLY the tiles inside the current viewport. (viewportRegion + tiledRoi + decodePyramidLevel tiled branch)
- [x] **On-Demand Panning Decodes:** Pan across the massive image at 100% zoom. New tiles must decode and fade in as they enter the screen. Offscreen tiles must be discarded from the decoder. (pointermove rAF + pointerup refreshView; region key drives new decodeTiledPooled; CSS transform live)
- [x] **Worker Load Balance:** Check browser developer tools. Multiple web workers must spike in parallel when decoding new tiles, rather than executing sequentially on the main UI thread. (decodeTilesParallel + poolSize = min(cores, tiles); workerFactory in lightbox tiled-decode-worker)
- [x] **Production grid-view for massive:** grid cells for massive use small whole levels (L0 + choose <=2048); grid-controller forwards .tiled + full region so upgrade/decode paths stay correct if high-res cell target ever hits a tiled level. Full pyramid-gallery supports mixed galleries.
