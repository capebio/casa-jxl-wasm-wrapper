# Wrapper Lab UX Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the hidden Controls slide-out panel from the wrapper lab, expose file loading and settings inline, and disable action buttons until files are loaded.

**Architecture:** Three file edits only — HTML removes the `<aside>` dashboard and its trigger button, moves thumb-size slider into the settings panel, and adds `disabled` attrs to action buttons; JS removes `wireDashboardControls()` and all dashboard wiring, adds `updateRunButtons()`; CSS adds disabled-state styling. The test file loses two stale assertions and gains two replacement ones.

**Tech Stack:** Vanilla JS (ESM), HTML, CSS. Test runner: Bun (`bun test`).

---

## File Map

| File | Action | What changes |
|------|--------|-------------|
| `web/jxl-wrapper-lab.html` | Modify | Remove `<aside>` dashboard block + Controls button; move thumb-size into settings-panel; add `disabled` to `#run-batch` and `#start-race`; remove `jxl-dashboard.css` link |
| `web/jxl-wrapper-lab.js` | Modify | Delete `wireDashboardControls()`; remove dashboard element refs; remove unused imports; add + wire `updateRunButtons()` |
| `web/jxl-wrapper-lab.css` | Modify | Add disabled-state rules for `#run-batch` and `#start-race` |
| `web/jxl-wrapper-lab.test.js` | Modify | Replace `wrapper-controls-btn` + `wireSlideoutPanel` assertions with `source-drop` + `updateRunButtons` assertions |

---

### Task 1: Update the test file first (TDD — tests must fail before we fix code)

**Files:**
- Modify: `web/jxl-wrapper-lab.test.js`

- [ ] **Step 1: Open the test file and identify the two stale assertions**

  Lines 18 and 32 currently assert things that will be removed:
  ```
  expect(html).toContain('wrapper-controls-btn');   // line 18 — button being removed
  expect(js).toContain('wireSlideoutPanel');         // line 32 — import being removed
  ```

- [ ] **Step 2: Replace those two assertions with ones that match the new design**

  In `web/jxl-wrapper-lab.test.js`, replace lines 18 and 32:

  ```js
  // Before (line 18):
  expect(html).toContain('wrapper-controls-btn');
  // After:
  expect(html).toContain('id="source-drop"');
  ```

  ```js
  // Before (line 32):
  expect(js).toContain('wireSlideoutPanel');
  // After:
  expect(js).toContain('updateRunButtons');
  ```

  Full file after both edits:
  ```js
  import { expect, test } from 'bun:test';
  import { existsSync, readFileSync } from 'node:fs';

  const htmlPath = new URL('./jxl-wrapper-lab.html', import.meta.url);
  const jsPath = new URL('./jxl-wrapper-lab.js', import.meta.url);

  test('wrapper lab page is a separate page with three-way mode and 100-picture batch controls', () => {
      expect(existsSync(htmlPath)).toBe(true);
      expect(existsSync(jsPath)).toBe(true);

      const html = readFileSync(htmlPath, 'utf8');
      const js = readFileSync(jsPath, 'utf8');

      expect(html).toContain('JPEG XL wrapper lab');
      expect(html).toContain('data-mode="wrapper"');
      expect(html).toContain('data-mode="existing"');
      expect(html).toContain('data-mode="compare"');
      expect(html).toContain('id="source-drop"');
      expect(html).toContain('batch-thumb-size');
      expect(html).toContain('id="batch-limit"');
      expect(html).toContain('id="run-batch"');
      expect(html).toContain('id="batch-grid"');
      expect(html).toContain('id="dbg-console-btn"');
      expect(html).toContain('Session worker');
      expect(html).toContain('Direct wrapper');
      expect(html).toContain('Batch tiles encode and decode resized thumbnails, not full-size source frames.');
      expect(html).toContain('Session worker routes JPEG XL through the browser session stack');
      expect(js).toContain('createEncoder');
      expect(js).toContain('createDecoder');
      expect(js).toContain('MAX_BATCH_LIMIT = 100');
      expect(js).toContain('initDebugConsole(dbgConsoleBtn)');
      expect(js).toContain('updateRunButtons');
  });
  ```

- [ ] **Step 3: Run the test to confirm it fails (expected — HTML/JS not changed yet)**

  ```
  cd C:\Foo\raw-converter-wasm
  bun test web/jxl-wrapper-lab.test.js
  ```

  Expected output: FAIL — `source-drop` exists so that assertion passes, but `updateRunButtons` not yet in JS so that one fails.

