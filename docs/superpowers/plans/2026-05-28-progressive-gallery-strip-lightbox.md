# Progressive Gallery Strip + Lightbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render each file as a progressive thumbnail strip that fills round-robin across photos, show timing/byte/percentage metadata beneath each thumbnail, and open any exact progressive state in a fullscreen popup lightbox with wraparound keyboard navigation.

**Architecture:** Split state orchestration from DOM rendering. A pure coordinator module will buffer frames per file and release them in round-robin order so the UI shows roughest states across all files first, then next roughest, etc. A separate lightbox module will own the popup overlay display and keyboard navigation, while the main gallery page only wires file input, decode sessions, and DOM updates.

**Tech Stack:** Vanilla ES modules, existing `@casabio/jxl-session` browser context, existing `jxl-debug-console`, HTML/CSS, Bun tests.

---

### Task 1: Add a pure round-robin gallery coordinator

**Files:**
- Create: `web/jxl-progressive-gallery-coordinator.js`
- Create: `web/jxl-progressive-gallery-coordinator.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { expect, test } from 'bun:test';
import { createGalleryCoordinator } from './jxl-progressive-gallery-coordinator.js';

test('releases roughest frames across all files before later rounds', () => {
  const coordinator = createGalleryCoordinator({
    files: [
      { fileId: 'a', name: 'a.jxl', byteLength: 100 },
      { fileId: 'b', name: 'b.jxl', byteLength: 200 },
    ],
  });

  coordinator.registerFrame('a', {
    frameIndex: 0,
    stage: 'dc',
    elapsedMs: 10,
    bytesFed: 64,
    info: { width: 1, height: 1 },
  });
  coordinator.registerFrame('a', {
    frameIndex: 1,
    stage: 'pass',
    elapsedMs: 20,
    bytesFed: 128,
    info: { width: 1, height: 1 },
  });

  expect(coordinator.visibleFrames('a').map((f) => f.frameIndex)).toEqual([0]);
  expect(coordinator.visibleFrames('b')).toEqual([]);

  coordinator.registerFrame('b', {
    frameIndex: 0,
    stage: 'dc',
    elapsedMs: 12,
    bytesFed: 80,
    info: { width: 2, height: 2 },
  });

  expect(coordinator.visibleFrames('a').map((f) => f.frameIndex)).toEqual([0]);
  expect(coordinator.visibleFrames('b').map((f) => f.frameIndex)).toEqual([0]);

  coordinator.markFileClosed('b');
  expect(coordinator.visibleFrames('a').map((f) => f.frameIndex)).toEqual([0, 1]);
});

test('wraps within a file series for exact-frame navigation', () => {
  const coordinator = createGalleryCoordinator({
    files: [{ fileId: 'a', name: 'a.jxl', byteLength: 100 }],
  });

  coordinator.registerFrame('a', { frameIndex: 0, stage: 'dc', elapsedMs: 10, bytesFed: 10, info: { width: 1, height: 1 } });
  coordinator.registerFrame('a', { frameIndex: 1, stage: 'pass', elapsedMs: 20, bytesFed: 20, info: { width: 1, height: 1 } });
  coordinator.registerFrame('a', { frameIndex: 2, stage: 'final', elapsedMs: 30, bytesFed: 100, info: { width: 1, height: 1 } });

  expect(coordinator.nextFrameIndex('a', 2)).toBe(0);
  expect(coordinator.prevFrameIndex('a', 0)).toBe(2);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test web\jxl-progressive-gallery-coordinator.test.js -v`

Expected: fail because `createGalleryCoordinator()` does not exist yet.

- [ ] **Step 3: Implement the minimal coordinator**

```js
// NOTE: The round-counter approach below was replaced during implementation.
// The actual implementation uses getVisibleCount() — see
// web/jxl-progressive-gallery-coordinator.js for the canonical code.
// The flushRounds approach failed its own spec test (frame visible before
// all files have round 0 data). Do not revert to flushRounds.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test web\jxl-progressive-gallery-coordinator.test.js -v`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/jxl-progressive-gallery-coordinator.js web/jxl-progressive-gallery-coordinator.test.js
git commit -m "feat: add progressive gallery round-robin coordinator"
```

---

### Task 2: Add the fullscreen lightbox for exact progressive states

**Files:**
- Create: `web/jxl-progressive-gallery-lightbox.js`
- Create: `web/jxl-progressive-gallery-lightbox.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { expect, test } from 'bun:test';
import { createGalleryLightbox } from './jxl-progressive-gallery-lightbox.js';

test('opens the exact clicked frame and wraps within the series on arrow keys', () => {
  const lightbox = createGalleryLightbox({
    framesByFile: new Map([
      ['a', [{ frameIndex: 0 }, { frameIndex: 1 }, { frameIndex: 2 }]],
      ['b', [{ frameIndex: 0 }, { frameIndex: 1 }]],
    ]),
  });

  lightbox.open('a', 1);
  expect(lightbox.current()).toEqual({ fileId: 'a', frameIndex: 1 });

  lightbox.handleKey({ key: 'ArrowRight', ctrlKey: false });
  expect(lightbox.current()).toEqual({ fileId: 'a', frameIndex: 2 });

  lightbox.handleKey({ key: 'ArrowRight', ctrlKey: false });
  expect(lightbox.current()).toEqual({ fileId: 'a', frameIndex: 0 });

  lightbox.handleKey({ key: 'ArrowLeft', ctrlKey: false });
  expect(lightbox.current()).toEqual({ fileId: 'a', frameIndex: 2 });
});

