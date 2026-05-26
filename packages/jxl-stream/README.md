# @casabio/jxl-stream

Stream adapters for the Casabio JXL wrapper.

## Browser Usage

```ts
import { fromReadableStream, toReadableStream } from '@casabio/jxl-stream';

// Decode from fetch
const response = await fetch('image.jxl');
await fromReadableStream(response.body!, session);

// Encode to stream
const stream = toReadableStream(encodeSession);
```

## Node.js Usage

```ts
import { fromNodeReadable, toNodeReadable } from '@casabio/jxl-stream';
import { createReadStream } from 'node:fs';

// Decode from file
const readable = createReadStream('image.jxl');
await fromNodeReadable(readable, session);

// Encode to readable
const stream = toNodeReadable(encodeSession);
```

## Range-Prefix Fetch

For sidecar-ladder and progressive-truncation workflows where only the first N bytes
of a remote JXL are needed (e.g. fetching just the smallest embedded sidecar, or a
DC-frame prefix of a `cjxl -p` encoded image):

```ts
import { fromRangePrefix } from '@casabio/jxl-stream';

// Fetch first 150 KB of remote JXL, pipe into a decode session.
await fromRangePrefix('https://cdn.example/species-42.jxl', 150_000, session, {
  onRangeNegotiated: (info) => {
    if (!info.honored) console.warn('Server ignored Range header, full file downloaded');
  },
});
```

Behaviour:
- Sends `Range: bytes=0-{byteCount-1}`.
- **206 Partial Content**: pipes body up to `byteCount` (cancels reader if server over-reads).
- **200 OK** (server ignored Range): caps delivery at `byteCount`, still works (bandwidth wasted on the wire only); detect via `onRangeNegotiated`.
- **416 Range Not Satisfiable**: throws `RangeError`.
- Resource shorter than `byteCount`: pipes everything available, returns cleanly.

**CORS**: `Range` is a non-simple header — server must respond with
`Access-Control-Allow-Headers: Range` (and ideally
`Access-Control-Expose-Headers: Content-Range, Accept-Ranges`) for cross-origin use.

**Truncation**: if the byte prefix slices mid-codestream, the decode may surface as
an error with `partialPixels` attached. Aligning prefixes to JXL sidecar boundaries
(known at encode time) avoids this entirely.

## Helpers

`BufferedReader` is provided for manual byte-range management.
