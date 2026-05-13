# Tauri Native App — Design Spec
**Date:** 2026-05-14  
**Status:** Approved

---

## Goal

Replace the browser-based ORF→JXL converter with a native Tauri 2 desktop app. Zero wasm. Full native Rust pipeline (decode + demosaic + tone/colour + JXL encode). Push results (JXL bytes + EXIF + filename) to the casabio-expedition-planner backend via a new HTTP endpoint.

---

## Constraints

- Windows primary target (WebView2)
- Must keep existing web tool working as fallback (`web/` + `serve.ts` unchanged)
- JXL quality/effort must be identical to the current jSquash output (both wrap same libjxl)
- Expedition planner backend must be optional — push fails gracefully, JXL saved locally instead
- Auth token stored in OS keychain, entered once by user
- Extensible push payload (EXIF fields, future metadata, no breaking schema change)

---

## Architecture

```
raw-converter-wasm/
├── raw-pipeline/          ← NEW pure-Rust library crate (no wasm-bindgen)
│   ├── src/
│   │   ├── lib.rs         ← re-exports pipeline, decompress, demosaic, tiff, exif
│   │   ├── pipeline.rs
│   │   ├── decompress.rs
│   │   ├── demosaic.rs
│   │   ├── tiff.rs
│   │   └── exif.rs        ← NEW: parse EXIF into structured ExifData
│   └── Cargo.toml
├── src/                   ← existing wasm-bindgen wrapper (unchanged, browser fallback)
├── src-tauri/             ← NEW Tauri 2 app
│   ├── src/
│   │   ├── main.rs
│   │   ├── lib.rs         ← Tauri commands
│   │   ├── pipeline.rs    ← orchestrates raw-pipeline + JXL encode per file
│   │   └── push.rs        ← HTTP client for expedition planner API
│   ├── capabilities/
│   │   └── default.json
│   ├── Cargo.toml
│   └── tauri.conf.json
├── web/                   ← existing frontend (modified: pool/workers → invoke calls)
│   ├── main.js            ← MODIFIED
│   ├── index.html         ← MODIFIED (upload button, no worker scripts)
│   └── ...
└── Cargo.toml             ← MODIFIED: workspace root
```

---

## Rust Workspace

`Cargo.toml` (root) becomes a workspace:

```toml
[workspace]
members = ["raw-pipeline", "src-tauri"]
resolver = "2"
```

`raw-pipeline` is a pure `[lib]` crate. No `wasm-bindgen`, no `cdylib`. Existing `src/` wasm crate stays as a separate non-workspace crate (built independently by `wasm-pack`).

---

## Tauri Commands

### `process_file`

```
Input:
  path: String              — absolute path to .orf file
  options: ProcessOptions {
    quality: u8,            — JXL quality 50–100
    effort: u8,             — JXL effort 1–9
    lossless: bool,
    look: LookOptions,      — all 12 look parameters
    user_rotation: i32,     — 0/90/180/270
    wb_r: Option<f32>,
    wb_b: Option<f32>,
  }

Output:
  ProcessResult {
    thumb: RgbFrame,        — downscaled RGB8 for gallery card
    lightbox: RgbFrame,     — full-res RGB8 for lightbox canvas
    jxl: Vec<u8>,           — encoded JXL bytes
    exif: ExifData,         — structured EXIF (see below)
    timings: Timings,       — decompress/demosaic/tone/encode ms
  }
```

Runs on a Rayon thread pool. Returns result as a single resolved promise (no streaming within one file). Progress for multi-file batches emitted as events (see below).

### `apply_look`

```
Input:
  id: u64                   — task ID (maps to cached rgb16 in Rust state)
  look: LookOptions

Output:
  { rgb: Vec<u8>, w: u32, h: u32 }
```

Rust keeps a `DashMap<u64, Rgb16State>` in app state. Live lightbox updates call this without re-running the full pipeline. Eviction: entries are dropped when a new batch starts (all keys cleared) or when the app closes. Max 50 entries retained; oldest evicted beyond that to cap memory.

### `pick_files`

```
Input:  (none — opens native file/folder dialog)
Output: Vec<String>         — absolute paths of selected .orf files
```

Uses `tauri-plugin-dialog`. Returns empty vec if user cancels. Filters to `.orf` / `.ORF`.

### `push_to_planner`

```
Input:
  PushPayload {
    filename: String,
    jxl_b64: String,        — base64-encoded JXL bytes
    exif: ExifData,
    planner_url: String,    — e.g. "http://localhost:3001"
    token: String,          — bearer token from keychain
  }

Output:
  PushResult { ok: bool, id: Option<String>, error: Option<String> }
```

HTTP POST to `{planner_url}/api/raw-images`. Timeout 30 s. Non-fatal: JS shows inline error badge on card, JXL still downloadable locally.

### `get_token` / `set_token`

Read/write bearer token from OS keychain (`keyring` crate). Called from a settings modal in the UI.

### `get_settings` / `set_settings`