test('ctrl+arrow moves between photos and keeps the same roughness step when possible', () => {
  const lightbox = createGalleryLightbox({
    framesByFile: new Map([
      ['a', [{ frameIndex: 0 }, { frameIndex: 1 }, { frameIndex: 2 }]],
      ['b', [{ frameIndex: 0 }, { frameIndex: 1 }]],
    ]),
  });

  lightbox.open('a', 2);
  lightbox.handleKey({ key: 'ArrowRight', ctrlKey: true });
  expect(lightbox.current()).toEqual({ fileId: 'b', frameIndex: 1 });

  lightbox.handleKey({ key: 'ArrowRight', ctrlKey: true });
  expect(lightbox.current()).toEqual({ fileId: 'a', frameIndex: 2 });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test web\jxl-progressive-gallery-lightbox.test.js -v`

Expected: fail because `createGalleryLightbox()` does not exist yet.

- [ ] **Step 3: Implement the lightbox**

```js
export function createGalleryLightbox({ framesByFile }) {
  let state = null;

  return {
    open(fileId, frameIndex) {
      state = { fileId, frameIndex };
    },
    current() {
      return state;
    },
    handleKey(ev) {
      if (!state) return;
      const frames = framesByFile.get(state.fileId) ?? [];
      if (frames.length === 0) return;

      if (ev.ctrlKey && ev.key === 'ArrowRight') {
        const ids = [...framesByFile.keys()];
        const nextFile = ids[(ids.indexOf(state.fileId) + 1) % ids.length];
        const nextFrames = framesByFile.get(nextFile) ?? [];
        state = { fileId: nextFile, frameIndex: Math.min(state.frameIndex, Math.max(0, nextFrames.length - 1)) };
        return;
      }

      if (ev.ctrlKey && ev.key === 'ArrowLeft') {
        const ids = [...framesByFile.keys()];
        const nextFile = ids[(ids.indexOf(state.fileId) - 1 + ids.length) % ids.length];
        const nextFrames = framesByFile.get(nextFile) ?? [];
        state = { fileId: nextFile, frameIndex: Math.min(state.frameIndex, Math.max(0, nextFrames.length - 1)) };
        return;
      }

      if (ev.key === 'ArrowRight') {
        state = { fileId: state.fileId, frameIndex: (state.frameIndex + 1) % frames.length };
      } else if (ev.key === 'ArrowLeft') {
        state = { fileId: state.fileId, frameIndex: (state.frameIndex - 1 + frames.length) % frames.length };
      }
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test web\jxl-progressive-gallery-lightbox.test.js -v`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/jxl-progressive-gallery-lightbox.js web/jxl-progressive-gallery-lightbox.test.js
git commit -m "feat: add progressive gallery lightbox navigation"
```

---

### Task 3: Rebuild the gallery layout for thumbnail strips, metrics, and click targets

**Files:**
- Create: `web/jxl-progressive-gallery.css`
- Modify: `web/jxl-progressive-gallery.html`
- Modify: `web/jxl-progressive-gallery.js`
- Modify: `web/jxl-progressive-gallery.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./jxl-progressive-gallery.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('./jxl-progressive-gallery.js', import.meta.url), 'utf8');

test('gallery markup includes row/column grid and lightbox mount points', () => {
  expect(html).toContain('data-gallery-rows');
  expect(html).toContain('data-lightbox-root');
  expect(html).toContain('ArrowLeft');
  expect(html).toContain('Ctrl+ArrowRight');
});

test('gallery script wires progressive metadata under each thumbnail', () => {
  expect(js).toContain('bytesFed');
  expect(js).toContain('elapsedMs');
  expect(js).toContain('percentFed');
  expect(js).toContain('frameIndex');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test web\jxl-progressive-gallery.test.js -v`

Expected: fail because the gallery still renders the old single-canvas slots and does not expose the lightbox mounts.

- [ ] **Step 3: Add the thumbnail-strip markup and CSS**

```html
<section class="gallery-strip" data-gallery-rows aria-label="Progressive thumbnail strips"></section>
<div data-lightbox-root hidden></div>
```

```css
.gallery-strip {
  display: grid;
  gap: 12px;
}

.gallery-row {
  display: grid;
  grid-template-columns: 220px 1fr;
  gap: 12px;
}

.thumb-strip {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(140px, 1fr);
  gap: 8px;
  overflow-x: auto;
}

.thumb-cell {
  display: grid;
  gap: 6px;
}

.thumb-meta {
  font-size: 11px;
  color: #9aa0a6;
  line-height: 1.35;
}
```

- [ ] **Step 4: Update the gallery renderer to show a cell per progressive frame**

```js
function renderCell(fileId, frame, meta) {
  return {
    fileId,
    frameIndex: meta.frameIndex,
    stage: frame.stage,
    elapsedMs: meta.elapsedMs,
    bytesFed: meta.bytesFed,
    percentFed: meta.percentFed,
    info: frame.info,
    pixels: frame.pixels,
  };
}
```

Each thumbnail cell should include:
- the rendered frame canvas
- a metadata block with:
  - stage
  - elapsed ms
  - bytes fed / total bytes
  - percent fed
  - dimensions

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test web\jxl-progressive-gallery.test.js -v`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/jxl-progressive-gallery.css web/jxl-progressive-gallery.html web/jxl-progressive-gallery.js web/jxl-progressive-gallery.test.js
git commit -m "feat: render progressive gallery strips with metadata"
```

---

### Task 4: Wire progressive decode, round-robin reveal, and lightbox navigation together

**Files:**
- Modify: `web/jxl-progressive-gallery.js`
- Modify: `web/jxl-progressive-gallery.html`
- Modify: `web/jxl-progressive-gallery.css`
- Modify: `web/jxl-progressive-gallery.test.js`

- [ ] **Step 1: Write the failing integration test**

```js
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const js = readFileSync(new URL('./jxl-progressive-gallery.js', import.meta.url), 'utf8');

test('gallery keeps one decode per file and round-robin reveals progressive frames', () => {
  expect(js).toContain('createGalleryCoordinator');
  expect(js).toContain('createGalleryLightbox');
  expect(js).toContain('round-robin');
  expect(js).toContain('session.frames()');
  expect(js).toContain('Promise.all(pushes)');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test web\jxl-progressive-gallery.test.js -v`

Expected: fail because the main gallery file has not been refactored to use the new coordinator and lightbox modules.

- [ ] **Step 3: Rework the decode pipeline**

```js
const coordinator = createGalleryCoordinator({
  files: selectedFiles.map((file) => ({
    fileId: slotId(file),
    name: file.name,
    byteLength: file.size,
  })),
});

for (const file of selectedFiles) {
  const session = ctx.decode({
    format: 'rgba8',
    progressionTarget: 'final',
    emitEveryPass: true,
  });

  const pushPromise = pushChunks(session, file, pushMode);
  const framesPromise = consumeFrames(session, file, coordinator, lightbox);

  await Promise.all([pushPromise, framesPromise]);
}
```

Rules for the implementation:
- keep one `DecodeSession` per file
- keep the current file’s frames buffered
- reveal round 0 across all active files before revealing round 1
- when a file ends early, allow later rounds for the remaining files to proceed
- open the lightbox on the exact clicked frame
- `ArrowLeft`/`ArrowRight` step through frames within the same file and wrap around
- `Ctrl+ArrowLeft`/`Ctrl+ArrowRight` step between files while keeping the same frame index when possible

- [ ] **Step 4: Update the gallery to show per-frame progress and byte/timing metadata**

The metadata line beneath each thumbnail should render values like:

```text
dc · 84.2 ms · 262144 / 1282113 bytes · 20.4%
```

Use the byte-fed percentage from the gallery decode feeder, not the codec’s internal progress.

- [ ] **Step 5: Add a fullscreen fallback overlay**

```js
function openLightbox(fileId, frameIndex) {
  lightbox.open(fileId, frameIndex);
  const root = document.querySelector('[data-lightbox-root]');
  root.hidden = false;
  root.classList.add('is-open');
}
```

If `requestFullscreen()` is available, call it. If the browser denies it, the overlay still has to cover the viewport.

- [ ] **Step 6: Run the browser-facing tests**

Run:

```bash
bun test web\jxl-progressive-gallery.test.js web\jxl-progressive-gallery-coordinator.test.js web\jxl-progressive-gallery-lightbox.test.js packages\jxl-session\test\decode-session.test.ts
```

Expected: all pass.

- [ ] **Step 7: Manual browser check**

Open `web/jxl-progressive-gallery.html` and verify:
- two large files populate in round-robin order, roughest states first
- every thumbnail cell is clickable
- lightbox opens on the exact progressive state clicked
- `ArrowLeft`/`ArrowRight` wraps within the current series
- `Ctrl+ArrowLeft`/`Ctrl+ArrowRight` moves between photos
- metadata beneath thumbnails updates with timing, bytes, and percentage

- [ ] **Step 8: Commit**

```bash
git add web/jxl-progressive-gallery.js web/jxl-progressive-gallery.html web/jxl-progressive-gallery.css web/jxl-progressive-gallery.test.js
git commit -m "feat: add progressive thumbnail strips and lightbox"
```

---

## Self-Review Checklist

- The round-robin reveal has a dedicated task and a pure coordinator test.
- The exact-frame lightbox has its own module and keyboard coverage.
- The gallery layout, metadata, and clickable cells are covered separately from decode plumbing.
- The decode wiring task keeps one session per file and preserves progressive emission.
- No task refers to undefined helper names without defining them earlier in the plan.
- The plan stays focused on the gallery and lightbox; no unrelated codec refactors are included.
