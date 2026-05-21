# Progressive Controls Dashboard and Thumbnail Resizing

**Date:** 2026-05-21  
**Status:** Draft

---

## Goal

Build one shared controls dashboard for the JPEG XL progressive pages and the wrapper lab. The dashboard must expose the full set of encode, decode, progressive, transport, and bench controls in a nested, scannable layout.

The same panel should appear on:

- `web/jxl-progressive.html`
- `web/jxl-wrapper-lab.html`

The dashboard must:

- make all relevant switches accessible
- disable and dim controls that are not relevant in the current page mode
- include an `i` button next to each control or control group with a short explanation
- allow bottom-of-page thumbnails to be resized by the user
- surface the cause of the slow timings currently reported as `34286 ms · 39994 ms`

## Problem Statement

The current progressive page shows timings in the 34-40 second range. That is too slow for what should be a codec and transport test harness.

One likely cause is artificial pacing in the current stream path:

- bytes are split into chunks
- each chunk is delayed with `setTimeout`
- the delay is fixed even when the point of the test is to measure codec behavior, not a synthetic network crawl

This design must make transport pacing explicit and configurable so the user can separate:

- real encode time
- real decode time
- byte-stream delivery delay
- paint cost

## Non-Goals

- Do not redesign the actual codec APIs.
- Do not remove existing benchmark pages.
- Do not hide controls that could still be useful later.
- Do not turn the dashboard into a generic settings app.
- Do not add unrelated image-editing features.

## Core Decision

Use one shared slide-out dashboard with nested sections and inline help.

Reason:

- the same controls matter across both pages
- a popout keeps the main canvas/cards visible
- nested groups scale better than one long vertical form
- dimmed disabled states preserve discoverability without implying the control is currently active

## UX Model

### Entry Point

- A fixed `Controls` button opens the panel.
- The panel can close to return full attention to the content area.
- The panel should work on desktop and mobile.

### Structure

The panel is organized into nested groups:

- `Source`
- `Encode`
- `Progressive`
- `Decode`
- `Transport`
- `Bench`
- `Display`

Each group has:

- a title
- a short summary
- an `i` button for group help
- child controls with their own `i` buttons when the control is non-obvious

### Relevance Rules

Controls can be in one of three states:

- active
- disabled and dimmed
- hidden only if the control has no meaning in the current app shell at all

Primary rule: keep the control visible whenever possible. If it is not relevant, disable it and dim it, and explain why.

Examples:

- progressive decode controls are active on the progressive page
- wrapper-lab-only batch controls are active on the wrapper page
- transport pacing controls are active when the stream path is in use
- pure viewer controls that do not affect batch mode are dimmed on the wrapper lab

## Shared Dashboard Content

### Source

- source selection or random-load trigger
- source metadata
- source reuse / reload indicators where relevant

### Encode

- encode backend
- quality
- effort
- lossless
- progressive on/off
- progressive flavor

### Progressive

- final decode vs progressive preview
- progressive step count
- preview source playback vs stream decode

### Decode

- decode backend
- priority
- preserve ICC
- preserve metadata
- emit every pass
- downsample
- region, if the implementation supports it in the current path

### Transport

- chunk size
- pacing delay
- transport mode preset
- hard `no pacing` option

This section is the key place to address the slow timings. The UI should make it obvious when the system is artificially waiting between chunks.

### Bench

- 300 long
- 800 long
- full-size reference
- concurrency
- run button
- results summary

### Display

- thumbnail display size for the bottom-of-page thumbnail grids
- optional density preset for compact vs roomy thumbnails

## Thumbnail Resizing

The bottom thumbnail area should be user-resizable.

Implementation intent:

- expose a slider in the `Display` section
- change the rendered thumbnail size, not the source image size
- apply the new size to the bottom gallery/grid on both pages
- preserve aspect ratio
- keep the resize fast enough that it feels immediate

Suggested behavior:

- default thumbnail display size remains the current size
- slider range roughly 12 px to 64 px
- the UI updates live while dragging

## Timing Visibility

The dashboard should separate timing categories so the user can identify the slowdown source.

Displayed categories:

- encode
- download / stream
- decode
- paint
- total wall time

For the progressive page, the current chunk-progress readout can remain, but it should sit under the transport section rather than acting as the only timing signal.

