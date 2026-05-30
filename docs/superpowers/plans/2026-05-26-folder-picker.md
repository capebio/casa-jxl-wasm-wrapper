# Folder Picker — Replaces Gobabeb Hardcode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace all hardcoded RAW folder paths with a persistent, user-selected folder using the File System Access API; remove the dead `/api/random-gobabeb` server endpoint.

**Architecture:** New module `web/jxl-source-folder.js` encapsulates IndexedDB persistence and File System Access API (with `<input webkitdirectory>` fallback). Wrapper lab and benchmark replace their `loadRandom*` functions to use the module, passing the resulting `File[]` into their existing file-loading pipelines. Server-side constants and endpoints are deleted.

**Tech Stack:** Vanilla JS ES modules, File System Access API (`showDirectoryPicker`), IndexedDB, `<input webkitdirectory>` fallback, Bun test runner.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `web/jxl-source-folder.js` | Create | IndexedDB persistence + folder picker + random RAW sampling |
| `web/jxl-wrapper-lab.js` | Modify | Replace `loadRandomSources` / `loadRandomFileSource`; update button label logic |
| `web/jxl-wrapper-lab.html` | Modify | Update button initial text |
| `web/jxl-benchmark.js` | Modify | Replace `loadRandomImages`; update button label logic |
| `web/jxl-benchmark.html` | Modify | Update button initial text |
| `serve.ts` | Modify | Remove `RANDOM_ORF_FOLDER`, `RANDOM_GOBABEB_FOLDER`, `/api/random-orf`, `/api/random-gobabeb` |
| `web/orf-render.test.js` | Modify | Replace hardcoded folder with `TEST_RAW_FOLDER` env var + skip guard |
| `web/icodec-jxl-worker.test.js` | Modify | Replace hardcoded path with `TEST_RAW_FILE` env var + skip guard |

---

### Task 1: Create `web/jxl-source-folder.js`

**Files:**
- Create: `web/jxl-source-folder.js`

No automated unit test is possible: IndexedDB and File System Access API require a real browser environment. Manual verification is in Task 4.

- [ ] **Step 1: Create the module**

Create `web/jxl-source-folder.js` with the full implementation:

```js
const RAW_EXTENSIONS = new Set([
    '.orf', '.dng', '.cr2', '.cr3', '.nef',
    '.arw', '.raf', '.rw2', '.pef', '.srw',
]);

const DB_NAME = 'jxl-source-folder';
const STORE_NAME = 'handles';
const HANDLE_KEY = 'folder';

function openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

export async function saveHandle(handle) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(handle, HANDLE_KEY);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
    });
}

export async function loadHandle() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(HANDLE_KEY);
        req.onsuccess = () => { db.close(); resolve(req.result ?? null); };
        req.onerror = () => { db.close(); reject(req.error); };
    });
}

export async function verifyHandle(handle) {
    if (!handle || typeof handle.queryPermission !== 'function') return false;
    try {
        const state = await handle.queryPermission({ mode: 'read' });
        if (state === 'granted') return true;
        const requested = await handle.requestPermission({ mode: 'read' });
        return requested === 'granted';
    } catch {
        return false;
    }
}

export async function pickFolder() {
    if (typeof window.showDirectoryPicker === 'function') {
        try {
            return await window.showDirectoryPicker({ mode: 'read' });
        } catch (err) {
            if (err.name === 'AbortError') return null;
            throw err;
        }
    }
    // Fallback: webkitdirectory input — returns pseudo-handle with _files array
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.webkitdirectory = true;
        input.onchange = () => {
            if (!input.files?.length) return resolve(null);
            resolve({ _files: [...input.files], name: 'selected folder' });
        };
        input.oncancel = () => resolve(null);
        input.click();
    });
}

export async function randomRaws(handle, n) {
    const files = [];

    if (handle._files) {
        // Fallback pseudo-handle
        for (const f of handle._files) {
            const ext = '.' + (f.name.split('.').pop() || '').toLowerCase();
            if (RAW_EXTENSIONS.has(ext)) files.push(f);
        }
    } else {
        for await (const [name, entry] of handle.entries()) {
            if (entry.kind !== 'file') continue;
            const ext = '.' + (name.split('.').pop() || '').toLowerCase();
            if (RAW_EXTENSIONS.has(ext)) files.push(await entry.getFile());
        }
    }

    // Fisher-Yates shuffle, take first n
    for (let i = files.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [files[i], files[j]] = [files[j], files[i]];
    }
    return files.slice(0, n);
}
```

- [ ] **Step 2: Commit**

```bash
git add web/jxl-source-folder.js
git commit -m "feat(source-folder): add persistent folder picker module"
```

---

### Task 2: Fix hardcoded paths in test files

**Files:**
- Modify: `web/orf-render.test.js`
- Modify: `web/icodec-jxl-worker.test.js`

