# Agent Handoff — raw-converter-wasm

**Date:** 2026-05-21
**Branch:** `main`
**Base HEAD:** `78cafaf`

---

## Session Summary

This session completed the `@casabio/jxl-wasm` package. All changes are **uncommitted** — commit before doing anything else.

### Codex update — progressive page session decode

Files changed by this pass:
- `web/jxl-progressive.js`
- `web/jxl-progressive-page.test.js`

What changed:
- Removed the remaining `decodeJxlBytes()` prefix/decode path from `web/jxl-progressive.js`.
- Added `streamDecodeJxl()` so the libjxl progressive preview path opens one `createProgressiveDecodeRequest()` session and feeds each streamed chunk via `request.push(chunk)`.
- Updated live page-loop decode in `runVariant()` to use session decode for `progressive + libjxl + stream`.
- Updated `replayDecodeCard()` to use the same session-based decode flow as live runs.
- Kept blob/object-URL decode only as the fallback path for non-progressive or non-libjxl decode backends.
- Added `decodeJxlFinal()` so final libjxl decodes also use the worker session path; jsquash still uses the blob fallback.
- Changed `streamBytes()` to yield only the current chunk, not a growing prefix buffer, avoiding repeated partial blob decode attempts.
- Replaced the thumbnail bench decode call with `decodeJxlFinal()` so libjxl lanes use session decode and jsquash lanes use fallback.
- Added `web/jxl-progressive-page.test.js` as a static regression check that the page no longer contains `decodeJxlBytes` and still feeds `request.push(chunk)`.

Verification run:

```powershell
rtk bun test web/jxl-progressive-page.test.js web/jxl-progressive-decode.test.js web/jxl-progressive-session.test.js web/jxl-progressive-session.backends.test.js web/jxl-progressive-policy.test.js
# 7 pass, 0 fail

rtk node --check web/jxl-progressive.js
# exit 0

rtk pwsh -NoProfile -Command 'rg -n "decodeJxlBytes|bytes\.slice\(0, loaded\)|decodeJxl\(" web/jxl-progressive.js'
# no matches
```

Broader check attempted:

```powershell
rtk bun test web
```

Result: 12 pass, 2 fail. Failures appear environment/unrelated:
- `EPERM reading "C:\Foo\raw-converter-wasm\packages\jxl-wasm\dist\jxl-core.scalar.js"` in `web/icodec-jxl-worker.test.js`
- `ORF ingest folder not found: C:\995\2026-02-17 Dave at Kyffhauser` in `web/orf-render.test.js`

Boundary respected:
- Did not edit `packages/jxl-wasm/src/facade.ts`.

### What landed

- `packages/jxl-wasm/src/bridge.cpp` — full C++ bridge over libjxl:
  - `jxl_wasm_decode_rgba8/16/rgbaf32` one-shot decode
  - `jxl_wasm_encode_rgba8/16/rgbaf32` one-shot encode
  - `jxl_wasm_dec_create(format)` … `jxl_wasm_dec_free` stateful progressive decoder
  - Progressive decode uses `JxlDecoderFlushImage` on `kDC` pass; returns `RESULT_PROGRESS=1` when flush fires
- `packages/jxl-wasm/exports.txt` — all 27 exports including stateful dec API
- `packages/jxl-wasm/src/facade.ts` — TypeScript façade:
  - Reactive-queue decoder: `push()` wakes the generator immediately (no wait-until-close blocking)
  - Multi-format: rgba8/16/f32 throughout, correct `bytesPerChannel` in `applyRegionAndDownsample`
  - `eventsProgressive` uses stateful bridge (fires when WASM has `_jxl_wasm_dec_create`)
  - `eventsOneShot` fallback for older WASM builds
  - Synthetic progress emission when no real DC flush fires (small images, unit tests)
  - WASM binary pre-read via `node:fs/promises` so Emscripten web-only build works in Bun/Node
- `packages/jxl-wasm/dist/` — rebuilt scalar + simd WASM tiers (fast-relink against cached `.a` archives)
- `packages/jxl-wasm/dist/build-manifest.json` — updated hashes/sizes
- `web/icodec-jxl-worker.test.js` — ORF round-trip test via direct façade (no icodec)

### Test results

```
bun test packages/jxl-wasm/test/facade.test.ts   → 6 pass, 0 fail
bun test web/icodec-jxl-worker.test.js           → 1 pass, 0 fail (30 s, full-size ORF)
```

---

## What Is Still Needed

### 1. Commit current work

All changes are uncommitted. Stage and commit everything in `packages/jxl-wasm/`, `packages/jxl-native/`, `packages/jxl-worker-node/`, `web/`, and `HANDOFF.md`.

### 2. `web/jxl-worker.js` replacement

Another agent was assigned this. It must replace the old icodec-based worker with one that:
- Imports `createDecoder` / `createEncoder` from `@casabio/jxl-wasm/dist/facade.js`
- Implements the existing worker message protocol (session open/push/close, encoder push/finish, event fan-out)
- Works inside a Web Worker (no Node APIs)

Key file: `web/jxl-worker.js`
Reference façade API: `packages/jxl-wasm/dist/facade.d.ts`

### 3. Run the full test suite to verify no regressions

```powershell
bun test packages/jxl-wasm/test/facade.test.ts `
         packages/jxl-native/test/facade.test.ts `
         packages/jxl-worker-node/test/backend-selector.test.ts `
         web/icodec-jxl-worker.test.js