## Architecture

### Files and Responsibilities

| File | Responsibility |
|---|---|
| `web/jxl-progressive.html` | Host the shared dashboard shell and page-specific content |
| `web/jxl-progressive.css` | Style the drawer, nested groups, dimmed states, info buttons, and thumbnail resize affordances |
| `web/jxl-progressive.js` | Wire the progressive page controls, timing display, and transport settings |
| `web/jxl-wrapper-lab.html` | Host the same dashboard shell for the wrapper lab |
| `web/jxl-wrapper-lab.css` | Style the shared dashboard within the wrapper lab layout |
| `web/jxl-wrapper-lab.js` | Wire wrapper-lab relevance rules and shared display controls |
| `web/panels.js` or a new shared UI helper | Provide reusable helpers for nested sections, help popovers, and dim/disable state management |

### Shared Data Model

The dashboard should be driven by a small shared state object:

- current page mode
- current backend selection
- current decode mode
- current progressive settings
- current transport settings
- thumbnail size

The UI layer should derive enabled/disabled state from that object rather than duplicating rules in the markup.

### Help System

The `i` buttons should open short explanatory popovers.

Rules:

- one help popover open at a time
- clicking outside closes the active popover
- each help string should be short and practical
- the help text should explain the effect and the trade-off

## Transport Investigation Plan

Because the page is showing multi-second to multi-minute totals, the design must make it possible to test whether the problem is:

- codec throughput
- transport pacing
- worker queueing
- unnecessary decode replay

The dashboard should expose the knobs needed to isolate those variables:

- disable pacing
- reduce chunk delay
- reduce chunk count
- switch progressive preview on and off
- switch between source playback and stream decode

The intent is not to guess the fix in advance. The intent is to make the slow path visible and measurable.

## Wrapper-Lab Integration

The wrapper lab should reuse the same dashboard vocabulary.

Rules:

- same section names
- same help pattern
- same disabled/dimmed treatment
- same thumbnail resizing control for the batch grid

Mode-specific behavior:

- wrapper-only controls remain active there
- progressive-page-only controls are dimmed there
- batch controls remain active there

This keeps the UI consistent while still showing the user which switches matter on each page.

## Error Handling

- If a control is not supported in the current mode, disable it and explain why.
- If a transport setting cannot be applied, fall back to the current safe default and surface that in the status line.
- If a progressive decode path cannot emit intermediate frames, the UI should say so instead of pretending it worked.
- If a resize request is too aggressive for the viewport, clamp it to the allowed range.

## Testing

### Unit Tests

- shared panel state maps controls to relevance correctly
- disabled state is applied when a control is irrelevant
- help buttons open and close the correct popover
- thumbnail size slider updates the derived size state
- transport pacing can be set to zero or reduced safely

### Page Tests

- progressive page includes the shared dashboard
- wrapper lab includes the shared dashboard
- bottom thumbnails resize when the display slider changes
- 300-long and 800-long controls remain present and selectable

### Regression Checks

- verify the default transport path no longer inserts unbounded artificial delay
- verify timing output still reports encode / stream / decode / paint separately

## Success Criteria

- both pages expose the same dashboard shell
- irrelevant controls are visibly disabled and dimmed
- every major control group has an explanation button
- the bottom thumbnail area can be resized by the user
- timing output makes it clear whether the slowdown is codec work or artificial pacing
- the progressive page can be used to test DC-only and DC + AC behavior directly

## Rollout Plan

1. Add the shared dashboard shell and help popovers.
2. Wire relevance rules for both pages.
3. Add the thumbnail resize control and plumb it to the bottom thumbnail grids.
4. Expose transport pacing controls and remove hidden fixed-delay behavior.
5. Update tests for shared panel presence and resize behavior.
6. Verify the progressive page timings on a real ORF run.

## Decision Record

Chosen approach:

- one shared popout dashboard
- nested control groups
- dimmed disabled irrelevant controls
- explicit transport pacing controls
- user-resizable bottom thumbnails

Rejected alternatives:

- separate page-specific control panels
  - harder to keep in sync
- hide irrelevant controls entirely
  - less discoverable
- fixed always-visible control rail
  - too much vertical pressure on the content area

