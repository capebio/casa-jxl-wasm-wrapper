# Progressive Controls Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one shared controls dashboard to the progressive and wrapper-lab pages, expose transport and progressive switches, and let users resize the thumbnail grids at the bottom of both pages.

**Architecture:** Add a shared UI helper for nested control groups and help popovers, then wire both pages to the same dashboard vocabulary. Keep the relevant state in each page module, derive disabled/dimmed behavior from mode, and apply thumbnail sizing through shared grid/canvas sizing helpers.

**Tech Stack:** Browser DOM, vanilla JS modules, CSS, Bun tests.

---

### Task 1: Add shared dashboard shell and help-popover helpers

**Files:**
- Create: `web/jxl-dashboard-ui.js`
- Modify: `web/jxl-progressive.html`
- Modify: `web/jxl-wrapper-lab.html`
- Modify: `web/jxl-progressive.css`
- Modify: `web/jxl-wrapper-lab.css`
- Test: `web/jxl-progressive-page.test.js`, `web/jxl-wrapper-lab.test.js`

- [ ] **Step 1: Write the failing tests**

```js
expect(readFileSync(new URL('./jxl-progressive.html', import.meta.url), 'utf8')).toContain('data-dashboard');
expect(readFileSync(new URL('./jxl-wrapper-lab.html', import.meta.url), 'utf8')).toContain('data-dashboard');
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `rtk proxy powershell -NoProfile -Command "bun test web/jxl-progressive-page.test.js web/jxl-wrapper-lab.test.js"`
Expected: fail because the dashboard markup is not present yet.

- [ ] **Step 3: Write the minimal implementation**

```js
export function wireDashboard(root, { onToggle, onHelp }) {
    // shared popout / help wiring
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `rtk proxy powershell -NoProfile -Command "bun test web/jxl-progressive-page.test.js web/jxl-wrapper-lab.test.js"`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add web/jxl-dashboard-ui.js web/jxl-progressive.html web/jxl-wrapper-lab.html web/jxl-progressive.css web/jxl-wrapper-lab.css web/jxl-progressive-page.test.js web/jxl-wrapper-lab.test.js
git commit -m "feat: add shared progressive dashboard shell"
```

### Task 2: Expose progressive, decode, and transport controls

**Files:**
- Modify: `web/jxl-progressive.js`
- Modify: `web/jxl-progressive.html`
- Modify: `web/jxl-progressive.css`
- Test: `web/jxl-progressive-page.test.js`, `web/jxl-progressive-decode.test.js`, `web/jxl-progressive-session.test.js`

- [ ] **Step 1: Write the failing tests**

```js
expect(source).toContain('transport pacing');
expect(source).toContain('progressiveFlavor');
expect(source).toContain('300 long');
expect(source).toContain('800 long');
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `rtk proxy powershell -NoProfile -Command "bun test web/jxl-progressive-page.test.js web/jxl-progressive-decode.test.js web/jxl-progressive-session.test.js"`
Expected: fail until the new controls are wired.

- [ ] **Step 3: Write the minimal implementation**

```js
function setTransportPacing(ms) {
    transportPacingMs = clamp(Number(ms) || 0, 0, 250);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `rtk proxy powershell -NoProfile -Command "bun test web/jxl-progressive-page.test.js web/jxl-progressive-decode.test.js web/jxl-progressive-session.test.js"`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add web/jxl-progressive.js web/jxl-progressive.html web/jxl-progressive.css web/jxl-progressive-page.test.js web/jxl-progressive-decode.test.js web/jxl-progressive-session.test.js
git commit -m "feat: add progressive transport controls"
```

### Task 3: Wire wrapper-lab relevance states and thumbnail resizing

**Files:**
- Modify: `web/jxl-wrapper-lab.js`
- Modify: `web/jxl-wrapper-lab.html`
- Modify: `web/jxl-wrapper-lab.css`
- Test: `web/jxl-wrapper-lab.test.js`

- [ ] **Step 1: Write the failing tests**

```js
expect(source).toContain('thumbnail size');
expect(source).toContain('disabled and dimmed');
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `rtk proxy powershell -NoProfile -Command "bun test web/jxl-wrapper-lab.test.js"`
Expected: fail until the batch grid responds to the display size control.

- [ ] **Step 3: Write the minimal implementation**

```js
function setThumbSize(px) {
    document.documentElement.style.setProperty('--thumb-size', `${px}px`);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `rtk proxy powershell -NoProfile -Command "bun test web/jxl-wrapper-lab.test.js"`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add web/jxl-wrapper-lab.js web/jxl-wrapper-lab.html web/jxl-wrapper-lab.css web/jxl-wrapper-lab.test.js
git commit -m "feat: resize wrapper lab thumbnails"
```

### Task 4: Verify UI and timing behavior in the browser

**Files:**
- Modify: none
- Test: browser verification against the served pages

- [ ] **Step 1: Run the app and inspect the progressive page**

Run: `rtk proxy powershell -NoProfile -Command "bun run serve.ts"`

- [ ] **Step 2: Open the local page and inspect the dashboard**

Expected: the dashboard opens, irrelevant controls are disabled/dimmed, and thumb size updates the bottom grid.

- [ ] **Step 3: Confirm timing split**

Expected: encode, stream/download, decode, paint, and wall time are visible separately.

- [ ] **Step 4: Confirm the 300-long / 800-long controls still work**

Expected: the run targets stay selectable and the thumb bench can run at both sizes.

---

**Coverage check**

- Shared dashboard shell: Task 1
- Disable/dim irrelevant controls: Tasks 1-3
- Help buttons: Task 1
- Transport pacing fix / visibility: Task 2
- 300-long and 800-long controls: Task 2
- Thumbnail resizing: Task 3
- Browser verification: Task 4

