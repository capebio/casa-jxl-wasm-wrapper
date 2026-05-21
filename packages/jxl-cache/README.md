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
