"""Add Tauri native Rust JXL architecture nodes and edges to ecosystem-map.model.json."""
import json

with open('docs/ecosystem-map.model.json', encoding='utf-8') as f:
    m = json.load(f)

new_nodes = [
  # ── Tauri system ────────────────────────────────────────────────────────────
  {
    "id": "tauri",
    "k": "system",
    "l": "Tauri Native App ★",
    "col": "raw",
    "desc": "Native desktop application built on Tauri (Rust backend + WebView frontend). Runs the same raw-pipeline crate as the WASM path but without any FFI boundary — Rust calls Rust directly. This eliminates the WASM heap-copy overhead and enables multi-threaded rayon parallelism and jpegxl-sys (C FFI) bindings that are blocked in WASM. The frontend communicates with the backend via Tauri IPC commands (tauri::command functions in pipeline.rs) using binary IPC responses to minimise serialisation cost. The entire JXL encode/decode stack — casabio_encode, jxl_casadecoder, jxl_casaencoder (via jxl-ffi), perceptual kernels — is the same Rust source as the WASM/WASM-worker path; there is no separate implementation. Key advantages vs WASM: native AVX2/AVX-512 without polyfill, ThreadsRunner for parallel JXL decode/encode, jxl-oxide region ROI without full-image allocation, DC-fast decode for live gallery paint. Key shared components: raw-pipeline workspace member (same Cargo.toml), jxl_casadecoder.rs (shared source, compiled native), casabio_encode.rs (shared), pipeline.rs (shared). src-tauri/src/ adds the Tauri command layer, caching (LRU AppState), priority scheduling, pyramid store, and Casabio upload integration.",
    "tech": ["rust", "js"]
  },

  # ── Tauri files ─────────────────────────────────────────────────────────────
  {
    "id": "t_lib",
    "k": "file",
    "l": "src-tauri/src/lib.rs",
    "p": "tauri",
    "path": "src-tauri/src/lib.rs",
    "lines": 200,
    "desc": "AppState definition and Tauri builder entry point. AppState holds all shared LRU caches: jxl_cache (25-entry, keyed by u64 id, ~15 MB/entry), jxl_lb_cache (lightbox JXL), subject_jxl_cache (100-entry, subject crops), rgb16_cache (full-res RGB16 for re-encode after look change). Also owns the PrioritySem (file-level concurrency semaphore, FILE_CONCURRENCY=3) and the Casabio session token. Tauri builder in run() registers all tauri::command handlers and configures IPC binary response mode. The binary response mode (tauri::ipc::Response) avoids JSON serialisation for pixel data — raw bytes go direct over the IPC pipe.",
    "tech": ["rust"]
  },
  {
    "id": "t_pipeline",
    "k": "file",
    "l": "src-tauri/src/pipeline.rs",
    "p": "tauri",
    "path": "src-tauri/src/pipeline.rs",
    "lines": 3589,
    "desc": "Core Tauri command file. Contains all JXL encode/decode commands and the main process_file async entry. Key sections: (1) decode_jxl_* family — six commands dispatching to jxl_native or jxl-oxide by path (full / region / DC / cached-id); (2) encode_rgba16_jxl — jpegxl_rs encoder command; (3) process_file — async multi-stage pipeline: decode RAW → tone → LRU cache → pyramid; (4) apply_look / apply_look_stream — re-tone from cached RGB16 with cancellation; (5) promote_file / cancel_file — priority-queue management via PrioritySem. Also contains RgbFrame, Rgb16State, ProcessResult types and the encode_jxl_with_channels helper that wires jpegxl_rs ThreadsRunner.",
    "tech": ["rust"]
  },
  {
    "id": "t_jxl_native",
    "k": "file",
    "l": "src-tauri/src/jxl_native.rs",
    "p": "tauri",
    "path": "src-tauri/src/jxl_native.rs",
    "lines": 190,
    "desc": "High-level JXL FFI wrappers used by the Tauri decode commands. Three public functions: decode_jxl_rgb8 (jpegxl_sys → RGB8, single-threaded), decode_jxl_rgba16 (jpegxl_rs → packed native-endian u16 bytes, 8 bytes/pixel), transcode_jpeg_to_jxl (bitstream-level JPEG→JXL via JxlEncoderAddJPEGFrame + JxlEncoderStoreJPEGMetadata — lossless EXIF preservation). This file handles the jpegxl-sys C FFI binding directly; it is the native-side analogue of the WASM jxl_casadecoder.rs Decoder API but for the simpler one-shot decode use cases. The Decoder object API in jxl_casadecoder.rs is used for progressive and region paths.",
    "tech": ["rust"]
  },
  {
    "id": "t_bench",
    "k": "file",
    "l": "src-tauri/src/bench.rs",
    "p": "tauri",
    "path": "src-tauri/src/bench.rs",
    "lines": 2222,
    "desc": "Benchmarking and diagnostic utilities for JXL decode paths. Contains: decode_oxide_region (jxl-oxide Decoder::set_image_region → cropped RGB8, avoids full image; used for ROI decode commands), decode_libjxl_dc (jpegxl_sys DC-preview pass — fast low-res first paint for gallery lightbox), bench_jxl_decode / bench_jxl_sweep (sweep across efforts 1–9 and qualities, log throughput + file sizes). Also benchmarks progressive decode timing (decode_progressive_first_total from jxl_lowlevel). Not exposed as Tauri commands; used via a build feature or direct binary invocation. The jxl-oxide region path here is the production decode backend for decode_jxl_region commands.",
    "tech": ["rust"]
  },
  {
    "id": "t_casabio",
    "k": "file",
    "l": "src-tauri/src/casabio.rs",
    "p": "tauri",
    "path": "src-tauri/src/casabio.rs",
    "lines": 413,
    "desc": "Casabio cloud upload integration. Wraps raw_pipeline::casabio_encode::encode_variants to produce the (thumb_300, preview_1080, full) JXL triplet, then uploads via multipart HTTP to the Casabio API. Tauri commands: set_token / get_token (persist API key in AppState), list_expeditions, upload_file (classify_source → encode_variants → upload). classify_source distinguishes JPEG masters (use transcode_jpeg_to_jxl lossless path) from RAW (use encode_variants lossy pipeline). Shared dependency on casabio_encode.rs — same encoding logic as the WASM/web upload path but running natively with full CPU parallelism.",
    "tech": ["rust"]
  },
  {
    "id": "t_pyramid",
    "k": "file",
    "l": "src-tauri/src/pyramid_store.rs",
    "p": "tauri",
    "path": "src-tauri/src/pyramid_store.rs",
    "lines": 579,
    "desc": "Multi-level pyramid storage and manifest management. PyramidManifest: index of level contenthashes (SHA-256) + metadata per level (full / 1080 / 300 / 128 / 64 px long-edge). ingest_raw_pyramid: calls casabio_encode::encode_rgba8_pyramid to produce all pyramid tiers, stores each JXL in the local pyramid cache directory keyed by contenthash, writes manifest. decode_jxl_level_for_id and decode_pyramid_roi_for_id commands read from this store for fast gallery browsing — they decode only the requested level without touching the full-resolution JXL. Mirrors the WASM jxl-pyramid package's level abstraction but for local disk storage.",
    "tech": ["rust"]
  },
  {
    "id": "t_pool",
    "k": "file",
    "l": "src-tauri/src/pool.rs",
    "p": "tauri",
    "path": "src-tauri/src/pool.rs",
    "lines": 111,
    "desc": "Memory pool for RGB16 buffer reuse across apply_look re-tone calls. Holds a Vec<Vec<u8>> of recycled full-resolution RGB16 buffers. Callers acquire a buffer (or allocate fresh if pool empty), process into it, then release it back. Avoids repeated 50–100 MB allocations when the user adjusts sliders in the look panel. Pool is bounded to avoid unbounded memory growth. Operates under Mutex inside AppState.",
    "tech": ["rust"]
  },
  {
    "id": "t_priorsem",
    "k": "file",
    "l": "src-tauri/src/priority_sem.rs",
    "p": "tauri",
    "path": "src-tauri/src/priority_sem.rs",
    "lines": 145,
    "desc": "Priority-aware semaphore for file-level concurrency control. FILE_CONCURRENCY=3 — at most 3 files decode/encode simultaneously. promote_file command elevates a queued file to the front of the wait queue (user clicked on a specific image). cancel_file cancels a queued or in-flight file (user scrolls past). Internally uses tokio::sync::Semaphore with a priority wait queue. Prevents the encoder thread pool from being saturated by background batch work while a user-selected image is waiting.",
    "tech": ["rust"]
  },

  # ── Tauri components / fns ───────────────────────────────────────────────────
  {
    "id": "t_process_file",
    "k": "fn",
    "p": "t_pipeline",
    "l": "process_file",
    "line": 1985,
    "desc": "Main async Tauri command. Receives ProcessOptions (quality, effort, lossless, look, skip_jxl, use_tiled_jxl, tile_size). Stages: (1) acquire PrioritySem slot; (2) decode_source_file → Bayer → RGB16 via raw_pipeline tiff/dng/cr2 + demosaic; (3) apply look → RGBA8 via pipeline::process; (4) downscale to lightbox (1800 px) + thumb (360 px); (5) encode_jxl_with_channels → JXL bytes via jpegxl_rs ThreadsRunner; (6) optionally ingest_raw_pyramid; (7) store results in AppState caches; (8) return ProcessResult. Cancel signal checked at each stage boundary. Timings returned per-stage.",
    "tech": ["rust"]
  },
  {
    "id": "t_decode_cmds",
    "k": "component",
    "p": "t_pipeline",
    "l": "decode_jxl_* commands",
    "line": 403,
    "desc": "Six Tauri decode commands dispatching to different native decode backends: decode_jxl_to_rgb (jpegxl_sys → RGB8, full image), decode_jxl_region (jxl-oxide set_image_region → RGB8 ROI crop), decode_jxl_dc (jpegxl_sys DC pass → low-res RGB8 preview), *_for_id variants use AppState::jxl_cache lookup to avoid re-transmitting JXL bytes over IPC. decode_jxl_level_for_id and decode_pyramid_roi_for_id route to pyramid_store. All respond with tauri::ipc::Response (binary: 4-byte width + 4-byte height LE header + raw pixel bytes) to skip JSON overhead.",
    "tech": ["rust"]
  },
  {
    "id": "t_encode_jxl",
    "k": "fn",
    "p": "t_pipeline",
    "l": "encode_jxl_with_channels",
    "line": 403,
    "desc": "Internal JXL encode helper called by process_file and the encode_rgba16_jxl command. Uses jpegxl_rs::encoder_builder with ThreadsRunner (default 6 threads on 12-core). Configuration: quality (0–100, converted to butteraugli distance), effort (1–9), lossless flag, decoding_speed tier (0–4, embedded at encode time), progressive_dc (0/1/2, first-paint tier). Channels auto-detected (3=RGB, 4=RGBA). Returns Vec<u8> JXL codestream. For tiled_jxl mode routes to the TJLX/JXTC encoder for images >8000 px or >40 Mpx.",
    "tech": ["rust"]
  },
  {
    "id": "t_apply_look",
    "k": "fn",
    "p": "t_pipeline",
    "l": "apply_look / apply_look_stream",
    "line": 2300,
    "desc": "Re-tone Tauri commands for slider interaction. apply_look: synchronous, pulls Rgb16State from rgb16_cache, calls pipeline::process_into with new LookOptions, returns RGBA8 lightbox. apply_look_stream: async streaming variant that sends progressive quality levels (downscaled fast → full-res) over a Tauri event channel, with cancellation via AtomicBool. Enables live-preview slider feedback without re-decoding the RAW file. LookOptions mirrors WASM LookRenderer parameters.",
    "tech": ["rust"]
  },

  # ── Shared references (virtual nodes pointing to shared Rust code) ───────────
  {
    "id": "t_shared_rawpipe",
    "k": "module",
    "p": "tauri",
    "l": "raw-pipeline (shared)",
    "path": "crates/raw-pipeline/src",
    "desc": "raw-pipeline Rust crate is a workspace member of both raw-converter-wasm and raw-converter-tauri. Compiled natively for Tauri (x86_64, full AVX2/AVX-512, rayon parallelism, jpegxl-sys C FFI enabled via jxl-lowlevel feature). Compiled to wasm32-unknown-unknown for the browser WASM path (jxl-encode/jxl-lowlevel features disabled). Source files are identical — no fork. Native build enables features=simd,jxl-lowlevel,jxl-encode; WASM build uses default-features=false. This is the key architectural invariant: one codebase, two compilation targets.",
    "tech": ["rust"]
  },
  {
    "id": "t_jxloxide",
    "k": "component",
    "p": "tauri",
    "l": "jxl-oxide (region ROI)",
    "desc": "Pure-Rust JXL decoder (crate jxl-oxide v0.11) used exclusively for region/ROI decode in the native Tauri path. Exposes set_image_region before decoding — libjxl C binding does not yet have a stable crop API at the Rust wrapper level. Avoids allocating and decoding the full image when only a viewport is needed (e.g. a 512×512 crop of a 24 MP image). Not used in WASM (wasm32 build excludes it — WASM decode uses the libjxl bridge). Not used for full-image decode (jpegxl_sys is faster for that path). Dependency only in src-tauri/Cargo.toml.",
    "tech": ["rust"]
  },
]

