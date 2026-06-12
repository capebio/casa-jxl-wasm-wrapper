# Plan: Agent 6 Item 2 — Animation frame delivery JS side (pairs with Agent 2 2.1)

**Status**: One-page plan. No source edits. Approval required before any change.

## Goal
Make the JS facade + decode-handler surface per-animation-frame events (using the existing JXL_DEC_RESULT_FRAME_DONE = 3 path in bridge.cpp) so callers receive individual frames with frameIndex/duration/name as they become ready, instead of only final or coarse progress.

## Merit (pipeline context)
- Bridge.cpp already implements the contract: for have_animation && !is_last_frame, after producing frame pixels it returns JXL_DEC_RESULT_FRAME_DONE (3) to allow the upper layer to flush that frame and continue (see bridge:2404 and surrounding anim frame handling + is_last_frame capture).
- DecodeEvent types in facade.ts already declare frameIndex, frameDuration, frameName, isLastFrame, animTicksPerSecond, animLoopCount on progress + final variants.
- Animation decode work (fast-path-principles, boundary-cost-audit, references/designs/animation-decode-enhancements.md, bridge encode side) shows investment in multi-frame JXL.
- Without JS-side handling, the FRAME_DONE early return is invisible; consumers see only one "final" or must wait for full stream. Per-frame delivery enables proper animated JXL (GIF-like) UX and matches "pairs with Agent 2".
- Positive: completes the bridge investment without new C++ work.

## Constraints / invariants
- CLAUDE.md layer map: facade.ts owns WASM heap + event shaping; decode-handler owns worker-side state machine + EMA drain. Changes belong here (not scheduler, not pyramid).
- Bridge returns the special code on non-last frames to trigger flush; do not remove or dedupe the opportunistic path (see DONOTCHANGE in Agents.md for progressive, analogous here).
- DecodeEvent already has the fields — do not invent new event type unless necessary (prefer enriching "progress" with frame* or a lightweight "frame" variant).
- WASM path note in options: "The WASM decoder always decodes the full stream; frame selection is not supported." (frameIndex option is native-only). Plan must respect this (we emit what the stream produces).
- No change to budget, backpressure, or main progressive contract.
- rejected optimizations.md: nothing directly rejects per-frame emission; related animation work was accepted.

## Files / cross-file surface
- packages/jxl-wasm/src/facade.ts (JxlDecoder impl, the event pump that calls into WASM decoder, mapping of internal result codes to DecodeEvent; icc/anim metadata capture sites)
- packages/jxl-worker-browser/src/decode-handler.ts (and node counterpart if parity) — handle the equivalent of "frame done" from facade, post MsgDecodeProgress with frame fields populated, without terminating the session.
- Protocol: @casabio/jxl-core/protocol.ts MsgDecodeProgress (or new lightweight) may need frame* fields if not present.
- Tests: packages/jxl-wasm/test/* (jxtc/anim if any), worker-browser tests, web/ animation labs if exist.
- Consumers: anything using events() or onFrame callbacks for animated JXL.

## One-page sketch (minimal steps)
1. In facade.ts LibjxlDecoder (events() pump + internal step loop over bridge results), on JXL_DEC_RESULT_FRAME_DONE (3) or equivalent frame boundary signal: capture frameIndex / duration / name / isLast from decoder state (already populated on JXL_DEC_FRAME + anim info), yield a DecodeEvent "progress" (or minimal new "frame" shape that is compatible with existing progress consumers) carrying pixels (zero-copy view where facade already supports) + frame* fields + isFinal=false, then continue for subsequent frames without closing the decoder.
2. Last frame (is_last_frame or final result) yields the normal "final" event with isLastFrame + animLoopCount + full anim header.
3. In decode-handler.ts (worker): treat frame-boundary progress from facade the same as any other progress (post MsgDecodeProgress with frame fields); never call finish on intermediate frames. Budget check remains global from session start (per-frame pixels still count against overall budget).
4. Protocol: extend MsgDecodeProgress (or reuse the shape DecodeEvent already declares) with optional frame* fields. No new message type if possible.
5. createDecoder paths that accept frameIndex (WASM note says full-stream anyway) still work; emitted events for that logical frame carry the index.
6. Test: feed multi-frame anim (or bridge synthetic that exercises return-3), assert N distinct frame-bearing progress events (with correct metadata and pixels) before the final, plus isLastFrame on last. Assert previous frame pixels are not mutated after yield.
7. Docs: note that anim frame delivery uses the same opportunistic flush discipline as progressive passes (see DONOTCHANGE in bridge).

## Efficiency & Speed deltas + features
- Pixels for intermediate frames follow the same zero-copy / grow-only buffer discipline as progressive (no extra alloc per frame beyond what libjxl already produced).
- Feature (low cost): allow per-frame progressionTarget (dc for first paint of each frame, then final) if bridge state machine supports re-targeting without restart — surfaces as two events per frame with stage. (Stretch if easy.)
- Budget is session-global (correct for long anims); consumer must drain promptly or risk budget_exceeded mid-anim.
- No change to main progressive contract or backpressure.

## Verification (narrow first)
- `bun test packages/jxl-wasm/test` (existing jxtc + facade tests; add anim coverage).
- Worker-browser handler tests exercising frame emission.
- If animation-lab.html or web/jxl-wrapper-lab exists: load a known animated JXL, assert UI receives per-frame paints (or log the events).
- Cross-check bridge: the return-3 path must still be hit (use the existing progressive-visible-passes style tests or add a minimal one).
- Full: rtk proxy bun test (if any animation-specific) + manual in browser with real multi-frame asset.
- No regression on single-frame or non-anim progressive.

## Risks / open questions
- Exact shape of "frame done" signal from the current facade wrapper around the WASM state (is it a special return from the low-level step, or an event the bridge already posts?). May require small bridge surface (e.g. a dec_frame_done hook) if not already visible.
- Buffering: per-frame pixels for long animations could be memory heavy if consumer does not drain promptly (scheduler budget still applies).
- Native vs WASM parity: native already supports frameIndex seek; WASM emits all frames in order.
- Unknown: volume of real animated JXL assets in the corpus today.

**Approval gate**: User must say "approved, execute 2" (or all) before any search_replace or edit. Plans only.