- [ ] **Step 4: Commit the updated test**

  ```bash
  git add web/jxl-wrapper-lab.test.js
  git commit -m "test(wrapper-lab): update assertions for inline controls redesign"
  ```

---

### Task 2: Remove the dashboard from HTML

**Files:**
- Modify: `web/jxl-wrapper-lab.html`

- [ ] **Step 1: Remove the `jxl-dashboard.css` stylesheet link**

  Delete this line from `<head>` (line 10):
  ```html
  <link rel="stylesheet" href="./jxl-dashboard.css" />
  ```

- [ ] **Step 2: Remove the Controls button from `.hero-actions`**

  In `.hero-actions` (around line 63), delete:
  ```html
  <button id="wrapper-controls-btn" class="dashboard-toggle" type="button" aria-expanded="false">Controls</button>
  ```

  `.hero-actions` should now contain only the mode-switch and Console button:
  ```html
  <div class="hero-actions">
      <div class="mode-switch" role="group" aria-label="Test mode">
          <button class="mode-btn is-active" type="button" data-mode="race" aria-pressed="true">Drag Race</button>
          <button class="mode-btn" type="button" data-mode="existing" aria-pressed="false">Session worker</button>
          <button class="mode-btn" type="button" data-mode="wrapper" aria-pressed="false">Direct wrapper</button>
          <button class="mode-btn" type="button" data-mode="compare" aria-pressed="false">Compare</button>
      </div>
      <button id="dbg-console-btn" class="secondary-btn" type="button">Console</button>
  </div>
  ```

- [ ] **Step 3: Add `disabled` attribute to `#start-race`**

  In `.race-controls` (around line 81), change:
  ```html
  <button id="start-race" class="primary-btn">Start Race</button>
  ```
  to:
  ```html
  <button id="start-race" class="primary-btn" disabled>Start Race</button>
  ```

- [ ] **Step 4: Remove the entire `<aside id="wrapper-dashboard">` block**

  Delete lines 95–142 in full — the entire aside element:
  ```html
  <aside id="wrapper-dashboard" class="dashboard" aria-hidden="true" data-open="false">
      ...
  </aside>
  ```
  (Everything from `<aside id="wrapper-dashboard"` to its closing `</aside>`.)

- [ ] **Step 5: Move the thumb-size slider into `.settings-panel` and add `disabled` to `#run-batch`**

  The `.control-band` section (around line 144) currently looks like:
  ```html
  <section class="control-band compact">
      <div class="source-panel">
          <label class="file-drop" for="source-input" id="source-drop">
              <input id="source-input" type="file" multiple accept=".orf,.ORF,.jpg,.jpeg,.png,.tif,.tiff,.jxl,image/*" hidden />
              <strong>Pick files</strong>
              <span>ORF, JPEG, PNG, TIFF, JXL</span>
          </label>
          <div class="control-row">
              <button id="load-random" class="secondary-btn" type="button">Random Gobabeb</button>
              <button id="run-batch" class="secondary-btn" type="button">Run batch</button>
              <button id="clear-batch" class="secondary-btn" type="button">Clear</button>
          </div>
      </div>

      <div class="settings-panel">
          <label class="setting"> ... batch-limit ... </label>
          <label class="setting"> ... batch-concurrency ... </label>
          <label class="setting"> ... batch-quality ... </label>
          <label class="setting"> ... batch-effort ... </label>
          <label class="setting toggle-setting"> ... batch-lossless ... </label>
      </div>
  </section>
  ```

  Replace with (adds `disabled` to `#run-batch`, appends thumb-size as 6th setting):
  ```html
  <section class="control-band compact">
      <div class="source-panel">
          <label class="file-drop" for="source-input" id="source-drop">
              <input id="source-input" type="file" multiple accept=".orf,.ORF,.jpg,.jpeg,.png,.tif,.tiff,.jxl,image/*" hidden />
              <strong>Pick files</strong>
              <span>ORF, JPEG, PNG, TIFF, JXL</span>
          </label>
          <div class="control-row">
              <button id="load-random" class="secondary-btn" type="button">Random Gobabeb</button>
              <button id="run-batch" class="secondary-btn" type="button" disabled>Run batch</button>
              <button id="clear-batch" class="secondary-btn" type="button">Clear</button>
          </div>
      </div>

      <div class="settings-panel">
          <label class="setting">
              <span>Batch limit</span>
              <input id="batch-limit" type="range" min="1" max="100" step="1" value="5" />
              <strong id="batch-limit-value">5</strong>
          </label>
          <label class="setting">
              <span>Concurrency</span>
              <input id="batch-concurrency" type="range" min="1" max="16" step="1" value="6" />
              <strong id="batch-concurrency-value">6</strong>
          </label>
          <label class="setting">
              <span>Quality</span>
              <input id="batch-quality" type="range" min="50" max="100" step="1" value="90" />
              <strong id="batch-quality-value">90</strong>
          </label>
          <label class="setting">
              <span>Effort</span>
              <input id="batch-effort" type="range" min="1" max="9" step="1" value="3" />
              <strong id="batch-effort-value">3</strong>
          </label>
          <label class="setting toggle-setting">
              <span>Lossless</span>
              <input id="batch-lossless" type="checkbox" />
          </label>
          <label class="setting">
              <span>Thumb size</span>
              <input id="batch-thumb-size" type="range" min="120" max="320" step="8" value="180" />
              <strong id="batch-thumb-size-value">180</strong>
          </label>
      </div>
  </section>
  ```

