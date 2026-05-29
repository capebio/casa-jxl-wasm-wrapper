# Handoff — Native Parity Continuation
**Date:** 2026-05-29  
**Branch:** `epiccodereview/20260527T054853`  
**Authored by:** Claude (session ending)

---

## 1. What Was Done This Session

Full WASM ↔ Tauri/native parity audit against `docs/FEATURE_PARITY_MATRIX.md`. Four encoder-side gaps closed in `packages/jxl-native`:

| Item | TS interface | native.cc | Rebuilt? |
|------|-------------|-----------|----------|
| `EncoderOptions.modular?: -1\|0\|1` | ✅ added | ✅ `JXL_ENC_FRAME_SETTING_MODULAR` | ✅ 6.2 MB addon |
| `EncoderOptions.advancedFrameSettings` escape hatch | ✅ added | ✅ `JxlEncoderFrameSettingsSetOption` loop | ✅ |
| `customBoxes` wired (was declared, ignored) | already present | ✅ `JxlEncoderAddBox` per entry | ✅ |
| `ExtraChannel.name?: string` | ✅ added | ✅ `JxlEncoderSetExtraChannelName` | ✅ |

**Build verified:**
- `npx tsc --noEmit` (packages/jxl-native) — clean
- `bun test packages/jxl-native/test/codec.test.ts` — 6 pass, 0 fail
- Rebuild env: `vcvars64 + JXL_NATIVE_INCLUDE_DIR=C:\Foo\raw-converter\target\release\build\jpegxl-sys-26f294f2024eaecb\out\include + JXL_NATIVE_LIB_DIR=C:\TEMP\jxl-mt-libs`

**Docs updated:**
- `docs/FEATURE_PARITY_MATRIX.md` — rows updated for modular, metadata boxes, extra channels, options surface
- `docs/references/PROGRESS_LOG.md` — entry prepended ("Native Parity Pass — 2026-05-29")

---

## 2. Key Files to Read First in a Fresh Session

In this order:

1. **`docs/FEATURE_PARITY_MATRIX.md`** — the single source of truth. Read the full matrix before touching any code.
2. **`docs/references/ACTION PLAN.md`** — milestones, root causes, success criteria.
3. **`docs/references/PROGRESS_LOG.md`** — top entry is this session's work; earlier entries have full context on what was implemented and why.
4. **`docs/references/designs/DESIGNS_INDEX.md`** — design note status per feature.
5. **`docs/references/designs/ISSUES.md`** — open blockers.
6. **`packages/jxl-native/src/index.ts`** — current native TS surface.
7. **`packages/jxl-native/src/native.cc`** — current native C++ implementation.
8. **`packages/jxl-wasm/src/facade.ts`** — WASM surface to match parity against.

---

## 3. Remaining Native Parity Gaps (Prioritized)

### 3a. Extra-Channel Decoder Reporting — HIGH VALUE, SELF-CONTAINED
**Current state:** `native.cc` `DecodeAll` does NOT emit extra-channel descriptors or pixel planes. WASM Phase 2 (different branch) has full decoder symmetry; on this branch neither side has it.

**What to implement in `native.cc` `DecodeAll`:**

After `JXL_DEC_BASIC_INFO` fires, collect extra-channel descriptors:
```cpp
// After basic info known:
uint32_t num_extra = basic.num_extra_channels;
struct DecodedEC {
    JxlExtraChannelInfo info;
    char name[256];
    std::vector<uint8_t> pixels;
};
std::vector<DecodedEC> extra_channels(num_extra);
for (uint32_t i = 0; i < num_extra; ++i) {
    JxlDecoderGetExtraChannelInfo(dec, i, &extra_channels[i].info);
    JxlDecoderGetExtraChannelName(dec, i, extra_channels[i].name, 256);
}
```

In `JXL_DEC_NEED_IMAGE_OUT_BUFFER` handler, also set extra-channel output buffers:
```cpp
for (uint32_t i = 0; i < num_extra; ++i) {
    size_t ec_buf_size = 0;
    JxlPixelFormat ec_pf = {1, JXL_TYPE_UINT8, JXL_NATIVE_ENDIAN, 0};
    // adjust dtype per extra_channels[i].info.bits_per_sample
    JxlDecoderExtraChannelBufferSize(dec, &ec_pf, &ec_buf_size, i);
    extra_channels[i].pixels.resize(ec_buf_size);
    JxlDecoderSetExtraChannelBuffer(dec, &ec_pf, extra_channels[i].pixels.data(), ec_buf_size, i);
}
```

On `JXL_DEC_FULL_IMAGE`, attach extra-channel descriptor objects + pixel planes to the final event.

**index.ts additions needed:**
```ts
export interface DecodedExtraChannel {
  readonly type: string;       // enum name
  readonly bitsPerSample: number;
  readonly name: string;
  readonly pixels: ArrayBuffer;
  readonly pixelFormat: PixelFormat;
}
// Add to ImageInfo:
extraChannels?: readonly DecodedExtraChannel[];
// Add to final/progress DecodeEvent:
extraPlanes?: readonly ArrayBuffer[];
extraChannelDescriptors?: readonly DecodedExtraChannel[];
```

