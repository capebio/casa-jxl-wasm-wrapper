# Blocked

## 2026-05-21

- Source and prebuild compilation are blocked in this workspace because the native toolchain is not installed and libjxl headers are not present.
- Exact npm version pinning for `prebuildify` and helper packages was not resolved because registry lookups failed in this workspace.
- Git commit creation is blocked because this workspace refuses writes to `.git/index.lock`.
