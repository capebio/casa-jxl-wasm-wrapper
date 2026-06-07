@C:\Users\User\.codex\RTK.md

# Communication

Use Caveman full mode for all assistant responses by default:
- Drop filler, pleasantries, and hedging.
- Use terse fragments when clear.
- Keep technical terms exact and code unchanged.
- Continue until user says `stop caveman` or `normal mode`.

# DONOTCHANGE: Progressive Decode Checkpoints

Do not remove or "dedupe away" open-stream opportunistic progressive flushes in
`packages/jxl-wasm/src/bridge.cpp`.

Required behavior:
- On `JXL_DEC_NEED_MORE_INPUT`, after a frame has started and before final, the bridge must attempt one `TryFlushProgressiveImage` per `input_generation`.
- Keep the `opportunistic_flush_generation != input_generation` guard.
- Do not reintroduce checksum/frame-hash dedup (`prev_flush_checksum` style) unless behind an explicit runtime experiment flag.
- When `progressiveDetail === 'passes'` (diagnostic) or throttle > 0, `web/jxl-single-progressive.js` must chunk-feed and yield between pushes (`sleep(0)` when unthrottled). Do not collapse diagnostic decode to a single push — one `input_generation` ⇒ at most one non-final flush (two frames). Product `lastPasses`/`dc` at throttle 0 may use one push; see `web/README.md`.
- Keep Single Progressive default progressive settings aligned with Sneyers baseline: `progressiveDc=2`, `progressiveAc=1`, `qProgressiveAc=1`, `groupOrder=1`, `progressiveDetail='lastPasses'`, `emitEveryPass` via `emitEveryPassForDetail` (false for `dc`, true for `lastPasses`/`passes`).

Why: libjxl often emits only coarse true `JXL_DEC_FRAME_PROGRESSION` boundaries for small/medium images. The UI needs chunk-visible checkpoints while bytes arrive. Removing this path collapses Single Progressive back to one non-final progress stage plus final, even when encoder settings request progressive layers.

Before touching this area, run:

```powershell
rtk proxy bun test packages/jxl-wasm/test/progressive-visible-passes.test.ts
rtk proxy bun test web/jxl-single-progressive-page.test.js
```
