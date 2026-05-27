# Blocked

## 2026-05-21

- Source and prebuild compilation require a native toolchain plus libjxl headers/libs. The addon now has a libjxl-backed implementation path, but this workspace still does not expose a confirmed host libjxl install.
- Git commit creation is blocked because this workspace refuses writes to `.git/index.lock`.
- `createDecoder` / `createEncoder` report `CapabilityMissing` when the built addon probes as unavailable.
- Native metadata boxes, region decode, chunked encode, and full progressive pass fidelity remain follow-up work.
