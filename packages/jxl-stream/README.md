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

## Helpers

`BufferedReader` is provided for manual byte-range management.
