# T-INT Design — Wire jxl-session into web/

**Date:** 2026-05-21  
**Status:** Approved  
**Spec reference:** casabio-jxl-wrapper-construction-spec-v2.md §26 T-INT

---

## Goal

Replace raw `Worker` + manual postMessage usage in `web/main.js` (encode) and `web/jxl-progressive.js` (decode) with calls through `jxl-session` / `jxl-scheduler`. This engages priority lanes, preemption, dedupe, and the session lifecycle defined by the spec.

## Constraints

- No bundler. `web/` uses ES module relative imports served directly.
- Packages use `@casabio/*` bare specifiers in compiled output.
- Must not break existing 12-pass test baseline (`bun test web/`).
- jsquash fallback paths stay on raw workers — out of scope.
- Do not touch any `packages/` source.

## Approach: Import Map + Session Context

Import maps resolve `@casabio/*` specifiers to `../packages/*/dist/` paths relative to the document base URL. Workers inherit the page import map (Chrome 91+, Firefox 108+, Safari 16.4+).

---

## Architecture

### New file: `web/jxl-browser-context.js`

Lazy singleton. First call to `getContext()` creates a `JxlContext` via `createBrowserContext()` from `@casabio/jxl-session`. Subsequent calls return the same instance. Export: `getContext()`.

```js
import { createBrowserContext } from '@casabio/jxl-session';
let _ctx = null;
export function getContext() {
  if (!_ctx) _ctx = createBrowserContext();
  return _ctx;
}
```

The `spawnWorker()` inside `createBrowserContext` resolves to `packages/jxl-worker-browser/dist/worker.js` via `import.meta.url` in `spawn.js`. No `wasmUrl` override needed.

**Dev server requirement:** Must serve from the project root (parent of `web/` and `packages/`), not from inside `web/`. `spawn.js` uses `new URL("./worker.js", import.meta.url)` — if the server root is `web/`, the worker URL will 404. The existing `serve.ts` already serves from the project root.

### Import map (both HTML files)

Added immediately before the closing `</head>` tag in `web/index.html` and `web/jxl-progressive.html`.

Required entries:

| Specifier | Resolves to |
|---|---|
| `@casabio/jxl-core` | `../packages/jxl-core/dist/index.js` |
| `@casabio/jxl-core/errors` | `../packages/jxl-core/dist/errors.js` |
| `@casabio/jxl-core/protocol` | `../packages/jxl-core/dist/protocol.js` |
| `@casabio/jxl-core/types` | `../packages/jxl-core/dist/types.js` |
| `@casabio/jxl-wasm` | `../packages/jxl-wasm/dist/index.js` |
| `@casabio/jxl-worker-browser` | `../packages/jxl-worker-browser/dist/index.js` |
| `@casabio/jxl-session` | `../packages/jxl-session/dist/index.js` |
| `@casabio/jxl-scheduler` | `../packages/jxl-scheduler/dist/index.js` |
| `@casabio/jxl-capabilities` | `../packages/jxl-capabilities/dist/index.js` |
| `@casabio/jxl-policy` | `../packages/jxl-policy/dist/index.js` |

Exact subpath exports (`/errors`, `/protocol`, `/types`) must be enumerated because import maps do not support wildcard subpath matching.

### `web/main.js` — encode path

**Remove:**
- `pool.addJxlWorker(new Worker(...))` loop
- `WorkerPool.addJxlWorker` method
- `WorkerPool._jxlWorkers` / `_jxlWorkerIdx` pool cycling
- `JXL_POOL_SIZE` constant

**Add:**
- `import { getContext } from './jxl-browser-context.js'` at top
- `encodeJxlSession(rgba, width, height, quality, effort, lossless, progressive)` helper:
  1. `const ctx = getContext()`
  2. `const session = ctx.encode({ format: 'rgba8', width, height, hasAlpha: true, distance: lossless ? 0 : null, quality: lossless ? null : quality, effort, progressive, priority: 'visible' })`
  3. `await session.pushPixels(rgba instanceof ArrayBuffer ? rgba : rgba.buffer)`
  4. `await session.finish()`
  5. Collect `session.chunks()` into single `Uint8Array`
  6. Return `{ jxl, jxlMs, w: width, h: height, effortUsed: effort, effortRequested: effort }`

