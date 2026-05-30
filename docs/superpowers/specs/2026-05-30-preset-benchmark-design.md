# JXL Preset Benchmark — Design Spec
**Date:** 2026-05-30  
**Branch:** finishing_feature_parity  
**Status:** Approved — ready for implementation plan

---

## Goal

Build a unified automated benchmark page that sweeps JXL encode/decode parameters across four quality tiers and derives four user-facing presets: **Low · Medium · High · Lossless**. Each preset represents the fastest viable parameter combination for that tier, validated across real RAW file types (ORF, DNG, CR2, JPEG).

Two prerequisite changes ship alongside the page:
1. **CR2 WASM export** — `process_cr2` / `process_cr2_with_flags` added to `src/lib.rs`
2. **Wrapper-lab additions** — `brotliEffort` and `modular` controls wired into `jxl-wrapper-lab.html`

---

## Constraints

- Browser-only (no Node, no Tauri). All encode/decode via WASM facade (`createEncoder` / `createDecoder`).
- CR2 decode uses `raw_pipeline::cr2::decode_bytes` (already in the crate, no new deps).
- File persistence via IndexedDB — decoded RGBA at benchmark working size, not raw bytes (37 MB CR2s exceed localStorage).
- Results persistence via localStorage — JSON only, no pixel data.
- Chart.js already loaded by jxl-benchmark.html; same CDN script tag reused here.
- Debug console reuses existing `jxl-debug-console.js` + `jxl-debug-console.css`.
- No concurrency during sweep runs — sequential isolation is the point.

---

## Part 1 — CR2 WASM Export

### Location
`src/lib.rs` — mirrors the DNG pattern exactly.

### New functions
```rust
fn decode_cr2_raw(data: &[u8]) -> Result<Cr2Decoded, JsError>
fn process_cr2_impl(decoded: Cr2Decoded, output_flags: u32, look: &LookOverrides) -> Result<ProcessResult, JsError>
pub fn process_cr2(data: &[u8], ...) -> Result<ProcessResult, JsError>          // #[wasm_bindgen]
pub fn process_cr2_with_flags(data: &[u8], output_flags: u32, ...) -> Result<ProcessResult, JsError>  // #[wasm_bindgen]
```

### Key differences from DNG
- CR2 is always RGGB — no `align_to_rggb` step.
- `color_matrix` field is `Option<[[f32; 3]; 3]>` — fall back to `CAM_TO_SRGB` if absent.
- `Cr2Image` has no `cfa` field.

### After adding
- Run `wasm-pack build --target web --out-dir pkg --release`.
- Update `web/jxl-wrapper-lab.html` file input `accept` to include `.cr2,.CR2`.
- Update `loadFileSource` and `loadBytesSourceByName` in `jxl-wrapper-lab.js` to handle `ext === 'cr2'` via `loadBytesAsSource` using `process_cr2`.

---

## Part 2 — Wrapper-Lab Additions

### New controls in `jxl-wrapper-lab.html` (inline-spinners section)

**Modular mode** — radio chips:
```
Auto (–1) | VarDCT (0) | Modular (1)
```

**Brotli effort** — number spinner, range –1 to 11, default –1 (libjxl default).

### JS changes (`jxl-wrapper-lab.js`)
- Add `getModular()` → reads radio chip value, returns `–1 | 0 | 1`
- Add `getBrotliEffort()` → reads spinner, returns `–1..11`
- Extend `makeEncoderOptions()` to include `modular` and `brotliEffort`
- Wire `syncSettingLabels` to new inputs

---

## Part 3 — Preset Benchmark Page

### Files
| File | Purpose |
|------|---------|
| `web/jxl-preset-benchmark.html` | Page shell, nav link, importmap |
| `web/jxl-preset-benchmark.js` | All sweep logic, IDB, results, presets |
| `web/jxl-preset-benchmark.css` | Page-specific styles (extends patterns from jxl-wrapper-lab.css) |

Nav: add link to existing `test-nav.css`-based nav bar on all pages.

### UI Sections (top to bottom)

#### ① File intake
Five typed drop slots: **ORF · DNG · CR2 · JPEG · Other**

Each slot:
- Drop zone + hidden file input, click to pick
- Type label + colour accent (green/blue/orange/purple/grey)
- Filename badge below (truncated, persisted)
- On load: restore from IndexedDB, show stored filename
- "Drop to replace" affordance when file already loaded

