# jxl-worker.js Encode Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the jsquash-based encode path in `web/jxl-worker.js` with `createEncoder` from `@casabio/jxl-wasm/dist/facade.js`, and remove the now-dead `decode_jxl` handler.

**Architecture:** `jxl-worker.js` already uses `createDecoder` from the facade for progressive decode. This plan finishes the migration by swapping out the one remaining jsquash path (encode) and deleting dead code (`decode_jxl` one-shot handler, jsquash module management). No callers change — the wire protocol is identical.

**Tech Stack:** Bun (test runner), `@casabio/jxl-wasm/dist/facade.js` (createEncoder), Web Worker (no Node APIs allowed in the worker itself).

---

### Task 1: Remove dead code and jsquash imports, add createEncoder import

**Files:**
- Modify: `web/jxl-worker.js`

- [ ] **Step 1: Open `web/jxl-worker.js` and replace the import block (lines 1–24)**

Current (lines 1–24):
```js
// Dedicated JXL encode worker.  Must be spawned from the page's main thread
// (not from within another worker) so that Emscripten Pthreads can bootstrap
// correctly under COOP + COEP headers.
//
// Protocol:
//   main → worker: { id, type:'encode_request', rgba: ArrayBuffer, width, height,
//                    quality, effort, lossless }
//   worker → main: { id, type:'done',         jxl: Uint8Array, jxlMs, w, h,
//                    effortUsed, effortRequested }
//               or { id, type:'encode_error',  error: string }
//
// At high effort on large images the WASM heap can run out.  When that
// happens the module becomes permanently unusable (ABORT flag is set).
// Fail fast instead of retrying lower efforts: the lower-effort ladder never
// recovered large-image encodes reliably and only poisoned the worker.

import { initEmscriptenModule } from './vendor/jsquash-jxl/utils.js';
import { defaultOptions }        from './vendor/jsquash-jxl/meta.js';
import jxlMtSIMDFactory          from './vendor/jsquash-jxl/codec/enc/jxl_enc_mt_simd.js';
import jxlMtFactory              from './vendor/jsquash-jxl/codec/enc/jxl_enc_mt.js';
import decode                    from './vendor/jsquash-jxl/decode.js';
import { simd }                  from './vendor/wasm-feature-detect/index.js';
import { createDecoder as createLibjxlDecoder } from '../packages/jxl-wasm/dist/facade.js';
const _simdOk = simd(); // Promise<bool> — resolved once, reused on OOM retries
```

Replace with:
```js
// Dedicated JXL encode worker.
//
// Protocol:
//   main → worker: { id, rgba: ArrayBuffer, width, height, quality, effort, lossless, progressive }
//   worker → main: { id, type:'done',        jxl: Uint8Array, jxlMs, w, h,
//                    effortUsed, effortRequested }
//               or { id, type:'encode_error', error: string }
//
// Progressive decode sessions use the libjxl facade directly.
// One-shot URL decode (decode_jxl) is handled by jxl-decode-worker.js.

import { createDecoder as createLibjxlDecoder, createEncoder }
    from '../packages/jxl-wasm/dist/facade.js';
```

- [ ] **Step 2: Remove module management and isAbortError — keep decodeSessions**

After the import block, the file has this block. Delete `createModule`, `moduleP`, and `isAbortError`. **Keep `const decodeSessions = new Map();`** — progressive decode sessions still use it.

Delete:
```js
async function createModule() {
    return initEmscriptenModule(await _simdOk ? jxlMtSIMDFactory : jxlMtFactory);
}

// One live module instance; replaced after every abort.
let moduleP = createModule();
```

Delete:
```js
function isAbortError(err) {
    return (err instanceof WebAssembly.RuntimeError) || String(err).includes('Abort');
}
```

Leave in place (do not delete):
```js
const decodeSessions = new Map();
```

- [ ] **Step 3: Remove the `decode_jxl` handler block from `self.onmessage`**

