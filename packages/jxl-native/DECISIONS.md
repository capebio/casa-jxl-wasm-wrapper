# Decisions

## 2026-05-21

- Used plain N-API in the addon stub so the package does not depend on node-addon-api yet.
- Kept the loader strict: prebuilt binary first, source build second, clean `CapabilityMissing` failure last.
- Pinned the same libjxl commit as `jxl-wasm` to keep the server and browser build paths aligned.
- Deferred exact npm package version pins for `prebuildify` and any helper packages because registry lookups were not reliable in this workspace.
- Aligned the published package name with the rest of the monorepo: `@casabio/jxl-native`.
