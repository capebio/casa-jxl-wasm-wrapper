"""Expand Tauri file nodes into component/fn children with accurate line numbers."""
import json

with open('docs/ecosystem-map.model.json', encoding='utf-8') as f:
    m = json.load(f)

# Patch existing pipeline component nodes with correct line numbers
line_patches = {
    't_process_file': 1985,
    't_decode_cmds':  2742,
    't_encode_jxl':   3082,
    't_apply_look':   2676,
}
for node in m['nodes']:
    if node['id'] in line_patches:
        node['line'] = line_patches[node['id']]

# ─── NEW NODES ──────────────────────────────────────────────────────────────
new_nodes = [

  # ── pipeline.rs children (new groups alongside existing fn nodes) ───────────
  {
    "id": "t_pl_types", "k": "component", "p": "t_pipeline",
    "l": "Data Types (Look/Process/Rgb16)",
    "line": 117,
    "desc": "Core data types for the pipeline IPC boundary. LookOptions (L117, 15 f32 fields): exposure_ev, contrast, shadows, highlights, saturation, vibrance, temperature, tint, hue_shift, clarity, noise_reduction, sharpening, black_point, white_point, gamma. Maps exactly to the WASM LookRenderer slider set. ProcessOptions (L133): quality, effort, lossless, look, skip_jxl, use_tiled_jxl, tile_size, progressive_dc, decoding_speed. RgbFrame (L207): Arc<Vec<u8>> data + width/height — cheap clone over IPC, Arc avoids copy when the same frame goes to multiple cache slots. Timings (L214): per-stage ms breakdown returned in ProcessResult. ProcessResult (L225): id, jxl_bytes, lightbox/thumb dims, exif, timings, pyramid path. Rgb16State (L277): full-resolution decoded linear RGB16 + PipelineParams (WB, matrix, black/white levels, CFA phase, orientation) — everything needed to re-run pipeline::process_into with new look params without re-parsing the RAW file. ImageRegion (L521): normalised or pixel-absolute crop rect used by decode_tiled_viewport_pooled and subject-crop commands. ThumbResult (L1652): thumb bytes + dims for get_orf_thumb.",
    "tech": ["rust"]
  },
  {
    "id": "t_pl_tiled", "k": "component", "p": "t_pipeline",
    "l": "Tiled JXL (TJLX / JXTC) engine",
    "line": 510,
    "desc": "Self-contained tiled JXL subsystem for images >8000 px or >40 Mpx that exceed single-JXL practical limits. should_tile_top_level (L510): threshold predicate. ImageRegion / tiles_overlapping_region (L521/L529): spatial index — given a viewport, returns which tile indices overlap (avoids decoding all tiles for a crop). decode_tiled_viewport_pooled (L783): fetches only needed tiles, decodes them in parallel via rayon, stitches into a single RGB8 canvas; pool param avoids re-allocating the canvas on repeated pan/zoom. encode_tiled_jxl (L1002): splits a large RGBA8 into fixed-size tiles, encodes each independently (rayon), assembles the TJLX container header. encode_jxtc_container_rgba8 (L1092): lower-level variant producing a JXTC container (raw multi-tile JXL stream without the sidecar manifest). Tiling is transparent to callers of the decode_jxl_* commands — the command dispatcher checks is_tiled_bytes() and routes appropriately.",
    "tech": ["rust"]
  },
  {
    "id": "t_pl_queue", "k": "component", "p": "t_pipeline",
    "l": "Queue / priority commands",
    "line": 1352,
    "desc": "Four Tauri commands that manage per-file concurrency without touching pixels. set_concurrency (L1353): resize the PrioritySem pool at runtime (default FILE_CONCURRENCY=3; useful for battery/thermal throttle from the UI). promote_file (L1363): elevate a queued file to front of wait queue — fires when user clicks a specific image in the grid while background batch is running. cancel_file (L1372): cancel a waiting or in-flight process_file; returns bool (true = was queued and removed, false = already processing, SIGALRM not sent). All three are synchronous and cheap; they only touch the Mutex-protected queue, not the pixel pipeline.",
    "tech": ["rust"]
  },
  {
    "id": "t_pl_cache", "k": "component", "p": "t_pipeline",
    "l": "Cache retrieval commands",
    "line": 1413,
    "desc": "Nine Tauri commands for reading from AppState LRU caches by numeric id (assigned by process_file). get_lightbox (L1414): RGBA8 lightbox from jxl_lb_cache. get_fast_thumb (L1426): smallest embedded JPEG thumbnail from the RAW file (no decode needed). get_jxl_for_id (L1438): raw JXL codestream bytes for external re-use or re-decode. get_pyramid_manifest_for_id (L1450): JSON manifest of pyramid level contenthashes. get_pyramid_level_bytes (L1464): raw JXL bytes for a specific pyramid level. get_gallery_index (L1478): GalleryIndex (all known image IDs + manifest refs for the gallery grid). get_thumb (L1489): small RGB8 thumb from thumb_cache. get_jxl_lightbox (L1503): lightbox from jxl_lb_cache (JXL format, for progressive-decode prefill). get_rgb16_for_id (L3201): raw RGB16 bytes for external perceptual comparison. All respond via tauri::ipc::Response (binary header + pixels) to skip JSON.",
    "tech": ["rust"]
  },
  {
    "id": "t_pl_meta_cmds", "k": "component", "p": "t_pipeline",
    "l": "RAW metadata / bench commands",
    "line": 1555,
    "desc": "Three lightweight Tauri commands for RAW file inspection without full decode. get_orf_metadata (L1556): parse TIFF header only → OrfMetadata (width, height, ISO, shutter, aperture, camera model, WB, colour matrix) via raw_pipeline::tiff::meta; used to populate the info panel without blocking a slot. bench_decode_orf (L1572): timed full decode → DecodeBench (parse_ms, decompress_ms, demosaic_ms, tone_ms, total_ms); used by the perf overlay. get_orf_thumb (L1595): extract the embedded JPEG preview from the RAW IFD (no pixel decode) → ThumbResult; used for instant grid population before process_file completes.",
    "tech": ["rust"]
  },

  # ── bench.rs children ────────────────────────────────────────────────────────
  {
    "id": "t_b_types", "k": "component", "p": "t_bench",
    "l": "Output types (Unified / Bench / Stress)",
    "line": 34,
    "desc": "Structured output types for all benchmark harnesses. CodecMetricEntry (L34): name+value f64 pair, JSON-serialisable, for embedding in unified output. UnifiedBenchOutput (L72): top-level wrapper (platform, date, codec_version, records: Vec<UnifiedBenchRecord>); UnifiedBenchRecord (L42) embeds codec_name, file_path, width, height, encode_ms, decode_ms, file_size_bytes, quality_score. Serialised to JSON by unified_bench_output_json (L97) and written by write_unified_bench_output (L101). BenchResult (L122): single-run result (path, dims, timing, DecodeRow per pass). DecodeRow (L110): one progressive decode pass row (pass, flush_ms, cumulative_ms, improvement %). SweepResult (L431): effort×quality sweep table. StressRow/StressResult (L508/L524): parallel-stress rows + aggregate percentiles.",
    "tech": ["rust"]
  },
  {
    "id": "t_b_decode", "k": "fn", "p": "t_bench",
    "l": "bench_jxl_decode (L288)",
    "line": 288,
    "desc": "Tauri command entry for single-file JXL decode benchmark. bench_jxl_decode (L288) dispatches to bench_one_path (L292), which: (1) reads JXL bytes; (2) decodes via decode_oxide_full (L258, jxl-oxide full-image path → RGB8 + decode_us); (3) also runs the progressive path via jxl_lowlevel::decode_progressive_frames to collect per-pass flush timings; (4) returns BenchResult with per-pass DecodeRow. decode_oxide_full (L258): single-image jxl-oxide decode capturing wall-clock microseconds; fb_to_rgb8 (L213) converts jxl_oxide::FrameBuffer to interleaved RGB8 bytes. run_pipeline_to_rgb8 (L131): runs the full RAW→RGB8 pipeline (parse+decompress+demosaic+tone) for pipeline timing comparison.",
    "tech": ["rust"]
  },
  {
    "id": "t_b_sweep", "k": "fn", "p": "t_bench",
    "l": "bench_jxl_sweep (L472)",
    "line": 472,
    "desc": "Tauri command. Sweeps quality (50/70/85/90/95) × effort (1/3/5/7/9) for a set of up to 5 sample ORF files (list_orfs L437 + pick_five L457 deterministic selection). For each combination: encode via encode_jxl_with_channels, measure encode_ms + file_size_bytes; decode via decode_oxide_full, measure decode_ms. Returns SweepResult with all rows. Used to tune default quality/effort settings. pick_five (L457) takes every 5th file from the sorted list to get a representative sample without scanning every image.",
    "tech": ["rust"]
  },
  {
    "id": "t_b_stress", "k": "fn", "p": "t_bench",
    "l": "bench_jxl_stress (L556)",
    "line": 556,
    "desc": "Tauri command. Parallel decode stress test — spawns N threads each decoding a queue of JXL files in a loop for T seconds; collects per-thread timing rows. stats_row (L719) computes p50/p95/p99 decode latencies per thread from the raw rows. percentile (L534): sorted-array percentile helper. target_dims (L545): scales width×height to a long-edge target for consistent comparison. Useful for detecting thermal throttling, memory pressure, and OS scheduler effects under sustained decode load.",
    "tech": ["rust"]
  },
  {
    "id": "t_b_thumb", "k": "fn", "p": "t_bench",
    "l": "bench_jxl_thumb (L820)",
    "line": 820,
    "desc": "Tauri command. Benchmark focusing on thumbnail and gallery-specific decode paths. Measures: time to embedded thumb (get_fast_thumb path), time to DC preview (decode_libjxl_dc path), time to full lightbox. Produces ThumbSizeRow/DcProbeRow/GalleryRow records tracking byte sizes and decode latencies for each image. sanitize_stem (L809) normalises filenames for report output. Used to calibrate the DC→full progressive-preview strategy for gallery scroll performance.",
    "tech": ["rust"]
  },
  {
    "id": "t_b_disk", "k": "fn", "p": "t_bench",
    "l": "bench_jxl_disk (L1490)",
    "line": 1490,
    "desc": "Tauri command + standalone harness run_disk_bench (L1504). Measures disk I/O bottleneck vs. decode bottleneck by comparing three read strategies: sidecar (one file per image), bundle-full (all images in one sequential bundle file read with read_bundle_entry L1341), bundle-pread (same bundle via pread syscall, allows parallel reads without seek lock, L1354). parse_bundle_entry (L1394): extracts one image from a pre-read bundle byte slice. ensure_flush_file (L1428) + flush_cache (L1451): primes the test by writing a large flush file to evict OS page cache, giving cold-read latencies. DiskOpRow/DiskResult: per-image timing + aggregate. Determines whether the gallery is I/O or CPU bound on the target machine.",
    "tech": ["rust"]
  },
  {
    "id": "t_b_crossover", "k": "fn", "p": "t_bench",
    "l": "run_crossover_bench (L1922)",
    "line": 1922,
    "desc": "Finds the encode effort crossover point: the effort level above which smaller file size no longer justifies longer encode time, for a given quality target. Iterates effort 1..9, encodes, measures encode_ms + decode_ms + file_size. CrossoverRow (L1901) captures all three per effort level. CrossoverResult (L1914) wraps the full table. Used to justify effort=3 as the default (empirically the best speed/size knee for this camera corpus).",
    "tech": ["rust"]
  },
  {
    "id": "t_b_effort", "k": "fn", "p": "t_bench",
    "l": "run_effort_bench (L2013)",
    "line": 2013,
    "desc": "Encodes the same image at all 9 effort levels and records encode_ms, decode_ms, file_size_bytes, SSIM (via perceptual kernel), butteraugli distance. EffortRow (L1991) / EffortResult (L2003). Complements run_crossover_bench — where crossover uses wall-clock only, effort_bench adds perceptual quality scores so the trade-off is effort vs. (speed AND quality).",
    "tech": ["rust"]
  },
  {
    "id": "t_b_dng", "k": "fn", "p": "t_bench",
    "l": "bench_dng_jxl (L2178)",
    "line": 2178,
    "desc": "Tauri command. DNG-specific decode pipeline benchmark. bench_one_dng (L2115): times DNG parse (dng_rs::meta), DNG decode (dng_rs::decode), demosaic, and tone stages separately using raw_pipeline functions directly. DngBenchRow (L2091) and DngBenchResult (L2106) capture per-stage milliseconds. Useful for diagnosing whether DNG processing is parse-bound (large CFA metadata), demosaic-bound (higher-res sensor), or tone-bound (same for all RAW formats).",
    "tech": ["rust"]
  },

  # ── casabio.rs children ───────────────────────────────────────────────────────
  {
    "id": "t_cb_token", "k": "component", "p": "t_casabio",
    "l": "Keyring token store",
    "line": 16,
    "desc": "OS keyring integration for persisting the Casabio API bearer token across sessions. keyring_entry (L16): constructs a keyring::Entry keyed on \"casabio\"/\"token\" (uses OS credential store: Keychain on macOS, DPAPI on Windows, libsecret on Linux). set_token (L20) / get_token (L24) / clear_token (L28): thin wrappers. Tauri commands casabio_set_token (L391) / casabio_clear_token (L396) delegate here. Token is never written to disk in plaintext or stored in AppState.",
    "tech": ["rust"]
  },
  {
    "id": "t_cb_expedition", "k": "component", "p": "t_casabio",
    "l": "Expedition listing",
    "line": 33,
    "desc": "Expedition struct (L33): id, name, description — deserialised from Casabio REST API GET /expeditions response. list_expeditions (L38): async HTTP GET with bearer token, deserialises Vec<Expedition>, returns Result. Tauri command casabio_list_expeditions (L401) wraps this with base_url from the frontend. casabio_pick_files (L370) is a companion Tauri command that opens a native file-picker dialog (tauri::AppHandle dialog API) for the user to select RAW/JPEG files to upload; it returns Vec<String> paths.",
    "tech": ["rust"]
  },
  {
    "id": "t_cb_source", "k": "component", "p": "t_casabio",
    "l": "Source classification + decode",
    "line": 58,
    "desc": "classify_source (L58): inspects file extension and TIFF magic bytes to return SourceType (Raw | Jpeg | Unsupported). This gates the encode path: JPEG → transcode_jpeg_to_jxl (lossless bitstream copy); Raw → decode_raw_to_rgba then encode_variants. decode_raw_to_rgba (L103): full RAW decode via raw_pipeline tiff/demosaic/pipeline, returns RGBA8 Vec. rgb_to_rgba (L139): fast 3→4 channel pad (inserts 0xFF alpha). read_exif_orientation (L149): reads EXIF orientation tag for pre-rotate. apply_exif_orientation_rgba (L163): rotates/flips RGBA8 buffer in-place to match EXIF orientation — needed because Casabio server expects canonical (unrotated) pixel data. decode_to_rgba (L195): dispatches to decode_raw_to_rgba or JPEG decode based on SourceType.",
    "tech": ["rust"]
  },
  {
    "id": "t_cb_upload", "k": "fn", "p": "t_casabio",
    "l": "upload_file (L226)",
    "line": 226,
    "desc": "Core async upload function. UploadResult (L219): expedition_id, image_id, thumb_url, preview_url, full_url — returned to the frontend on success. upload_file (L226): (1) classify_source; (2) decode_to_rgba → RGBA8; (3) call raw_pipeline::casabio_encode::encode_variants (thumb_300 + preview_1080 + full) → VariantSet of three JXL byte vecs; (4) POST multipart/form-data with all three JXLs + EXIF JSON to Casabio API; (5) deserialise UploadResult. Tauri command casabio_upload_file (L406) wraps upload_file, propagates errors as String for the frontend error UI.",
    "tech": ["rust"]
  },

  # ── pyramid_store.rs children ─────────────────────────────────────────────────
  {
    "id": "t_py_types", "k": "component", "p": "t_pyramid",
    "l": "Manifest / Index types",
    "line": 40,
    "desc": "Twelve public types defining the pyramid on-disk schema. MasterFormat (L40): Raw|Jpeg — determines which ingest path. MasterInfo (L48): master path, format, dimensions, mtime_ms. LevelSize (L56): Full|P1080|P300|P128|P64 — pyramid level enum with long-edge px value. LevelEntry (L72): contenthash (SHA-256 hex), width, height, file_size_bytes, quality_distance. PyramidManifest (L84): master_info + Vec<LevelEntry> — written as JSON alongside each image. IndexL0/IndexEntry (L99/L106): gallery index types (L0 = top-level index, one IndexEntry per image with id + manifest ref). GalleryIndex (L114): Vec<IndexEntry> + build timestamp. PyramidL0Seed (L120): minimal per-image seed for fast index rebuild. IngestOutput (L127): returned from ingest_raw_pyramid / ingest_jpg_pyramid with all level paths and contenthashes. PyramidStore (L133): root path + config (tile_size, quality ladder).",
    "tech": ["rust"]
  },
  {
    "id": "t_py_ladder", "k": "fn", "p": "t_pyramid",
    "l": "plan_ladder_distances (L188)",
    "line": 188,
    "desc": "Determines the butteraugli distance for each pyramid level based on the master image's pixel dimensions and the configured quality target. plan_ladder_distances (L188): computes the (base_distance, sizes_px, distances) triplet — larger levels get lower distance (higher quality) because the viewer will zoom in; smallest levels tolerate more compression since they're only shown as thumbnails. round4 (L198): rounds to 4 decimal places for stable JSON. to_entry (L210): converts a PyramidLevel to LevelEntry filling in contenthash and file_size. write_level_files (L222): encodes each pyramid level to its contenthash-keyed path on disk; skips a level if a file with that hash already exists (content-addressable dedup). build_manifest (L237): assembles PyramidManifest from LevelEntries + MasterInfo.",
    "tech": ["rust"]
  },
  {
    "id": "t_py_manifest", "k": "component", "p": "t_pyramid",
    "l": "Manifest I/O",
    "line": 259,
    "desc": "Low-level manifest read/write. read_manifest (L259): reads image_id.manifest.json from the pyramid root. is_up_to_date (L265): compares existing manifest's mtime_ms to the source file's current mtime_ms — if equal, skip re-ingest (ingest is idempotent). write_manifest_atomic (L269): writes to a .tmp file then renames, preventing torn reads if the process crashes mid-write. Used by both ingest paths. is_tiled_bytes (L202) in the same file checks the JXTC magic header (first 4 bytes) to route tiled vs. plain JXL at decode time.",
    "tech": ["rust"]
  },
  {
    "id": "t_py_index", "k": "fn", "p": "t_pyramid",
    "l": "rebuild_index / read_or_rebuild_index (L280/L331)",
    "line": 280,
    "desc": "Gallery index management. rebuild_index (L280): walks the pyramid root directory, reads all manifests, builds a fresh GalleryIndex sorted by mtime descending (newest first). read_or_rebuild_index (L331): checks if gallery.index.json exists and is newer than all manifests; returns it if valid, otherwise calls rebuild_index and writes a fresh one. Keeps the gallery grid fast: the frontend calls get_gallery_index once at startup, then incremental updates come from ingest_raw_pyramid's IngestOutput. master_format_from_path (L343): extension-based SourceType detection for the index walker.",
    "tech": ["rust"]
  },
  {
    "id": "t_py_ingest", "k": "fn", "p": "t_pyramid",
    "l": "ingest_raw_pyramid / ingest_jpg_pyramid (L382 / L469)",
    "line": 382,
    "desc": "Main ingest entry points. ingest_raw_pyramid (L382): checks is_up_to_date → if stale: calls raw_pipeline::casabio_encode::encode_rgba8_pyramid to produce all PyramidLevel tiers → write_level_files → build_manifest → write_manifest_atomic → updates gallery index → returns IngestOutput. maybe_replace_full_with_tiled (L357): if the master is >8000 px or >40 Mpx, replaces the full-res JXL tier with an encode_tiled_jxl TJLX container so single-image decode stays practical. ingest_jpg_pyramid (L469): JPEG master path — uses transcode_jpeg_to_jxl for the full tier (lossless), then re-encodes downscaled tiers with encode_rgba8_pyramid from the decoded JPEG. file_mtime_ms (L549): stat wrapper returning milliseconds.",
    "tech": ["rust"]
  },
]

existing_ids = {n['id'] for n in m['nodes']}
dupes = [n['id'] for n in new_nodes if n['id'] in existing_ids]
if dupes:
    print(f'ERROR duplicate IDs: {dupes}')
else:
    m['nodes'].extend(new_nodes)
    print(f'Added {len(new_nodes)} nodes. Total: {len(m["nodes"])}')

with open('docs/ecosystem-map.model.json', 'w', encoding='utf-8') as f:
    json.dump(m, f, indent=2, ensure_ascii=False)
print('Written.')
