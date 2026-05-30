# Feature Design Note: Patches and Splines (Advanced Coding Tools)

**Feature:** Dictionary patches (repeated content modeling) and Catmull-Rom splines (advanced feature coding) in JPEG XL  
**Date:** 2026-05-28  
**Author:** Grok  
**Status:** Design ready for implementation handoff  
**Related Index Section:** 11. Patches and Splines (Additional Features Identified – Audit 2026-05-28)  
**Priority:** Lower than the core controls batch, but valuable for a truly feature-maximal implementation. Experimental / rarely exposed in high-level wrappers.

---

## 1. Goal & Value

Expose (or at minimum provide escape-hatch access to) two advanced coding tools in libjxl:

- **Patches** — Dictionary-based modeling of repeated image content (great for certain synthetic, UI, or patterned imagery).
- **Splines** — Catmull-Rom spline modeling for compact representation of certain image features (edges, gradients, etc.).

**Why consider this for CasaWASM:**
- These are part of the "complete" libjxl encoder surface.
- They can deliver significant compression wins on the right content (synthetic graphics, medical imagery with repeating structures, etc.).
- The audit in REFERENCE_INDEX explicitly calls them out as advanced coding tools that are "rarely exposed in high-level wrappers."
- Implementing (or at least surfacing) them reinforces the "most complete production-grade JXL implementation" strategy.

**Important scoping note:** These features are more experimental and content-dependent than the previous controls. A minimal viable design may be "excellent escape hatch + optional high-level toggles" rather than rich first-class APIs.

---

## 2. Reference Analysis

- **Official libjxl format_overview.md** (and related design docs) — primary source for dictionary patches and Catmull-Rom splines.
- **cjxl_main.cc** — look for `--patches` and related experimental flags. This is the best place to see real (if limited) usage and option wiring.
- **libjxl headers** (`encode.h`, etc.) — the raw `JXL_ENC_FRAME_SETTING_*` or box-level APIs for enabling and configuring these tools.
- High-level wrappers (jpegxl-rs, libvips, chafey) — generally provide little or no direct support; this is an area where CasaWASM can differentiate by at least making the power accessible.

During implementation, the agent should extract the relevant sections from `format_overview.md`, the libjxl source, and any `--patches` handling in cjxl_main.cc.

---

## 3. Recommended Approach & API Shape

Because these are advanced/experimental, a two-tier strategy is recommended:

### Tier 1 – Escape Hatch (Strongly Recommended for First Cut)

```ts
export interface EncoderOptions {
  // ... all previous options

  /** Raw advanced frame setting escape hatch for power users and future features */
  advancedFrameSettings?: Array<{
    id: number;     // JXL_ENC_FRAME_SETTING_* constant value
    value: number;
  }>;
}
```

This single mechanism (already conceptually present via the patterns in previous notes) instantly gives access to patches, splines, and any future experimental settings without waiting for dedicated APIs.

### Tier 2 – High-Level Convenience (Later / Optional)

```ts
export interface AdvancedCodingOptions {
  /** Enable dictionary patch modeling (if supported for the content) */
  enablePatches?: boolean;

  /** Enable spline modeling */
  enableSplines?: boolean;

  /** Optional strength or mode controls (to be defined after pulling real cjxl usage) */
  patchStrength?: number;
}

export interface EncoderOptions {
  // ...
  advancedCoding?: AdvancedCodingOptions;
}
```

Start with Tier 1 + clear documentation. Add Tier 2 only after real usage data from cjxl and libjxl examples shows ergonomic value.

---

## 4. WASM Implementation

### bridge.cpp

- Pass through any `advancedFrameSettings` via `JxlEncoderFrameSettingsSetOption`.
- For dedicated `enablePatches` / `enableSplines`, map to the appropriate `JXL_ENC_FRAME_SETTING_*` values (or box-level APIs) once the exact constants are identified from the references.

### facade.ts

- Expose the escape hatch cleanly.
- (Optional later) Add the higher-level `advancedCoding` bag that translates into the raw settings.

No new low-level WASM exports are expected to be required.

---

## 5. Tauri / Rust Side

jpegxl-rs already follows an escape-hatch philosophy for many advanced features. The native side can adopt the exact same `advancedFrameSettings` pattern (or a typed `AdvancedCodingOptions` struct that eventually maps to raw options).

This keeps the two platforms consistent.

---

## 6. Benchmark Wiring

**Recommended approach:** Add an "Experimental / Advanced Coding" section in the wrapper lab (or a dedicated advanced benchmark page).

**What to show:**
- Toggle for patches and/or splines on suitable test content (synthetic patterns, repeating elements, certain medical or graphical images).
- File size delta + encode time.
- Visual quality comparison (especially on content where these tools shine).
- Clear warning that results are highly content-dependent.

Include a note that these features may be disabled or have limited effect depending on libjxl build configuration.

---

## 7. Testing

- Basic "does not crash + produces valid JXL" when the settings are enabled.
- Size/quality impact measurements on a small curated set of content known to benefit.
- Ensure the escape hatch does not interfere with any of the previously designed controls.
- Decoder compatibility (these tools are encoder-only modeling aids; the resulting codestream must decode on any compliant decoder).

---

## 8. Files & Scope Expectations

- `packages/jxl-wasm/src/bridge.cpp`
- `packages/jxl-wasm/src/facade.ts`
- `web/jxl-wrapper-lab.js` (advanced section)
- Documentation updates (clearly label as experimental / content-dependent)

This is one of the lower-effort notes in the overall batch if scoped primarily to the escape hatch. A rich first-class API would require significantly more research and validation.

---

## 9. Rationale

- Acknowledges the experimental nature of the features (as stated in the INDEX).
- Prioritizes the escape hatch as the highest-ROI first deliverable (consistent with jpegxl-rs philosophy and previous design notes).
- Positions the library to easily adopt these tools as they mature in libjxl.
- Avoids over-promising on compression wins that are highly content-specific.

---

## 10. Implementation Checklist

- [x] Branch: worktree + main (feature/patches-splines work)
- [x] Extract exact constants (PATCHES = 8 from libjxl encode.h)
- [x] Implement the `advancedFrameSettings` escape hatch (Array<{id,value}> + JxlFrameSetting helper) — both WASM and native
- [ ] (Optional) Add higher-level `advancedCoding` sugar (deferred per design note)
- [x] Add experimental section to the benchmark with appropriate warnings (minimal checkbox + warning in wrapper-lab)
- [x] Basic validity + size-impact smoke on friendly synthetic repeating content (test + console logging)
- [x] Tauri parity via the same escape hatch (native package wired + parsing + SetOption)
- [x] Clear documentation of experimental status (JSDoc + lab warning)
- [x] Full handoff + PROGRESS_LOG entry (entry exists in PROGRESS_LOG.md with Visibility Note re: branch isolation — see 2026-06 sync pass)

---

**End of design note.**

This is the eleventh design note. The remaining audit items are now quite low priority or very narrow. 

I am ready to continue with any specific remaining item, do a summary of the entire designs/ folder, or pause for review. Just say the word.