- [ ] **Step 6: Verify HTML is valid (no unclosed tags)**

  Open `web/jxl-wrapper-lab.html` in a browser at `http://localhost:9000/web/jxl-wrapper-lab.html` and confirm no console errors. The file picker and settings sliders should be visible immediately without any button click.

- [ ] **Step 7: Commit the HTML changes**

  ```bash
  git add web/jxl-wrapper-lab.html
  git commit -m "feat(wrapper-lab): remove dashboard slide-out, expose controls inline"
  ```

---

### Task 3: Update the JS — remove dashboard wiring, add updateRunButtons

**Files:**
- Modify: `web/jxl-wrapper-lab.js`

- [ ] **Step 1: Remove unused imports**

  The import block at the top currently reads:
  ```js
  import {
      bindRangeLabel,
      clamp,
      setCssVar,
      setGroupDisabled,
      wireHelpPopovers,
      wireSlideoutPanel,
  } from './jxl-dashboard-ui.js';
  ```

  Remove the three no-longer-needed names:
  ```js
  import {
      bindRangeLabel,
      clamp,
      setCssVar,
  } from './jxl-dashboard-ui.js';
  ```

- [ ] **Step 2: Remove dashboard element queries and unused panel refs**

  Delete these three `const` declarations (around lines 40–42):
  ```js
  const wrapperDashboard = document.getElementById('wrapper-dashboard');
  const wrapperControlsBtn = document.getElementById('wrapper-controls-btn');
  const wrapperControlsClose = document.getElementById('wrapper-controls-close');
  ```

  Also delete these two (only used by `wireDashboardControls` to move them into the aside):
  ```js
  const controlBand = document.querySelector('.control-band');
  const statusGrid = document.querySelector('.status-grid');
  ```

- [ ] **Step 3: Delete `wireDashboardControls()` entirely**

  Remove the whole function (lines 1245–1262):
  ```js
  function wireDashboardControls() {
      wireSlideoutPanel({
          panel: wrapperDashboard,
          openButton: wrapperControlsBtn,
          closeButton: wrapperControlsClose,
      });
      wireHelpPopovers(wrapperDashboard);

      wrapperDashboard?.appendChild(controlBand);
      wrapperDashboard?.appendChild(statusGrid);

      bindRangeLabel(batchThumbSizeInput, batchThumbSizeValue, (value) => String(value));
      batchThumbSizeInput?.addEventListener('input', syncBatchThumbSize);
      syncBatchThumbSize();

      setGroupDisabled(wrapperDashboard?.querySelector('[data-group="progressive"]'), true, 'Progressive encode controls live on the progressive page.');
      setGroupDisabled(wrapperDashboard?.querySelector('[data-group="display"]'), false);
  }
  ```

- [ ] **Step 4: Add `updateRunButtons()` function**

  Add this function just before `wireControls()`:
  ```js
  function updateRunButtons() {
      const hasFiles = selectedSources.length > 0;
      runBatchBtn.disabled = !hasFiles;
      startRaceBtn.disabled = !hasFiles;
  }
  ```

- [ ] **Step 5: Wire thumb-size binding in `wireControls()` (was in wireDashboardControls)**

  In `wireControls()`, after the `syncSettingLabels()` call at the top of the function, add:
  ```js
  bindRangeLabel(batchThumbSizeInput, batchThumbSizeValue, (value) => String(value));
  batchThumbSizeInput?.addEventListener('input', syncBatchThumbSize);
  syncBatchThumbSize();
  ```

- [ ] **Step 6: Call `updateRunButtons()` in `wireControls()`**

  In `wireControls()`, after `resetGrid()`, add:
  ```js
  updateRunButtons();
  ```

