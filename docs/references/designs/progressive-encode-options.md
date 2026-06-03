# Feature Design Note: Progressive Encode Options (Early Preview Focused)

**Feature:** First-class, fine-grained control over progressive encoding knobs that directly affect how early a usable preview appears (progressive DC layers, group order, preview bias, etc.).

**Date:** 2026-06
**Status:** Implemented (2026-06-03) — see docs/superpowers/specs/2026-06-03-truly-progressive-jxl-design.md and docs/Benchmark results/truly-progressive-2026-06-03.md for the measurement-driven SNEYERS_PRESET.
**Priority:** High — directly addresses the gap between our decode capabilities and the earliest previews possible with well-encoded files (as noted by Jon Sneyers regarding jxl-rs vs libjxl C).

---

## Goal

Allow callers to produce JXL files that become recognizable *as early as possible* over the network or in progressive viewers, while staying on the official libjxl encoder.

The biggest wins for "early usable preview" come from:

- Center-out group ordering (dramatically better perceived quality at low byte counts than scanline).
- Multiple progressive DC layers.
- Explicit preview bias / previewFirst behavior.
- Sensible defaults when the user just says "I want good progressive for web/viewers".

---

## Current State (Before This Work)

`EncoderOptions` only exposes very coarse controls:

```ts
progressive?: boolean;
progressiveFlavor?: "dc" | "ac";
previewFirst?: boolean;   // mostly just flips AC on
```

Internally this maps to `progressiveDc: 0|1`, `progressiveAc: 0|1`.

No `groupOrder`, no multi-layer DC, no last-passes bias, etc.

This means even when we have excellent *decode*-side early preview machinery (opportunistic flush + dedicated preview frame support from the prior slice), the *encoded files* often don't contain data that becomes useful until relatively late.

---

## Recommended API Additions (WASM + Native Parity)

Add to `EncoderOptions`:

```ts
export interface EncoderOptions {
  // ... existing fields

  /**
   * Group order for progressive / ROI friendliness.
   * 0 = scanline (default, fastest encode)
   * 1 = center-out (strongly recommended for progressive viewing and thumbnails)
   */
  groupOrder?: 0 | 1;

  /**
   * Number of progressive DC layers (0 = none, 1 = basic DC, 2+ = more granular DC progression).
   * Higher values + center-out group order give the best "early recognizable" behavior.
   */
  progressiveDc?: 0 | 1 | 2;

  /**
   * Strong bias toward having a very small usable preview as early as possible.
   * When true, the encoder will prefer settings that allow something recognizable
   * after only a few kilobytes (works together with groupOrder + progressiveDc).
   */
  previewFirst?: boolean;

  // Future (lower priority for this slice):
  // lastPassesBias, responsive, etc.
}
```

These should also be available under `advancedControls` as the promoted IDs for power users (ID 17 for group order, etc.).

---

## Implementation Notes

- `groupOrder` maps to `JXL_ENC_FRAME_SETTING_GROUP_ORDER` (or the equivalent advanced ID 17).
- `progressiveDc` > 1 maps to the corresponding frame setting.
- When `previewFirst` is true, we should automatically set sensible values for `groupOrder` and `progressiveDc` unless the caller overrides them (smart defaults).
- All changes must flow through the existing advanced pairs mechanism where possible to avoid new FFI.

This work pairs perfectly with the dedicated preview frame *decode* support added in the preceding slice.

---

## Benchmark Wiring (Mandatory)

- In `jxl-wrapper-lab` and `jxl-progressive-paint`, add controls for `groupOrder` and `progressiveDc`.
- Add a "Early Preview Quality" comparison mode that encodes the same image with different combinations and shows byte count vs recognizable quality (side-by-side or animated).
- Measure and display "bytes until first recognizable preview" for each setting.

---

## Status

- Decode-side dedicated preview + opportunistic flush: Done (previous slice).
- Encode-side progressive options design note + first implementation slice (groupOrder + better progressiveDc + smart previewFirst): In progress.

---

