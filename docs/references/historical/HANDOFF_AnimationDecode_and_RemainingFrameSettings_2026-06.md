# Handoff: Animation Decode Enhancements + Remaining Low-Level Frame Settings (Notes 4 & 5)

**Date:** 2026-06
**Context:** All high-priority and most medium design notes from the 2026-05-28 Next Features Handoff have been completed. The final two medium/follow-up items are grouped here for focused continuation work. The user explicitly requested a clean handoff separating these from the first three medium items.

---

## Current Reality (Ground Truth)

### Completed Work (Relevant Context)
- Full set of 2026-06 Phase 3 micro-features (HDR Signaling, Pixel Art, JPEG Recompression, Production Chunked) — all at exemplar standard.
- Progressive Encode Options design note complete.
- Advanced Decoder Controls & Tuning design note complete.
- WASM Build Strategy decision recorded: **Stay with Full builds** for the foreseeable future (see `wasm-build-strategy.md`).
- `additional-hdr-signaling.md`, `jumbf-box-support.md`, and `granular-extra-channel-modular.md` have been authored (see the companion handoff for those).

### State of These Two Notes

**4. Animation Decode Enhancements** — ✅ **COMPLETE** (source-only; WASM rebuild + full seek body pending)

Implemented on branch `feature/animation-decode-enhancements`:
- `seekToFrame?` / `seekToTime?` on `JxlDecoder` interface and `LibjxlDecoder` class (runtime stubs that throw `CapabilityMissing` until WASM rebuild)
- `animationSeek` capability gate: dynamic in `JxlCapabilities` (reads `_jxl_wasm_dec_seek_to_frame` presence) and in `WrapperCapabilities` (reads `cachedModule` after first load — correct sync behavior)
- `jxl_wasm_dec_seek_to_frame` in bridge.cpp (forward-only via `JxlDecoderSkipFrames`; source-only, pending rebuild)
- `seekToFrame?` / `seekToTime?` parity stubs on `NativeDecoder` in jxl-native
- Animation lab fully enhanced: frame buffer accumulation, RAF playback loop with tick-accurate timing, range scrubber, per-frame metadata panel, play/pause toggle, loop count support
- 3 new tests passing; 72 total tests green

**Post-rebuild work remaining:**
- [ ] Implement `seekToFrame` body (replace `CapabilityMissing` throw with real forward-seek loop)
- [ ] Implement `seekToTime` body (convert ms → frame via `animTicsPerSecond`)
- [ ] Validate end-to-end seek with real multi-frame JXL fixture
- [ ] Add seek demo controls to animation lab

**5. Remaining Low-Level Frame Settings** — ✅ **COMPLETE** (documentation + audit only)

Full coverage audit of all 36 `JXL_ENC_FRAME_SETTING_*` IDs (0–35):
- 26 first-class in existing design notes / facade.ts fields
- 10 in escape hatch with documented guidance and usage examples
- 0 new promotions — all high-ROI settings were already covered

See `docs/references/designs/remaining-frame-settings.md` for the full table and escape-hatch guide.

---

## Process Compliance

- ✅ `FEATURE_IMPLEMENTATION_TEMPLATE.md` followed
- ✅ Benchmark wiring: animation lab enhanced with full frame buffer + playback demo
- ✅ WASM ↔ Native public API parity: `seekToFrame?` / `seekToTime?` on both interfaces
- ✅ Living "Implementation Progress" + full Cleanup & Handoff blocks in each design note
- ✅ Tracking updated: `DESIGNS_INDEX.md`, `PROGRESS_LOG.md`, `ISSUES.md` (§11), this handoff
- ✅ Dedicated feature branch: `feature/animation-decode-enhancements`
- ✅ Full-build-only — no Lite/Decode-only variants introduced
- ✅ Ruthless standard honored: 0 new promotions in remaining-frame-settings audit

---

## Key Files

- `docs/references/designs/animation-decode-enhancements.md` — living design note with post-rebuild checklist
- `docs/references/designs/remaining-frame-settings.md` — full ID coverage table + escape-hatch guide
- `packages/jxl-wasm/src/facade.ts` — `seekToFrame`/`seekToTime` stubs, `animationSeek` capability, `cachedModule` cache
- `packages/jxl-wasm/src/bridge.cpp` — `jxl_wasm_dec_seek_to_frame` source (forward-only seek)
- `web/animation-lab.html` — frame buffer + playback loop + scrubber + metadata panel
- `docs/references/designs/ISSUES.md` §11 — closure entry with post-rebuild checklist

---

## What to Do When Resuming (Post-Rebuild)

1. Verify `bun test ./node_modules/@casabio/jxl-wasm/test/facade.test.ts` — 72+ tests pass.
2. Confirm `getWrapperCapabilities().animationSeek` returns `true` after module load.
3. Implement `seekToFrame` body in `LibjxlDecoder` (replace the `CapabilityMissing` stub).
4. Implement `seekToTime` body (read `animTicsPerSecond` from the animation header event, compute `Math.floor(timeMs * ticksPerSecond / 1000)`).
5. Add seek demo controls to animation lab.
6. Validate with a real multi-frame JXL file.
7. Update DESIGNS_INDEX status from "source-only" to "Implemented."

---

**Both Notes 4 & 5 from the 2026-05-28 Next Features Handoff are complete.** The 2026-05-28 design note phase is fully closed. The only open work is the post-WASM-rebuild seek body implementation (see §9 of ISSUES.md for rebuild prerequisites).

**End of this handoff.**
