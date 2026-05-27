# Decisions - jxl-stream

- **Type Reference**: Since `jxl-core` might not be fully built, I will re-declare or assume the interfaces from Section 5 in my implementation where needed for compilation, or just use `any` if it's too complex to re-declare everything, but I'll try to be precise.

- **`fromRangePrefix` lives in the stream layer (not session/policy).** Stream is byte transport; mapping target-resolution → byte offset is a caller / policy concern (sidecar offset table). Keeps stream package free of JXL bitstream knowledge.

- **Optimistic Range, 200-fallback.** No `HEAD` / `Accept-Ranges` probe — adds latency and an extra round-trip. Sending `Range: bytes=0-N-1` directly handles both compliant servers (206) and non-compliant ones (200 with full body, sliced locally). Caller can detect ignored Range via `onRangeNegotiated({ honored: false })`.

- **No artificial cap on `byteCount`.** Library validates `> 0` and finite; oversized requests degrade gracefully (server returns 200 or short 206). Sizing is the caller's concern.

- **Truncated-EOF tolerance is a session/worker concern, not stream.** `fromRangePrefix` always calls `session.close()` after delivering its bytes. If the prefix slices mid-codestream, decoding may surface as an error with `partialPixels` attached (existing channel in `decode-handler.ts`). Aligning prefixes to JXL sidecar boundaries avoids the issue entirely. A future `DecodeOptions.allowTruncated` flag will graduate the partial-pixel path to a first-class final-frame event.

- **CORS Range preflight is a deployment concern.** Documented in jsdoc; not enforced or probed by the library. Servers must allow `Range` request header and (optionally) expose `Content-Range` / `Accept-Ranges`.