new_edges = [
  # Tauri → shared raw-pipeline nodes
  {"f": "tauri",          "t": "rawdec",        "l": "shared src",          "pay": "bytes"},
  {"f": "tauri",          "t": "enc",            "l": "shared src",          "pay": "rgba8"},
  {"f": "tauri",          "t": "dec",            "l": "shared src",          "pay": "jxl"},
  {"f": "tauri",          "t": "perc",           "l": "shared metrics",      "pay": "metric"},

  # Tauri internal wiring
  {"f": "t_lib",          "t": "t_pipeline",     "l": "registers commands",  "pay": "bytes"},
  {"f": "t_pipeline",     "t": "t_jxl_native",   "l": "full/DC decode",      "pay": "jxl"},
  {"f": "t_pipeline",     "t": "t_bench",        "l": "region decode",       "pay": "jxl"},
  {"f": "t_pipeline",     "t": "t_pyramid",      "l": "pyramid level",       "pay": "jxl"},
  {"f": "t_pipeline",     "t": "t_casabio",      "l": "upload variants",     "pay": "jxl"},
  {"f": "t_pipeline",     "t": "t_priorsem",     "l": "concurrency gate",    "pay": "bytes"},
  {"f": "t_pipeline",     "t": "t_pool",         "l": "RGB16 reuse",         "pay": "rgb16"},

  # Tauri → shared Rust nodes (cross-repo shared source)
  {"f": "t_pipeline",     "t": "pipeline",       "l": "process_into (tone)", "pay": "rgb16"},
  {"f": "t_pipeline",     "t": "casabio",        "l": "encode_variants",     "pay": "rgba8"},
  {"f": "t_jxl_native",   "t": "dec_rs",         "l": "shared decoder src",  "pay": "jxl"},
  {"f": "t_casabio",      "t": "casabio",        "l": "encode_variants",     "pay": "rgba8"},
  {"f": "t_pyramid",      "t": "casabio",        "l": "encode_rgba8_pyramid","pay": "rgba8"},
  {"f": "t_bench",        "t": "dec_rs",         "l": "Decoder API",         "pay": "jxl"},

  # jxl-oxide as a separate Tauri-only dependency
  {"f": "t_bench",        "t": "t_jxloxide",     "l": "region ROI",          "pay": "jxl"},
  {"f": "t_jxloxide",     "t": "dec",            "l": "pure-Rust alt path",  "pay": "jxl"},
]

existing_ids = {n['id'] for n in m['nodes']}
dupes = [n['id'] for n in new_nodes if n['id'] in existing_ids]
if dupes:
    print(f'WARNING: duplicate node IDs: {dupes}')
else:
    m['nodes'].extend(new_nodes)
    m['edges'].extend(new_edges)
    print(f'Added {len(new_nodes)} nodes, {len(new_edges)} edges.')
    print(f'Totals: {len(m["nodes"])} nodes, {len(m["edges"])} edges.')

with open('docs/ecosystem-map.model.json', 'w', encoding='utf-8') as f:
    json.dump(m, f, indent=2, ensure_ascii=False)
print('Written.')
