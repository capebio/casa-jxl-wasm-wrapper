# Opus 4.8 — Progressive "Throttle" Fix Handoff

**Date:** 2026-06-07
**Branch:** `Opus4.8MaxInvestigationImplementation`
**Read first:** `docs/Opus4.8ThrottleFindings.md` (data-grounded root cause), then `Opus4.8MaxInvestigation.md` (the audit this implements). Cross-check every change against `CLAUDE.md` → "Recurring False Claims" and "Layer Invariants", and `docs/rejected optimizations.md`.

## State you are inheriting

- The "throttle" is **not** a throttle. `throttle = 0` in all measured runs; there is no injected delay on that path. The slowness is structural: **N progressive passes → N full reconstructions + N full-frame paints**, serialized, N and per-pass cost both rising with resolution (3.3× at display → **9.5×** at Original vs one-shot).
- **Already landed — do NOT redo or revert:** opportunistic per-generation flush removed (`d2f98af`/`63c345f`); chart freeze + 3 GB Float32 cascade removed (`de0869f`-A/D, `82d5910`); sync `putImageData` → async `createImageBitmap` (`de0869f`-B); borders skipped > 4 MP (`de0869f`-C, `600bf96`); permanent stats-worker latch fixed (`82d5910`); **decode-in-worker already defaults ON** (`html:206` ships `checked` — R3 is done).
- Passes now equal real `FRAME_PROGRESSION` boundaries (12 at Original), not chunk count.

## Non-negotiable guardrails (will be rejected on review)

