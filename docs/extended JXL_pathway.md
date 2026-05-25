# Extended CasaWASM JXL & RAW Conversion Pipeline Pathway

This extended document expands the original `JXL_pathway.md` with build notes, troubleshooting guidance, test targets, and practical next steps for working with the `web/pkg` WASM artifacts and the worker decode/encode handlers.

## Quick summary

- Canonical runtime path: RAW ingestion -> debayer/demosaic (Rust `raw_pipeline`) -> pixel buffer -> JXL encoder (WASM/native `libjxl`) or direct rendering.
- For decoding, the browser-side pipeline uses streamed ingestion, a scheduler/pool, and worker sessions that feed chunks into WASM via a C++ bridge.
- Rebuilding the WASM that links `libjxl` requires a full wasm toolchain (clang/LLVM with a wasm linker) — missing wasm-ld is a common failure.

## File map (high-value files)

- Entry points and WASM FFI:
  - [src/lib.rs](src/lib.rs) — exported functions: `process_orf`, `process_dng`.
- Streaming & scheduler:
  - [packages/jxl-stream/src/browser.ts](packages/jxl-stream/src/browser.ts)
  - [packages/jxl-scheduler/src/scheduler.ts](packages/jxl-scheduler/src/scheduler.ts)
  - [packages/jxl-scheduler/src/pool.ts](packages/jxl-scheduler/src/pool.ts)
- Worker & session handling:
  - [packages/jxl-worker-browser/src/worker.ts](packages/jxl-worker-browser/src/worker.ts)
  - [packages/jxl-worker-browser/src/decode-handler.ts](packages/jxl-worker-browser/src/decode-handler.ts)
  - [packages/jxl-worker-browser/src/encode-handler.ts](packages/jxl-worker-browser/src/encode-handler.ts)
- WASM facade & bridge:
  - [packages/jxl-wasm/src/facade.ts](packages/jxl-wasm/src/facade.ts)
  - [packages/jxl-wasm/src/bridge.cpp](packages/jxl-wasm/src/bridge.cpp)
  - `web/pkg/` — shipped wasm-bindgen output (JS glue + `.wasm` + `.d.ts`). Prefer using shipped `web/pkg` when possible.

## Architectural Context

For a deeper dive into how these components interact and their optimization levels, see:
- [docs/jxl-jigsaw.md](jxl-jigsaw.md) — Comprehensive architectural map and data flow.
- [docs/file-optimization-assessment.md](file-optimization-assessment.md) — Detailed optimization scores and technical rationale for key files.

## Build & Docker notes (practical troubleshooting)

- Problem: building `raw_converter_wasm` that links `libjxl` fails if the container/system lacks a wasm-targeted LLVM toolchain; errors cite missing `wasm-ld-<version>` or CMake linking failures.
- Strategies:
  1. Use a builder image that contains LLVM/clang/wasm-ld (e.g., images that include `lld` or use Emscripten). This increases image size but resolves native linking.
  2. Use `emscripten` toolchain (if the build can be adapted) so C/C++ compile/link works to `asmjs/wasm` with emsdk.
  3. Build `web/pkg` on a machine with a full toolchain and copy artifacts into the repo (fast, avoids CI complexity).
  4. If only JS-level helpers (like `downscale_rgb` or `rgb_to_rgba`) are needed, prefer the shipped `web/pkg` to avoid rebuilds entirely.

### Minimal Docker recipe hints

- Ensure the container installs `clang`, `cmake`, `pkg-config`, `build-essential`, and an LLVM toolchain that provides `wasm-ld` (or install `lld`). Example apt packages: `clang`, `lld`, `cmake`, `build-essential`, `pkg-config`.
- Add `rustup target add wasm32-unknown-unknown` and ensure `wasm-bindgen-cli` is installed in the container's PATH before running `wasm-bindgen` on the produced `.wasm`.

## WASM artifact guidance

- Use zero-copy patterns when possible: allocate a WASM heap buffer large enough and write directly from JS (or use BYOB readers) to avoid intermediate `Uint8Array` allocations.
- If COOP/COEP headers can be set, `SharedArrayBuffer` enables zero-copy pixel sharing across worker boundaries.
- If you need a new WASM export (e.g., `downscale_rgba`) prefer to add a small Rust shim that calls existing pipeline functions and rebuild the crate; otherwise, implement JS-level composition by chaining `downscale_rgb` + `rgb_to_rgba`.

## Tests & verification checklist (decode/worker focused)

Add tests that mock a `BrowserDecoder` and the worker `postMessage` interface to verify these behaviors:

- Cancellation scenarios:
  - Cancel while paused (no active push) → decoder disposed, event iterator unblocked, `decode_cancelled` posted.
  - Cancel while waiting for input (blocked on `events()` iterator) → decoder disposed and iterator completes.
  - Cancel during active `push()` (simulate long `push`) → `disposeActiveDecoder()` called and session terminates safely.
- Budget behavior:
  - Budget exceeded before any progress → `postBudgetExceeded()` invoked and decoder cleaned up.
  - Budget check nullish-safe behavior (`opts.budgetMs == null`) should not crash when `budgetMs` absent.
- Backpressure / drain coalescing:
  - Stream many small chunks; assert `worker_drain` messages are coalesced (not emitted per-chunk) and queued bytes stay below `BYTE_DRAIN_HWM`.
  - Verify `DRAIN_MIN_INTERVAL_MS` prevents spamming drain messages during bursts.

For unit tests, create a small harness under `packages/jxl-worker-browser/test/` that stubs `BrowserDecoder` with an async generator for `events()` and an async `push()` which can be delayed artificially.

## Practical next steps (recommended)

1. Add the tests above to `packages/jxl-worker-browser/test/` and run the package `typecheck`/`build` first (`npm run build`) to ensure TypeScript types align.
2. If you need new WASM exports, prefer building on a machine/container that includes `lld/wasm-ld` and `cmake`. If network or toolchain constraints persist, build once elsewhere and copy `web/pkg` into the repo.
3. Add a small `docs/BUILD_WASM.md` if you expect other contributors to rebuild WASM — record the exact Docker image, apt packages, and rustup toolchain used so builds are reproducible.

---

If you'd like, I can now:

- add the test harness and example unit tests for `decode-handler.ts`, or
- create a `docs/BUILD_WASM.md` describing a reproducible Docker image for building `web/pkg`, or
- mark this extended document into the repo navigation (README link).

Tell me which next step you prefer and I'll implement it.
