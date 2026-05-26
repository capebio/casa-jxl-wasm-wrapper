# Folder Picker — Replaces Gobabeb Hardcode

**Date:** 2026-05-26  
**Scope:** `web/jxl-source-folder.js` (new) + `web/jxl-wrapper-lab.js` + `web/jxl-benchmark.js` + `serve.ts` + `web/orf-render.test.js` + `web/icodec-jxl-worker.test.js`  
**Goal:** Replace all hardcoded RAW folder paths with a persistent, user-selected folder via the File System Access API.

---

## Problem Summary

1. `serve.ts` exposes `/api/random-gobabeb` which returns random `.ORF` file paths from a hardcoded local directory (`C:\995\…`). That directory is deleted. The endpoint is now broken.
2. `web/jxl-wrapper-lab.js` and `web/jxl-benchmark.js` call `/api/random-gobabeb` to load random test images.
3. `web/orf-render.test.js` and `web/icodec-jxl-worker.test.js` hardcode absolute paths to files that no longer exist.

---

## Design

### New module: `web/jxl-source-folder.js`

Single responsibility: manage one persisted `FileSystemDirectoryHandle` and provide random `.ORF` file sampling.

**Exports:**

```js
export async function pickFolder()         // opens showDirectoryPicker() or <input webkitdirectory>; returns FileSystemDirectoryHandle or null
export async function saveHandle(handle)   // persists handle to IndexedDB
export async function loadHandle()         // returns saved handle or null
export async function verifyHandle(handle) // queryPermission(); returns true if still granted
export async function randomOrfs(handle, n) // returns n random File objects with .name ending in .orf/.ORF
```

**IndexedDB schema:**
- DB name: `jxl-source-folder`
- Store name: `handles`
- Single record: key `"folder"`, value: `FileSystemDirectoryHandle`

**Browser support:**
- Primary: `showDirectoryPicker()` (Chrome/Edge 86+) — full persistence via IndexedDB
- Fallback: `<input type="file" webkitdirectory>` — no persistence (handle not available from input)

**Fallback detection:**
```js
const supportsFilePicker = typeof window.showDirectoryPicker === 'function';
```

### Button wiring (wrapper lab + benchmark)

Replace "Load Gobabeb" / "Load Random" button with a single **"Load from folder"** button (`#load-random`). Its label updates based on state:

| State | Label |
|---|---|
| No folder saved | `Pick RAW folder` |
| Folder saved, permission granted | `Load from [folderName]` |
| Folder saved, permission revoked | `Re-grant [folderName]` |

On click:
1. `loadHandle()` — try to get saved handle
2. `verifyHandle(handle)` — check permission
3. If no handle or permission denied: `pickFolder()` → `saveHandle(handle)`
4. `randomOrfs(handle, n)` → convert to `File` objects → pass to existing `loadSourcesFromFiles(files)`

`n` = existing batch limit setting (same as current random load count).

### `serve.ts` changes

Remove entirely:
- `RANDOM_GOBABEB_FOLDER` constant
- `RANDOM_ORF_FOLDER` constant  
- `/api/random-gobabeb` route handler

No replacement server-side route needed — folder access is now fully client-side.

### Test changes

**`web/orf-render.test.js`:**
- Replace `const ORF_FOLDER = String.raw\`...\`` with `const ORF_FOLDER = process.env.TEST_ORF_FOLDER ?? null`
- Wrap test body: `if (!ORF_FOLDER) { test.skip(...) }` or use `skipIf`

**`web/icodec-jxl-worker.test.js`:**
- Remove `DEFAULT_ORF_PATH` constant
- Replace with `const ORF_PATH = process.env.TEST_ORF ?? null`
- Skip test if `ORF_PATH` is null

---

## File List

| File | Action |
|---|---|
| `web/jxl-source-folder.js` | Create |
| `web/jxl-wrapper-lab.js` | Modify: replace random-load logic |
| `web/jxl-benchmark.js` | Modify: replace random-load logic |
| `serve.ts` | Modify: remove Gobabeb constants + endpoint |
| `web/orf-render.test.js` | Modify: env var + skip guard |
| `web/icodec-jxl-worker.test.js` | Modify: env var + skip guard |

---

## Out of Scope

- Other RAW formats (only `.ORF` / `.orf` targeted — existing behaviour)
- Recursive directory scanning (flat scan, same as existing `/api/random-gobabeb`)
- Multiple saved folders
- Folder picker UI on `jxl-progressive.html` (separate session)
- Unit tests for `jxl-source-folder.js` (IndexedDB and File System Access API require a real browser; no mock test added)

---

## Success Criteria

1. "Load from folder" button visible and correctly labelled before any folder is chosen (`Pick RAW folder`).
2. Clicking it opens the native folder picker (Chrome/Edge) or a file input (fallback).
3. Chosen folder name persists in IndexedDB; next page load shows `Load from [name]` without re-picking.
4. If folder permission was revoked, button shows `Re-grant [name]` and re-opens picker on click.
5. `/api/random-gobabeb` route no longer exists in `serve.ts`.
6. `web/orf-render.test.js` and `web/icodec-jxl-worker.test.js` skip cleanly when env vars are absent; no hardcoded paths remain.
7. No regressions on wrapper lab or benchmark page functionality.
