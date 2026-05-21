# Browser-Only Raw libjxl Wrapper for Progressive JXL

**Date:** 2026-05-21  
**Status:** Approved

---

## Goal

Build a browser-only JPEG XL wrapper around raw libjxl compiled to WebAssembly. The wrapper must support:

- real progressive decode
- real streaming encode
- stateful session management across partial input and output
- maximum practical speed for:
  - large images over slow internet
  - many thumbnails on slow internet

This is a browser path only. No server dependency. No native fallback in the primary flow.

## Non-Goals

- Do not keep the current one-shot `decode(input) -> output` API as the primary abstraction.
- Do not depend on `@jsquash/jxl` for the progressive path.
- Do not add UI features unrelated to JXL transport or codec throughput.
- Do not optimize for animated JXL in this phase.

## Constraints

- Must run in the browser.
- Must fit the existing worker-based architecture in `web/`.
- Must preserve the main-thread UI responsiveness.
- Must handle partial network delivery.
- Must work for both viewer-first and thumbnail-first usage.
- Must fail cleanly on malformed codestreams, OOM, and worker aborts.
- Must avoid unnecessary pixel copies.

## Core Decision

Use a raw libjxl WASM wrapper, not a stateless JS codec helper.

Reason:

- libjxl exposes decoder progression events and flush points.
- libjxl exposes encoder streaming output and chunked input.
- the wrapper needs to own state across messages.
- the product goal is not simply "decode JXL"; it is "show useful pixels early and keep refining them".

## Sources

