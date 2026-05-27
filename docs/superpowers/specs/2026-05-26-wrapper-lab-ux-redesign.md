# Wrapper Lab UX Redesign

**Date:** 2026-05-26  
**Scope:** `web/jxl-wrapper-lab.html` + `web/jxl-wrapper-lab.js` + `web/jxl-wrapper-lab.css`  
**Goal:** Fix hidden file-loading flow, illegible Controls button, and ungated action buttons.

---

## Problem Summary

1. `wireDashboardControls()` moves `.control-band` (file picker + settings) and `.status-grid` into the hidden `.wrapper-dashboard` slide-out. File loading is therefore invisible on first visit — users must discover the "Controls" button before they can do anything.
2. The Controls button (`.dashboard-toggle`) renders with near-white text (`#ebeff5`) on a near-white background. Illegible.
3. "Run batch" and "Start Race" are always clickable even with no files loaded; they silently no-op.

---

## Design

### Structure after

```
[hero — mode buttons, Console button]          ← unchanged
[race-container]                               ← race mode only (unchanged)
[control-band]                                 ← ALWAYS in DOM, never moved
  left col: file drop + Load Random + Run batch + Clear
  right col: settings sliders (batch limit, concurrency, quality, effort, lossless, thumb size)
[status-grid]                                  ← ALWAYS in DOM, never moved
[batch-grid-shell]                             ← batch modes only (unchanged)
```

The `.wrapper-dashboard` aside, `#wrapper-controls-btn`, and `#wrapper-controls-close` are removed from the HTML.

### Responsive layout

Existing breakpoints handle everything. No new CSS needed beyond removing now-dead rules.

| Viewport | control-band |
|----------|-------------|
| > 1200 px | 2 columns: file panel left, settings right |
| ≤ 1200 px | 1 column: stacked |
| ≤ 900 px  | settings-panel collapses to 1 column |

### Disabled state gating

- `#run-batch` and `#start-race` start with `disabled` attribute in HTML.
- JS calls `updateRunButtons()` which sets/clears `disabled` based on `selectedSources.length > 0`.
- Call sites: after `loadSourcesFromFiles`, after `loadRandomSources`, inside `clearBatch`.
- Visual: native browser disabled dimming + `cursor: not-allowed` via CSS.

### Thumb size slider

Currently lives in dashboard "Display" group. Moves to `.settings-panel` as a 6th row alongside quality/effort/etc.

---

## Changes

### HTML (`jxl-wrapper-lab.html`)

- Remove `<aside id="wrapper-dashboard" ...>` block entirely.
- Remove `<button id="wrapper-controls-btn" ...>Controls</button>` from `.hero-actions`.
- Remove `<button id="wrapper-controls-close" ...>` (inside the aside — gone with it).
- Add `disabled` attribute to `#run-batch` and `#start-race` buttons.
- Move `#batch-thumb-size` label+input+value into `.settings-panel` (from the removed dashboard Display group).
- Remove `<link rel="stylesheet" href="./jxl-dashboard.css" />` — no longer using dashboard elements on this page.

### JS (`jxl-wrapper-lab.js`)

- Delete `wireDashboardControls()` function.
- Remove its call-site.
- Remove imports no longer used: `wireSlideoutPanel`, `wireHelpPopovers`, `setGroupDisabled`.
- Remove element queries for: `wrapperDashboard`, `wrapperControlsBtn`, `wrapperControlsClose`.
- Add `updateRunButtons()`:
  ```js
  function updateRunButtons() {
      const hasFiles = selectedSources.length > 0;
      runBatchBtn.disabled = !hasFiles;
      startRaceBtn.disabled = !hasFiles;
  }
  ```
- Call `updateRunButtons()` at end of `loadSourcesFromFiles`, `loadRandomSources`, `clearBatch`, and initial `wireControls()`.

### CSS (`jxl-wrapper-lab.css`)

- Add disabled style scoped to these buttons:
  ```css
  #run-batch:disabled,
  #start-race:disabled {
      opacity: 0.4;
      cursor: not-allowed;
      pointer-events: none;
  }
  ```
- No other CSS changes needed — existing responsive rules on `.control-band` and `.settings-panel` already handle layout at all breakpoints.

---

## Out of scope

- Other pages (`jxl-benchmark.html`, `jxl-progressive.html`) — untouched.
- `jxl-dashboard.css` — kept, not deleted (shared by other pages).
- Hero lede text — not changed.
- Race-container format/size chips — not changed.

---

## Success criteria

1. File drop zone and Load Random button visible immediately on page load, no button click required.
2. "Run batch" and "Start Race" are visually disabled (dimmed, not-allowed cursor) until at least one file is loaded.
3. Both buttons re-enable after load, re-disable after Clear.
4. No Controls button on the page.
5. All controls readable at all viewport widths (320 px – 1920 px).
6. No regressions on other pages.