## Implementation Progress (Living Section)

**Current branch:** (continuing from preview decode work)

**Work completed in this continuation of Task 3:**

- Added `progressiveDc?: number` to `EncoderOptions` (jxl-core) with clear JSDoc explaining impact on early low-frequency stages.
- Extended `resolveEncoderBridgeSettings` in facade.ts:
  - Respects explicit `progressiveDc` value instead of hardcoding to 1.
  - When `previewFirst` is true and no explicit `progressiveDc`, ensures at least 1 (basic early DC layer).
- `groupOrder` (from previous micro-slice) now has smart promotion when `previewFirst` + automatic injection into `advancedControls` (sustainable pattern).
- Mirrored `progressiveDc` and `groupOrder` fields into `jxl-native` `EncoderOptions` for parity (via advanced injection, zero native.cc touch this pass; adv loop already drives the ids).
- Extended raw-pipeline casabio_encode with *_with_progressive entrypoints + internal set (transmute for FrameSetting to keep Cargo surface small) + test smoke.
- Updated workers/session to clean casts; added source test + live native encode exercise (Dc=2 path produced bytes).
- Updated the design note itself with this progress and clarified priorities.

These changes mean callers can now do:

```ts
const opts = {
  progressive: true,
  previewFirst: true,
  progressiveDc: 2,      // more granular DC stages
  groupOrder: 1,         // center-out — best for perceived early quality
};
```

The values flow to the bridge (and will reach native encode path).

**Next immediate work (still in this Task 3 slice):**
See the top of `docs/HANDOFF-predator-progressive-2026.md` — the "Handoff for Next Continuation..." block + new "Progress This Continuation" section (added 2026-06) is the living task list. UI checkbox + smart defaults + wiring + render surfacing + test extension (assert >=3 events for Dc=2+group=1+passes) + doc updates landed. Page source tests + progressive-detail roundtrip test now pass and enforce the multi-layer signal. 

Post 2026-06-03 measurement + follow-ups: decode collection + prefix-probe wired to matrix worker (live 1st-prog + min-bytes heatmaps/CSV); predator-paint-visual-smoke automation executed (timelineEntries=2, first-paint ~443ms, center-bias proxy score ~18.8 on g=1 run with passes/preview/Dc~2); native encode_variants_with_progressive (Dc=2/g=1 smoke) source+check verified; docs (audit/report/INCOMPLETE/handoff) updated with numbers. Full human-eye A/B on Gobabeb + native matrix parity remain open.

**Rationale:** `progressiveDc` layers + center-out group order are the two highest-leverage encode-time controls for producing files that become useful extremely early — directly complementing the decode-side preview machinery.

---

**End of current note (living document).**

---

## 2026-06-03 Update

**SNEYERS_PRESET locked** in `web/jxl-progressive-best-preset.js`:
- `progressiveDc=2, progressiveAc=1, qProgressiveAc=1, groupOrder=1, effort=3, decodingSpeed=0`
- Wired into `facade.ts:resolveEncoderBridgeSettings` behind `USE_SNEYERS_DEFAULT=true` (single-line rollback).
- Default applies whenever `progressive=true && previewFirst=true`.

**JPEG path mirror bench** added (`benchmark/jpeg-progressive-stream.mjs`) — same flag matrix, effort sweep {3,5}, JPEG pixel source via sharp. Proves the preset works on both RAW and JPEG inputs.

**Monotonicity asserted** — `web/jxl-progressive-quality.js` computes PSNR per cutoff; `detectMonotone()` validates each paint ≥ prior − 0.5 dB. Summary metrics: `firstRecognizableBytes`, `previewBytes`, `finalPsnr`, `monotone` added to `summarizeByteCutoffResults`.

**UI throttle wired** — `web/jxl-progressive-paint.html` gains `#preset-name` (default: Sneyers) and `#throttle-rate` (default: 100 KB/s) selects. `feedThrottled()` replaces `streamIntoDecoder` when throttle > 0, producing real network-rate progressive reveals.