**Reference:** `packages/jxl-wasm/src/bridge.cpp` lines 269-304 (Phase 2 decoder descriptor collection) and `facade.ts` lines 1165-1182 (header info attachment). Those are on the `feature/full-extra-channel-infrastructure` worktree branch — may need `git show` or checkout to inspect. Alternatively `decode.h` in `C:\Foo\raw-converter\target\release\build\jpegxl-sys-26f294f2024eaecb\out\include\jxl\decode.h` has the full API.

---

### 3b. Core Modular Controls — Nested Shape
**Current state:** `modular?: -1|0|1` wired (force only). Design note `designs/core-modular-controls.md` recommends full nested shape.

**Recommended approach:** Use `advancedFrameSettings` escape hatch (now wired) as the interim path for groupSize/predictor etc. Dedicated nested `modular: { force?, groupSize?, predictor?, nbPrevChannels?, palette?, paletteColors? }` is a nice-to-have for ergonomics but functionally covered already.

**libjxl constants** (from `encode.h`):
```
JXL_ENC_FRAME_SETTING_MODULAR_GROUP_SIZE     = 32
JXL_ENC_FRAME_SETTING_MODULAR_PREDICTOR     = 33
JXL_ENC_FRAME_SETTING_MODULAR_NB_PREV_CHANNELS = 34
JXL_ENC_FRAME_SETTING_MODULAR_PALETTE_COLORS = 35
JXL_ENC_FRAME_SETTING_MODULAR_LOSSY_PALETTE  = 36
JXL_ENC_FRAME_SETTING_MODULAR_MA_TREE_LEARNING_PERCENT = 37
```

If implementing as dedicated fields: follow the same `EncoderData` + `CreateEncoder` + `EncodeAll` pattern used for `modular`, `brotli_effort`, etc.

---

### 3c. Gain Maps — Native Side
**Current state:** WASM has a stub (bridge.cpp `#if JXL_GAIN_MAP_SUPPORTED` guard + `gainMapEncode` capability gate). Native has ❌.

**What you'd need:**
- `jxl/gain_map.h` (present at `...\out\include\jxl\gain_map.h`)
- `JxlEncoderAddJPEGReconstructionData` or the gain map box API
- Design note: `docs/references/designs/gain-maps.md`

**Complexity:** Medium-high. Depends on the libjxl build actually having gain map symbols (check `JXL_GAIN_MAP_SUPPORTED` define). Lower priority than 3a.

---

### 3d. Animation Native Parity — Source Exists, Needs Rebuild
**Current state:** native.cc already has full animation encode + decode (added 2026-05-29 per PROGRESS_LOG). Rebuild confirmed in that session — 6 tests pass including animation source-text tests.

**Status:** ✅ source + addon binary complete. Verified working. No action needed unless tests fail.

---

### 3e. RAW Pipeline Gaps (Rust/Tauri side)
**Current state:** Multiple ❌ on Tauri side per parity matrix row 3. These are in `src-tauri/` (Rust), not in `packages/jxl-native/`. Require different skills (Rust + Tauri).

Top items:
- `LookRenderer` — WASM-resident RGB16 state; Tauri equivalent would be `Rgb16State` struct in `raw-pipeline`
- `process_orf_with_flags` — selective output bitmask
- Orientation==1 fast-path

These are independent of the JXL native addon work and need `raw-pipeline/src/` + `src-tauri/` changes.

---

## 4. Build Commands (Known Working)

### Native addon rebuild
```powershell
$vcvars = "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
$includeDir = "C:\Foo\raw-converter\target\release\build\jpegxl-sys-26f294f2024eaecb\out\include"
$libDir = "C:\TEMP\jxl-mt-libs"
$cmd = "call `"$vcvars`" >nul && set JXL_NATIVE_INCLUDE_DIR=$includeDir && set JXL_NATIVE_LIB_DIR=$libDir && cd C:\Foo\raw-converter-wasm\packages\jxl-native && npx node-gyp rebuild --release 2>&1"
cmd /c $cmd | Select-Object -Last 20
```

### WASM rebuild (Docker)
```powershell
docker run --rm -v "C:\Foo\raw-converter-wasm\packages\jxl-wasm:/work/jxl-wasm" -w /work/jxl-wasm jxl-wasm-builder:local node scripts/build.mjs --inside-docker
```

### Typecheck
```powershell
npx tsc --noEmit --project packages/jxl-native/tsconfig.json
npx tsc --noEmit --project packages/jxl-wasm/tsconfig.json
```

### Tests
```powershell
bun test packages/jxl-native/test/codec.test.ts
bun test packages/jxl-wasm/test/facade.test.ts
```

---

## 5. Process Reminders

Per `FEATURE_IMPLEMENTATION_TEMPLATE.md`:
- Create a feature branch **before any code** (`feature/ec-decoder-reporting`, etc.)
- Every feature needs benchmark wiring (wrapper-lab tab or new page)
- End with PROGRESS_LOG append + DESIGNS_INDEX status update + FEATURE_PARITY_MATRIX update

---

## 6. Recommended Next Action

**Start with 3a (Extra-Channel Decoder Reporting).**

It is:
- Self-contained to `native.cc` + `index.ts`
- No new dependencies beyond libjxl headers already in place
- Closes the last major encode/decode asymmetry in jxl-native
- Clearly specced in the decode.h API

After that: 3b modular nested shape (if ergonomics matter) or skip to 3e RAW pipeline if the Tauri app integration is the priority.

---

**End of handoff.**
