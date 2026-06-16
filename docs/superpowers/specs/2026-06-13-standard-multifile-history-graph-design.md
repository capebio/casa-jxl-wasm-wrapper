# Standard Multifile History Graph Design

Date: 2026-06-13
Status: Draft approved in chat, pending user review
Scope: Generate a self-contained HTML benchmark history graph for `StandardMultifileTest.mjs`

## Goal

Produce a beautiful, self-contained HTML artifact that is regenerated whenever `StandardMultifileTest.mjs` runs.

The artifact must:

- visualize benchmark history from the beginning of available `StandardMultifileTest-general` runs
- use true `RunTimestamp` spacing on the x-axis, including runs only seconds apart
- use time in milliseconds on the y-axis
- support multiple metric lines with left-side toggles
- allow per-metric color customization with visible swatches
- show thermal and system-state context so timing spikes can be interpreted

The output file will be:

- `docs/outputs/timing tests/GraphAggregateResults.html`

## Source Of Truth

Historical `.toon` outputs remain the source of truth.

The graph output is rebuilt from all matching files in:

- `docs/outputs/timing tests/*StandardMultifileTest-general.toon`

This avoids drift and means the HTML artifact can always be reconstructed from recorded benchmark runs.

## Output Strategy

`StandardMultifileTest.mjs` will:

1. write the current `.toon` run as it already does
2. scan all historical `*StandardMultifileTest-general.toon` files
3. parse the curated timing and telemetry metrics from each file
4. generate `GraphAggregateResults.html`

The HTML file will be fully self-contained:

- inline CSS
- inline JavaScript
- inline aggregated JSON data
- no CDN dependencies
- no Tailwind

This keeps the artifact portable and robust when opened directly from disk.

## Curated Metrics

Only curated metrics will be exposed in the UI. Metrics that are missing everywhere or are zero for every historical run will be excluded entirely from the control list and graph.

Initial curated metric candidates:

- `AvgRawMs`
- `AvgProgEncMtMs`
- `AvgShotEncMtMs`
- `AvgProgFirstMtMs`
- `AvgProgFinalMtMs`
- `AvgShotDecMtMs`
- `MultiWorkerParallelWallMs`
- `RealJxtcTiledRoi_512_512_Ms`
- `MonolithicRoi_512_512_Ms`
- `EncCoreCompressMs`

These cover:

- RAW ingest cost
- progressive encode cost
- one-shot encode cost
- progressive first-paint latency
- progressive final-paint latency
- one-shot decode cost
- multi-worker decode wall time
- tiled ROI versus monolithic ROI behavior
- core JXTC compression timing

## Data Model

Each parsed historical run will produce one normalized record with:

- `timestampIso`
- `timestampMs`
- `fileName`
- `testName`
- curated metric values when present
- telemetry values when present

Telemetry fields to retain:

- `CpuActiveLoadPct`
- `CpuClockCurrentGhz`
- `CpuClockMaxGhz`
- `CpuThrottlingPct`
- `SystemMemoryFreeGb`

The parser should tolerate older `.toon` files that do not contain all telemetry or FFI timing fields.

## Graph Design

The graph will be rendered with custom SVG inside the generated HTML page.

Reasons:

- exact timestamp positioning
- smooth spline curves
- high control over gradients, markers, and overlays
- easy portability with no external library

### Axes

- x-axis: continuous time scale derived from actual `RunTimestamp`
- y-axis: milliseconds

The x-axis must not bucket by date or run order. If two runs occurred seconds apart, the spacing must reflect that.

### Lines

- one line per enabled metric
- smooth spline interpolation between points
- point markers remain on exact sampled coordinates
- line colors come from user-adjustable color swatches in the left rail

### Interaction

- hover crosshair
- shared tooltip for nearest timestamp
- tooltip includes all enabled metric values at that run
- tooltip also includes telemetry context for that run

### Thermal / System-State Overlay

Metric line colors remain user-controlled and stable.

Thermal and system state will be shown separately as a contextual overlay:

- faint vertical bands per run behind the plot
- cool runs tinted blue
- hot or throttled runs tinted red
- intermediate runs tinted through cyan, amber, and orange as needed
- optional subtle point halo intensity based on computed heat score

This preserves metric readability while still exposing why timings may leap up.

## Heat Score

Heat score will be derived from a weighted combination of:

- `CpuActiveLoadPct`
- inverse of `CpuThrottlingPct`
- optional clock anomaly relative to max clock

`SystemMemoryFreeGb` may be shown in tooltips but should not strongly affect heat coloring unless later evidence shows it correlates with runtime distortion.

The score is used only for visualization, not for altering any recorded timings.

## Layout

The page will use a two-column layout:

- left control rail
- right graph and summary area

### Left Rail

- metric toggle list
- per-metric color swatch
- preset buttons:
  - `Core`
  - `Encode`
  - `Decode`
  - `All`
- reset colors action

### Main Area

- title and generated summary
- latest run versus previous run summary strip
- large graph area
- small note explaining heat overlay and timestamp spacing

## Latest Versus Previous Summary

The top summary strip will compare the newest run to the immediately previous historical run and surface:

- latest timestamp
- previous timestamp
- biggest improvements among visible curated metrics
- biggest regressions among visible curated metrics
- latest telemetry summary

This gives fast comparison value without requiring the user to inspect each line manually.

## Parsing Rules

The implementation should parse values directly from `.toon` text using tolerant regex extraction.

Rules:

- accept missing fields as `null`
- preserve historical compatibility with earlier runs
- include only files matching `*StandardMultifileTest-general.toon`
- sort by actual timestamp ascending for plotting
- use filename as fallback timestamp only if `RunTimestamp` is missing

## Styling Direction

The page should feel intentional and polished rather than generic dashboard output.

Style goals:

- deep neutral background with subtle gradient
- crisp plot frame
- restrained glow on active lines
- readable typography with strong hierarchy
- tooltips styled like instrumentation, not default browser chrome
- heat overlay visible but subordinate to data

## Non-Goals

Not in scope for this change:

- integrating the graph into an existing app route
- fetching data live from a server
- editing or rewriting historical `.toon` files
- exposing every raw metric recorded in `.toon`
- adding Tailwind or other UI frameworks

## Implementation Notes

- keep current `.toon` output behavior intact
- append new aggregate generation after `.toon` file creation
- avoid dependencies that require bundling or installation
- ensure generated HTML opens directly via file path

## Verification

Minimum verification after implementation:

- run `StandardMultifileTest.mjs` to regenerate current `.toon` and `GraphAggregateResults.html`
- open the generated HTML and verify:
  - multiple metric lines render
  - x-axis spacing reflects real timestamps
  - toggles work
  - color swatches update line colors
  - heat overlay changes across runs with differing telemetry
  - latest run appears in the history
  - zero-only metrics do not appear

## Risks

- historical `.toon` shape drift may require tolerant parsing
- spline rendering must avoid misleading point placement
- older runs without telemetry may reduce heat-overlay fidelity
- too many default-enabled lines may create clutter

## Recommendation

Implement the graph generator directly in `StandardMultifileTest.mjs`, with self-contained SVG-based HTML output rebuilt from all historical benchmark runs on every benchmark execution.