- [ ] **Step 1: Verify tests currently fail due to hardcoded paths**

Run:
```
bun test web/orf-render.test.js web/icodec-jxl-worker.test.js 2>&1 | head -30
```
Expected: errors about missing folders/files.

- [ ] **Step 2: Fix `web/orf-render.test.js`**

Replace lines 7–28 with env-var guard. The full updated top of the file:

```js
import { expect, test } from 'bun:test';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import initRaw, { process_orf, rgb_to_rgba } from '../pkg/raw_converter_wasm.js';
import { encodeBackendForTarget } from './jxl-progressive-policy.js';

const RAW_FOLDER = process.env.TEST_RAW_FOLDER ?? null;
const SELECTED_COUNT = 2;
const ENCODE_BACKENDS = ['jsquash', 'libjxl'];
const PROGRESSIVE_MODES = [false, true];

function getOrfEntries() {
    if (!RAW_FOLDER) throw new Error('TEST_RAW_FOLDER not set');
    if (!existsSync(RAW_FOLDER)) {
        throw new Error(`RAW folder not found: ${RAW_FOLDER}`);
    }

    const entries = readdirSync(RAW_FOLDER)
        .filter((name) => name.toLowerCase().endsWith('.orf'))
        .map((name) => ({
            name,
            path: join(RAW_FOLDER, name),
            size: readFileSync(join(RAW_FOLDER, name)).byteLength,
        }))
        .sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));

    if (!entries.length) {
        throw new Error(`No ORF files found in ${RAW_FOLDER}`);
    }
    return entries.slice(0, SELECTED_COUNT).map((entry) => ({
        ...entry,
```

Then, for each `test(...)` block in the file, wrap the body so it skips when `RAW_FOLDER` is null. The first test call (there is one outer loop that calls `test()`) needs:

```js
// At each test() call site, replace the pattern:
test(`...`, async () => {
    // existing body
});
// With:
test(`...`, async () => {
    if (!RAW_FOLDER) return; // skip: TEST_RAW_FOLDER not set
    // existing body
});
```

Read the full file first to find all `test(` call sites, then add the skip guard to each.

- [ ] **Step 3: Fix `web/icodec-jxl-worker.test.js`**

Replace lines 10–15:

Old:
```js
const DEFAULT_ORF_PATH = String.raw`C:\995\2026-02-24 Avis Dam Part II\P2240674 Solanum nigrum.ORF`;
const ORF_PATH = process.env.TEST_ORF ?? DEFAULT_ORF_PATH;

if (!existsSync(ORF_PATH)) {
    throw new Error(`ORF fixture not found: ${ORF_PATH}`);
}
```

New:
```js
const RAW_PATH = process.env.TEST_RAW_FILE ?? null;
```

Then at the top of the single `test(...)` callback, add:
```js
if (!RAW_PATH) return; // skip: TEST_RAW_FILE not set
if (!existsSync(RAW_PATH)) throw new Error(`RAW fixture not found: ${RAW_PATH}`);
```

Replace all remaining `ORF_PATH` references in the file with `RAW_PATH`.

- [ ] **Step 4: Verify tests now skip cleanly**

Run:
```
bun test web/orf-render.test.js web/icodec-jxl-worker.test.js 2>&1 | head -30
```
Expected: tests pass or show as skipped, no errors about missing files.

- [ ] **Step 5: Commit**

```bash
git add web/orf-render.test.js web/icodec-jxl-worker.test.js
git commit -m "fix(tests): replace hardcoded RAW paths with TEST_RAW_FOLDER/TEST_RAW_FILE env vars"
```

---

### Task 3: Clean up `serve.ts` — remove dead endpoints

**Files:**
- Modify: `serve.ts`

- [ ] **Step 1: Remove constants and routes from `serve.ts`**

Delete line 14: `const RANDOM_ORF_FOLDER = ...`  
Delete line 15: `const RANDOM_GOBABEB_FOLDER = ...`

Delete the entire `/api/random-orf` handler block (lines 55–80):
```ts
if (path === "/api/random-orf") {
    // ... entire block
}
```

Delete the entire `/api/random-gobabeb` handler block (lines 81–106):
```ts
if (path === "/api/random-gobabeb") {
    // ... entire block
}
```

Also remove now-unused imports from `"node:fs/promises"`. The remaining used imports are: `mkdir`, `readFile`, `readdir` (used by nothing now — check), `writeFile`. After removal of both endpoints, `readdir` is no longer used. Remove it from the import.

Final import line:
```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
```

- [ ] **Step 2: Verify server still starts**

Run:
```
bun run serve.ts
```
Expected: `Serving http://localhost:9000` with no errors. Press Ctrl+C.

- [ ] **Step 3: Commit**

