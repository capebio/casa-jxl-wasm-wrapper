# jxl-session — BLOCKED.md

## B-001 Dedupe disabled — no source identity in DecodeOptions/EncodeOptions

The session facade passes `sourceKey: null` to the scheduler, so dedupe/fan-out (Section 12.4) is unreachable. To enable: add a `sourceKey?: string` to `DecodeOptions` (jxl-core) carrying a URL hash or content hash, or expose a context method that accepts one. The T-INT web layer has the source URL/bytes and should drive this. See DECISIONS.md D-003.

## B-002 End-to-end decode/encode blocked on codec tasks

jxl-session is structurally complete and typechecks, but real decode/encode cannot run until:
- T-DECODE-WASM / T-ENCODE-WASM fill in `jxl-worker-browser` codec handlers (currently stubs)
- T-DECODE-NATIVE / T-ENCODE-NATIVE fill in `jxl-worker-node` handlers
- T-WASM-BUILD produces a real `jxl-wasm` artifact (no `dist/` today)
- T-NATIVE-BIND produces `jxl-native` prebuilds

All are Codex tasks not yet done — Codex's branch landed scaffolds only (see `packages/jxl-wasm/STATE.md`).

## B-003 Cache not wired into the decode/encode flow

`ContextOptions.cache` is accepted but the facade does not consult `jxl-cache`. Cache keys (Section 14.2) are `sha256(sourceBytes) + outputDescriptor` — the facade does not have source bytes as a single hashable unit (bytes arrive as a stream of `push()` chunks). Cache lookup belongs in the T-INT web layer, which holds the source URL/Blob and can hash it before deciding whether to decode at all.