Delete these lines (currently after the `decode_cancel` handler):
```js
    if (data.type === 'decode_jxl') {
        const { decodeId, url } = data;
        try {
            const resp = await fetch(url);
            const buf  = await resp.arrayBuffer();
            const img  = await decode(buf); // returns { data: Uint8ClampedArray, width, height }
            self.postMessage(
                { type: 'jxl_decoded', decodeId, rgba: img.data, w: img.width, h: img.height },
                [img.data.buffer],
            );
        } catch (err) {
            self.postMessage({ type: 'decode_error', decodeId, error: String(err?.message ?? err) });
        }
        return;
    }
```

- [ ] **Step 4: Run syntax check**

```powershell
node --check C:/Foo/raw-converter-wasm/web/jxl-worker.js
```

Expected: exits 0 (no output). If errors appear, fix them before continuing.

- [ ] **Step 5: Commit**

```bash
git -C C:/Foo/raw-converter-wasm add web/jxl-worker.js
git -C C:/Foo/raw-converter-wasm commit -m "refactor(jxl-worker): remove jsquash imports and dead decode_jxl handler"
```

---

### Task 2: Replace jsquash encode path with createEncoder

**Files:**
- Modify: `web/jxl-worker.js`

- [ ] **Step 1: Replace the encode block inside `self.onmessage`**

Current encode block (starts after the `decode_cancel` handler return, ends at closing `};` of onmessage):
```js
    // --- encode path ---
    const { id, rgba, width, height, quality, effort, lossless, progressive } = data;
    const t0 = performance.now();
    try {
        let module = await moduleP;
        const opts = { ...defaultOptions, quality, effort, lossless, progressive: Boolean(progressive) };
        let resultView;
        try {
            resultView = module.encode(new Uint8ClampedArray(rgba), width, height, opts);
        } catch (encErr) {
            if (isAbortError(encErr)) {
                // Re-init so the worker is usable for later, smaller jobs.
                moduleP = createModule();
                throw new Error(
                    `JXL encode OOM at effort ${opts.effort} — image too large (${width}×${height})`
                );
            }
            throw encErr;
        }

        if (!resultView) throw new Error('Encoding error (null result).');
        const jxlMs = performance.now() - t0;

        const jxlBytes = new Uint8Array(
            resultView.buffer, resultView.byteOffset, resultView.byteLength,
        ).slice();

        self.postMessage(
            { id, type: 'done', jxl: jxlBytes, jxlMs, w: width, h: height,
              effortUsed: opts.effort, effortRequested: effort },
            [jxlBytes.buffer],
        );
    } catch (err) {
        self.postMessage({ id, type: 'encode_error', error: String(err?.message ?? err) });
    }
```

Replace with:
```js
    // --- encode path ---
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

- [ ] **Step 2: Run syntax check**

```powershell
node --check C:/Foo/raw-converter-wasm/web/jxl-worker.js
```

Expected: exits 0.

- [ ] **Step 3: Run test suite — verify no regressions**

```powershell
cd C:/Foo/raw-converter-wasm && bun test web
```

Expected: **13 pass, 1 fail** (the 1 fail is `orf-render.test.js` — missing ORF fixture folder, pre-existing). If any previously-passing test now fails, investigate before continuing.

- [ ] **Step 4: Verify no jsquash references remain in the worker**

```powershell
Select-String -Path C:/Foo/raw-converter-wasm/web/jxl-worker.js -Pattern "jsquash|initEmscriptenModule|defaultOptions|jxlMt|simd\(\)|isAbortError|decode_jxl|moduleP"
```

Expected: no matches.

- [ ] **Step 5: Commit**

```bash
git -C C:/Foo/raw-converter-wasm add web/jxl-worker.js
git -C C:/Foo/raw-converter-wasm commit -m "feat(jxl-worker): replace jsquash encode with createEncoder from facade"
```

---

### Task 3: Push and verify

- [ ] **Step 1: Push to origin**

```bash
git -C C:/Foo/raw-converter-wasm push origin main
```

- [ ] **Step 2: Final state check**

```powershell
cd C:/Foo/raw-converter-wasm && bun test web
```

Expected: 13 pass, 1 fail (same as before). Done.
