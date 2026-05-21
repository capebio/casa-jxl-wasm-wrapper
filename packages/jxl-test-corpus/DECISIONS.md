# Decisions - jxl-test-corpus

- **Unified Loader**: Decided to design the loader to return a `Uint8Array` for the bytes, making it platform-agnostic once the bytes are loaded.
- **Fixture Storage**: Fixtures will be stored in `src/fixtures` and included in the build.