#### ② Sweep settings
- **Image sizes** — checkboxes: `128px · 512px · 1920px · Full` (all checked by default)
- **Quality tiers** — checkboxes: `Low · Medium · High · Lossless` (all checked)
- **Runs per config** — spinner, default 3, range 1–5
- Buttons: **▶ Run sweep · ■ Stop · Load saved · Export CSV · Console**

#### ③ Phase progress + live status
Four phase cards (Effort · Decode speed · Modular+Brotli · Resampling), each with:
- Phase label + status icon (pending / active ↻ / done ✓)
- Sub-label describing what's being swept
- Progress bar (fill animates during active phase)

Live status ticker below cards:
- Current operation: `Phase N · Tier · File · Size · param=val/total`
- Last result line: enc/dec ms, size KB, delta vs baseline
- Next-up preview
- Elapsed + estimated remaining

#### ④ Phase graphs (Chart.js)
Four charts, rendered as each phase completes (or updates live):

| Chart | Type | X | Y | Series |
|-------|------|---|---|--------|
| Phase 1a — Encode time vs Effort | Line | effort (1–6) | encode ms | one line per image size |
| Phase 1b — File size vs Effort | Line | effort (1–6) | size KB | one line per image size; knee marker annotated |
| Phase 2 — Decode time vs Speed tier | Line | tier (0–4) | decode ms | one line per image size |
| Phase 3 — Modular × Brotli | Grouped bar | combo label | encode ms | grouped by modular mode |

Phase 4 (resampling) shown in results table only — 3 data points don't need a chart.

All charts: `responsive: true`, legend bottom, axes labelled. Same Chart.js instance pattern as `jxl-benchmark.html`.

#### ⑤ Raw results table
Columns: File · Size · Tier · Phase · Effort · DecSpd · Modular · Brotli · Resamp · Enc ms · Dec ms · KB · Score

- Sortable by any column (click header)
- Best row per (file, tier, size) highlighted with `★` and green accent
- Persisted to localStorage on completion

#### ⑥ Preset cards
Four cards: **Low · Medium · High · Lossless**

Each card shows:
- Derived parameter set (quality, effort, decodingSpeed, modular, brotliEffort, resampling, lossless)
- Per-size timing summary: 128px and 1920px enc/dec ms
- **Copy JSON** button — copies full preset object including `benchStats`

Preset JSON schema:
```json
{
  "tier": "medium",
  "quality": 85,
  "lossless": false,
  "effort": 3,
  "decodingSpeed": 3,
  "modular": -1,
  "brotliEffort": -1,
  "resampling": 1,
  "benchStats": {
    "128px":  { "avgEncMs": 18,  "avgDecMs": 5,  "avgSizeKb": 42  },
    "512px":  { "avgEncMs": 82,  "avgDecMs": 17, "avgSizeKb": 374 },
    "1920px": { "avgEncMs": 210, "avgDecMs": 45, "avgSizeKb": 1820 },
    "full":   { "avgEncMs": 890, "avgDecMs": 180,"avgSizeKb": 7200 }
  }
}
```

---

## Sweep Engine

### Quality tiers
```js
const TIERS = [
  { id: 'low',      label: 'Low',      quality: 72,  lossless: false },
  { id: 'medium',   label: 'Medium',   quality: 85,  lossless: false },
  { id: 'high',     label: 'High',     quality: 92,  lossless: false },
  { id: 'lossless', label: 'Lossless', quality: 100, lossless: true  },
];
```

### Image sizes
```js
const SIZES = [128, 512, 1920, 'full'];
```

### Phases (per tier, per file)

**Phase 1 — Effort sweep**
- Fix: `decodingSpeed=0, modular=-1, brotliEffort=-1, resampling=1`
- Sweep: `effort ∈ [1, 2, 3, 4, 5, 6]` at each image size
- Record: `encodeMs, decodeMs, sizeBytes` (median of N runs)
- Output: `bestEffort` per (tier, size) via knee-point algorithm

**Phase 2 — Decode speed tier**
- Fix: `effort=bestEffort[tier][size], modular=-1, brotliEffort=-1, resampling=1`
- Sweep: `decodingSpeed ∈ [0, 1, 2, 3, 4]` at each image size
- Record: `encodeMs, decodeMs`
- Output: `bestDecodeSpeed` per (tier, size) — value that minimises `decodeMs` without penalising `encodeMs > 2×` vs tier-0 baseline

