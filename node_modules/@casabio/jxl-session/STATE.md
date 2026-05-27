# jxl-session — STATE.md

## Status: COMPLETE (structurally) — end-to-end blocked on codec tasks

## Tasks complete
- [x] src/event-stream.ts — push-driven AsyncIterable (AsyncEventStream)
- [x] src/util.ts — deferred(), toTransferableBuffer(), newSessionId()
- [x] src/decode-session.ts — DecodeSessionImpl (full DecodeSession contract)
- [x] src/encode-session.ts — EncodeSessionImpl (full EncodeSession contract)
- [x] src/context.ts — JxlContext + createBrowserContext + createNodeContext
- [x] src/index.ts — public barrel
- [x] package.json, tsconfig.json
- [x] tsc build clean, dist/ emitted

## Blockers
See BLOCKED.md. B-002 (codec tasks) prevents real decode/encode; the facade
itself is complete and typechecks.

## Context
Built during T-INT prep. jxl-session is in the spec module map (Section 4.1)
and required by the T-INT brief ("Replace the call sites in web/main.js with
jxl-session calls") but no Section 25 task explicitly builds it. Built here as
a T-INT prerequisite.

## T-TEST (picked up from Gemini — unit half)
- [x] test/event-stream.test.ts — AsyncEventStream (6 tests)
- [x] test/jxl-core.test.ts — JxlError taxonomy (4 tests)
- [x] test/decode-session.test.ts — lifecycle, push ordering, cancel, error
      normalization, budget expiry, telemetry (14 tests)
- [x] test/encode-session.test.ts — lifecycle, chunks, cancel, error
      normalization, quality/distance defaulting (9 tests)
- [x] test/integration.test.ts — 10 integration tests SCAFFOLDED as skipped
      (blocked on real codec — see BLOCKED.md B-002)
- [x] 33 pass / 0 fail / 10 skipped (node:test runner)
- [x] Bug found + fixed: done() promise rejected with no caller handler
      surfaced as unhandledRejection — both session impls now attach a
      no-op catch (see DECISIONS.md D-011).

jxl-scheduler already carries 18 of its own tests (landed under T-SCHEDULER).
Combined unit coverage for jxl-core / jxl-scheduler / jxl-session: 51 tests.

## Next subtask
- T-TEST integration half: unskip integration.test.ts once the codec lands.
- T-INT web wiring (web/jxl-worker.js, web/main.js) — deferred until codec lands.