- Replace the existing `pool` encode dispatch (where `worker.postMessage({ id, rgba, ... })` is called) with `encodeJxlSession(...)`.

Callers receive the same response shape — no caller-side changes.

### `web/jxl-progressive.js` — decode path

**Remove (libjxl branch only):**
- Worker acquisition for `('decode', 'libjxl')` in `getWorkerScript` / `getWorker` calls
- `createProgressiveDecodeRequest` usage on the libjxl branch

**Add:**
- `import { getContext } from './jxl-browser-context.js'` at top
- `decodeJxlFinalSession(bytes, priority = 'visible')`:
  1. `const session = getContext().decode({ format: 'rgba8', priority })`
  2. `await session.push(bytes instanceof ArrayBuffer ? bytes : bytes.buffer)`
  3. `await session.close()`
  4. Iterate `session.frames()` until `stage === 'final'`; return normalized frame
- `streamDecodeJxlSession(bytes, { onFrame } = {}, priority = 'visible')`:
  1. `const session = getContext().decode({ format: 'rgba8', progressionTarget: 'final', emitEveryPass: true, priority })`
  2. Push bytes, close
  3. Iterate `session.frames()`; call `onFrame(normalizeFrame(ev))` per event
  4. Return final frame on `stage === 'final'`

Priority assignment in call sites:
- Viewer decode (`decodeMode === 'final'`, visible slot): `'visible'`
- Near-viewport gallery items: `'near'`
- Thumb bench background prefetch: `'background'`

**jsquash path:** Unchanged. `createProgressiveDecodeRequest` + raw worker still used when `backend !== 'libjxl'`.

### Deleted files

- `web/jxl-worker.js` — functionality provided by `jxl-worker-browser/dist/worker.js`

### Unchanged files

- `web/icodec-jxl-worker.js` — libjxl icodec encode (separate domain)
- `web/jxl-decode-worker.js` — jsquash decode fallback
- `web/jxl-progressive-decode.js` — jsquash path
- All `packages/` directories

---

## Error Handling

- Decode errors: `session.frames()` throws `JxlError`; `session.done()` rejects. Wrap in `try/catch` replacing existing `onError` callback pattern.
- Encode errors: wrap `encodeJxlSession` in `try/catch`; re-throw or return `{ type: 'encode_error', error: String(err) }` to match existing caller expectation.
- `AbortSignal`: pass through `DecodeOptions.signal` where caller has an `AbortController` (cancel path in `jxl-progressive.js`).
- Import map failure / `createBrowserContext()` throw: caught at module init; logs to console; returns a no-op context to prevent hard page crash.

---

## Testing

### Smoke test (manual)

Test file: `C:\995\2026-02-24 Avis Dam Part II\P2240817 Xerophyta humilis.ORF`

1. Serve `web/` via existing `serve.ts` dev server.
2. `index.html`: drag ORF → encode → confirm JXL bytes returned, timing logged.
3. `jxl-progressive.html`: decode a JXL → confirm header → DC → final frame progression in UI.
4. DevTools → Workers: workers named from `packages/jxl-worker-browser/dist/worker.js`, not `jxl-worker.js`.
5. DevTools → Console: no import resolution errors.

### Regression check

```
bun test web/
```

Baseline: 12 pass, 2 fail (pre-existing environment failures — EPERM on scalar.js, ORF folder missing). Must not regress below 12 pass.

---

## Success Criteria

1. ORF → JXL encode completes via `jxl-session` encode session (no `jxl-worker.js` worker in DevTools).
2. Progressive decode emits header / DC / final events via `jxl-session` decode session.
3. `web/jxl-worker.js` deleted from repo.
4. `bun test web/` still 12 pass.
5. No import resolution errors in DevTools console.
