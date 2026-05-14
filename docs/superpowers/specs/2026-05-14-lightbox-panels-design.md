# Lightbox Panels — Histogram, Colour Profiles, Filters

**Date:** 2026-05-14  
**Status:** Approved

---

## Goal

Add three collapsible panels to the lightbox viewport: Histogram (H), Colour Profiles (C), and Filters (F). Each collapses to a small icon in a stacked vertical strip at the top-right of the lightbox frame. All three can be open simultaneously. Zero WASM/Rust recompile — all logic is JS-side.

## Constraints

- No WASM recompile (approach A: JS parameter deltas + canvas post-process).
- Works in both browser (`IS_TAURI=false`) and Tauri (`IS_TAURI=true`).
- Must not break existing look sliders, keyboard shortcuts, or zoom/pan.
- Keyboard: `H` histogram, `C` colour profiles, `F` filters (toggle open/closed).

## Panel Stack UI

Three icon-pills anchored `position: absolute; top: 12px; right: 12px` inside `.lightbox-viewport`. Stacked vertically with 6px gap. Each pill = 32×32px icon button. When expanded, panel opens below its icon, 240px wide, dark frosted-glass style matching existing `.lightbox-info`.

Collapsed stack (all closed):
```
[H]
[C]
[F]
```

Expanded example (H open, others closed):
```
[H] ┐
    │ histogram canvas
    │ L/RGB toggle
    │ levels handles
    └─
[C]
[F]
```

All panels are independent — expanding one does not close another.

---

## Panel 1 — Histogram (key: H)

### Display
- Canvas element 220×80px, log-scale Y axis, X axis = 0–255.
- Two modes toggled by `[L | RGB]` button inside panel:
  - **Luminance**: `Y = 0.299R + 0.587G + 0.114B`, single white filled curve.
  - **RGB**: red, green, blue filled curves drawn semi-transparent in that order.
- Recomputed from `#lightbox-canvas` via `ctx.getImageData()` after every draw (including live-look updates).

### Levels Control (5 handles)

Two rows of draggable handles below the histogram canvas.

**Input row** (top, 3 handles):
- `levelsInBlack` (0–255, default 0) — left triangle, clips shadows.
- `levelsInMid` (0.1–10.0, default 1.0) — centre triangle, gamma/midtone.
- `levelsInWhite` (0–255, default 255) — right triangle, clips highlights.

**Output row** (bottom, 2 handles):
- `levelsOutBlack` (0–255, default 0) — left triangle, lifts shadows (matte/fade).
- `levelsOutWhite` (0–255, default 255) — right triangle, compresses highlights.

**Remap formula** (applied to canvas pixels as post-process after each render):
```
normalized = clamp((pixel - inBlack) / (inWhite - inBlack), 0, 1)
gamma      = pow(normalized, 1.0 / inMid)
output     = outBlack + gamma * (outWhite - outBlack)
```
Applied per-channel to R, G, B. Operates on 8-bit rendered canvas (no WASM change needed).

Handles are draggable horizontally. Input black cannot exceed input white. Output black cannot exceed output white.

---

## Panel 2 — Colour Profiles (key: C)

Named parameter delta-objects merged into `getCurrentLook()` before `triggerLiveUpdate()`. One profile active at a time. Tapping active profile deselects (returns to None = zero deltas).

### Built-in Profiles

| Profile | contrast | saturation | vibrance | temp | tint | highlights | shadows | whites | blacks | clarity |
|---|---|---|---|---|---|---|---|---|---|---|
| Natural | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Vivid | +0.2 | +0.3 | +0.2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Muted | −0.15 | −0.3 | 0 | 0 | 0 | 0 | +0.1 | 0 | 0 | 0 |
| Portrait | 0 | +0.1 | 0 | +0.05 | 0 | −0.1 | +0.15 | 0 | 0 | 0 |
| Monotone | 0 | −1.0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| i-Enhance | +0.1 | +0.2 | +0.3 | 0 | 0 | 0 | 0 | 0 | 0 | +0.1 |
| Flat | −0.4 | −0.1 | 0 | 0 | 0 | −0.3 | +0.3 | 0 | 0 | 0 |

### User Profiles

Displayed below built-ins as a second section "My Profiles". Slots 1–10 (expandable).

**Storage:**
- Tauri: `{appDataDir}/raw-converter/profiles.json`
- Browser: `localStorage` key `raw-profiles`

**Shortcuts:**
- `Ctrl+Shift+S` — save current look as named profile (prompts for name, assigns next slot).
- `Ctrl+Shift+L` — open profile picker modal.
- `Ctrl+Shift+1` … `Ctrl+Shift+0` — load profile slots 1–10 directly.
- `Ctrl+1` … `Ctrl+9` — quick-select B&W filter (1=Natural, 2=Soft, 3=Strong, 4=Red, 5=Orange, 6=Yellow, 7=Green, 8=Blue, 9=Infrared).
- `Ctrl+0` — clear active filter.