```bash
git add serve.ts
git commit -m "fix(serve): remove dead RANDOM_ORF_FOLDER and RANDOM_GOBABEB_FOLDER endpoints"
```

---

### Task 4: Wire folder picker into Wrapper Lab

**Files:**
- Modify: `web/jxl-wrapper-lab.js`
- Modify: `web/jxl-wrapper-lab.html`

Context: `jxl-wrapper-lab.js` currently has `loadRandomFileSource()` (fetches `/api/random-gobabeb`) and `loadRandomSources(count)` (calls it N times with concurrency). Both are replaced. `syncSettingLabels()` (line ~276) sets `loadRandomBtn.textContent` — that line must be updated to use folder name state. `getBatchLimit()` returns current slider value.

- [ ] **Step 1: Add import to `web/jxl-wrapper-lab.js`**

At line 1 (after existing imports), add:
```js
import { pickFolder, saveHandle, loadHandle, verifyHandle, randomRaws } from './jxl-source-folder.js';
```

- [ ] **Step 2: Add `savedFolderHandle` state variable**

After `let sessionBackendBroken = false;` (around line 59), add:
```js
let savedFolderHandle = null;
```

- [ ] **Step 3: Add `getFolderBtnLabel()` and `initFolderHandle()`**

After the `savedFolderHandle` declaration, add:
```js
function getFolderBtnLabel() {
    if (!savedFolderHandle) return 'Pick RAW folder';
    return `Load ${getBatchLimit()} from "${savedFolderHandle.name}"`;
}

async function initFolderHandle() {
    savedFolderHandle = await loadHandle();
    syncSettingLabels();
}
```

- [ ] **Step 4: Update `syncSettingLabels()` to use `getFolderBtnLabel()`**

In `syncSettingLabels()` (around line 281), replace:
```js
    loadRandomBtn.textContent = `Load ${getBatchLimit()} random Gobabeb file${getBatchLimit() === 1 ? '' : 's'}`;
```
With:
```js
    loadRandomBtn.textContent = getFolderBtnLabel();
```

- [ ] **Step 5: Replace `loadRandomFileSource` and `loadRandomSources` with new implementation**

Delete the entire `loadRandomFileSource()` function (lines 537–547).

Replace the entire `loadRandomSources()` function (lines 734–763) with:
```js
async function loadRandomSources(count = getBatchLimit()) {
    let handle = savedFolderHandle;
    if (!handle || !(await verifyHandle(handle))) {
        handle = await pickFolder();
        if (!handle) return;
        if (typeof handle.entries === 'function') await saveHandle(handle);
        savedFolderHandle = handle;
        syncSettingLabels();
    }
    const files = await randomRaws(handle, count);
    if (!files.length) {
        batchStatus.textContent = 'No RAW files found in selected folder.';
        return;
    }
    await loadSourcesFromFiles(files);
}
```

- [ ] **Step 6: Call `initFolderHandle()` at startup**

In the init block at the bottom of the file (around line 1267, after `await initRaw()`), add:
```js
void initFolderHandle();
```

- [ ] **Step 7: Update HTML button initial text**

In `web/jxl-wrapper-lab.html` around line 105, change:
```html
<button id="load-random" class="secondary-btn" type="button">Random Gobabeb</button>
```
To:
```html
<button id="load-random" class="secondary-btn" type="button">Pick RAW folder</button>
```

- [ ] **Step 8: Verify manually**

Start server: `bun run serve.ts`  
Open `http://localhost:9000/web/jxl-wrapper-lab.html`

Check:
1. Button shows "Pick RAW folder" on first visit (no saved folder)
2. Clicking opens native folder picker (Chrome/Edge) or file picker (fallback)
3. After picking, button updates to `Load N from "foldername"`
4. Files load into batch grid
5. Reload page → button shows `Load N from "foldername"` immediately (persisted)
6. After picking, Run batch and Start Race buttons become enabled

- [ ] **Step 9: Commit**

```bash
git add web/jxl-wrapper-lab.js web/jxl-wrapper-lab.html
git commit -m "feat(wrapper-lab): replace Gobabeb fetch with persistent folder picker"
```

---

### Task 5: Wire folder picker into Benchmark

**Files:**
- Modify: `web/jxl-benchmark.js`
- Modify: `web/jxl-benchmark.html`

Context: `jxl-benchmark.js` has `loadRandomImages()` which fetches from `/api/random-gobabeb` sequentially. The button is `#load-random`. `selectedSources` is module-level. `processImageFile(file, arrayBuffer)` is the existing file processor — takes `(fileInfo, arrayBuffer)`.

- [ ] **Step 1: Add import to `web/jxl-benchmark.js`**

At the top of the file (after existing imports, if any — benchmark may have no ES imports at the top), add:
```js
import { pickFolder, saveHandle, loadHandle, verifyHandle, randomRaws } from './jxl-source-folder.js';
```

