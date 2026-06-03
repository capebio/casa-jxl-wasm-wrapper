# Encode Space Explorer — Design Spec
_Date: 2026-06-03_

## Goal

Add a new benchmark page that lets the user pick one ORF file, encode it to JXL across a matrix of (effort × distance) combinations at quarter resolution, and interactively explore quality/size tradeoffs via sliders and a matrix grid — replicating the jpegxl.info "Distance vs Effort Visualizer" experience but against the user's own images.

## Constraints

- Browser-only; no new packages or shared modules.
- Follows existing benchmark page conventions (nav, WASM init, file picker, console panel).
- Compute time must be manageable: default sweep = 40 cells at quarter resolution (~4–10 min).
- Sliders and matrix must be usable immediately as cells complete (progressive population).
- Single ORF file input (not multi-file like crop-benchmark).

## Architecture

### New files

| File | Role |
|------|------|
| `web/jxl-encode-space.html` | Page shell, nav, importmap, control band, two sections |
| `web/jxl-encode-space.js` | All logic: ORF decode, sweep loop, cache, UI wiring |
| `web/jxl-encode-space.css` | Page-specific styles (interactive viewer, matrix grid, cell badges) |

Nav link "Encode Space" added to `home-bar-links` in all existing benchmark HTML files.

### Dependencies (existing)

- `./pkg/raw_converter_wasm.js` — `process_orf`, `downscale_rgba`
- `@casabio/jxl-wasm` — `createEncoder`, `createDecoder`
- `./jxl-file-picker.js` — unified file picker with session persistence

## Data Flow

```
ORF file
  → process_orf() [full res]
  → downscale_rgba(pixels, srcW, srcH, dstW, dstH) [÷4 default]
  → rgba: Uint8Array, width: number, height: number  [cached; one decode per run]

for each (effort, distance) in sweep:
  → createEncoder({ format:'rgba8', width, height, hasAlpha:true, distance, effort, ... })
  → collect chunks → concat → jxlBytes: Uint8Array
  → createDecoder({ format:'rgba8', ... }) → push jxlBytes → final event → pixels
  → createImageBitmap(new ImageData(pixels, w, h))
  → cellCache.set(`${effort}:${distance}`, { bitmap, sizeKb, bpp, encodeMs })
  → update matrix cell UI, refresh interactive viewer if current cell just landed
```

Encoding runs sequentially in a single `for` loop with `await new Promise(r => setTimeout(r, 0))` between cells to yield to the browser event loop. No workers needed.

## State Model

```js
cellCache    Map<`${effort}:${distance}`, CellResult>
sweepConfig  { efforts: number[], distances: number[], outputScale: number }
currentCell  { effort: number, distance: number }
rgba         Uint8Array | null   // decoded ORF at output resolution
imgW, imgH   number              // output dimensions
running      boolean
abortCtrl    AbortController | null
```

`CellResult`:
```ts
{ bitmap: ImageBitmap, sizeKb: number, bpp: number, encodeMs: number }
```

## UI Structure

```
[nav home-bar]

[hero.compact]
  eyebrow: "Encode Space Explorer · <wasm-status>"
  h1: "Distance × Effort: quality and file-size tradeoffs on your own images"
  sub: "Encodes one ORF at quarter resolution across all selected effort/distance combinations."

[control-band]
  [row 1] Pick ORF… · Run · Stop · Console
           status chips: File / Progress (N/total) / Stage
  [row 2] Effort: checkboxes 1–9 (default: 1 3 5 7 9 checked)
           Distance: [Coarse ▾] [Fine ▾] [Custom…]  (coarse default)
           Output scale: [¼ fast] [½] [Full slow]

[console-panel] (hidden by default, same as crop-benchmark)

[interactive-viewer]
  layout: flex row
    [canvas 600px wide, aspect-ratio from image]  — pending: spinner overlay
    [effort-slider vertical, right of canvas, labels right]
  [distance-slider horizontal, full width below canvas]
  [stats-bar] effort label · distance label · size KB · BPP · encode ms

[matrix-section]
  header: "Matrix · <N> cells · <elapsed>" + [Copy MD] [Export JSON]
  [matrix-grid]
    corner cell (blank) | effort col headers (e1 e3 e5 …)
    per distance row:
      row header (distance value) | per-effort cell:
        pending:  spinner + "…"
        done:     <canvas 60×45> + size badge (KB, color-coded)
        error:    "err" badge
        selected: highlighted border (--accent color)
    clicking a cell → sets currentCell → updates interactive viewer
  color coding: cell border/badge green→yellow→red by sizeKb relative to run min/max
```

## Parameter Defaults

| Setting | Default | Options |
|---------|---------|---------|
| Efforts | 1, 3, 5, 7, 9 | Any subset of 1–9 via checkboxes |
| Distances (coarse) | 0, 0.5, 1, 1.5, 2, 3, 5, 8 | — |
| Distances (fine) | 0, 0.2, 0.4, 0.6, 0.8, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 7, 10 | — |
| Distances (custom) | text input, comma-separated | — |
| Output scale | 0.25 | 0.25 / 0.5 / 1.0 |

Default sweep: 5 efforts × 8 distances = **40 cells**.

Estimated time display (shown before run): `~N min` based on `cells × 8s` heuristic (effort-weighted).

## BPP Calculation

```js
bpp = (sizeBytes * 8) / (width * height)
```

## Error Handling

- ORF decode error → abort run, show error in status chip.
- Encode error for a cell → mark cell "error", continue to next cell.
- Decode error for a cell → mark cell "error", jxlBytes still stored for size display.
- Abort (Stop button) → `abortCtrl.abort()`, checked between cells; partial results remain usable.

## Export

**Copy MD**: table of size KB + BPP + encode ms per (effort, distance).  
**Export JSON**: full `{ config, cells: [{effort, distance, sizeKb, bpp, encodeMs}] }`.

## Edge Cases

- ORF smaller than quarter-res target → use full res (no upscale).
- Distance = 0 (lossless) → encode time may be long at high effort; warn in UI.
- All efforts deselected → disable Run, show validation hint.
- Cell already cached within the same run → reuse cached result, skip encode. A new run clears `cellCache` and re-encodes all cells.

## Success Criteria

1. Page loads, WASM initialises, file picker works.
2. After Run: cells populate progressively in the matrix; interactive viewer shows the first completed cell.
3. Sliders update the viewer instantly (no re-encode) once a cell is cached.
4. Clicking a matrix cell jumps the viewer to that cell.
5. Export JSON contains all cell results with correct metadata.
6. Stop aborts mid-sweep; partial results remain displayed.
7. Nav link present and correct on all existing benchmark pages.
