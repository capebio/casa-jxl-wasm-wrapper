# Handoff: Single Progressive / Sneyers Progressive Tuning

Date: 2026-06-05
Branch: `fix/progressive-paint-sneyers-fidelity`
Latest pushed commit at handoff time: `61ae318 feat(single-progressive): show decode transfer speed`

## Current State

The Single progressive page is working again and emits multiple visible progressive checkpoints.

Recent confirmed user run:

- Settings: `sizePreset=very-large`, `longEdgeRequest=2160`, `qualityPreset=very-high`, `q=95`, `throttleKbPerSec=0`, `progressiveDc=0`, `progressiveDetail=passes`
- Source: Gobabeb ORF, `5240x3912`
- Encoded JXL: `217.0 KB`
- Passes: `11` total, all distinct frame hashes
- First paint: `280.45 ms` at `60.0 KB`
- Final progressive paint: `2919.68 ms`
- One-shot decode: `293.5 ms`
- Effective progressive transfer/decode average: `74.3 KB/s`

Interpretation:

- The progressive UX is functioning.
- The first frame is fuzzy, which is desirable.
- Center-out behavior is evident.
- Pass 2 is already high quality in the center square, so further tuning should focus on making the early-to-mid refinement progression more useful rather than merely increasing pass count.

## What Broke It

The regression to only two frames was not Sneyers encoder flags.

Actual root cause had two parts:

1. `27b0403` added checksum dedup in `packages/jxl-wasm/src/bridge.cpp` for progressive flush snapshots. That removed many chunk-visible pseudo-progress frames, leaving mostly true libjxl boundaries.
2. In Single progressive, when throttle `0` had no yield between chunks, the facade batched queued chunks into one large WASM push. Decoder then saw one big input step and emitted only coarse progress plus final.

## What Restored It

Commit `4764a67 fix(progressive): restore chunk-visible paint checkpoints`:

- Removed bridge checksum dedup.
- Kept the generation gate, so the facade cannot drain the same snapshot forever.
- Rebuilt `packages/jxl-wasm/dist/*` WASM tiers.

Commit `03221eb fix(single-progressive): yield chunks without paint pacing`:

- Changed unthrottled chunk pacing from `nextPaint()` to `sleep(0)`.
- This keeps chunk boundaries visible to the decoder without capping on animation-frame cadence.

Commit `61ae318 feat(single-progressive): show decode transfer speed`:

- Adds current effective transfer/decode speed in ongoing status.
- Adds final average speed in status, console, metrics panel, CSV, JSON, TOON, and CopyMD.

Important behavior:

- No yield between chunks collapses back to two frames.
- `nextPaint()` yield works but imposes frame-rate pacing.
- `sleep(0)` yield works and is the current best default.

## Files Most Relevant

- `packages/jxl-wasm/src/bridge.cpp`
  - Current desired behavior: one opportunistic flush per input generation, no checksum dedup.
  - Keep `opportunistic_flush_generation` gate.
  - Do not reintroduce `prev_flush_checksum` dedup unless explicitly testing a separate mode.

- `web/jxl-single-progressive.js`
  - `feedThrottled()` currently uses:
    - `2 KB` chunks until first pass
    - `16 KB` chunks after first pass
    - throttle delay if `throttleKbPerSec > 0`
    - `sleep(0)` between chunks when unthrottled
  - `decodeProgressively()` computes per-pass and average effective transfer/decode speed.

- `web/jxl-progressive-frame-stats.js`
  - Provides frame stats: alpha min/max, alpha zero percent, RGB nonzero, luma variance, frame hash.

## Verification Run

Focused tests pass:

```powershell
rtk bun test web/jxl-single-progressive-page.test.js packages/jxl-wasm/test/progressive-detail.test.ts
rtk proxy node --check web/jxl-single-progressive.js
```

Prior broader focused suite also passed:

```powershell
rtk bun test packages/jxl-wasm/test/progressive-detail.test.ts web/jxl-single-progressive-page.test.js web/jxl-progressive-paint-page.test.js
```

## Open Tuning Questions

1. Early refinement quality:
   - User observed first frame fuzzy and useful.
   - Pass 2 already looks quite good in the center square.
   - Need tuning to make the sequence from pass 2 onward feel more meaningfully progressive.

2. Full-resolution cost:
   - Original/source-size runs can take ~30s progressive final even for ~500 KB codestreams.
   - This appears dominated by repeated full-frame decode/flush/render of very large RGBA frames, not byte transfer.
   - Need per-pass wall delta to pinpoint where time goes.

3. Next metrics to add:
   - `delta_ms` since previous pass.
   - per-pass effective speed based on delta bytes / delta ms.
   - maybe render time separate from decoder push/drain time.

4. Possible tuning axes:
   - progressiveDc: `0`, `1`, `2`
   - q/quality preset
   - long edge
   - chunk size schedule
   - progressive AC/qAC flags only with careful A/B
   - cap or skip late pseudo-progress checkpoints when visual hash deltas become tiny

## Warnings For Next Agent

- Browser imports `packages/jxl-wasm/dist`, not `src`. Bridge changes require WASM rebuild.
- If you change `bridge.cpp`, rebuild dist and hard-refresh browser.
- Do not remove all per-chunk yield in Single progressive unless intentionally reproducing the two-frame failure.
- Do not remove the bridge generation gate; that can cause repeated draining of the same snapshot.
- Worktree has unrelated untracked files under `.claude/`, `.superpowers/`, `benchmark/`, `docs/Benchmark results/`, and `tools/`. Do not stage them unless explicitly asked.

## Suggested Next Step

Add per-pass delta metrics:

- `delta_ms`
- `delta_bytes`
- `delta_kb_per_sec`
- include in console pass lines, lightbox, metrics exports

Then run A/B:

- `very-large`, q95, progressiveDc 0/1/2
- `very-large`, q90, progressiveDc 0/1/2
- source/original only after the smaller case is understood

Goal: preserve fuzzy first paint while delaying or softening the pass-2 center-square jump so progressive refinement is visually more gradual.
