# @casabio/jxl-session — Changelog

## v0.1.0 (2026-05-21)

- Initial release.
- JxlContext facade with createBrowserContext / createNodeContext.
- DecodeSessionImpl + EncodeSessionImpl — full Section 5 contract.
- AsyncEventStream — push-driven AsyncIterable for frames()/chunks().
- Routes through jxl-scheduler; worker packages loaded via dynamic import.
- tsc clean.
- End-to-end decode/encode blocked on Codex codec tasks (see BLOCKED.md).

### T-TEST (unit half)
- Test suite: 33 unit tests (event-stream, JxlError, decode-session,
  encode-session) — all pass on the node:test runner.
- 10 integration tests scaffolded as skipped, pending the real codec.
- Fix: done() promise now has a no-op catch so callers using only
  frames()/chunks() never trigger an unhandledRejection.
