# Milestone M1: Ingest CLI & Gallery Grid — Test Matrix Specification

**Milestone Status:** Planned & Approved (M1 Core Stage)
**Target Branches:** `feat/pyramid-m1-ingest-cli` and `feat/pyramid-m1-gallery-grid`

This document specifies the comprehensive test matrix for Milestone M1 of the Pyramid Gallery Pipeline. It covers all ingest behavior, pipeline invariants, edge cases, error conditions, and metadata schema validation. These are test-case requirements designed to guide the implementer of automated tests.

---

## 1. CLI Ingest Test Cases

The Node ingest CLI must process master images (RAW & JPG) in batches. All output files must be validated for correctness, folder structure, and content-addressing integrity.

| Test Case ID | Test Category | Scenario Description | Expected Outcome | Verification Details |
|:---|:---|:---|:---|:---|
| **TC-ING-01** | Level Selection | Small master (e.g. 1920×1080) processed by CLI. | Levels exceeding master dimensions are skipped. | Output manifest contains levels for target sizes `[256, 512, 1024]` + `full` (1920×1080). The `2048` level is omitted. No upscaling. |
| **TC-ING-02** | Level Selection | Tiny master (e.g. 128×96) processed by CLI. | No sidecars generated. Only the `full` level is written. | Manifest has exactly one level: `full` (128×96). |
| **TC-ING-03** | Bit Depth | RAW master processed by CLI. | Every level in the output manifest is 8-bit. | Manifest `bitsPerSample` is `8` for ALL levels (`256`, `512`, `1024`, `2048`, `full`). No 16-bit files written in M1. |
| **TC-ING-04** | Bit Depth | JPG master processed by CLI. | Every level in the output manifest is 8-bit. | Manifest `bitsPerSample` is `8` for ALL levels (`256`, `512`, `1024`, `2048`, `full`). |
| **TC-ING-05** | Orientation | RAW master processed by CLI. | Orientation is baked into the pixels; orientation field set to `"baked"`. | Manifest `orientation` field is `"baked"`. Pixels are rotated. |
| **TC-ING-06** | Orientation | JPG master processed by CLI. | Lossless transcode is performed; orientation field set to `"source"`. | Manifest `orientation` field is `"source"`. Original EXIF rotation preserved. |
| **TC-ING-07** | Lossless Transcode | JPG master processed by CLI. | Full level JXL is produced by lossless transcode of the source JPEG. | Full level JXL bytes are generated via `transcodeJpegToJxl` with zero loss of quality. File size is smaller than source JPEG. |
| **TC-ING-08** | Ingest Quality | RAW master processed by CLI. | Correct distances applied: q85 (`1.45`) for small, q95 (`0.55`) for large. | `256`, `512`, `1024` are encoded at distance `1.45`. `2048` and `full` are encoded at distance `0.55`. |
| **TC-ING-09** | Resumability | CLI run twice on the same unmodified master. | Second run skips processing entirely. | Output files remain untouched. Log output shows `"skipped"`. Verification uses file modification timestamps (`mtime`). |
| **TC-ING-10** | Resumability | CLI run on master after updating its `mtime`. | CLI re-processes the file. | Manifest is rewritten with updated `master.mtimeMs`. Levels are re-generated. |
| **TC-ING-11** | Error Isolation | Batch containing one corrupt RAW file and two good files. | CLI processes good files; corrupt file logs error and does not stop batch. | Manifests and levels for good files are fully written. Corrupt file is gracefully reported to stderr with non-zero exit code but no crash. |
| **TC-ING-12** | Sharding | Batch run with `--shard 0/2` and `--shard 1/2`. | Round-robin distribution of files across shards. | Shard 0 processes files at indices `0, 2, 4...`. Shard 1 processes `1, 3, 5...`. No file is processed by both shards. |
| **TC-ING-13** | Sharding Index | Sharded run executing manifest writes. | Gallery index `index.json` is NOT written during sharded execution. | Sharded workers write atomic manifests but omit `index.json`. A separate CLI call with `--reindex-only` generates the final `index.json` from disk. |
| **TC-ING-14** | Atomic Writes | Process interrupted during file write. | No partial or corrupt manifest files left in active state. | CLI writes manifests to `manifest.json.tmp` and renames to `manifest.json` on success. Interrupted runs only leave tmp files. |

