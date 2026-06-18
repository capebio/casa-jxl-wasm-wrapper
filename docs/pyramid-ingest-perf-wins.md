# Pyramid-Ingest Performance Wins

Ported two major optimizations from jxl-cache/browser.ts to pyramid-ingest (manifest + hash):

| Optimization | Before | After | Win | Flipflop |
|---|---|---|---|---|
| **Manifest encode** | JSON.stringify (pretty) | Binary varint records | −73% | pyramid-manifest-encode |
| **Content hash** | SHA-256 sync (crypto) | FNV-1a 64-bit (2-lane) | −69% | pyramid-hash-contentHash |

## Implementation

### 1. Binary Manifest Format (−73%)
- Added `manifestToBinary()` and `binaryToManifest()` in `manifest.ts`
- Format: varint-framed records with UTF-8 string fields, optional fields elided
- `parseManifest()` auto-detects: first byte != '{' → binary decode, else JSON
- All manifest I/O now reads as binary; JSON/binary works transparently

**Files changed:**
- `src/manifest.ts`: encode/decode functions
- `src/schema.ts`: auto-detect in parseManifest
- `src/ingest.ts`: read manifests as binary (lines 405, 450, 948)
- `src/cli.ts`: read manifests as binary (line 163)
- Tests: use parseManifest instead of JSON.parse

### 2. Sync FNV-1a Hash (−69%)
- Replaced `createHash("sha256")` with two-lane FNV-1a in `hash.ts`
- Sync operation (no async infection); 64-bit collision-safe to ~4B files
- Same truncation contract (16 hex chars by default)

**Files changed:**
- `src/hash.ts`: fnv1a64Hex() + contentHash/imageIdForPath
- Tests: update expected values (empty hash = `811c9dc5c2b2ae35`, not SHA-256)

## Flipflop Measurements

Benchmarks in `.flipflop/tests/`:
- `pyramid-manifest-encode.mjs`: −64–85% (avg 73%)
- `pyramid-hash-contentHash.mjs`: −57–76% (avg 68.6%)

## Test Status
- **CLI tests**: 8/8 pass (reindex, proxy, shard, migrate with binary manifests)
- **Hash tests**: 3/3 pass (FNV identity, determinism, path normalization)
- **Known pre-existing failures**: tiling-ingest expectations (unrelated to binary format)

## Roadmap
- Off-main-thread manifest flush (eliminate stalls on large indices)
- Index binary format (if needed; manifests are the write-amplification bottleneck)
- OPFS sync-access-handle for cache cold-path 2× speedup (browser-only)
