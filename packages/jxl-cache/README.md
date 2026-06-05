# @casabio/jxl-cache

Caching layer for the Casabio JXL wrapper.

## Features

- **Two-layer caching**: Hot in-memory LRU and persistent storage.
- **Platform-aware**: OPFS in browsers, filesystem in Node.js.
- **Quota-aware**: Handles browser storage limits with automatic eviction.

## Usage

```ts
import { createJxlCache } from '@casabio/jxl-cache';

const cache = createJxlCache({
  memoryLimit: 128 * 1024 * 1024, // 128 MiB
  persistentLimit: 1024 * 1024 * 1024, // 1 GiB
  persistent: true,
  basePath: './cache' // Node.js only
});

await cache.init();

// Set
await cache.set('my-key', buffer);

// Get
const buffer = await cache.get('my-key');

// Stats
console.log(cache.stats());
```

## Key conventions

Callers SHOULD use these prefixes/suffixes to avoid collisions:

- `${sourceHash}` — the full-resolution encoded JXL.
- `${sourceHash}:thumb` — a 320 px long-edge sidecar thumbnail JXL (produced via separate encode or first chunk of a sidecarSizes encode), if available.
- `${sourceHash}:dc-prefix-${kb}kb` — a byte-truncated DC-only prefix (Chapter 2 of investigations).

The cache itself is content-agnostic and does not enforce these — it is purely a convention for cross-page reuse.