Read/write `{ planner_url: String }` from `tauri-plugin-store` (persistent JSON file in app data dir). `planner_url` defaults to `http://localhost:3001`. Stored separately from the keychain token since it's not a secret.

---

## ExifData Structure

```rust
pub struct ExifData {
    pub make: Option<String>,
    pub model: Option<String>,
    pub lens: Option<String>,
    pub datetime: Option<String>,       // "YYYY:MM:DD HH:MM:SS"
    pub exposure: Option<Rational>,     // shutter speed
    pub fnumber: Option<Rational>,
    pub iso: Option<u32>,
    pub focal_length: Option<Rational>,
    pub focal_length_35: Option<u32>,
    pub gps: Option<GpsData>,
    pub orientation: u16,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub wb_r: Option<f32>,
    pub wb_b: Option<f32>,
    pub wb_mode: Option<u16>,
    pub wb_from_camera: bool,
    pub quality: Option<u8>,
}
```

Serialises to JSON. Expedition planner stores as JSONB or text column — forward-compatible with new fields.

---

## Progress Events

For multi-file batches, Rust emits to the frontend window:

```
"file_progress" → { path: String, stage: "decoding"|"pipeline"|"encoding"|"done"|"error", error?: String }
```

Frontend uses these to update card state (busy → encoding → done/error) instead of worker messages.

---

## Frontend Changes (`web/main.js`)

**Remove:**
- `WorkerPool` class (entire ~200 lines)
- All `new Worker(...)` calls
- `pool.init()`, `pool.submit()`, `pool.reprocessLive()`, etc.
- wasm COOP/COEP dependency (no SharedArrayBuffer needed)

**Add:**
- `const { invoke } = window.__TAURI__.core`
- `invoke("pick_files")` replaces `<input type="file">` click and drag-drop file gathering
- `invoke("process_file", { path, options })` replaces `pool.submit()`
- `invoke("apply_look", { id, look })` replaces `pool.reprocessLive()`
- `listen("file_progress", handler)` drives card state updates
- Upload button per card → `invoke("push_to_planner", payload)`
- Settings modal (token entry) → `invoke("set_token", { token })`

**Keep unchanged:**
- All gallery/grid rendering
- Lightbox (zoom, pan, rotate, source toggle)
- Look sliders and presets
- Stats log
- Embedded JPEG extraction and preview (pure JS, still useful for fast first-draw)
- All CSS

---

## Expedition Planner Backend — New Endpoint

**File:** `backend/routes/raw-images.ts`

```
POST /api/raw-images
Content-Type: application/json
Authorization: Bearer <token>

Body: {
  filename: string,
  jxl_b64: string,       // base64 JXL, up to ~30 MB decoded
  exif: ExifPayload,     // mirrors ExifData above
  // future fields added here without breaking old clients
}

Response 200: { ok: true, id: "rawimg_..." }
Response 401: { ok: false, error: "unauthorized" }
Response 413: { ok: false, error: "file too large" }
```

- Size limit: 50 MB request body
- Auth: validate `Authorization: Bearer` against a token stored in `backend/.env` as `RAW_UPLOAD_TOKEN`
- Storage: new SQLite table `raw_images` (id, filename, jxl_blob BLOB, exif_json TEXT, created_at). API receives base64, server decodes to binary before inserting — do not store base64 strings.
- Register route in `backend/server.ts` alongside existing routes

---

## Build Setup

### libjxl on Windows (one-time)

```powershell
# Install vcpkg and libjxl static
git clone https://github.com/microsoft/vcpkg C:\vcpkg
C:\vcpkg\bootstrap-vcpkg.bat
C:\vcpkg\vcpkg install libjxl:x64-windows-static

# Set env vars (add to user profile)
$env:VCPKG_ROOT = "C:\vcpkg"
$env:JPEGXL_SYS_VCPKG = "1"
```

`jpegxl-rs` in `src-tauri/Cargo.toml`:
```toml
jpegxl-rs = { version = "0.10", features = ["vendored"] }
```

`vendored` feature builds libjxl from source via cmake — avoids vcpkg entirely if cmake + ninja are installed. Prefer this.

### Dev workflow

```powershell
cargo tauri dev          # hot-reload webview, Rust recompiles on change
cargo tauri build        # produces installer in src-tauri/target/release/bundle/
```

wasm build (browser fallback, independent):
```powershell
wasm-pack build --target web
```

---

## Success Criteria

1. Tauri app opens, native file picker selects ORF files
2. Gallery renders thumbnails; lightbox opens with full-res RAW render
3. Look sliders update lightbox live (<200 ms round-trip)
4. JXL export produces identical file to browser tool at same quality/effort
5. "Upload to planner" button POSTs to expedition planner, card shows upload badge
6. Browser tool (`bun serve.ts`) still works unchanged
7. No wasm files loaded by Tauri app

---

## Out of Scope

- macOS / Linux builds (future)
- Approach B hybrid (wasm JXL) — superseded by C
- Tauri auto-updater
- Offline queue for push-when-planner-unavailable (beyond graceful error)
