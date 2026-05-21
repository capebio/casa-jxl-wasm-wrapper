# Design: jxl-worker.js Encode Migration to Facade

**Date:** 2026-05-21
**Branch:** main
**File scope:** `web/jxl-worker.js` only

---

## Goal

Remove the jsquash-based encode path from `web/jxl-worker.js` and replace it
with `createEncoder` from `@casabio/jxl-wasm/dist/facade.js`. Preserve the
existing worker message protocol exactly so no callers change.

## Background

`jxl-worker.js` was partially migrated: the progressive decode session already
uses `createDecoder` from the facade. Two jsquash-based paths remain:

1. **Encode path** — `initEmscriptenModule`, jsquash SIMD/MT factories,
   `module.encode()`.
2. **`decode_jxl` one-shot handler** — jsquash `decode()`, now dead code
   (superseded by `jxl-decode-worker.js`).

## Constraints

- Must work inside a Web Worker (no Node APIs).
- Must not change the wire protocol (callers in `main.js` are unchanged).
- `jxl-decode-worker.js` is out of scope.

## What Changes

### Imports

Remove:
```js
import { initEmscriptenModule } from './vendor/jsquash-jxl/utils.js';
import { defaultOptions }        from './vendor/jsquash-jxl/meta.js';
import jxlMtSIMDFactory          from './vendor/jsquash-jxl/codec/enc/jxl_enc_mt_simd.js';
import jxlMtFactory              from './vendor/jsquash-jxl/codec/enc/jxl_enc_mt.js';
import decode                    from './vendor/jsquash-jxl/decode.js';
import { simd }                  from './vendor/wasm-feature-detect/index.js';
```

Update (add `createEncoder`):
```js
import { createDecoder as createLibjxlDecoder, createEncoder }
    from '../packages/jxl-wasm/dist/facade.js';
```

### Remove dead code

- `createModule()` function
- `let moduleP = createModule()`
- `isAbortError()` function
- `decode_jxl` handler block (lines 59–73)

### Encode handler

Replace the jsquash encode block with:

```js
const { id, rgba, width, height, quality, effort, lossless, progressive } = data;
const t0 = performance.now();
try {
    const encoder = createEncoder({
        format: 'rgba8',
        width,
        height,
        hasAlpha: true,
        iccProfile: null,
        exif: null,
        xmp: null,
        distance: lossless ? 0 : null,
        quality: lossless ? null : quality,
        effort,
        progressive: Boolean(progressive),
        previewFirst: false,
        chunked: false,
    });
    encoder.pushPixels(rgba);
    encoder.finish();

    const parts = [];
    try {
        for await (const chunk of encoder.chunks()) {
            parts.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
        }
    } finally {
        encoder.dispose();
    }

    const totalLen = parts.reduce((n, a) => n + a.byteLength, 0);
    const jxlBytes = new Uint8Array(totalLen);
    let off = 0;
    for (const p of parts) { jxlBytes.set(p, off); off += p.byteLength; }

    const jxlMs = performance.now() - t0;
    self.postMessage(
        { id, type: 'done', jxl: jxlBytes, jxlMs, w: width, h: height,
          effortUsed: effort, effortRequested: effort },
        [jxlBytes.buffer],
    );
} catch (err) {
    self.postMessage({ id, type: 'encode_error', error: String(err?.message ?? err) });
}
```

## Quality / Distance Mapping

| Old field | New facade field | Notes |
|-----------|-----------------|-------|
| `lossless=true` | `distance: 0` | libjxl lossless |
| `lossless=false` | `quality: <value>` | facade maps 0-100 → distance |
| `effort` | `effort` | same scale (1-9) |
| `progressive` | `progressive: Boolean(progressive)` | coerce |

The facade's `distanceFromQuality(q) = (100-q)/6.67` handles the mapping
internally when `distance` is `null`.

## OOM / ABORT Behavior

The jsquash path recovered from WASM ABORT by re-initializing the module
(`moduleP = createModule()`). The facade uses a singleton module promise;
an ABORT poisons it permanently. We drop this recovery — an ABORTed WASM
heap is unrecoverable at the data level; callers receive `encode_error` and
the browser/OS will restart the worker on the next navigate.

## Wire Protocol (unchanged)

**Encode request (main → worker):**
```
{ id, rgba: ArrayBuffer, width, height, quality, effort, lossless, progressive }
```

**Encode response (worker → main):**
```
{ id, type: 'done', jxl: Uint8Array, jxlMs, w, h, effortUsed, effortRequested }
{ id, type: 'encode_error', error: string }
```

## Tests

No new tests. The encode path requires a real WASM binary loaded in a Web
Worker context. Existing `bun test web` integration suite covers the paths
this change does not touch. The ORF render encode flow is exercised by
`web/orf-render.test.js` (skipped in CI due to missing fixture folder).

## Success Criteria

1. `web/jxl-worker.js` imports no jsquash modules.
2. `bun test web` shows same pass/fail as before (13 pass, 1 fail for missing
   ORF fixture — no regressions).
3. `node --check web/jxl-worker.js` exits 0.
4. Progressive decode sessions (already facade-based) unaffected.
