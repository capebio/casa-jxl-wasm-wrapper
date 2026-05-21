# @casabio/jxl-core — Changelog

## v0.1.0 (2026-05-21)

- Initial release.
- `src/types.ts`: Full public API surface per spec Section 5.
- `src/errors.ts`: `JxlError` and `JxlErrorCode` per spec Section 18.
- `src/protocol.ts`: Worker message protocol per spec Section 16.
- `src/schemas/`: JSON Schemas for `decode_start`, `encode_start`, `decode_header`, `worker_ready`.
- T-CORE complete. Ready for other packages to depend on.