```

Expected: all pass. `jxl-native` tests should also pass — the binding probe returns `loaded: false`, which is intentional; backend-selector silently falls back to WASM.

### 4. ICC / EXIF / XMP metadata (deferred)

`bridge.cpp`'s `EncodeRgba()` ignores the `iccProfile`, `exif`, `xmp` fields from `EncoderOptions`. The façade passes them but the bridge discards them. To wire these up:
- In `EncodeRgba`: call `JxlEncoderSetICCProfile`, `JxlEncoderAddBox(enc, "Exif", ...)`, `JxlEncoderAddBox(enc, "xml ", ...)` before `CloseInput`
- Requires passing these byte slices through WASM memory (new export functions or extend existing bridge ABI)
- Add tests in `facade.test.ts`

Not blocking for ORF → JXL conversion; color is sRGB-tagged by default.

### 5. Threaded WASM tiers (blocked)

`simd-mt` and `relaxed-simd-mt` tiers require Docker + GHCR access. GHCR returned "denied" for anonymous pulls. Deferred. Two tiers (scalar + simd) are sufficient for all current testing. The loader in `dist/loader.js` should serve scalar to browsers lacking SIMD, and simd to modern Chrome/Firefox/Safari.

### 6. jxl-native — real N-API implementation (low priority)

`native.cc` is a scaffold stub; `probe()` returns `loaded: false` so the backend-selector always falls back to WASM. This is correct behavior for now.

When ready to implement:
- libjxl headers need to be installed or vendored under `packages/jxl-native/deps/`
- `binding.gyp` needs libjxl include + lib paths
- `native.cc` needs real N-API decode/encode logic mirroring `bridge.cpp`
- `probe()` should return `loaded: true` only after confirming libjxl initialized
- node-gyp is at `C:\Users\User\node_modules\.bin\node-gyp.exe`

### 7. Progressive detail upgrade (optional)

Current bridge uses `kDC` progressive detail — fires once per frame. For richer multi-pass previews, change `JxlDecoderSetProgressiveDetail(dec, kDC)` to `kLastPasses` or `kPasses` in `jxl_wasm_dec_create`. The façade already handles multiple `RESULT_PROGRESS` returns correctly — it loops and emits a `progress` event per flush.

---

## Architecture Snapshot

```
ORF file
  └─ raw_converter_wasm.js (Rust/WASM)
       └─ RGB pixels
            └─ jxl-wasm facade  (packages/jxl-wasm/src/facade.ts)
                 └─ bridge.cpp  → libjxl → jxl-core.scalar.wasm / jxl-core.simd.wasm
                      └─ JXL bytes / decoded pixels
```

`jxl-worker-node` backend-selector picks native (unavailable) → WASM. Workers in `web/` use the façade directly.

---

## Key Files

| File | Purpose |
|---|---|
| `packages/jxl-wasm/src/facade.ts` | TypeScript façade — entry point for all codec calls |
| `packages/jxl-wasm/src/bridge.cpp` | C++ bridge — libjxl ↔ WASM ABI |
| `packages/jxl-wasm/exports.txt` | Emscripten export list |
| `packages/jxl-wasm/dist/jxl-core.scalar.*` | Production WASM (scalar) |
| `packages/jxl-wasm/dist/jxl-core.simd.*` | Production WASM (SIMD) |
| `packages/jxl-wasm/dist/build-manifest.json` | Build provenance + hashes |
| `packages/jxl-wasm/test/facade.test.ts` | Unit tests (mock + real WASM) |
| `web/icodec-jxl-worker.test.js` | ORF integration test |
| `packages/jxl-native/src/native.cc` | N-API stub (not yet real) |
| `packages/jxl-worker-node/src/backend-selector.ts` | native-vs-WASM selection |

## Fast Relink Recipe

When bridge.cpp changes without needing a full libjxl rebuild:

```powershell
$emcc = "C:\Users\User\emsdk\upstream\emscripten\em++.bat"
$workDir = "$env:TEMP\jxl-wasm-work"
$exports = "$pwd\packages\jxl-wasm\exports.txt"
$dist = "$pwd\packages\jxl-wasm\dist"

# Compile bridge
& $emcc -O3 -fno-rtti -fno-exceptions -flto `
  -I "$workDir\scalar\lib\include" `
  -c packages\jxl-wasm\src\bridge.cpp `
  -o "$workDir\bridge.scalar.o"

# Link scalar
$s = "$workDir\scalar"
& $emcc -O3 -flto -fno-rtti -fno-exceptions `
  "$workDir\bridge.scalar.o" `
  "$s\lib\libjxl.a" "$s\lib\libjxl_cms.a" "$s\lib\libjxl_threads.a" `
  "$s\lib\libjxl_extras_codec.a" "$s\lib\libjxl_extras-internal.a" "$s\lib\libjpegli-static.a" `
  "$s\third_party\brotli\libbrotlienc.a" "$s\third_party\brotli\libbrotlidec.a" `
  "$s\third_party\brotli\libbrotlicommon.a" "$s\third_party\highway\libhwy.a" `
  -sENVIRONMENT=web,worker -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createJxlModule `
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=33554432 -sMAXIMUM_MEMORY=4294967296 `
  -sFILESYSTEM=0 -sASSERTIONS=0 -sINVOKE_RUN=0 `
  "-sEXPORTED_RUNTIME_METHODS=['HEAPU8','HEAPU32']" `
  "-sEXPORTED_FUNCTIONS=@$exports" `
  -o "$dist\jxl-core.scalar.js"

# Repeat with -msimd128 + $workDir\simd\ for simd tier
```

Archives cached at `%TEMP%\jxl-wasm-work\scalar\` and `\simd\`. Survive reboots as long as `%TEMP%` is not cleaned.
