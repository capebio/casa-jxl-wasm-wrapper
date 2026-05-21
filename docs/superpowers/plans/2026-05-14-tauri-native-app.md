# Tauri Native App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a native Tauri 2 desktop app (`C:\Foo\raw-converter-tauri\`) that runs the ORF→JXL pipeline natively in Rust and pushes results to the casabio-expedition-planner backend, while keeping the existing browser tool (`raw-converter-wasm\`) completely unchanged.

**Architecture:** A new sibling directory `C:\Foo\raw-converter-tauri\` contains a Cargo workspace with two members: `raw-pipeline` (pure-Rust port of the existing pipeline) and `src-tauri` (Tauri 2 app). The existing `raw-converter-wasm\` project is untouched except for a conditional Tauri code path added to `web\main.js`. The Tauri app loads `web\` from the sibling directory via a relative path in `tauri.conf.json`.

**Tech Stack:** Rust 1.77+, Tauri 2, jpegxl-rs 0.10 (vendored libjxl), rayon, dashmap 6, keyring 2, reqwest 0.12, tauri-plugin-dialog 2, tauri-plugin-store 2, tokio 1

---

## Scope Note

The backend endpoint (Task 13) lives in the `casabio-expedition-planner` repo. If that's a separate directory, complete Tasks 1–12 first and treat Task 13 as a standalone.

---

## File Map

**New directory: `C:\Foo\raw-converter-tauri\`**

| File | Responsibility |
|------|---------------|
| `Cargo.toml` | Workspace root (raw-pipeline + src-tauri) |
| `raw-pipeline/Cargo.toml` | Pure-Rust lib, no wasm-bindgen |
| `raw-pipeline/src/lib.rs` | pub use re-exports |
| `raw-pipeline/src/pipeline.rs` | Ported from `raw-converter-wasm/src/pipeline.rs` |
| `raw-pipeline/src/decompress.rs` | Ported (zero changes needed) |
| `raw-pipeline/src/demosaic.rs` | Ported (zero changes needed) |
| `raw-pipeline/src/tiff.rs` | Ported (zero changes needed) |
| `raw-pipeline/src/exif.rs` | NEW — ExifData, GpsData, Rational; OrfInfo→ExifData |
| `src-tauri/build.rs` | Tauri build script (required boilerplate) |
| `src-tauri/Cargo.toml` | Tauri 2 app + all runtime deps |
| `src-tauri/tauri.conf.json` | App metadata, frontendDist pointing to `../../raw-converter-wasm/web` |
| `src-tauri/capabilities/default.json` | Tauri 2 permissions |
| `src-tauri/src/main.rs` | 3-line entry point |
| `src-tauri/src/lib.rs` | AppState, command registration, `run()` |
| `src-tauri/src/pipeline.rs` | `process_file`, `apply_look`; all input/output types |
| `src-tauri/src/push.rs` | `push_to_planner`, `pick_files`, `get/set_token`, `get/set_settings` |

**Modified in `C:\Foo\raw-converter-wasm\`**

| File | Change |
|------|--------|
| `web/main.js` | Add `IS_TAURI` guard; Tauri invoke path alongside existing WorkerPool path |

---

## Task 1: Workspace scaffold

**Files:**
- Create: `C:\Foo\raw-converter-tauri\Cargo.toml`
- Create: `C:\Foo\raw-converter-tauri\raw-pipeline\Cargo.toml`
- Create: `C:\Foo\raw-converter-tauri\raw-pipeline\src\lib.rs`

- [ ] **Step 1: Create directory tree**

```powershell
New-Item -ItemType Directory -Force "C:\Foo\raw-converter-tauri\raw-pipeline\src"
New-Item -ItemType Directory -Force "C:\Foo\raw-converter-tauri\src-tauri\src"
New-Item -ItemType Directory -Force "C:\Foo\raw-converter-tauri\src-tauri\capabilities"
```

- [ ] **Step 2: Write workspace Cargo.toml**

`C:\Foo\raw-converter-tauri\Cargo.toml`:
```toml
[workspace]
members = ["raw-pipeline", "src-tauri"]
resolver = "2"
```

- [ ] **Step 3: Write raw-pipeline Cargo.toml**

`C:\Foo\raw-converter-tauri\raw-pipeline\Cargo.toml`:
```toml
[package]
name = "raw-pipeline"
version = "0.1.0"
edition = "2021"

[dependencies]
serde = { version = "1", features = ["derive"] }

[dev-dependencies]
# none needed yet
```

- [ ] **Step 4: Write placeholder lib.rs**

`C:\Foo\raw-converter-tauri\raw-pipeline\src\lib.rs`:
```rust
pub mod decompress;
pub mod demosaic;
pub mod exif;
pub mod pipeline;
pub mod tiff;
```

- [ ] **Step 5: Verify workspace parses**

```powershell
cd C:\Foo\raw-converter-tauri
cargo metadata --no-deps 2>&1 | Select-Object -First 5
```

Expected: JSON output with workspace members listed, no errors.

- [ ] **Step 6: Commit**

```powershell
cd C:\Foo\raw-converter-tauri
git init
git add Cargo.toml raw-pipeline/Cargo.toml raw-pipeline/src/lib.rs
git commit -m "chore: init raw-converter-tauri workspace"
```

---

## Task 2: Port raw-pipeline source files

The four pipeline source files (`decompress.rs`, `demosaic.rs`, `pipeline.rs`, `tiff.rs`) have zero wasm-bindgen dependencies — copy them verbatim. All wasm glue lives in `raw-converter-wasm/src/lib.rs` only.

**Files:**
- Create: `raw-pipeline/src/decompress.rs` (copy of `raw-converter-wasm/src/decompress.rs`)
- Create: `raw-pipeline/src/demosaic.rs` (copy of `raw-converter-wasm/src/demosaic.rs`)
- Create: `raw-pipeline/src/pipeline.rs` (copy of `raw-converter-wasm/src/pipeline.rs`)
- Create: `raw-pipeline/src/tiff.rs` (copy of `raw-converter-wasm/src/tiff.rs`)

- [ ] **Step 1: Write failing compile test**

`C:\Foo\raw-converter-tauri\raw-pipeline\src\lib.rs` — add at bottom:
```rust
#[cfg(test)]
mod compile_tests {
    use super::*;

    #[test]
    fn pipeline_params_default_builds() {
        let p = pipeline::PipelineParams::default_olympus();
        assert_eq!(p.black, 256);
        assert_eq!(p.white, 4095);
    }
}
```

- [ ] **Step 2: Run — expect compile failure (modules not yet populated)**

```powershell
cd C:\Foo\raw-converter-tauri
cargo test -p raw-pipeline 2>&1 | Select-Object -Last 10
```

Expected: error about missing module files.

- [ ] **Step 3: Copy decompress.rs**

```powershell
Copy-Item "C:\Foo\raw-converter-wasm\src\decompress.rs" `
          "C:\Foo\raw-converter-tauri\raw-pipeline\src\decompress.rs"
```

- [ ] **Step 4: Copy demosaic.rs**

```powershell
Copy-Item "C:\Foo\raw-converter-wasm\src\demosaic.rs" `
          "C:\Foo\raw-converter-tauri\raw-pipeline\src\demosaic.rs"
```

- [ ] **Step 5: Copy pipeline.rs**

```powershell
Copy-Item "C:\Foo\raw-converter-wasm\src\pipeline.rs" `
          "C:\Foo\raw-converter-tauri\raw-pipeline\src\pipeline.rs"
```

- [ ] **Step 6: Copy tiff.rs**

```powershell
Copy-Item "C:\Foo\raw-converter-wasm\src\tiff.rs" `
          "C:\Foo\raw-converter-tauri\raw-pipeline\src\tiff.rs"