- libjxl decoder API: [libjxl.readthedocs.io/en/latest/api_decoder.html](https://libjxl.readthedocs.io/en/latest/api_decoder.html)
- libjxl encoder API: [libjxl.readthedocs.io/en/latest/api_encoder.html](https://libjxl.readthedocs.io/en/latest/api_encoder.html)
- libjxl README: [github.com/libjxl/libjxl](https://github.com/libjxl/libjxl)
- browser WASM codec wrapper reference: [github.com/Kaciras/icodec](https://github.com/Kaciras/icodec)

## Architecture

### Modules

| Module | Responsibility |
|---|---|
| `jxl-core.wasm` | Raw libjxl compiled to WASM, with minimal glue for decode and encode APIs |
| `jxl-worker.js` | Owns live decoder and encoder sessions, feeds chunks, flushes output, transfers buffers |
| `jxl-session.js` | Browser-side session facade, IDs, callbacks, cancellation, and error normalization |
| `jxl-stream.js` | Wraps `ReadableStream`, `fetch()`, and Blob sources into chunk pushes |
| `jxl-policy.js` | Chooses decode/encode policy based on use case: viewer, gallery, thumbnail, export |

### Layering Rules

- main thread never calls libjxl directly
- worker owns codec state
- session objects are one image in, one image out
- decode and encode sessions are separate types
- pixel buffers should be transferred, not copied, wherever possible

## Decode Design

### Session Model

Each decode request creates a session with:

- `sessionId`
- input source descriptor
- byte offset
- cancel flag
- progressive target
- current dimensions
- last emitted preview frame
- final-frame completion flag

The session stays alive until:

- final image is emitted
- the caller cancels
- the stream ends with a fatal error

### Decode Flow

1. Main thread starts a decode session for a `File`, `Blob`, or network stream.
2. `jxl-stream.js` pushes bytes into `jxl-worker.js`.
3. Worker creates and owns a libjxl decoder instance.
4. Worker subscribes to decode events and sets progressive detail.
5. On `JXL_DEC_FRAME_PROGRESSION`, worker calls `JxlDecoderFlushImage()`.
6. Worker posts the flushed RGBA frame back immediately.
7. Worker continues ingesting bytes and repeats until final image or cancel.

### Decode Policy

Use different progressive targets by context:

- thumbnail list
  - stop after the first useful low-detail frame unless promoted
  - prioritize visible items
- lightbox viewer
  - emit DC preview immediately
  - continue toward finer detail while visible
- full-screen export preview
  - keep decoding until final output

### Progressive Detail Strategy

Default baseline:

- request `kDC` as the guaranteed first useful stage

Enhancements:

- request finer progressive detail only when the browser and file justify it
- do not assume every file will provide many progression events
- treat `kLastPasses` and `kPasses` as optional quality improvements, not hard requirements

This is an inference from the current libjxl docs and implementation notes, not a promise of every future codestream.

## Encode Design

### Session Model

Each encode request creates a session with:

- `sessionId`
- input pixel source
- output policy
- quality / effort / progressive settings
- transfer buffer queue
- final close flag
- abort flag

### Encode Flow

1. Main thread hands RGBA pixels or `ImageData` to the worker.
2. Worker configures frame settings from quality and effort.
3. Worker sets progressive options based on policy.
4. For regular jobs, worker uses `JxlEncoderAddImageFrame()`.
5. For large jobs, worker uses `JxlEncoderAddChunkedFrame()` to reduce peak memory and support streaming pixel input.
6. Worker pumps output via `JxlEncoderProcessOutput()` or `JxlEncoderSetOutputProcessor()`.
7. Worker emits byte chunks as soon as they are available.

### Encode Policy

- thumbnail encode
  - fast effort
  - progressive DC on
  - progressive AC off unless needed
- viewer encode
  - balanced effort
  - progressive DC on
  - progressive AC on for large images if bytes and quality justify it
- archival encode
  - higher effort
  - progressive options enabled only when they materially help user experience

### Quality Mapping

Map UI quality values through `JxlEncoderDistanceFromQuality()` rather than inventing a separate scale.

## Browser Performance Plan

### Threading

Primary target:

- SIMD-enabled WASM
- worker isolation
- multiple workers for parallel gallery work if the browser can support it

Fallback target:

- single-thread WASM
- same API, lower throughput

### Priority Rules

- visible lightbox image always outranks background thumbnails
- thumbnails outrank offscreen prefetch work
- cancellation beats completion for no-longer-visible items

### Memory Rules

- transfer encoded byte chunks instead of copying them
- avoid holding decoded full-size RGBA longer than needed
- cache only the representations the UI actually reuses
- isolate per-session temp state so a failed image cannot poison future work

## Message Protocol

### Decode Messages

Main to worker:

```json
{ "type": "decode_start", "sessionId": "123", "source": "...", "detail": "dc" }
{ "type": "decode_push", "sessionId": "123", "chunk": "[ArrayBuffer]" }
{ "type": "decode_close", "sessionId": "123" }
{ "type": "decode_cancel", "sessionId": "123" }
```

Worker to main:

```json
{ "type": "decode_progress", "sessionId": "123", "stage": "dc", "rgba": "[ArrayBuffer]", "w": 5184, "h": 3888 }
{ "type": "decode_progress", "sessionId": "123", "stage": "refine", "rgba": "[ArrayBuffer]", "w": 5184, "h": 3888 }
{ "type": "decode_final", "sessionId": "123", "rgba": "[ArrayBuffer]", "w": 5184, "h": 3888 }
{ "type": "decode_error", "sessionId": "123", "error": "..." }
{ "type": "decode_cancelled", "sessionId": "123" }
```

### Encode Messages

Main to worker:

```json
{ "type": "encode_start", "sessionId": "abc", "quality": 92, "effort": 4, "progressive": true }
{ "type": "encode_push_pixels", "sessionId": "abc", "pixels": "[ArrayBuffer]" }
{ "type": "encode_finish", "sessionId": "abc" }
{ "type": "encode_cancel", "sessionId": "abc" }
```

Worker to main:

```json
{ "type": "encode_chunk", "sessionId": "abc", "bytes": "[ArrayBuffer]" }
{ "type": "encode_done", "sessionId": "abc", "bytesWritten": 123456 }
{ "type": "encode_error", "sessionId": "abc", "error": "..." }
{ "type": "encode_cancelled", "sessionId": "abc" }
```

## Integration With Current Repo

The current browser code already has a JXL worker boundary in `web/jxl-worker.js` and a queue/callback layer in `web/main.js`.

This spec replaces the current one-shot decode behavior with a session-oriented codec wrapper while preserving the worker architecture.

Expected integration points:

- `web/jxl-worker.js`
  - replace one-shot decode logic with session-aware decode and encode handlers
- `web/main.js`
  - route viewer and thumbnail requests through the new session API
  - maintain per-URL dedupe and priority routing
- `web/icodec-jxl-options.js`
  - keep as a policy helper only if still useful
  - progressive settings must map cleanly to the raw wrapper

## Error Handling

- malformed codestream
  - fail the session immediately
- truncated stream
  - keep partial frames if possible until input ends
  - only fail hard when no further progress is possible
- worker abort or libjxl OOM
  - destroy the session
  - create a fresh worker if needed
  - never reuse poisoned codec state
- unsupported browser features
  - fail fast with a clear capability error

## Caching and Reuse

- cache decode results by source URL and codestream identity when practical
- cache final thumbnails more aggressively than full-size frames
- do not cache transient progressive states beyond the current visible session unless there is a clear reuse path
- reuse workers, not decoder instances

## Testing

### Unit Tests

- session creation and teardown
- chunk push ordering
- cancel during decode and encode
- error normalization
- cache keying and dedupe

### Integration Tests

- decode a truncated JXL stream and verify early frames appear
- decode a large JXL with progressive refinement
- encode a large RGBA buffer and verify bytes are emitted before completion
- verify thumbnail queue stays responsive while a visible image is decoding

### Performance Checks

- time to first visible pixel
- time to thumbnail placeholder
- time to final decode
- time to first output byte on encode
- throughput under concurrent thumbnail load

## Success Criteria

- first visible pixels appear before the full file arrives
- thumbnails become usable quickly on slow connections
- large images visibly refine during download
- encode can stream bytes out before the full input pipeline is done
- worker isolation keeps one bad file from breaking later files
- the browser UI remains responsive under many concurrent thumbnail requests

## Rollout Plan

1. Add the session-based worker protocol.
2. Replace one-shot decode with raw libjxl progressive decode.
3. Add streaming encode.
4. Wire viewer and thumbnail callers to the new wrapper.
5. Add chunked-stream and cancellation tests.
6. Benchmark and tune decode priorities.

## Decision Record

Chosen architecture:

- raw libjxl WASM wrapper
- session-based decode and encode
- worker-managed state
- progressive decode and streaming encode as first-class features

Rejected alternatives:

- keep the current one-shot JS codec helper
  - too limited for real progressive behavior
- simulate progressive behavior by truncating or re-decoding prefixes
  - wastes CPU and does not expose true codec-native progression