**Phase 3 — Modular + Brotli**
- Fix: `effort=best, decodingSpeed=best, resampling=1`
- Sweep: `modular ∈ [-1, 0, 1]` × `brotliEffort ∈ [-1, 0, 4, 9]` (12 combos) at 512px only (representative)
- Record: `encodeMs, sizeBytes`
- Output: `bestModular, bestBrotliEffort` per tier

**Phase 4 — Resampling**
- Fix: all best params from phases 1–3
- Sweep: `resampling ∈ [1, 2, 4]` at each image size
- Record: `encodeMs, decodeMs, sizeBytes`
- Output: `bestResampling` per (tier, size)

### Knee-point algorithm (Phase 1)
```
For i = 1..N (effort steps, sorted ascending):
  sizeReduction[i] = (size[i-1] - size[i]) / size[i-1]   // % smaller
  timeCost[i]      = (time[i] - time[i-1]) / time[i-1]   // % slower
  if timeCost[i] > 3 × sizeReduction[i]:
    bestEffort = effort[i-1]   // one step before the knee
    break
If no knee found: bestEffort = effort that minimises size
```

### Score formula (for results table)
```
sizeEff   = min(size) / result.size          // higher = smaller file
encSpeed  = min(encMs) / result.encMs        // higher = faster encode
decSpeed  = min(decMs) / result.decMs        // higher = faster decode
score     = round((sizeEff * 0.4 + encSpeed * 0.4 + decSpeed * 0.2) * 100)
```
All normalised within the same (tier, phase) result set.

### Run isolation
- No concurrency — one encode+decode at a time
- Each config: run N times, take median
- `await nextFrame()` between runs to keep UI responsive
- Abort check after each run; sweep cancels cleanly on Stop

---

## File Persistence (IndexedDB)

DB name: `jxl-preset-bench`, store: `sources`

Per slot key (`'orf' | 'dng' | 'cr2' | 'jpeg' | 'other'`):
```js
{ name: string, bytes: Uint8Array, fileType: string }
```

Raw file bytes stored (not decoded RGBA). Typical sizes: ORF 17 MB, DNG 16 MB, CR2 21–37 MB, JPEG ~1 MB — well within IDB limits. This allows full-resolution benchmark runs without re-asking the user for the file.

On drop: read `File` → `idb.put(slot, { name, bytes, fileType })`.  
On page load: `idb.get(slot)` → if present, decode via WASM (process_orf / process_dng / process_cr2) → store decoded full-res RGBA in memory → show filename badge. Decode happens once per page load, then in-memory RGBA is resized to each sweep size on demand.

---

## Results Persistence (localStorage)

Key: `jxl-preset-bench-results`  
Value: JSON — last completed sweep only (overwritten on each new sweep).

Includes: timestamp, sweep config, all phase result rows, derived presets.

---

## Error Handling

- Per-run encode/decode errors: log to console, skip that config, continue sweep.
- IDB unavailable: fall back to memory-only (no persistence, warn user).
- File decode error (bad file): show error badge on slot, slot treated as absent.
- Partial sweep (Stop pressed): results for completed phases are kept and shown; presets derived from available data only, labelled "partial".

---

## Feature Matrix Audit — Gaps Addressed

| Matrix item | Currently | After this task |
|-------------|-----------|-----------------|
| CR2 WASM export | ❌ not in WASM | ✅ `process_cr2` + `process_cr2_with_flags` |
| Brotli effort UI | ❌ not in wrapper-lab | ✅ spinner added |
| Modular mode UI | ❌ not in wrapper-lab | ✅ radio chips added |
| Benchmark exposure for brotli/modular | 🟡 API only | ✅ wrapper-lab + preset benchmark |

Patches/splines, gain maps, progressive controls: out of scope — no preset value.

---

## Success Criteria

1. All four file slots load and decode ORF, DNG, CR2, JPEG without error.
2. Files survive page reload (IndexedDB round-trip).
3. Full sweep completes without hanging; Stop cancels cleanly.
4. All four Chart.js graphs render with correct axes after each phase.
5. Preset JSON copies to clipboard with correct schema.
6. Results table sorts by every column.
7. CR2 round-trip in wrapper-lab: drop `.cr2` → encode → decode → visible image.
8. Brotli + modular controls visible and passed through to encoder in wrapper-lab.
9. WASM build passes (`wasm-pack build --target web`) with no new warnings.
