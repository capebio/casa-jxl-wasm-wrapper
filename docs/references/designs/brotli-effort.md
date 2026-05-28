# Feature Design Note: Brotli Effort

**Feature:** JXL_ENC_FRAME_SETTING_BROTLI_EFFORT (auxiliary data Brotli compression effort)  
**Date:** 2026-05-28  
**Author:** Grok (synthesized from REFERENCE_INDEX + collected references)  
**Status:** Implemented (2026-05-28)  
**Related Index Section:** 7. Brotli Effort

---

## 1. Goal & Value

Expose control over the Brotli effort level used for compressing non-pixel auxiliary data in the JXL codestream / container (metadata boxes, ICC profiles, EXIF/XMP, extra channels, JPEG reconstruction boxes, etc.).

**Why it matters:**
- Directly affects final file size for any JXL that carries metadata or extra channels.
- Higher effort (up to 11) can yield meaningfully smaller files when Brotli-compressible data is present.
- Low implementation risk: single integer frame setting, no new decoder state or pixel-path changes.
- High-leverage early win per sprint priorities (listed together with basic extra-channel distance).

**Scope for first cut:** Encode-side only. Decoder already respects whatever is in the stream.

---

## 2. Reference Analysis

| Library                  | Exposure                                                                 | Quality of Reference                          | Notes |
|--------------------------|--------------------------------------------------------------------------|-----------------------------------------------|-------|
| **cjxl_main.cc** (primary) | `--brotli_effort` (0-11, default 9) fully wired in AddCommandLineOptions + ProcessFlags → frame settings | Excellent (real production CLI usage)        | Gold standard for option mapping + help text. Default 9. |
| **libjxl (raw)**         | `JXL_ENC_FRAME_SETTING_BROTLI_EFFORT` via `JxlEncoderFrameSettingsSetOption` or `JxlEncoderSetFrameSetting` | Definitive                                     | Enum value + valid range documented in encode.h / docs. |
| **jpegxl-rs**            | Escape hatch via `set_frame_option(...)` (pattern shown for Modular family) | High (recommended model for Tauri ergonomics) | No dedicated builder method; use the generic/raw path. Builder + escape hatch pattern is clean. |
| **libvips**              | Not exposed (jxlsave.c)                                                  | Good negative example                         | Pragmatic production wrapper chose to omit; size wins not worth the API surface for their users. |
| **chafey/libjxl-js**     | Not mentioned in encoder header notes                                    | Thin / absent                                 | Thin Embind binding; advanced frame settings appear limited or absent. |

**Key takeaway:** cjxl_main.cc + raw libjxl header are sufficient to implement correctly. jpegxl-rs escape hatch is the pattern to copy for the Rust side.

---

## 3. Recommended API Shape (CasaWASM – WASM + future Tauri parity)

### TypeScript (facade / public API)

Add to existing `EncoderOptions` (or a nested `advanced` bag for future-proofing):

```ts
export interface EncoderOptions {
  // ... existing fields (effort, quality, lossless, progressive, etc.)

  /** Brotli effort for auxiliary data (metadata, extra channels, boxes). 0-11, default 9 (libjxl/cjxl default). */
  brotliEffort?: number;
}
```

Keep the top-level flat for ergonomics (matches current style for `effort`, `distance`).

Internal advanced bag can be added later if the surface grows.

### Rust side (Tauri / jpegxl-rs consumers)

Mirror in the high-level params struct used by `@casabio/jxl-native` or the Tauri command layer:

```rust
pub struct EncodeParams {
    // ... existing
    pub brotli_effort: Option<u32>,   // 0-11
}
```

---

## 4. WASM Implementation (bridge.cpp + facade.ts)

### Changes

1. **packages/jxl-wasm/src/bridge.cpp**
   - In `EncodeRgba` (and any multi-frame / animation entry points):
     - After `JxlEncoderFrameSettingsCreate(...)`
     - Before `JxlEncoderAddImageFrame` / `JxlEncoderProcessOutput`:
       ```cpp
       if (options.brotli_effort >= 0) {
         int v = std::clamp(options.brotli_effort, 0, 11);
         JxlEncoderFrameSettingsSetOption(frame_settings,
             JXL_ENC_FRAME_SETTING_BROTLI_EFFORT, v);
       }
       ```
   - Accept the value through the existing options struct passed from JS (extend the C++ side struct if needed).
   - One-shot and stateful encode paths must both apply it.

2. **packages/jxl-wasm/src/facade.ts**
   - Forward `brotliEffort` from the JS `EncoderOptions` bag into the WASM call.
   - Add light validation / clamping in JS (or let bridge do it).
   - Update any JSDoc / type exports.
   - Ensure it flows through both `encodeRgba*` helpers and the low-level encoder path if separate.

3. **packages/jxl-wasm/exports.txt** (unlikely change)
   - No new exports required (reuses existing encode entry points).

### Error / Validation
- Out-of-range: clamp silently (0-11) or throw `RangeError` with clear message. Recommend clamp + console warning for dev ergonomics.

---

## 5. Tauri / Native Implementation (Rust preferred)

**Primary path:** `jpegxl-rs` (inflation crate) as per global strategy.

- Extend the encode wrapper (likely in `packages/jxl-native` or a new `jxl-rs-wrapper` crate) to accept `brotli_effort`.
- Use the escape hatch:
  ```rust
  if let Some(effort) = params.brotli_effort {
      encoder.set_frame_option(
          JxlEncoderFrameSetting::BrotliEffort,   // or equivalent constant
          effort as i64
      )?;
  }
  ```
