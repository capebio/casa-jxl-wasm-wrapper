# Pyramid Gallery Pipeline — Documentation & Usage Draft

**Specification Status:** Approved Design
**Component:** `pyramid-gallery` / `pyramid-ingest`
**Milestone Status:** M0 Primers Completed; M1-M4 Pipeline Active

This document contains the user-facing README sections, topology diagrams, command syntax placeholders, on-disk directory layouts, and manifest/index explanations for the Pyramid Gallery Pipeline.

---

## 1. Executive Topology Overview

The Pyramid Gallery Pipeline is a high-performance, static-first, hybrid image delivery solution. 
- **Decoupled Heavy Compute:** Heavy RAW decoding and JXL multi-level encoding are performed once at ingest time (on-device/workstation).
- **Dumb Static Hosting:** The server holds **zero image logic** (no server-side resizing or transform microservices). It serves immutable, static, highly-compressible content-addressed `.jxl` assets and JSON metadata.
- **Client-Side Progressive Delivery:** Instead of within-image DC progressive streams, progressiveness is achieved through an **over-the-wire resolution level ladder**. The client selects and decodes the exact right-sized level needed for the viewport × DPR.

```
[ Workstation / On-Device ]            [ CDN / Static Dumb Host ]            [ Web Browser Client ]
  Ingest RAW/JPG masters                 Immutable JXL Levels                  First Paint: L0 Seed (~19ms)
  → Downscale Cascade                    levels/{hash16}.jxl                   Upgrade: Monotonic by View × DPR
  → Encode Pyramid Sidecars              images/{imageId}/manifest.json        Adjust: Presets & Float WebGL (RAW)
  → Write Manifest/Index                 index.json                            Export: Crop Region (ROI)
```

---

## 2. Ingest CLI Command Syntax (PENDING CONFIRMATION BY GROK BUILD)

The ingest CLI is run on-device to batch process master images. 

*Note: Command syntax below is a planned draft and is pending final confirmation by Grok Build.*

### Basic Ingest:
Processes all supported master images recursively in `<input_dir>` and outputs the levels, manifests, and index to `<output_dir>`.
```bash
node dist/cli.js --out <output_dir> <input_dir_or_files>
```

### Advanced Ingest Options:
- `--concurrency <N>`: Bounded worker pool concurrency limit (auto-clamped based on core count and memory safety to prevent out-of-memory).
- `--mem-budget-mb <MB>`: Maximum memory allocated for processing queues (defaults to `4096`).
- `--force`: Force re-processing of masters even if an up-to-date manifest with matching `mtimeMs` already exists on disk.
- `--tier <scalar|simd|simd-mt>`: Force specific WASM tier for JXL encoding (defaults to `simd`).

### Sharded Processing (for Concurrent Batch Pipelines):
To process a very large batch of files across multiple CPU workers or parallel sharded jobs without file-write race conditions:
```bash
# Process Shard 0 of 4
node dist/cli.js --out <output_dir> --shard 0/4 <input_dir>

# Process Shard 1 of 4
node dist/cli.js --out <output_dir> --shard 1/4 <input_dir>

# Rebuild index.json once all shards are finished (running index writer after shards avoids write conflicts)
node dist/cli.js --out <output_dir> --reindex-only
```

### Proxy Mode (Verification Probe Only):
Generates a SINGLE low-resolution level (defaults to `512px` at `q85`) and a proxy manifest. Skips full-pyramid generation, skip-upscale analysis, JPEG lossless transcode, and gallery indexing. Used for lightweight locality checks.
```bash
node dist/cli.js --out <output_dir> --proxy 512 <input_dir>
```

---

## 3. Directory Layout on Static Dumb Host

Once ingested, the `<output_dir>` is ready to be copied or pushed directly to any CDN or static server (e.g. Amazon S3, Cloudflare Pages, Netlify, Nginx).

```
<output_dir>/
├── index.json                        # Global gallery index (seeds layout + L0 in 1 round-trip)
├── levels/                           # Flat, shared, content-addressed JXL assets
│   ├── 1a2b3c4d5e6f7a8b.jxl          # Deduped level file (named by SHA-256 first 16 chars)
│   ├── 9f8e7d6c5b4a3f2e.jxl
│   └── ...
└── images/                           # Individual image folders
    ├── 9f86d081884c7d65/             # Directory named by stable imageId (absolute path hash)
    │   └── manifest.json             # Single-image metadata, levels map, original format details
    ├── 4a3c2b1d0e9f8a7b/
    │   └── manifest.json
    └── ...
```

---

## 4. Manifest & Index Explanation

### 4.1 Global Gallery Index (`index.json`)
The gallery index is fetched once on client startup. It packs all image layouts (aspect ratio) and their smallest `L0` thumbnail details so the client can construct the entire grid instantly and begin downloading seeds in one round-trip, preventing N manifest fetch cycles.

```json
{
  "schema": 1,
  "images": [
    {
      "imageId": "9f86d081884c7d65",
      "aspect": 1.3333,
      "l0": {
        "contenthash": "1a2b3c4d5e6f7a8b",
        "w": 256,
        "h": 192
      }
    }
  ]
}
```

### 4.2 Per-Image Manifest (`manifest.json`)
When a user clicks on a thumbnail or hovers over a grid tile, the client lazily fetches that image's specific `manifest.json` on-demand to orchestrate upgrades or load the lightbox.

```json
{
  "schema": 1,
  "imageId": "9f86d081884c7d65",
  "master": {
    "name": "P2200566.ORF",
    "format": "orf",
    "mtimeMs": 1717689600000
  },
  "orientation": "baked",
  "width": 4624,
  "height": 3468,
  "aspect": 1.3333,
  "levels": [
    { "size": 256,    "w": 256,  "h": 192,  "bytes": 8192,    "bitsPerSample": 8, "contenthash": "1a2b...", "tiled": false },
    { "size": 512,    "w": 512,  "h": 384,  "bytes": 24576,   "bitsPerSample": 8, "contenthash": "5a6b...", "tiled": false },
    { "size": 1024,   "w": 1024, "h": 768,  "bytes": 98304,   "bitsPerSample": 8, "contenthash": "9c0d...", "tiled": false },
    { "size": 2048,   "w": 2048, "h": 1536, "bytes": 524288,  "bitsPerSample": 8, "contenthash": "cd34...", "tiled": false },
    { "size": "full", "w": 4624, "h": 3468, "bytes": 2097152, "bitsPerSample": 8, "contenthash": "ef56...", "tiled": false }
  ]
}
```

---

## 5. Milestone Status Dashboard

The pipeline delivery is tracked across five shippable milestones.

| Milestone | Component Name | Core Deliverables | Current Status |
|:---:|:---|:---|:---:|
| **M0** | WASM Bridge Primitives | `sidecars_v2` and `downscaleRgba16` C++ exports; TS facade wrappers. | **Completed & Verified** |
| **M1** | Ingest CLI & Grid | Node CLI, lossless transcode, index generator, proxy, lazy grid upgrade. | **In Progress** |
| **M2** | 8-bit Lightbox | Adaptive select, pan canvas transform, presets, sliders, live histogram. | **Planned** |
| **M3** | 16-bit RAW / WebGL | RGB16 RAW path, WebGL float texture shader, FS dither, high-precision crop export. | **Planned** |
| **M4** | Massive Tiling | JXTC tiled top level, LevelSource interface, parallel worker ROI decode. | **Planned** |