- No pixel-buffer pool for transferred outputs — transferred `ArrayBuffer`s detach (R1-2/R2-2/DH-2).
- No drain/`onDrain` on the decoder; backpressure lives at the scheduler/worker boundary only.
- No per-stage budget reset; no soft-preemption/yield protocol; no batching in session/facade.
- Keep all edits in the page layer (`web/jxl-single-progressive.*`). Do **not** push page concerns into `scheduler`/`facade`/`session`. Format validation stays in libjxl.
- The page tests (`web/jxl-single-progressive-page.test.js`) are **source-level string assertions** — they grep the page for expected settings/IDs. Any control/ID/default change requires updating them. (Both progressive page test files already show Modified from in-flight work — rebase onto them, don't clobber.)

---

## Tasks (ordered)

### F0 — Confirm the measurement baseline *(do first; cheap; changes the math)*
- **Goal:** know whether reconstruction is single- or multi-threaded before trusting absolute ms.
- **Do:** on page load log `crossOriginIsolated` and the `.wasm` variant the facade selected. Serve via `tools/dev-server.mjs` (sends COOP/COEP at `:34-35`). Map = audit **R2**.
- **Done when:** console shows `crossOriginIsolated === true` and a `*-mt` wasm. If false → fix hosting headers first; every other number changes.
- **Risk:** none (logging).

### F1 — Stop forcing every-pass emit for local bytes *(highest impact; audit R1)*
- **Goal:** default the "decode this file" path to product policy; reserve every-pass for an explicit diagnostic. Collapses N from 12 → ~2–3 at Original.
- **Files / anchors:**
  - `web/jxl-single-progressive.js:11` — `const PROGRESSIVE_DETAIL = 'passes'` (currently hard-coded).
  - Decode option objects that consume it: `:846` (`decodeProgressively`), `:933` (`decodeProgressivelyViaWorker`); `emitEveryPass: true` at `:845`/`:932`. One-shot (`:1042-1043`, `emitEveryPass:false`) stays as-is.
  - `web/jxl-single-progressive.html` — add a control near the existing selects (`progressive-ac` `:174` … `decode-in-worker` `:206`).
- **Change sketch:** add `<select id="progressive-detail">` with `lastPasses` (default), `passes` (diagnostic), `dc` (DC preview + final). Read it where the other settings are read (`getSettings`/`buildEncodeDecodeSettings`, same place `:653-659` reads `progressive-dc`/`-ac`), thread the chosen detail + `emitEveryPass = (detail === 'passes')` into the `:846`/`:933` option objects. Default → product behavior.
- **Done when:** default Original run shows `m-passes` ~2–3 and `final_ms` drops toward ~1–1.5 s; selecting "passes" reproduces today's 12-pass behavior.
- **Risk:** low (this is what the product worker already ships, `jxl-decode-worker.js` `lastPasses`). Update page tests asserting settings.

### F2 — Don't chunk-feed or `sleep(0)` local bytes *(audit T2/R5)*
- **Goal:** remove the self-inflicted per-chunk macrotask hops that inflate inter-pass gaps.
- **Files / anchors:** `feedThrottled` `:1177-1199` (unthrottled `await sleep(0)` at `:1196`; ramp/steady consts `:12-13`); callers `:912` (main) and `:999` (worker).
- **Change sketch:** when `throttleKbPerSec === 0`, push the whole buffer in **one** `decoder.push` (the facade already coalesces; `decoder.push` is synchronous per `CLAUDE.md`), then `close()`. Keep the chunk loop + delay **only** for `throttle > 0` (genuine network sim). Drop the `:1196` `else sleep(0)`.
- **Done when:** at throttle 0, a single push; inter-pass gaps shrink; no behavior change at throttle > 0.
- **Risk:** low. Do not add backpressure/drain here (guardrail).

### F3 — Stop painting 82 MB per intermediate pass *(paint is ~25% of wall at Original)*
- **Goal:** cut the ~1.7 s of per-pass paint at Original; remove main-thread hitches.
- **Files / anchors:** `renderProgressivePass` `:1203-1225`; `drawPixels` `:1367-1374` (`createImageBitmap(new ImageData(82 MB))` + `drawImage`); `drawPassWithOverlay` `:1376-1382`.
- **Change sketch:** (a) paint **intermediates at display resolution** — downscale to the visible canvas size before `createImageBitmap` (full-res only for the final pass); and/or (b) **rAF-coalesce** paints so a burst of passes shares one paint (port the A2 pattern already in `jxl-progressive-paint.js`, commit `1b7bc73` — it never landed in this file).
- **Done when:** Σ`paintMs` at Original drops sharply; refine still visibly progresses; final is full-res.
- **Risk:** medium. Keep `pass.pixels` intact for lightbox/stats and respect `thinRetainedPassPixels` (`:921`); compute stats from full-res pixels, not the display-downscaled paint.

### F4 — Fix the misleading `decMs` metric
- **Goal:** stop labeling event-loop gap as "decode" (see Findings §1). `decodeMs = deltaMs − paintMs` at `:880`/`:972`.
- **Change sketch:** rename the column to "inter-pass" / "gap−paint" in the dashboard and TOON header (`:1924`). If a true decode number is wanted, have the worker stamp decode-start/decode-end around its `push`/flush and return it on the frame; surface that as the real "decode" field.
- **Done when:** the dashboard/TOON no longer present a derived gap as decode time.
- **Risk:** low (instrumentation only).

### F5 — Bridge-side trims *(needs WASM rebuild; do AFTER F1)*
- **Goal:** shrink each remaining pass once F1 has reduced how many there are. Audit **R4** + **R6**.
- **Files / anchors:** `packages/jxl-wasm/src/bridge.cpp` — `JxlDecoderFlushImage` `:1937`; first-flush all-zero guard `:1955` (`flush_count == 0`); opportunistic gate `:2048-2050`; COPY-1 `memcpy s->flushed ← s->pixels` (~`:1951`); facade copy-out.
- **Change sketch:** R4 — extend the guard to "no new groups committed since last flush" (track libjxl's group/pass counter; never suppress the final). R6 — expose `s->pixels` as a read-only view for *peek* snapshots to drop COPY-1, keeping the owned-buffer transfer only for the final. **Heed the red-garbage warning at `bridge.cpp:1920-1931`** — read the buffer, never swap it.
- **Build:** per `CLAUDE.md` Build Notes — `node scripts/build.mjs` from `packages/jxl-wasm` (emsdk at `C:\Users\User\emsdk`, `docker.io/emscripten/emsdk`). Rebuild ships in `web/pkg`.
- **Done when:** per-pass cost drops with no dropped real pass and final image intact (regression-test the flip-flop path).
- **Risk:** medium — needs a reliable "did anything change" signal; over-suppression drops a real pass.

---

## Verification protocol

1. **Measure before each change.** Run the page per size (`di`/`vl`/`or`) at throttle 0, export TOON, record `m-passes`, `first_ms`, `final_ms`, Σ`paintMs`, `oneShot_ms`, ratio. (Force borders off via `?borders=0` for clean paint numbers.)
2. **Target:** Original `final_ms / oneShot_ms` from **9.5× → ≤ ~2×** after F1+F2+F3; first paint should land well before one-shot final once N is small.
3. **A/B the diagnostic toggle:** "passes" mode must still reproduce the 12-pass behavior (so the lab capability isn't lost).
4. **Tests:** `node --test web/jxl-single-progressive-page.test.js` (+ `web/jxl-progressive-paint-page.test.js`); full suite `npm test` (`node tools/run-workspaces.mjs test`). Remember these assert on page **source** — update them with any control/default change.

## Sequencing

F0 → F1 (biggest win) → F2 → F3 → F4 (anytime) → F5 (last; rebuild). F1 before F5 so the bridge work targets a small, real pass count.

## Open confirmations (from Findings §7)

- Confirm `decode-in-worker` was checked when the 2026-06-07 export was made (it is the default).
- Confirm the 22-pass block's knob (likely `go=tb`).
- `encMs` (846–1728 ms RAW→JXL re-encode) runs **before** any progressive pixel — if "time to first pixel from click" is the metric, give the encode step its own pass; it is out of scope for the throttle fixes above.
