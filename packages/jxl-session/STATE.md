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

## Next subtask
T-INT web wiring (web/jxl-worker.js, web/main.js) — deferred until the merge
settles and the Codex codec tasks land.