```

- [ ] **Step 7: Run tests — expect pass**

```powershell
cd C:\Foo\raw-converter-tauri
cargo test -p raw-pipeline 2>&1
```

Expected: `test compile_tests::pipeline_params_default_builds ... ok`

- [ ] **Step 8: Add pipeline process smoke test**

Append to the `compile_tests` module in `raw-pipeline/src/lib.rs`:
```rust
    #[test]
    fn process_synthetic_black_frame() {
        // 4×4 RGGB at black level → output should be near-black
        let w = 4usize;
        let h = 4usize;
        let raw = vec![256u16; w * h]; // all pixels at black level
        let rgb16 = demosaic::demosaic_rggb(&raw, w, h).unwrap();
        let params = pipeline::PipelineParams::default_olympus();
        let rgb8 = pipeline::process(&rgb16, &params);
        // Every channel should be well below 50/255 (baseline exposure lifts a
        // pure-black frame slightly, but not above 50).
        assert!(rgb8.iter().all(|&v| v < 50),
            "expected near-black output, got max={}", rgb8.iter().max().unwrap());
    }
```

- [ ] **Step 9: Run — expect pass**

```powershell
cargo test -p raw-pipeline 2>&1
```

Expected: both tests `ok`.

- [ ] **Step 10: Commit**

```powershell
git add raw-pipeline/src/
git commit -m "feat(raw-pipeline): port pipeline source files from wasm crate"
```

---

## Task 3: Implement ExifData

**Files:**
- Create: `raw-pipeline/src/exif.rs`

- [ ] **Step 1: Write failing test**

`raw-pipeline/src/exif.rs` (create with test only):
```rust
use crate::tiff::OrfInfo;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Rational {
    pub num: u32,
    pub den: u32,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GpsData {
    pub lat: f64,
    pub lon: f64,
    pub alt: f64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ExifData {
    pub make: Option<String>,
    pub model: Option<String>,
    pub lens: Option<String>,
    pub datetime: Option<String>,
    pub exposure: Option<Rational>,
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

impl ExifData {
    pub fn from_orf_info(info: &OrfInfo, image_w: u32, image_h: u32) -> Self {
        todo!()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tiff::OrfInfo;

    fn make_info() -> OrfInfo {
        OrfInfo {
            width: 4608,
            height: 3456,
            bits_per_sample: 12,
            compression: 1,
            strip_offset: 0,
            strip_byte_count: 0,
            orientation: 1,
            make: "OLYMPUS IMAGING CORP.".to_string(),
            model: "E-M5".to_string(),
            wb_r: Some(1.78),
            wb_b: Some(1.50),
            color_matrix: None,
            black_level: 256,
            little_endian: true,
            wb_mode: Some(1),
            lens: "M.Zuiko 12-40".to_string(),
            datetime: "2024:03:15 10:30:00".to_string(),
            exposure: Some((1, 500)),
            fnumber: Some((28, 10)),
            iso: Some(200),
            focal_length: Some((40, 1)),
            focal_length_35: Some(80),
            gps_lat: Some(48.8566),
            gps_lon: Some(2.3522),
            gps_alt: Some(35.0),
            quality: Some(3),
        }
    }

    #[test]
    fn exif_from_orf_info_maps_all_fields() {
        let info = make_info();
        let exif = ExifData::from_orf_info(&info, 4608, 3456);

        assert_eq!(exif.make.as_deref(), Some("OLYMPUS IMAGING CORP."));
        assert_eq!(exif.model.as_deref(), Some("E-M5"));
        assert_eq!(exif.lens.as_deref(), Some("M.Zuiko 12-40"));
        assert_eq!(exif.datetime.as_deref(), Some("2024:03:15 10:30:00"));
        assert_eq!(exif.iso, Some(200));
        assert_eq!(exif.focal_length_35, Some(80u32));
        assert_eq!(exif.orientation, 1);
        assert_eq!(exif.width, Some(4608));
        assert_eq!(exif.height, Some(3456));
        assert_eq!(exif.wb_r, Some(1.78));
        assert_eq!(exif.wb_b, Some(1.50));
        assert!(exif.wb_from_camera);
        assert_eq!(exif.quality, Some(3));

        let exp = exif.exposure.unwrap();
        assert_eq!((exp.num, exp.den), (1, 500));

        let f = exif.fnumber.unwrap();
        assert_eq!((f.num, f.den), (28, 10));

        let gps = exif.gps.unwrap();
        assert!((gps.lat - 48.8566).abs() < 1e-4);
        assert!((gps.lon - 2.3522).abs() < 1e-4);
    }

    #[test]
    fn exif_from_orf_info_absent_fields() {
        let mut info = make_info();
        info.gps_lat = None;
        info.gps_lon = None;
        info.wb_r = None;
        info.wb_b = None;
        info.lens = String::new();
        info.datetime = String::new();
        let exif = ExifData::from_orf_info(&info, 4608, 3456);
        assert!(exif.gps.is_none());
        assert!(!exif.wb_from_camera);
        assert!(exif.lens.is_none());
        assert!(exif.datetime.is_none());
    }
}
```

- [ ] **Step 2: Run — expect failure (todo! panic)**

```powershell
cd C:\Foo\raw-converter-tauri
cargo test -p raw-pipeline exif 2>&1 | Select-Object -Last 15
```

Expected: test fails with `not yet implemented`.

- [ ] **Step 3: Implement `from_orf_info`**

Replace the `todo!()` body:
```rust
impl ExifData {
    pub fn from_orf_info(info: &OrfInfo, image_w: u32, image_h: u32) -> Self {
        let nonempty = |s: &str| if s.is_empty() { None } else { Some(s.to_string()) };

        let gps = if info.gps_lat.is_some() && info.gps_lon.is_some() {
            Some(GpsData {
                lat: info.gps_lat.unwrap(),
                lon: info.gps_lon.unwrap(),
                alt: info.gps_alt.unwrap_or(0.0),
            })
        } else {
            None
        };

        ExifData {
            make:           nonempty(&info.make),
            model:          nonempty(&info.model),
            lens:           nonempty(&info.lens),
            datetime:       nonempty(&info.datetime),
            exposure:       info.exposure.map(|(n, d)| Rational { num: n, den: d }),
            fnumber:        info.fnumber.map(|(n, d)| Rational { num: n, den: d }),
            iso:            info.iso,
            focal_length:   info.focal_length.map(|(n, d)| Rational { num: n, den: d }),
            focal_length_35: info.focal_length_35.map(|v| v as u32),
            gps,
            orientation:    info.orientation,
            width:          Some(image_w),
            height:         Some(image_h),
            wb_r:           info.wb_r,
            wb_b:           info.wb_b,
            wb_mode:        info.wb_mode,
            wb_from_camera: info.wb_r.is_some() && info.wb_b.is_some(),
            quality:        info.quality.map(|q| q as u8),
        }
    }
}
```

- [ ] **Step 4: Run — expect pass**

```powershell
cargo test -p raw-pipeline 2>&1
```

Expected: all tests `ok` (4 tests total).

- [ ] **Step 5: Commit**

```powershell
git add raw-pipeline/src/exif.rs raw-pipeline/src/lib.rs
git commit -m "feat(raw-pipeline): add ExifData with from_orf_info conversion"
```

---

## Task 4: Scaffold Tauri 2 app

**Files:**
- Create: `src-tauri/build.rs`
- Create: `src-tauri/Cargo.toml`
- Create: `src-tauri/tauri.conf.json`
- Create: `src-tauri/capabilities/default.json`
- Create: `src-tauri/src/main.rs`
- Create: `src-tauri/src/lib.rs`
- Create: `src-tauri/src/pipeline.rs` (stub)
- Create: `src-tauri/src/push.rs` (stub)

- [ ] **Step 1: Write src-tauri/build.rs**

```rust
fn main() {
    tauri_build::build()
}
```

- [ ] **Step 2: Write src-tauri/Cargo.toml**

```toml
[package]
name = "raw-converter-tauri"
version = "0.1.0"
edition = "2021"
default-run = "raw-converter-tauri"

[[bin]]
name = "raw-converter-tauri"
path = "src/main.rs"

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-dialog = "2"
tauri-plugin-store = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
raw-pipeline = { path = "../raw-pipeline" }
jpegxl-rs = { version = "0.10", features = ["vendored"] }
rayon = "1"
dashmap = "6"
keyring = { version = "2", features = ["windows-native"] }
reqwest = { version = "0.12", features = ["json"] }
base64 = "0.22"
tokio = { version = "1", features = ["rt-multi-thread", "macros"] }
atomic-counter = "1"
```

- [ ] **Step 3: Write tauri.conf.json**

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "RAW Converter",
  "version": "0.1.0",
  "identifier": "au.casabio.raw-converter",
  "build": {
    "frontendDist": "../../raw-converter-wasm/web",
    "devUrl": "http://localhost:1420"
  },
  "app": {
    "windows": [
      {
        "title": "RAW Converter",
        "width": 1280,
        "height": 800,
        "resizable": true
      }
    ],
    "security": {
      "csp": null
    }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": []
  }
}
```

- [ ] **Step 4: Write capabilities/default.json**

```json
{
  "$schema": "https://schema.tauri.app/config/2/capabilities",
  "identifier": "default",
  "description": "Default capabilities",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "dialog:allow-open",
    "store:allow-load",
    "store:allow-set",
    "store:allow-get",
    "store:allow-save"
  ]
}
```

- [ ] **Step 5: Write src/main.rs**

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    raw_converter_tauri_lib::run();
}
```

- [ ] **Step 6: Write stub src/pipeline.rs**

```rust
// Stub — implemented in Tasks 5 and 6.
```

- [ ] **Step 7: Write stub src/push.rs**

```rust
// Stub — implemented in Tasks 8–10.
```

- [ ] **Step 8: Write src/lib.rs**

```rust
pub mod pipeline;
pub mod push;

use tauri::Manager;

pub struct AppState {
    pub rgb16_cache: dashmap::DashMap<u64, pipeline::Rgb16State>,
    pub next_id: std::sync::atomic::AtomicU64,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            rgb16_cache: dashmap::DashMap::new(),
            next_id: std::sync::atomic::AtomicU64::new(1),
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            pipeline::process_file,
            pipeline::apply_look,
            push::pick_files,
            push::push_to_planner,
            push::get_token,
            push::set_token,
            push::get_settings,
            push::set_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error running Tauri application");
}
```

- [ ] **Step 9: Verify compile (stubs, commands not yet defined)**

Add temporary stub commands so it compiles. In `pipeline.rs`:
```rust
#[tauri::command]
pub async fn process_file() -> Result<(), String> { Ok(()) }
#[tauri::command]
pub async fn apply_look() -> Result<(), String> { Ok(()) }

pub struct Rgb16State {
    pub _placeholder: (),
}
```

In `push.rs`:
```rust
#[tauri::command]
pub async fn pick_files() -> Result<Vec<String>, String> { Ok(vec![]) }
#[tauri::command]
pub async fn push_to_planner() -> Result<(), String> { Ok(()) }
#[tauri::command]
pub async fn get_token() -> Result<Option<String>, String> { Ok(None) }
#[tauri::command]
pub async fn set_token() -> Result<(), String> { Ok(()) }
#[tauri::command]
pub async fn get_settings() -> Result<serde_json::Value, String> { Ok(serde_json::json!({})) }
#[tauri::command]
pub async fn set_settings() -> Result<(), String> { Ok(()) }
```

```powershell
cd C:\Foo\raw-converter-tauri
cargo build -p raw-converter-tauri 2>&1 | Select-Object -Last 20
```

Expected: compiles (may warn about unused variables in stubs — that's fine).

- [ ] **Step 10: Commit**

```powershell
git add src-tauri/
git commit -m "feat(tauri): scaffold Tauri 2 app with stub commands"
```

---

## Task 5: Implement `process_file` command

**Files:**
- Modify: `src-tauri/src/pipeline.rs`

- [ ] **Step 1: Write failing test for ProcessOptions deserialization**

In `src-tauri/src/pipeline.rs`, replace the stub with:
```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
pub struct LookOptions {
    pub exposure_ev: f32,
    pub contrast: f32,
    pub highlights: f32,
    pub shadows: f32,
    pub whites: f32,
    pub blacks: f32,
    pub saturation: f32,
    pub vibrance: f32,
    pub temp: f32,
    pub tint: f32,
    pub texture: f32,
    pub clarity: f32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProcessOptions {
    pub quality: u8,
    pub effort: u8,
    pub lossless: bool,
    pub look: LookOptions,
    pub user_rotation: i32,
    pub wb_r: Option<f32>,
    pub wb_b: Option<f32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RgbFrame {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct Timings {
    pub decompress_ms: u64,
    pub demosaic_ms: u64,
    pub tone_ms: u64,
    pub encode_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProcessResult {
    pub id: u64,
    pub thumb: RgbFrame,
    pub lightbox: RgbFrame,
    pub jxl: Vec<u8>,
    pub exif: raw_pipeline::exif::ExifData,
    pub timings: Timings,
}

pub struct Rgb16State {
    pub data: Vec<u16>,
    pub width: usize,
    pub height: usize,
    pub wb_r: f32,
    pub wb_b: f32,
    pub orientation: u16,
    pub color_matrix: Option<[[f32; 3]; 3]>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn look_options_default_finite() {
        let look = LookOptions {
            exposure_ev: 0.0, contrast: 0.0, highlights: 0.0, shadows: 0.0,
            whites: 0.0, blacks: 0.0, saturation: 0.0, vibrance: 0.0,
            temp: 0.0, tint: 0.0, texture: 0.0, clarity: 0.0,
        };
        assert!(look.exposure_ev.is_finite());
    }

    #[test]
    fn process_options_deserializes() {
        let json = r#"{
            "quality": 85, "effort": 7, "lossless": false,
            "user_rotation": 0, "wb_r": null, "wb_b": null,
            "look": {
                "exposure_ev": 0.0, "contrast": 0.0, "highlights": 0.0,
                "shadows": 0.0, "whites": 0.0, "blacks": 0.0,
                "saturation": 0.0, "vibrance": 0.0, "temp": 0.0,
                "tint": 0.0, "texture": 0.0, "clarity": 0.0
            }
        }"#;
        let opts: ProcessOptions = serde_json::from_str(json).unwrap();
        assert_eq!(opts.quality, 85);
        assert_eq!(opts.effort, 7);
        assert!(!opts.lossless);
    }
}
```

- [ ] **Step 2: Run — expect pass**

```powershell
cargo test -p raw-converter-tauri 2>&1
```

Expected: `look_options_default_finite ... ok`, `process_options_deserializes ... ok`.

- [ ] **Step 3: Implement `process_file` command body**

Add below the types and tests (before the `#[cfg(test)]` block):

```rust
fn build_params_from_look(
    look: &LookOptions,
    wb_r_override: Option<f32>,
    wb_b_override: Option<f32>,
    info: &raw_pipeline::tiff::OrfInfo,
) -> raw_pipeline::pipeline::PipelineParams {
    let mut params = raw_pipeline::pipeline::PipelineParams::default_olympus();
    let wb_from_camera = info.wb_r.is_some() && info.wb_b.is_some();
    if wb_from_camera {
        if let Some(r) = info.wb_r { params.wb_r = r; }
        if let Some(b) = info.wb_b { params.wb_b = b; }
    } else {
        // gray-world fallback not available here (need raw pixels); caller
        // pre-computes and passes wb_r/wb_b via override when wb absent.
        // Default Olympus WB stays as fallback.
    }
    if let Some(m) = info.color_matrix { params.color_matrix = Some(m); }
    if let Some(r) = wb_r_override { if r > 0.0 { params.wb_r = r; } }
    if let Some(b) = wb_b_override { if b > 0.0 { params.wb_b = b; } }

    if look.exposure_ev.is_finite()  { params.exposure_ev = look.exposure_ev; }
    if look.contrast.is_finite()     { params.contrast    = look.contrast; }
    if look.highlights.is_finite()   { params.highlights  = look.highlights; }
    if look.shadows.is_finite()      { params.shadows     = look.shadows; }
    if look.whites.is_finite()       { params.whites      = look.whites; }
    if look.blacks.is_finite()       { params.blacks      = look.blacks; }
    if look.saturation.is_finite()   { params.saturation  = look.saturation; }
    if look.vibrance.is_finite()     { params.vibrance    = look.vibrance; }
    if look.temp.is_finite()         { params.temp        = look.temp; }
    if look.tint.is_finite()         { params.tint        = look.tint; }
    if look.texture.is_finite()      { params.texture     = look.texture; }
    if look.clarity.is_finite()      { params.clarity     = look.clarity; }
    params
}

fn downscale_rgb16(src: &[u16], sw: usize, sh: usize, dw: usize, dh: usize) -> Vec<u8> {
    let xr = sw as f32 / dw as f32;
    let yr = sh as f32 / dh as f32;
    let mut out = vec![0u8; dw * dh * 6];
    for dy in 0..dh {
        let y0 = (dy as f32 * yr) as usize;
        let y1 = ((dy as f32 + 1.0) * yr).min(sh as f32) as usize;
        let y1 = y1.max(y0 + 1);
        for dx in 0..dw {
            let x0 = (dx as f32 * xr) as usize;
            let x1 = ((dx as f32 + 1.0) * xr).min(sw as f32) as usize;
            let x1 = x1.max(x0 + 1);
            let (mut rr, mut gg, mut bb, mut n) = (0u32, 0u32, 0u32, 0u32);
            for y in y0..y1 {
                for x in x0..x1 {
                    let i = (y * sw + x) * 3;
                    rr += src[i] as u32; gg += src[i+1] as u32; bb += src[i+2] as u32; n += 1;
                }
            }
            let n = n.max(1);
            let o = (dy * dw + dx) * 6;
            let rv = (rr / n) as u16; let gv = (gg / n) as u16; let bv = (bb / n) as u16;
            out[o]   = (rv & 0xff) as u8; out[o+1] = (rv >> 8) as u8;
            out[o+2] = (gv & 0xff) as u8; out[o+3] = (gv >> 8) as u8;
            out[o+4] = (bv & 0xff) as u8; out[o+5] = (bv >> 8) as u8;
        }
    }
    out
}

fn encode_jxl(rgb8: &[u8], width: u32, height: u32, quality: u8, effort: u8, lossless: bool) -> Result<Vec<u8>, String> {
    use jpegxl_rs::encode::{EncoderFrame, EncoderResult, JxlEncoder};
    use jpegxl_rs::encode::EncoderSpeed;

    let mut encoder = JxlEncoder::new().map_err(|e| e.to_string())?;
    if lossless {
        encoder.lossless = true;
    } else {
        encoder.quality = quality as f32;
    }
    encoder.speed = match effort {
        1 => EncoderSpeed::Lightning,
        2 => EncoderSpeed::Thunder,
        3 => EncoderSpeed::Falcon,
        4 => EncoderSpeed::Cheetah,
        5 => EncoderSpeed::Hare,
        6 => EncoderSpeed::Wombat,
        7 => EncoderSpeed::Squirrel,
        8 => EncoderSpeed::Kitten,
        _ => EncoderSpeed::Tortoise,
    };
    let frame = EncoderFrame::new(rgb8).num_channels(3);
    let result: EncoderResult<Vec<u8>> = encoder
        .encode_frame(&frame, width, height)
        .map_err(|e| e.to_string())?;
    Ok(result.data)
}

#[tauri::command]
pub async fn process_file(
    path: String,
    options: ProcessOptions,
    state: tauri::State<'_, crate::AppState>,
) -> Result<ProcessResult, String> {
    let options = options.clone();

    let (result, id) = tokio::task::spawn_blocking({
        let state_rgb16 = state.rgb16_cache.clone();
        let next_id = &state.next_id;
        let id = next_id.fetch_add(1, std::sync::atomic::Ordering::Relaxed);

        move || -> Result<(ProcessResult, u64), String> {
            let data = std::fs::read(&path).map_err(|e| e.to_string())?;

            let t0 = std::time::Instant::now();
            let info = raw_pipeline::tiff::parse(&data).map_err(|e| e.to_string())?;

            if info.compression != 1 {
                return Err(format!("compression {} not supported", info.compression));
            }
            let w = info.width as usize;
            let h = info.height as usize;
            let strip_end = info.strip_offset as usize + info.strip_byte_count as usize;
            let strip = &data[info.strip_offset as usize..strip_end];

            let t_decomp = std::time::Instant::now();
            let raw = raw_pipeline::decompress::decompress(strip, w, h)
                .map_err(|e| e.to_string())?;
            let decompress_ms = t_decomp.elapsed().as_millis() as u64;

            let mut params = build_params_from_look(&options.look, options.wb_r, options.wb_b, &info);

            // Gray-world fallback when camera didn't store WB
            let wb_from_camera = info.wb_r.is_some() && info.wb_b.is_some();
            if !wb_from_camera && options.wb_r.is_none() {
                let (ar, ab) = raw_pipeline::pipeline::auto_wb_rggb(&raw, w, h, params.black);
                params.wb_r = ar;
                params.wb_b = ab;
            }

            let t_demosaic = std::time::Instant::now();
            let mut rgb16 = raw_pipeline::demosaic::demosaic_rggb(&raw, w, h)
                .map_err(|e| e.to_string())?;
            let demosaic_ms = t_demosaic.elapsed().as_millis() as u64;
            drop(raw);

            // Cache lightbox-sized rgb16 for apply_look
            const LB_LONG_EDGE: usize = 1800;
            let (lb_w, lb_h) = if w >= h {
                let lw = w.min(LB_LONG_EDGE); (lw, ((h * lw) / w).max(1))
            } else {
                let lh = h.min(LB_LONG_EDGE); (((w * lh) / h).max(1), lh)
            };
            let rgb16_lb_bytes = downscale_rgb16(&rgb16, w, h, lb_w, lb_h);
            let rgb16_lb_u16: Vec<u16> = rgb16_lb_bytes.chunks_exact(2)
                .map(|b| u16::from_le_bytes([b[0], b[1]])).collect();

            // Thumb
            const THUMB_LONG_EDGE: usize = 360;
            let (thumb_w, thumb_h) = if w >= h {
                let tw = w.min(THUMB_LONG_EDGE); (tw, ((h * tw) / w).max(1))
            } else {
                let th = h.min(THUMB_LONG_EDGE); (((w * th) / h).max(1), th)
            };
            let rgb16_thumb_bytes = downscale_rgb16(&rgb16, w, h, thumb_w, thumb_h);
            let rgb16_thumb_u16: Vec<u16> = rgb16_thumb_bytes.chunks_exact(2)
                .map(|b| u16::from_le_bytes([b[0], b[1]])).collect();

            let t_tone = std::time::Instant::now();
            if params.texture != 0.0 || params.clarity != 0.0 {
                raw_pipeline::pipeline::apply_unsharp_masks(&mut rgb16, w, h, &params);
            }
            let rgb8 = raw_pipeline::pipeline::process(&rgb16, &params);
            let tone_ms = t_tone.elapsed().as_millis() as u64;
            drop(rgb16);

            // Apply EXIF + user rotation
            let effective_orientation = match options.user_rotation.rem_euclid(4) {
                0 => info.orientation,
                1 => 6,  // 90° CW
                2 => 3,  // 180°
                3 => 8,  // 90° CCW
                _ => info.orientation,
            };
            let (final_rgb, final_w, final_h) =
                raw_pipeline::pipeline::apply_orientation(&rgb8, w, h, effective_orientation);
            drop(rgb8);

            // Tonemap lightbox + thumb downscales
            let lb_rgb8 = {
                let mut lp = params.clone();
                raw_pipeline::pipeline::process(&rgb16_lb_u16, &lp)
            };
            let (lb_final, lb_fw, lb_fh) =
                raw_pipeline::pipeline::apply_orientation(&lb_rgb8, lb_w, lb_h, effective_orientation);

            let thumb_rgb8 = raw_pipeline::pipeline::process(&rgb16_thumb_u16, &params);
            let (th_final, th_fw, th_fh) =
                raw_pipeline::pipeline::apply_orientation(&thumb_rgb8, thumb_w, thumb_h, effective_orientation);

            // JXL encode full-res
            let t_enc = std::time::Instant::now();
            let jxl = encode_jxl(&final_rgb, final_w as u32, final_h as u32,
                                   options.quality, options.effort, options.lossless)?;
            let encode_ms = t_enc.elapsed().as_millis() as u64;

            // Evict oldest entries beyond limit of 50
            if state_rgb16.len() >= 50 {
                state_rgb16.clear();
            }
            state_rgb16.insert(id, Rgb16State {
                data: rgb16_lb_u16,
                width: lb_w,
                height: lb_h,
                wb_r: params.wb_r,
                wb_b: params.wb_b,
                orientation: effective_orientation,
                color_matrix: params.color_matrix,
            });

            let exif = raw_pipeline::exif::ExifData::from_orf_info(&info, w as u32, h as u32);

            Ok((ProcessResult {
                id,
                thumb: RgbFrame { data: th_final, width: th_fw as u32, height: th_fh as u32 },
                lightbox: RgbFrame { data: lb_final, width: lb_fw as u32, height: lb_fh as u32 },
                jxl,
                exif,
                timings: Timings { decompress_ms, demosaic_ms, tone_ms, encode_ms },
            }, id))
        }
    }).await.map_err(|e| e.to_string())??;

    Ok(result)
}
```

**Note on jpegxl-rs API:** The `EncoderFrame`, `EncoderSpeed`, and field names above match jpegxl-rs 0.10 patterns. If cargo reports missing items, check `cargo doc -p jpegxl-rs --open` for the exact API surface.

**Note on `params.clone()`:** `PipelineParams` doesn't derive `Clone` in the ported source. Add `#[derive(Clone)]` to `PipelineParams` in `raw-pipeline/src/pipeline.rs`.

- [ ] **Step 4: Add `#[derive(Clone)]` to `PipelineParams`**

Open `raw-pipeline/src/pipeline.rs`, find:
```rust
pub struct PipelineParams {
```
Change to:
```rust
#[derive(Clone)]
pub struct PipelineParams {
```

- [ ] **Step 5: Compile check (no test ORF available yet)**

```powershell
cargo build -p raw-converter-tauri 2>&1 | Select-Object -Last 20
```

Expected: compiles. Resolve any jpegxl-rs API errors by inspecting `cargo doc -p jpegxl-rs`.

- [ ] **Step 6: Commit**

```powershell
git add src-tauri/src/pipeline.rs raw-pipeline/src/pipeline.rs
git commit -m "feat(tauri): implement process_file command with full pipeline"
```

---

## Task 6: Implement `apply_look` command

**Files:**
- Modify: `src-tauri/src/pipeline.rs`

- [ ] **Step 1: Write failing test for apply_look logic**

Append to `tests` module in `src-tauri/src/pipeline.rs`:
```rust
    #[test]
    fn apply_look_result_has_correct_pixel_count() {
        // Synthetic lb rgb16: 10×10 all at mid-level (32767)
        let w = 10usize; let h = 10usize;
        let data = vec![32767u16; w * h * 3];
        let look = LookOptions {
            exposure_ev: 0.0, contrast: 0.0, highlights: 0.0, shadows: 0.0,
            whites: 0.0, blacks: 0.0, saturation: 0.0, vibrance: 0.0,
            temp: 0.0, tint: 0.0, texture: 0.0, clarity: 0.0,
        };
        let rgb_state = Rgb16State {
            data: data.clone(),
            width: w, height: h,
            wb_r: 1.78, wb_b: 1.50,
            orientation: 1,
            color_matrix: None,
        };
        // Call the pure helper (not the Tauri command)
        let out = apply_look_inner(&rgb_state, &look);
        assert_eq!(out.data.len(), w * h * 3);
        assert_eq!(out.width, w as u32);
        assert_eq!(out.height, h as u32);
    }
```

- [ ] **Step 2: Implement `apply_look_inner` helper and `apply_look` command**

Add above the `#[cfg(test)]` block:
```rust
pub fn apply_look_inner(state: &Rgb16State, look: &LookOptions) -> RgbFrame {
    let mut params = raw_pipeline::pipeline::PipelineParams::default_olympus();
    params.wb_r = state.wb_r;
    params.wb_b = state.wb_b;
    if let Some(m) = state.color_matrix { params.color_matrix = Some(m); }
    if look.exposure_ev.is_finite()  { params.exposure_ev = look.exposure_ev; }
    if look.contrast.is_finite()     { params.contrast    = look.contrast; }
    if look.highlights.is_finite()   { params.highlights  = look.highlights; }
    if look.shadows.is_finite()      { params.shadows     = look.shadows; }
    if look.whites.is_finite()       { params.whites      = look.whites; }
    if look.blacks.is_finite()       { params.blacks      = look.blacks; }
    if look.saturation.is_finite()   { params.saturation  = look.saturation; }
    if look.vibrance.is_finite()     { params.vibrance    = look.vibrance; }
    if look.temp.is_finite()         { params.temp        = look.temp; }
    if look.tint.is_finite()         { params.tint        = look.tint; }
    if look.texture.is_finite()      { params.texture     = look.texture; }
    if look.clarity.is_finite()      { params.clarity     = look.clarity; }

    let w = state.width; let h = state.height;
    let mut rgb16 = state.data.clone();
    if params.texture != 0.0 || params.clarity != 0.0 {
        raw_pipeline::pipeline::apply_unsharp_masks(&mut rgb16, w, h, &params);
    }
    let rgb8 = raw_pipeline::pipeline::process(&rgb16, &params);
    let (final_rgb, fw, fh) =
        raw_pipeline::pipeline::apply_orientation(&rgb8, w, h, state.orientation);
    RgbFrame { data: final_rgb, width: fw as u32, height: fh as u32 }
}

#[tauri::command]
pub async fn apply_look(
    id: u64,
    look: LookOptions,
    state: tauri::State<'_, crate::AppState>,
) -> Result<RgbFrame, String> {
    let entry = state.rgb16_cache.get(&id)
        .ok_or_else(|| format!("apply_look: id {} not found in cache", id))?;
    let result = tokio::task::spawn_blocking({
        let rgb_state = Rgb16State {
            data: entry.data.clone(),
            width: entry.width,
            height: entry.height,
            wb_r: entry.wb_r,
            wb_b: entry.wb_b,
            orientation: entry.orientation,
            color_matrix: entry.color_matrix,
        };
        let look = look.clone();
        move || apply_look_inner(&rgb_state, &look)
    }).await.map_err(|e| e.to_string())?;
    Ok(result)
}
```

- [ ] **Step 3: Run tests — expect pass**

```powershell
cargo test -p raw-converter-tauri 2>&1
```

Expected: `apply_look_result_has_correct_pixel_count ... ok`.

- [ ] **Step 4: Commit**

```powershell
git add src-tauri/src/pipeline.rs
git commit -m "feat(tauri): implement apply_look command with rgb16 cache"
```

---

## Task 7: Implement `pick_files`, token, and settings commands

**Files:**
- Modify: `src-tauri/src/push.rs`

- [ ] **Step 1: Write failing test for settings deserialization**

Replace stub `push.rs`:
```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    pub planner_url: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self { planner_url: "http://localhost:3001".to_string() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_default_url() {
        let s = AppSettings::default();
        assert_eq!(s.planner_url, "http://localhost:3001");
    }

    #[test]
    fn settings_round_trips_json() {
        let s = AppSettings { planner_url: "http://192.168.1.5:3001".to_string() };
        let json = serde_json::to_string(&s).unwrap();
        let back: AppSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(back.planner_url, s.planner_url);
    }
}
```

- [ ] **Step 2: Run — expect pass**

```powershell
cargo test -p raw-converter-tauri 2>&1 | grep "push"
```

Expected: both settings tests `ok`.

- [ ] **Step 3: Implement all commands in push.rs**

Add below the types:
```rust
const SERVICE_NAME: &str = "au.casabio.raw-converter";
const ACCOUNT_NAME: &str = "planner-token";
const SETTINGS_KEY: &str = "settings";

#[tauri::command]
pub async fn pick_files(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let paths = app.dialog()
        .file()
        .add_filter("Olympus RAW", &["orf", "ORF"])
        .blocking_pick_files();
    Ok(paths.unwrap_or_default()
        .into_iter()
        .map(|p| p.to_string())
        .collect())
}

#[tauri::command]
pub async fn get_token() -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(SERVICE_NAME, ACCOUNT_NAME)
        .map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn set_token(token: String) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE_NAME, ACCOUNT_NAME)
        .map_err(|e| e.to_string())?;
    entry.set_password(&token).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_settings(app: tauri::AppHandle) -> Result<AppSettings, String> {
    use tauri_plugin_store::StoreExt;
    let store = app.store("settings.json").map_err(|e| e.to_string())?;
    match store.get(SETTINGS_KEY) {
        Some(val) => serde_json::from_value(val).map_err(|e| e.to_string()),
        None => Ok(AppSettings::default()),
    }
}

#[tauri::command]
pub async fn set_settings(app: tauri::AppHandle, settings: AppSettings) -> Result<(), String> {
    use tauri_plugin_store::StoreExt;
    let store = app.store("settings.json").map_err(|e| e.to_string())?;
    store.set(SETTINGS_KEY, serde_json::to_value(&settings).map_err(|e| e.to_string())?);
    store.save().map_err(|e| e.to_string())
}

// push_to_planner — implemented in Task 8
#[tauri::command]
pub async fn push_to_planner() -> Result<(), String> { Ok(()) }
```

- [ ] **Step 4: Compile check**

```powershell
cargo build -p raw-converter-tauri 2>&1 | Select-Object -Last 10
```

Expected: compiles.

- [ ] **Step 5: Commit**

```powershell
git add src-tauri/src/push.rs
git commit -m "feat(tauri): implement pick_files, token, and settings commands"
```

---

## Task 8: Implement `push_to_planner`

**Files:**
- Modify: `src-tauri/src/push.rs`

- [ ] **Step 1: Write failing test for PushPayload serialization**

Add to `tests` module in `push.rs`:
```rust
    #[test]
    fn push_payload_serializes_correctly() {
        let payload = PushPayload {
            filename: "IMG_0001.ORF".to_string(),
            jxl_b64: base64::Engine::encode(
                &base64::engine::general_purpose::STANDARD, b"fakejxlbytes"),
            exif: serde_json::json!({}),
            planner_url: "http://localhost:3001".to_string(),
            token: "tok_test".to_string(),
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("IMG_0001.ORF"));
        assert!(json.contains("planner_url"));
    }
```

Add to imports at top of push.rs:
```rust
use base64::Engine as _;
```

- [ ] **Step 2: Define PushPayload and PushResult types**

Add below `AppSettings`:
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PushPayload {
    pub filename: String,
    pub jxl_b64: String,
    pub exif: serde_json::Value,
    pub planner_url: String,
    pub token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PushResult {
    pub ok: bool,
    pub id: Option<String>,
    pub error: Option<String>,
}
```

- [ ] **Step 3: Run test — expect compile error (base64 Engine not in scope)**

```powershell
cargo test -p raw-converter-tauri push 2>&1 | Select-Object -Last 10
```

Expected: compiles and `push_payload_serializes_correctly ... ok`.

- [ ] **Step 4: Implement `push_to_planner` command**

Replace the stub `push_to_planner`:
```rust
#[tauri::command]
pub async fn push_to_planner(payload: PushPayload) -> Result<PushResult, String> {
    use reqwest::StatusCode;

    let url = format!("{}/api/raw-images", payload.planner_url.trim_end_matches('/'));
    let body = serde_json::json!({
        "filename": payload.filename,
        "jxl_b64": payload.jxl_b64,
        "exif": payload.exif,
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .post(&url)
        .bearer_auth(&payload.token)
        .json(&body)
        .send()
        .await;

    match resp {
        Ok(r) if r.status() == StatusCode::OK => {
            let json: serde_json::Value = r.json().await.unwrap_or_default();
            Ok(PushResult {
                ok: true,
                id: json["id"].as_str().map(String::from),
                error: None,
            })
        }
        Ok(r) => {
            let status = r.status();
            let body = r.text().await.unwrap_or_default();
            Ok(PushResult {
                ok: false,
                id: None,
                error: Some(format!("HTTP {}: {}", status, body)),
            })
        }
        Err(e) => Ok(PushResult {
            ok: false,
            id: None,
            error: Some(e.to_string()),
        }),
    }
}
```

- [ ] **Step 5: Compile check**

```powershell
cargo build -p raw-converter-tauri 2>&1 | Select-Object -Last 10
```

Expected: compiles.

- [ ] **Step 6: Commit**

```powershell
git add src-tauri/src/push.rs
git commit -m "feat(tauri): implement push_to_planner with reqwest"
```

---

## Task 9: Wire `file_progress` events

**Files:**
- Modify: `src-tauri/src/pipeline.rs`

The spec emits per-stage progress for multi-file batches. `process_file` handles one file; the JS loop submits multiple invokes concurrently and each fires events as it progresses.

- [ ] **Step 1: Add progress event emission to `process_file`**

`process_file` needs a `window: tauri::Window` parameter and a helper. Add at the top of the command:

```rust
#[derive(Debug, Clone, Serialize)]
struct FileProgress<'a> {
    path: &'a str,
    stage: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'a str>,
}
```

Modify `process_file` signature:
```rust
#[tauri::command]
pub async fn process_file(
    path: String,
    options: ProcessOptions,
    state: tauri::State<'_, crate::AppState>,
    window: tauri::Window,
) -> Result<ProcessResult, String> {
```

Add progress emission macro inside spawn_blocking closure — emit via `window.emit`:
- After parse: `window.emit("file_progress", FileProgress { path: &path, stage: "decoding", error: None }).ok();`
- After demosaic: `window.emit("file_progress", FileProgress { path: &path, stage: "pipeline", error: None }).ok();`  
- After JXL encode: `window.emit("file_progress", FileProgress { path: &path, stage: "encoding", error: None }).ok();`
- On success return: `window.emit("file_progress", FileProgress { path: &path, stage: "done", error: None }).ok();`
- On error: `window.emit("file_progress", FileProgress { path: &path, stage: "error", error: Some(&err) }).ok();`

Since `window` can't be sent across threads, emit before entering `spawn_blocking` or use `app_handle`:

Change parameter to `app: tauri::AppHandle` and emit via `app.emit`:
```rust
pub async fn process_file(
    path: String,
    options: ProcessOptions,
    state: tauri::State<'_, crate::AppState>,
    app: tauri::AppHandle,
) -> Result<ProcessResult, String> {
    app.emit("file_progress", serde_json::json!({
        "path": path, "stage": "decoding"
    })).ok();
    // ... spawn_blocking ...
    // emit "pipeline", "encoding", "done" at appropriate points
    // On error path:
    //   app.emit("file_progress", json!({"path": path, "stage": "error", "error": err_msg})).ok();
```

- [ ] **Step 2: Update `lib.rs` invoke_handler** (no change needed — `app: tauri::AppHandle` is injected automatically by Tauri)

- [ ] **Step 3: Compile check**

```powershell
cargo build -p raw-converter-tauri 2>&1 | Select-Object -Last 10
```

Expected: compiles.

- [ ] **Step 4: Commit**

```powershell
git add src-tauri/src/pipeline.rs
git commit -m "feat(tauri): emit file_progress events from process_file"
```

---

## Task 10: Frontend — add Tauri code path to web/main.js

**Files:**
- Modify: `C:\Foo\raw-converter-wasm\web\main.js`

Strategy: add `IS_TAURI` guard at the top; keep WorkerPool for browser. The file picker, batch submit, and live-look paths branch on `IS_TAURI`. All gallery/lightbox rendering, CSS, look sliders stay untouched.

- [ ] **Step 1: Read current file-input and pool.submit call sites**

```powershell
Select-String -Path "C:\Foo\raw-converter-wasm\web\main.js" -Pattern "pool\.|fileInput|drop.*files|file-input" | Select-Object -First 30
```

Note the exact line numbers for each call site before editing.

- [ ] **Step 2: Add IS_TAURI guard and Tauri imports at top of main.js**

After the `BUILD_TAG` constant (around line 14), add:
```js
const IS_TAURI = typeof window !== 'undefined' && !!window.__TAURI__;
const { invoke, listen } = IS_TAURI ? window.__TAURI__.core : {};
```

- [ ] **Step 3: Add Tauri file-picker path alongside existing drag-drop / input path**

Find the `pick` button click handler and `fileInput change` handler. Wrap the existing logic in `if (!IS_TAURI)` and add a Tauri branch:

```js
// Tauri path — replaces drag-drop and file-input
if (IS_TAURI) {
    pick.addEventListener('click', async () => {
        const paths = await invoke('pick_files');
        if (paths.length > 0) startBatchTauri(paths);
    });
    // Disable drag-drop in Tauri (native picker only)
    drop.addEventListener('dragover', e => e.preventDefault());
    drop.addEventListener('drop', e => e.preventDefault());
} else {
    // existing drag-drop + fileInput handlers stay here
    pick.addEventListener('click', () => fileInput.click());
    // ... existing code ...
}
```

- [ ] **Step 4: Add `startBatchTauri` function**

Add below the existing `startBatch` function (or wherever `cards` and `pool.submit` are managed):
```js
async function startBatchTauri(paths) {
    // Build card placeholders (reuse existing createCard() if present, else minimal version)
    for (const path of paths) {
        const filename = path.split(/[\\/]/).pop();
        const card = createCard(filename); // existing helper
        grid.appendChild(card);
    }

    // Listen for progress events
    const unlisten = await listen('file_progress', ({ payload }) => {
        const card = findCardByFilename(payload.path.split(/[\\/]/).pop());
        if (!card) return;
        if (payload.stage === 'done') setCardDone(card);
        else if (payload.stage === 'error') setCardError(card, payload.error);
        else setCardStage(card, payload.stage);
    });

    // Submit all files concurrently
    const look = getCurrentLook(); // existing helper that reads slider values
    await Promise.allSettled(paths.map(async (path) => {
        try {
            const result = await invoke('process_file', {
                path,
                options: {
                    quality: getQuality(),
                    effort: getEffort(),
                    lossless: false,
                    look,
                    user_rotation: 0,
                    wb_r: null,
                    wb_b: null,
                },
            });
            // result: { id, thumb, lightbox, jxl, exif, timings }
            const filename = path.split(/[\\/]/).pop();
            onFileDone(filename, result); // see step 5
        } catch (err) {
            console.error('process_file failed:', path, err);
        }
    }));

    unlisten();
}
```

- [ ] **Step 5: Add `onFileDone` to update card with thumb + store lightbox data**

```js
function onFileDone(filename, result) {
    const card = findCardByFilename(filename);
    if (!card) return;

    // Draw thumb onto card canvas
    const canvas = card.querySelector('canvas');
    if (canvas) {
        const ctx = canvas.getContext('2d');
        const { data, width, height } = result.thumb;
        const imgData = new ImageData(
            new Uint8ClampedArray(rgbToRgba(data)), width, height);
        canvas.width = width; canvas.height = height;
        ctx.putImageData(imgData, 0, 0);
    }

    // Store result on card for lightbox + download
    card._tauriResult = result;

    // Download JXL button
    const dlBtn = card.querySelector('.dl-btn');
    if (dlBtn) {
        dlBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const blob = new Blob([new Uint8Array(result.jxl)], { type: 'image/jxl' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = filename.replace(/\.orf$/i, '.jxl');
            a.click(); URL.revokeObjectURL(url);
        });
    }
}

function rgbToRgba(rgb) {
    const rgba = new Uint8ClampedArray(rgb.length / 3 * 4);
    for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
        rgba[j] = rgb[i]; rgba[j+1] = rgb[i+1]; rgba[j+2] = rgb[i+2]; rgba[j+3] = 255;
    }
    return rgba;
}
```

- [ ] **Step 6: Add live-look path for Tauri lightbox**

In the lightbox look-slider event handler (find where `pool.reprocessLive` is called), add Tauri branch:

```js
async function reprocessLive() {
    if (!currentCard) return;
    if (IS_TAURI) {
        if (!currentCard._tauriResult) return;
        const { id } = currentCard._tauriResult;
        const result = await invoke('apply_look', { id, look: getCurrentLook() });
        drawLightbox(result.data, result.width, result.height);
    } else {
        pool.reprocessLive(/* existing args */);
    }
}
```

- [ ] **Step 7: Add settings modal for token entry**

Add a settings button to the toolbar (find where toolbar buttons are built in main.js or index.html — check which file has the toolbar):

In `web/index.html`, add button near the existing controls:
```html
<button id="settings-btn" title="Planner Settings">⚙</button>
<dialog id="settings-dialog">
  <form method="dialog">
    <label>Bearer token<input id="token-input" type="password" autocomplete="off"></label>
    <label>Planner URL<input id="planner-url-input" type="url" value="http://localhost:3001"></label>
    <button type="submit">Save</button>
  </form>
</dialog>
```

In `main.js`, add (only when `IS_TAURI`):
```js
if (IS_TAURI) {
    const settingsBtn = document.getElementById('settings-btn');
    const settingsDialog = document.getElementById('settings-dialog');
    const tokenInput = document.getElementById('token-input');
    const plannerUrlInput = document.getElementById('planner-url-input');

    // Load current settings on open
    settingsBtn.addEventListener('click', async () => {
        const settings = await invoke('get_settings');
        plannerUrlInput.value = settings.planner_url;
        const token = await invoke('get_token');
        tokenInput.value = token ? '••••••••' : '';
        settingsDialog.showModal();
    });

    settingsDialog.addEventListener('close', async () => {
        // Only save if user explicitly submitted (not ESC)
        if (settingsDialog.returnValue === '') return;
        if (tokenInput.value && !tokenInput.value.startsWith('•')) {
            await invoke('set_token', { token: tokenInput.value });
        }
        await invoke('set_settings', {
            settings: { planner_url: plannerUrlInput.value }
        });
    });
}
```

- [ ] **Step 8: Add upload button per card**

In the card template (wherever cards are created — likely `createCard()`), add:
```js
if (IS_TAURI) {
    const uploadBtn = document.createElement('button');
    uploadBtn.className = 'upload-btn';
    uploadBtn.textContent = '↑';
    uploadBtn.title = 'Upload to planner';
    uploadBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!card._tauriResult) return;
        uploadBtn.disabled = true;
        uploadBtn.textContent = '…';
        try {
            const settings = await invoke('get_settings');
            const token = await invoke('get_token') ?? '';
            const { jxl, exif } = card._tauriResult;
            const jxl_b64 = btoa(String.fromCharCode(...new Uint8Array(jxl)));
            const result = await invoke('push_to_planner', {
                payload: {
                    filename: card._filename,
                    jxl_b64,
                    exif,
                    planner_url: settings.planner_url,
                    token,
                },
            });
            uploadBtn.textContent = result.ok ? '✓' : '✗';
            uploadBtn.title = result.error ?? 'Uploaded';
        } catch (err) {
            uploadBtn.textContent = '✗';
            uploadBtn.title = String(err);
        }
    });
    card.appendChild(uploadBtn);
}
```

- [ ] **Step 9: Verify browser tool still works**

```powershell
cd C:\Foo\raw-converter-wasm
bun serve.ts
```

Open `http://localhost:1420` in browser. Drag a file. Confirm gallery renders and no JS errors appear in DevTools console.

- [ ] **Step 10: Verify Tauri dev builds**

```powershell
cd C:\Foo\raw-converter-tauri
cargo tauri dev
```

Expected: Tauri window opens with the web UI. File picker opens on button click.

- [ ] **Step 11: Commit**

```powershell
cd C:\Foo\raw-converter-wasm
git add web/main.js web/index.html
git commit -m "feat(web): add IS_TAURI conditional paths for native invoke"
```

---

## Task 11: Backend endpoint (expedition-planner repo)

**Files:**
- Create: `backend/routes/raw-images.ts`
- Modify: `backend/server.ts`
- Create: migration for `raw_images` table

> **If the expedition-planner backend lives in a separate directory**, navigate there before running these steps.

- [ ] **Step 1: Write failing test for the route handler**

`backend/routes/raw-images.test.ts`:
```typescript
import { describe, it, expect, beforeEach } from 'bun:test';
import { app } from '../server';  // or however the server is exported

const VALID_TOKEN = 'test_token_abc';
process.env.RAW_UPLOAD_TOKEN = VALID_TOKEN;

describe('POST /api/raw-images', () => {
    it('returns 401 with wrong token', async () => {
        const res = await app.fetch(new Request('http://localhost/api/raw-images', {
            method: 'POST',
            headers: { Authorization: 'Bearer bad_token', 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: 'a.orf', jxl_b64: btoa('fake'), exif: {} }),
        }));
        expect(res.status).toBe(401);
    });

    it('returns 200 with correct token and valid body', async () => {
        const res = await app.fetch(new Request('http://localhost/api/raw-images', {
            method: 'POST',
            headers: { Authorization: `Bearer ${VALID_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: 'a.orf', jxl_b64: btoa('fakejxl'), exif: { iso: 200 } }),
        }));
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.ok).toBe(true);
        expect(json.id).toMatch(/^rawimg_/);
    });
});
```

Run (expect fail — route not yet created):
```bash
bun test backend/routes/raw-images.test.ts
```

- [ ] **Step 2: Create SQLite migration**

Create `backend/migrations/YYYYMMDD_raw_images.sql`:
```sql
CREATE TABLE IF NOT EXISTS raw_images (
    id          TEXT PRIMARY KEY,
    filename    TEXT NOT NULL,
    jxl_blob    BLOB NOT NULL,
    exif_json   TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Apply migration in your existing migration runner (check `backend/db.ts` or similar).

- [ ] **Step 3: Create backend/routes/raw-images.ts**

```typescript
import { Database } from 'bun:sqlite'; // or your existing db import

const MAX_BODY_BYTES = 50 * 1024 * 1024; // 50 MB

function randomId(): string {
    return 'rawimg_' + Math.random().toString(36).slice(2, 11);
}

export function rawImagesRouter(db: Database) {
    return async function handleRawImages(req: Request): Promise<Response> {
        const token = process.env.RAW_UPLOAD_TOKEN;
        const auth = req.headers.get('Authorization') ?? '';
        if (!token || auth !== `Bearer ${token}`) {
            return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
        }

        const contentLength = Number(req.headers.get('content-length') ?? 0);
        if (contentLength > MAX_BODY_BYTES) {
            return Response.json({ ok: false, error: 'file too large' }, { status: 413 });
        }

        let body: { filename: string; jxl_b64: string; exif: unknown };
        try {
            body = await req.json();
        } catch {
            return Response.json({ ok: false, error: 'invalid JSON' }, { status: 400 });
        }

        const { filename, jxl_b64, exif } = body;
        if (!filename || !jxl_b64) {
            return Response.json({ ok: false, error: 'missing fields' }, { status: 400 });
        }

        let jxlBytes: Uint8Array;
        try {
            jxlBytes = Buffer.from(jxl_b64, 'base64');
        } catch {
            return Response.json({ ok: false, error: 'invalid base64' }, { status: 400 });
        }

        const id = randomId();
        db.prepare(
            'INSERT INTO raw_images (id, filename, jxl_blob, exif_json) VALUES (?, ?, ?, ?)'
        ).run(id, filename, jxlBytes, JSON.stringify(exif ?? {}));

        return Response.json({ ok: true, id });
    };
}
```

- [ ] **Step 4: Register in backend/server.ts**

Find where routes are registered and add:
```typescript
import { rawImagesRouter } from './routes/raw-images';
// ...
const rawImages = rawImagesRouter(db);
// In your request dispatcher:
if (pathname === '/api/raw-images' && method === 'POST') {
    return rawImages(req);
}
```

- [ ] **Step 5: Run tests — expect pass**

```bash
bun test backend/routes/raw-images.test.ts
```

Expected: both tests pass.

- [ ] **Step 6: Commit**

```bash
git add backend/routes/raw-images.ts backend/server.ts backend/migrations/
git commit -m "feat(backend): add POST /api/raw-images endpoint with SQLite storage"
```

---

## Task 12: Integration smoke test

- [ ] **Step 1: Build Tauri app**

```powershell
cd C:\Foo\raw-converter-tauri
cargo tauri build 2>&1 | Select-Object -Last 5
```

Expected: installer produced in `src-tauri/target/release/bundle/`.

- [ ] **Step 2: Run all Rust tests**

```powershell
cargo test --workspace 2>&1
```

Expected: all tests pass.

- [ ] **Step 3: Manual smoke test checklist**

Run `cargo tauri dev` and verify:
- [ ] Window opens; file picker appears on button click
- [ ] Select one ORF file; gallery card appears with thumbnail
- [ ] Click card; lightbox opens with full RAW render
- [ ] Move a look slider; lightbox updates within 200 ms
- [ ] Click download on a card; `.jxl` file downloads
- [ ] Open settings modal; enter a token; save; reopen — token field shows `••••••••`
- [ ] Run `bun serve.ts` simultaneously; browser tool still works

- [ ] **Step 4: Verify no wasm files loaded by Tauri**

Open Tauri DevTools (right-click → Inspect in dev mode). In Network tab, confirm no `.wasm` requests.

---

## Self-Review Against Spec

| Spec Requirement | Covered By |
|------------------|-----------|
| Native Tauri 2 Windows app | Tasks 4–9 |
| Zero wasm in Tauri path | Architecture (separate project), Task 12 step 4 |
| raw-pipeline pure-Rust lib | Tasks 1–3 |
| `process_file` command | Task 5 |
| `apply_look` with Rgb16 cache | Task 6 |
| `pick_files` native dialog | Task 7 |
| `push_to_planner` HTTP POST | Task 8 |
| Token in OS keychain | Task 7 |
| `get/set_settings` in store | Task 7 |
| `file_progress` events | Task 9 |
| Web frontend IS_TAURI branches | Task 10 |
| Browser fallback unchanged | Task 10 (IS_TAURI guard keeps WorkerPool) |
| Backend `/api/raw-images` | Task 11 |
| ExifData structured type | Task 3 |
| Max 50 Rgb16 cache entries | Task 5 (clear on overflow) |
| JXL quality/effort identical | Same libjxl via jpegxl-rs vendored |
| Auth token, planner URL optional | Task 8 (graceful non-fatal error) |