---

## 2. Proxy Mode Test Cases

Proxy mode is used for high-scale locality or presence verification without storing a full pyramid.

| Test Case ID | Scenario Description | Expected Ingest Outcome | Output File Verification |
|:---|:---|:---|:---|
| **TC-PRX-01** | `--proxy 512` run on RAW master. | Exactly one level (512px) is written at q85 (`1.45`). | Manifest written with `"proxy": true` containing ONLY the `512` size level. `levels/` folder gets exactly one JXL file. |
| **TC-PRX-02** | `--proxy 256` run on JPG master. | Exactly one level (256px) is written at q85 (`1.45`). | Manifest written with `"proxy": true` containing ONLY the `256` size level. Lossless transcode skipped. |
| **TC-PRX-03** | Index behavior after proxy run. | Index is untouched. | Proxy runs do NOT add entries to `index.json`. |

---

## 3. Schema & Path Layout Test Cases

The gallery structure on disk must be structured, deterministic, and content-addressed.

| Test Case ID | Validation Target | Format Specification | Expected Output Verification |
|:---|:---|:---|:---|
| **TC-SCH-01** | Content Addressing | `{contenthash}.jxl` filename validation. | Filename is exactly the **first 16 lowercase hex characters** of the SHA-256 hash of the JXL level bytes. |
| **TC-SCH-02** | Image ID Stability | `images/{imageId}/` directory name validation. | Directory name is exactly the **first 16 lowercase hex characters** of the SHA-256 hash of the absolute master file path. Identical across runs. |
| **TC-SCH-03** | Cross-Image Deduplication | Shared levels across different master images. | Two masters with identical visual contents generate identical level files that write once to `levels/`. |
| **TC-SCH-04** | Index Round-Trip | Gallery `index.json` payload size and content. | Single network round-trip seeds the grid. Contains `imageId`, `aspect` (rounded to 4 decimal places), and `l0` details (`contenthash`, `w`, `h`). |
| **TC-SCH-05** | Index Exclusions | Proxy and corrupt assets in index. | Assets with `"proxy": true` or missing manifests are excluded from `index.json`. |

---

## 4. Client Gallery Grid Test Cases

These verify how the client utilizes the pre-ingested levels for a seamless grid.

| Test Case ID | Category | Interaction Scenario | Expected Client Behavior |
|:---|:---|:---|:---|
| **TC-CLT-01** | Grid Layout | Client fetches `index.json` before any JXL files. | Grid layouts are computed immediately based on each image's pre-recorded `aspect` ratio. Zero layout shift occurs. |
| **TC-CLT-02** | Seed Loading | Grid cells enter the viewport. | Client fetches L0 seed levels (`256px`) first and paints immediately using lightweight one-shot decoding. |
| **TC-CLT-03** | Monotonic Upgrades | Scrolling rapidly down and up. | Cells never downgrade their resolution. If a cell has already upgraded to L2 (`1024px`), it does not downgrade to L1 or L0 on scroll-back. |
| **TC-CLT-04** | Laziness & Prefetch | Fast scrolling across a large grid. | Decodes are requested only for cells within the visible viewport plus a small prefetch boundary ring. |
| **TC-CLT-05** | Cancellation | Fast scrolling past cells before they load. | Offscreen decode requests are cancelled before they begin decoding in the worker scheduler queue, saving CPU cycles. |
| **TC-CLT-06** | Upgrade Quality | High-DPI screen (DPR=2) rendering a 300px cell. | Client selects the upgrade target based on `300px * 2 = 600px` -> fetches the nearest larger level `1024px` for crisp rendering. |
