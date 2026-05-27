# @casabio/jxl-session

The session facade for the Casabio JXL wrapper. This is the **only** module callers import to drive codec work, and the only module that talks to `jxl-worker-*` (spec Section 4.2).

## Entry points

```ts
import { createBrowserContext, createNodeContext } from "@casabio/jxl-session";

const ctx = createBrowserContext({ poolSize: 3 });

// Decode
const dec = ctx.decode({ format: "rgba8", progressionTarget: "final" });
await dec.push(bytes);
await dec.close();
for await (const frame of dec.frames()) {
  // frame.stage: "dc" | "pass" | "final", frame.pixels: ArrayBuffer
}
const info = await dec.done();

// Encode
const enc = ctx.encode({ format: "rgba16", width, height, hasAlpha: false, chunked: true });
await enc.pushPixels(pixelBuffer);
await enc.finish();
for await (const chunk of enc.chunks()) { /* upload chunk */ }
const totalBytes = await enc.done();

await ctx.shutdown();
```

## Architecture

```
caller → JxlContext → DecodeSessionImpl/EncodeSessionImpl → Scheduler → worker
```

- `JxlContext` owns a `Scheduler` (jxl-scheduler).
- Each `decode()`/`encode()` mints a session, registers a worker-message handler, and calls `scheduler.acquireSlot()`.
- `frames()` / `chunks()` are push-driven `AsyncIterable`s (`AsyncEventStream`).
- Backpressure on `push`/`pushPixels` flows through `scheduler.waitForDrain()`.
- Worker packages are loaded via dynamic `import()` so a browser bundle never pulls `node:worker_threads`.

## Status

Structurally complete and typechecks clean. **End-to-end decode/encode is blocked** until the WASM/native codec tasks (T-DECODE-WASM, T-ENCODE-WASM, T-DECODE-NATIVE, T-ENCODE-NATIVE) land — the worker handlers are currently stubs. See `BLOCKED.md`.

See `DECISIONS.md` for non-obvious choices.