Profile = full look snapshot: all 12 slider values + active filter name.

---

## Panel 3 — Filters (key: F)

Filters stack on top of the active colour profile. Two categories:

### Pipeline Filters (trigger re-render via `triggerLiveUpdate`)

One active at a time. Deselect by tapping again.

#### B&W Suite (9 variants)

| Filter | sat | contrast | temp | tint | highlights | shadows | whites | blacks |
|---|---|---|---|---|---|---|---|---|
| B&W Natural | −1.0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| B&W Soft | −1.0 | −0.25 | 0 | 0 | −0.15 | +0.2 | 0 | 0 |
| B&W Strong | −1.0 | +0.4 | 0 | 0 | 0 | 0 | +0.15 | −0.15 |
| B&W Red | −1.0 | 0 | +0.4 | −0.1 | 0 | 0 | 0 | 0 |
| B&W Orange | −1.0 | 0 | +0.25 | 0 | 0 | 0 | 0 | 0 |
| B&W Yellow | −1.0 | 0 | +0.12 | 0 | 0 | 0 | 0 | 0 |
| B&W Green | −1.0 | 0 | −0.15 | +0.2 | 0 | 0 | 0 | 0 |
| B&W Blue | −1.0 | 0 | −0.35 | 0 | 0 | 0 | 0 | 0 |
| Infrared | −1.0 | 0 | +0.5 | 0 | +0.4 | 0 | +0.3 | 0 |

#### Creative Looks

| Filter | contrast | sat | temp | tint | highlights | shadows | whites | blacks | clarity |
|---|---|---|---|---|---|---|---|---|---|
| Fade | −0.3 | 0 | 0 | 0 | 0 | 0 | −0.1 | +0.15 | 0 |
| Cross-process | +0.2 | +0.3 | −0.2 | +0.3 | 0 | 0 | 0 | 0 | 0 |
| Bleach bypass | +0.4 | −0.5 | 0 | 0 | 0 | 0 | 0 | 0 | +0.2 |

### CSS Overlay Filters (instant, no re-render)

Independent toggles — can stack on top of any pipeline filter.

| Filter | Implementation |
|---|---|
| **Film grain** | `<canvas>` overlay, SVG `feTurbulence` noise, opacity 15%, z-index above lightbox canvas |
| **Vignette** | `<div>` overlay, CSS `radial-gradient(ellipse, transparent 55%, rgba(0,0,0,0.65) 100%)` |

---

## Per-image Sidecar (Ctrl+S)

Saves current state (slider values + active profile name + active filter name + levels handles) for the open image.

**Saved object:**
```json
{
  "filename": "P1100079.ORF",
  "look": {
    "exposureEv": 0.0, "contrast": 0.0, "highlights": 0.0, "shadows": 0.0,
    "whites": 0.0, "blacks": 0.0, "saturation": 0.0, "vibrance": 0.0,
    "temp": 0.0, "tint": 0.0, "texture": 0.0, "clarity": 0.0
  },
  "profile": "Vivid",
  "filter": "B&W Red",
  "levels": {
    "inBlack": 0, "inMid": 1.0, "inWhite": 255,
    "outBlack": 0, "outWhite": 255
  }
}
```

**Storage:**
- Tauri: `P1100079.ORF.look.json` written next to the ORF via two new Tauri commands `read_look(path)` / `write_look(path, json)` added to `push.rs` using `std::fs` (no new plugin dependency).
- Browser: `localStorage` key `raw-sidecar:P1100079.ORF`.

**Auto-load:** when lightbox opens for a card, check for existing sidecar and apply silently.

**Card badge:** small dot (`.sidecar-dot`, 8px, accent colour) on bottom-right of thumbnail when sidecar exists.

---

## Look Merge Order

When building the final look to send to `triggerLiveUpdate()`:

```
base = getCurrentLook()           // slider values
merged = base + profileDeltas     // colour profile on top
merged = merged + filterDeltas    // filter on top
// levels applied as canvas post-process after render (not sent to pipeline)
```

All additions are clamped to valid param ranges after merge.

---

## Success Criteria

- [ ] H/C/F keys toggle panels; panels stack correctly in top-right.
- [ ] Histogram updates on every lightbox draw, L/RGB modes both work.
- [ ] All 5 levels handles draggable; remap formula applies correctly; histogram updates to reflect remapped output.
- [ ] 7 built-in profiles apply correct deltas; deselect returns to neutral.
- [ ] User profiles: Ctrl+Shift+S saves, Ctrl+Shift+L loads, Ctrl+Shift+1–0 loads by slot.
- [ ] All 12 pipeline filters trigger re-render with correct deltas.
- [ ] Film grain and vignette CSS overlays appear and toggle independently.
- [ ] Ctrl+S saves sidecar; reopening lightbox restores state; dot badge appears on card.
- [ ] All features work in both browser (IS_TAURI=false) and Tauri (IS_TAURI=true).
- [ ] No regressions in existing keyboard shortcuts, zoom/pan, or look sliders.