- [ ] **Step 2: Add `savedFolderHandle` state and label helpers**

After the `let wasmReady = false;` declaration (around line 182), add:
```js
let savedFolderHandle = null;

function getFolderBtnLabel() {
    if (!savedFolderHandle) return 'Pick RAW folder';
    return `Load from "${savedFolderHandle.name}"`;
}

async function initFolderHandle() {
    savedFolderHandle = await loadHandle();
    if (loadRandomBtn) loadRandomBtn.textContent = getFolderBtnLabel();
}
```

- [ ] **Step 3: Replace `loadRandomImages()` with new implementation**

Delete the entire `loadRandomImages()` function (lines 528–594) and replace with:
```js
async function loadRandomImages() {
    const maxFiles = Number(maxFilesInput.value);

    if (!wasmReady) {
        setProgress('WASM not ready — wait a moment and try again.');
        dbgLog('✗ loadRandomImages: WASM not ready');
        return;
    }

    let handle = savedFolderHandle;
    if (!handle || !(await verifyHandle(handle))) {
        handle = await pickFolder();
        if (!handle) return;
        if (typeof handle.entries === 'function') await saveHandle(handle);
        savedFolderHandle = handle;
        if (loadRandomBtn) loadRandomBtn.textContent = getFolderBtnLabel();
    }

    loadRandomBtn.disabled = true;
    loadRandomBtn.textContent = 'Loading…';
    setProgress(`Loading files from "${handle.name}"...`);
    dbgLog('Loading random images...');

    selectedSources = [];
    let lastError = null;

    try {
        const files = await randomRaws(handle, maxFiles);
        if (!files.length) {
            setProgress('No RAW files found in selected folder.');
            return;
        }

        for (const file of files) {
            try {
                const fetchStart = performance.now();
                const arrayBuffer = await file.arrayBuffer();
                const fetchMs = performance.now() - fetchStart;

                const processStart = performance.now();
                const rgba = await processImageFile(file, arrayBuffer);
                const processMs = performance.now() - processStart;

                if (rgba) {
                    selectedSources.push({ file: file.name, ...rgba });
                    const fileSizeKB = (arrayBuffer.byteLength / 1024).toFixed(1);
                    dbgLog(`✓ ${file.name}`, `${rgba.width}×${rgba.height} | read ${fetchMs.toFixed(1)}ms + decode ${processMs.toFixed(1)}ms | ${fileSizeKB} KB`);
                } else {
                    lastError = `Processing failed for ${file.name}`;
                    dbgLog(`✗ ${lastError}`);
                }
            } catch (err) {
                lastError = err.message;
                dbgLog(`✗ Error: ${err.message}`);
                console.error('loadRandomImages error:', err);
                break;
            }
        }
    } finally {
        loadRandomBtn.disabled = false;
        loadRandomBtn.textContent = getFolderBtnLabel();
    }

    updateSelectionStatus();
    if (selectedSources.length) {
        setProgress(`Loaded ${selectedSources.length} random file${selectedSources.length !== 1 ? 's' : ''}.`);
    } else if (lastError) {
        setProgress(`Failed: ${lastError}`);
    }
}
```

- [ ] **Step 4: Call `initFolderHandle()` at startup**

After `initRaw().then(...)` block (around line 317), add:
```js
void initFolderHandle();
```

- [ ] **Step 5: Update HTML button initial text**

In `web/jxl-benchmark.html` around line 59, change:
```html
<button id="load-random" class="secondary-btn" type="button">Random Gobabeb</button>
```
To:
```html
<button id="load-random" class="secondary-btn" type="button">Pick RAW folder</button>
```

- [ ] **Step 6: Verify manually**

Open `http://localhost:9000/web/jxl-benchmark.html`

Check:
1. Button shows "Pick RAW folder" (no saved folder) OR `Load from "foldername"` (folder persisted from wrapper lab — same IndexedDB)
2. Clicking opens folder picker
3. After picking, files load and benchmark can run

- [ ] **Step 7: Commit**

```bash
git add web/jxl-benchmark.js web/jxl-benchmark.html
git commit -m "feat(benchmark): replace Gobabeb fetch with persistent folder picker"
```

---

## Verification checklist (after all tasks)

- [ ] `bun test web/orf-render.test.js web/icodec-jxl-worker.test.js` — both skip cleanly with no hardcoded-path errors
- [ ] `grep -r "Gobabeb\|GOBABEB\|random-gobabeb\|random-orf\|RANDOM_ORF\|RANDOM_GOB" web/ serve.ts` — no matches (except possibly in test files for rejected-optimization docs)
- [ ] `bun run serve.ts` — starts without errors
- [ ] Wrapper lab: folder picker works, label persists across reload
- [ ] Benchmark: shared folder from wrapper lab remembered (same DB)