- If jpegxl-rs adds a direct method later, prefer the high-level API.
- Keep the public Tauri command / IPC surface identical in shape to the WASM `EncoderOptions` (or a shared `JxlEncodeOptions` type if one is introduced).

**Fallback (if raw C++ still used anywhere):** mirror the bridge.cpp pattern via jpegxl-sys.

**Parity requirement:** The same numeric range and default (9) must be used on both sides.

---

## 6. Benchmark Wiring (Mandatory)

**Target page:** `web/jxl-wrapper-lab.js` (or the progressive paint / controls dashboard if more appropriate).

**UI addition:**
- Number input or slider (0–11) labeled **"Brotli effort (aux)"**.
- Default value: 9.
- Help text / tooltip: "Compression effort for metadata, ICC, EXIF, extra channels, etc. Higher = smaller files, slower encode. Default 9 (cjxl)."
- On change, re-encode a representative test image that includes metadata + alpha or an extra channel.
- Display: file size delta vs baseline (effort=0 or current default) + encode time.

**Why mandatory:** Per FEATURE_IMPLEMENTATION_TEMPLATE.md §9. Every new control must be immediately demonstrable.

**Minimal viable:** Add the control + a size comparison card even if full A/B harness is added later.

---

## 7. Testing Strategy

- Unit: facade encode options round-trip (mock + real WASM).
- Integration: encode an image with rich metadata / alpha / extra channel at effort 0, 5, 9, 11. Assert monotonic size reduction (or at least non-increase) as effort rises.
- Cross-platform: same test vector on WASM and (once Tauri side exists) native path; sizes should be close.
- Regression: existing ORF→JXL and other encode tests must continue to pass (default behavior unchanged).

No new decoder tests required.

---

## 8. Files Likely Touched (Implementation Phase)

**WASM:**
- `packages/jxl-wasm/src/bridge.cpp`
- `packages/jxl-wasm/src/facade.ts`
- `packages/jxl-wasm/test/facade.test.ts` (options test)
- `web/jxl-wrapper-lab.js` (or relevant bench page)
- Possibly `web/jxl-progressive-*.js` if advanced encode options flow through workers

**Tauri / Rust:**
- `packages/jxl-native/...` (or equivalent Rust encode module)
- Tauri command handler that maps to the Rust params
- Shared types if introduced (`JxlEncodeOptions` etc.)

**Docs:**
- Update any central JXL options table / "Overview and features of the CasaWASM JXL wrapper.md"
- Append entry to `PROGRESS_LOG.md` at end of impl (per template)

**No changes expected in:**
- Scheduler, decode path, cache, stream layers (pure encode option).

---

## 9. Edge Cases & Gotchas

- Value 0 is valid (fastest, least compression of aux data).
- Only affects Brotli-compressed boxes; VarDCT/Modular pixel data use the separate `effort` setting.
- Interaction with `lossless_jpeg` reconstruction boxes: higher effort can shrink the JPEG reconstruction data.
- Default must remain 9 for backward compatibility (no size surprises for existing callers).
- Performance: effort=11 can be dramatically slower on images with large EXIF or many extra channels. Document this in UI help.

---

## 10. Rationale & Trade-offs

- **Flat `brotliEffort` on EncoderOptions** vs nested `advanced.brotliEffort`: chose flat for consistency with `effort`/`distance` and to keep first-cut API simple. Can nest later.
- **Clamp vs hard error**: clamp + warn (developer-friendly) because the setting is an optimization hint, not a correctness parameter.
- **WASM first, then Tauri**: follows existing pattern and the "WASM as reference implementation" strategy.
- **No libvips-style omission**: CasaWASM goal is *feature-maximal*. We expose even if libvips chose not to.
- **Escape hatch on Rust side**: acceptable because jpegxl-rs already uses this pattern successfully for the much larger Modular family.

---

## 11. Open Questions (for implementer or later)

- Should we also expose the setting for decode (if any future decoder-side Brotli tuning appears in libjxl)? Currently no.
- Long-term: group this + other aux settings (box compression flags) under a single `auxCompression` options object?
- Help text wording for the benchmark UI (copy from cjxl_main.cc --help is a good starting point).

---

## 12. Implementation Checklist (for the agent following FEATURE_IMPLEMENTATION_TEMPLATE)

- [x] Create feature branch: `feature/brotli-effort` *(work done on epiccodereview/20260527T054853)*
- [x] Read this design note + latest REFERENCE_INDEX + TEMPLATE
- [x] Implement WASM side (bridge + facade) — was already present; verified complete
- [x] Wire benchmark control + size feedback — `web/jxl-benchmark.js` + `benchmark/encode-option-sweep.mjs` already present
- [x] Add/update tests — `packages/jxl-native/test/codec.test.ts` new test added; 2/2 pass
- [x] Implement native addon side for parity (`packages/jxl-native`) — `EncoderData.brotli_effort`, `CreateEncoder`, `EncodeAll`, TS interface, addon rebuilt
- [x] Produce Cleanup & Handoff block — `_cleanup.md` updated
- [x] Append entry to `references/PROGRESS_LOG.md`
- [x] Update this design note with implementation status

---

**End of design note.** Ready for review and handoff to implementation agent.
