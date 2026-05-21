# Blocked

## 2026-05-21

- Local execution of the WASM build pipeline is blocked in this workspace because `emcc` is not installed and `docker` is not available.
- The PGO path is blocked until `jxl-test-corpus/pgo-manifest.json` is merged from the Gemini branch.
- Git commit creation is blocked because this workspace refuses writes to `.git/index.lock`.
- `createDecoder` / `createEncoder` are exported, but they intentionally report `CapabilityMissing` until T-WASM-BUILD installs generated libjxl JS/WASM glue behind the facade.