- [ ] **Step 7: Call `updateRunButtons()` at end of `loadSourcesFromFiles`**

  The function currently ends:
  ```js
  async function loadSourcesFromFiles(fileList) {
      ...
      batchStatus.textContent = `Loaded ${loaded.length} file(s) in ${fmtTiming(elapsed)}.`;
      setCounters({ loaded: loaded.length });
  }
  ```

  Add the call:
  ```js
  async function loadSourcesFromFiles(fileList) {
      ...
      batchStatus.textContent = `Loaded ${loaded.length} file(s) in ${fmtTiming(elapsed)}.`;
      setCounters({ loaded: loaded.length });
      updateRunButtons();
  }
  ```

- [ ] **Step 8: Call `updateRunButtons()` at end of `loadRandomSources`**

  The function currently ends (around line 753–754):
  ```js
  batchStatus.textContent = `Loaded ${loaded.length}/${total} random Gobabeb files in ${fmtTiming(elapsed)}.`;
  setCounters({ loaded: loaded.length });
  ```

  Add the call:
  ```js
  batchStatus.textContent = `Loaded ${loaded.length}/${total} random Gobabeb files in ${fmtTiming(elapsed)}.`;
  setCounters({ loaded: loaded.length });
  updateRunButtons();
  ```

- [ ] **Step 9: Call `updateRunButtons()` at end of `clearBatch`**

  The function currently ends:
  ```js
  function clearBatch() {
      ...
      setStatus('Idle.', 'Ready.');
  }
  ```

  Add the call:
  ```js
  function clearBatch() {
      ...
      setStatus('Idle.', 'Ready.');
      updateRunButtons();
  }
  ```

- [ ] **Step 10: Remove `wireDashboardControls()` call from the init block**

  Near the bottom of the file, delete the call:
  ```js
  wireDashboardControls();
  ```

  The init block should now read:
  ```js
  await initRaw();
  if (dbgConsoleBtn) initDebugConsole(dbgConsoleBtn);
  void resetContext().then((ctx) => {
      existingContext = ctx;
      sessionBackendBroken = false;
  }).catch(() => {});
  wireControls();
  setCounters({ loaded: 0, queued: 0, done: 0, errors: 0 });
  ```

- [ ] **Step 11: Commit JS changes**

  ```bash
  git add web/jxl-wrapper-lab.js
  git commit -m "feat(wrapper-lab): remove wireDashboardControls, add updateRunButtons"
  ```

---

### Task 4: Add disabled-state CSS

**Files:**
- Modify: `web/jxl-wrapper-lab.css`

- [ ] **Step 1: Add disabled styles at the end of the file**

  Append to `web/jxl-wrapper-lab.css`:
  ```css
  #run-batch:disabled,
  #start-race:disabled {
      opacity: 0.4;
      cursor: not-allowed;
      pointer-events: none;
  }
  ```

- [ ] **Step 2: Commit CSS**

  ```bash
  git add web/jxl-wrapper-lab.css
  git commit -m "feat(wrapper-lab): disable-state styles for run-batch and start-race"
  ```

---

### Task 5: Run tests and verify

- [ ] **Step 1: Run the wrapper lab test**

  ```
  cd C:\Foo\raw-converter-wasm
  bun test web/jxl-wrapper-lab.test.js
  ```

  Expected: PASS — `id="source-drop"` exists in HTML, `updateRunButtons` exists in JS.

- [ ] **Step 2: Run all tests to check for regressions**

  ```
  bun test
  ```

  Expected: all previously passing tests still pass.

- [ ] **Step 3: Manual smoke test in browser**

  Open `http://localhost:9000/web/jxl-wrapper-lab.html` and verify:
  1. File drop zone visible immediately — no button click needed.
  2. Settings sliders (batch limit, concurrency, quality, effort, lossless, thumb size) visible in right column.
  3. "Run batch" button is dimmed and unclickable on load.
  4. "Start Race" button is dimmed and unclickable on load.
  5. Click "Load Random Gobabeb" — both buttons activate after files load.
  6. Click "Clear" — both buttons dim again.
  7. No Controls button anywhere on the page.
  8. Resize window to ≤1200 px — settings stack below file panel.
  9. Check other pages (`jxl-benchmark.html`, `jxl-progressive.html`) load without errors.

- [ ] **Step 4: Commit final verification**

  ```bash
  git add .
  git commit -m "chore(wrapper-lab): verify ux redesign complete"
  ```
  (Only commit if there are any unstaged files from verification; otherwise skip.)
