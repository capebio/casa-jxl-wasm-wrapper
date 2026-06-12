# HANDOFF — jxl-worker-node 22-Lens Review
**Files:** `packages/jxl-worker-node/src/worker.ts`, `decode-handler.ts`, `encode-handler.ts`, `backend-selector.ts`, `spawn.ts`, `index.ts`
**Date:** 2026-06-12. Six agent sessions, one file each. Findings amalgamated across all lenses; duplicates merged.

## Strategic map (Lens 1/7/22)

```
host process
  index.ts ──→ spawn.ts ──(worker_threads postMessage, transfer)──→ worker.ts
                                                                       ├─ backend-selector.ts → @casabio/jxl-native | @casabio/jxl-wasm
                                                                       ├─ decode-handler.ts  (chunks in → pixels out, drain/budget/pause)
                                                                       └─ encode-handler.ts  (pixels in → JXL chunks out, sidecar offsets)
```

Data crossing the worker boundary: `decode_chunk` Buffers in, pixel ArrayBuffers out (transferred when wholly owned), `encode_pixels` in, `encode_chunk` out (currently **cloned**, see E-2). Cold-start messages buffer in worker.ts maps until backend init resolves. The connective tissue is sessionId string keys across seven Maps/Sets in worker.ts — most of the bugs below are lifecycle races on those keys.

Severity: P0 = correctness/data-loss now, P1 = real bug or contract violation under realistic timing, P2 = perf/observability win, P3 = hygiene/feature.

---

## Agent 1 — `worker.ts`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article. 

### W-1 (P0) `releaseSessionState` poisons future sessions and leaks memory
`releaseSessionState` (line ~413) does `cancelledPendingStarts.add(sessionId)` **unconditionally**, even when no pending start exists (the common case: releasing a completed/active session). The set entry is only ever consumed by an in-flight start promise. Consequences:
1. **Unbounded leak** — one stale string per released session, forever (only cleared on shutdown).
2. **Silent session kill on sessionId reuse** — a later `decode_start`/`encode_start` reusing that id passes `hasAnySession`, runs backend init, then hits `cancelledPendingStarts.delete(id) === true` → returns without creating a handler and without posting any error. Host waits forever.

Fix — only arm the guard when a pending start actually exists:
```ts
async function releaseSessionState(sessionId: string): Promise<void> {
  if (pendingDecodeStarts.has(sessionId) || pendingEncodeStarts.has(sessionId)) {
    cancelledPendingStarts.add(sessionId);
  }
  pendingDecodeStarts.delete(sessionId);
  // ... rest unchanged
}
```
Verify against the scheduler (`packages/jxl-scheduler/src/scheduler.ts`) whether sessionIds can recur; even if they currently don't, the leak alone justifies the fix. Add a test: release_state on active session → same sessionId decode_start succeeds.

### W-2 (P1) Stale start-promise clobbers a successor session (generation race)
Window: `failPendingDecode` (queue overflow) or `releaseSessionState` deletes the pending entry while the original start promise is still awaiting `initBackend()`. A **new** start with the same sessionId then registers its own pending entry and begins queueing chunks. When the *old* promise resolves it executes `pendingDecodeStarts.delete(msg.sessionId)` (deleting the **new** session's entry) and, on the cancelled path, `clearQueuedDecode(msg.sessionId)` (wiping the **new** session's queued chunks). Result: silent chunk loss / dropped messages for the successor (messages routed after the delete find neither handler nor pending entry and are discarded by `routeDecodeMessage`).

Fix — identity-guard all map mutations inside the start promise. The closure can reference its own promise because the first `await` guarantees the continuation runs after `pendingDecodeStarts.set`:
```ts
const startPromise: Promise<void> = (async () => {
  let b: Backend;
  try { b = await initBackend(); }
  catch (err) {
    if (pendingDecodeStarts.get(msg.sessionId) === startPromise) {
      pendingDecodeStarts.delete(msg.sessionId);
      clearQueuedDecode(msg.sessionId);
      if (!cancelledPendingStarts.delete(msg.sessionId)) {
        safePostMessage({ type: "decode_error", sessionId: msg.sessionId,
          code: "CapabilityMissing", message: `Backend init failed: ${formatError(err)}` });
      }
    }
    return;
  }
  if (pendingDecodeStarts.get(msg.sessionId) !== startPromise) return; // superseded
  pendingDecodeStarts.delete(msg.sessionId);
  if (shuttingDown || cancelledPendingStarts.delete(msg.sessionId)) {
    clearQueuedDecode(msg.sessionId);
    return;
  }
  // ... create handler, flush queue (unchanged)
})();
pendingDecodeStarts.set(msg.sessionId, startPromise);
```
Apply identically to `handleEncodeStart`. Note `cleanupFailedBackendStart` becomes inline/removable. Add test: overflow-fail a pending start, immediately restart same id, assert second session receives all chunks.

### W-3 (P2) `failPendingDecode`/`failPendingEncode` bypass `safePostMessage`
Lines ~150/157 use `port.postMessage` directly; during late shutdown a closed port throws and the exception propagates into `queueDecodeMessage` → message handler. Use `safePostMessage`.

### W-4 (P2) Error reports drop stacks; worker stays alive after `uncaughtException`
`worker_error` posts `err.message` only — use existing `formatError(err)` to include the stack. Separately, after an `uncaughtException` the worker keeps accepting sessions in unknown state. Recommend: post `worker_error`, then initiate `handleShutdown()` (graceful cancel of live sessions, ack, force-exit timer already exists). Check host-side pool expectations first (jxl-scheduler pool recycling).

### W-5 (P3, perf — Lens 19 fast path) Mono-session route memo
`routeDecodeMessage` runs `Map.get` per chunk. Workers overwhelmingly serve one session at a time. Optional micro-opt: cache `{id, handler}` of last route, invalidate in `onSessionEnd`/release. Only do this if profiling shows Map.get in the chunk path matters (it likely does not — fine to reject with a one-liner).

### W-6 (P3) `worker_ready` can over-promise
If backend init fails at startup, `worker_ready` still reports `backend: "wasm"`. Consider a `degraded?: true` field so the pool can prefer other workers — **protocol change**, coordinate via end-of-session request, do not change `MsgWorkerReady` unilaterally.

---

## Agent 2 — `decode-handler.ts`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article. 

### D-1 (P1) Pause is not honoured while the drain loop is hot — preemption ack is a lie
`onPause` posts the `decode_paused` ack immediately and `wake()`s — but the inner drain loop (`feedDecoder`, line ~297) checks only `!this.isTerminal()`, **not** `this.paused`. If the scheduler pauses a session with a deep queue, the worker keeps pushing every queued chunk through WASM (each push synchronous, potentially heavy) after acking "paused". This violates the scheduler's preemption contract (CLAUDE.md: pause → ack → resume; hard cancel is "soft *between chunks*" — pause must be too). Worse, if `inputClosed` is set, the post-loop close check runs **while paused** and completes the decode during pause.

Fix (both gates):
```ts
while (!this.isTerminal() && !this.paused && this.chunkQueue.length > this.chunkReadIndex) {
  // ... existing body
}
if (this.inputClosed && !this.isTerminal() && !this.paused) {
  await decoder.close();
  return;
}
```
The outer loop's `if (this.paused) { await this.waitForResume(); continue; }` then parks correctly. Compare with `packages/jxl-worker-browser/src/decode-handler.ts` — mirror whichever ordering it uses (the file claims exact parity; if the browser handler has the same hole, request approval to fix it there at the end). Optionally consider deferring the `decode_paused` ack until the loop actually parks (more honest, more plumbing) — only if the scheduler relies on ack-means-stopped; check `scheduler.ts` preemption logic before choosing.

### D-2 (P1, perf hazard) Non-owning pixel views structured-clone the ENTIRE backing buffer
`postWithPixels` (line ~435): when `pixels` is a view (`byteOffset !== 0` or shorter than its ArrayBuffer), it falls back to plain `postMessage` with no transfer. Structured clone of a TypedArray/Buffer view serializes its **whole underlying ArrayBuffer**. A native binding returning views into a large arena (or Node's shared 8 KiB Buffer pool at small sizes) would copy the entire arena per progress event — silent multi-MB amplification. Fix: slice to exact bytes and transfer (one bounded copy, always ≤ clone cost):
```ts
private postWithPixels(msg: { pixels: ArrayBuffer }, pixels: Buffer): void {
  const ab = pixels.buffer;
  if (pixels.byteOffset === 0 && pixels.byteLength === ab.byteLength) {
    this.port.postMessage(msg, [ab]);
    return;
  }
  const exact = ab.slice(pixels.byteOffset, pixels.byteOffset + pixels.byteLength);
  msg.pixels = exact;
  this.port.postMessage(msg, [exact]);
}
```
(Adjust the `msg` typing — currently `object`; tighten to `{ pixels: ArrayBuffer }` intersection so the reassignment is typed.) Verify what the current backends actually return (`@casabio/jxl-native` `createDecoder` events; `jxl-wasm` facade) so the commit message states whether this is latent or live.

### D-3 (P2) `decode_cancelled` posted for `release_state` — asymmetric with encode
`onCancel` ignores its `reason` and always posts `decode_cancelled`. `EncodeHandler.onCancel` suppresses the message when `reason === "release_state"` (host already forgot the session). Mirror encode:
```ts
async onCancel(reason?: string): Promise<void> {
  if (this.ended || this.cancelled) return;
  this.cancelled = true;
  this.paused = false;
  if (reason !== "release_state") {
    this.port.postMessage({ type: "decode_cancelled", sessionId: this.sessionId } satisfies MsgDecodeCancelled);
  }
  this.finishSession("cancelled");
  void this.disposeActiveDecoder();
}
```

### D-4 (P2) `worker_drain` posted after terminal transition
In `feedDecoder`, `maybePostDrain()` runs after `await decoder.push(chunk)` even if cancel/error landed during the push — a drain message for a dead session reaches the scheduler. Guard: `if (this.isTerminal()) return;` immediately after the push (before EMA update is fine either way).

### D-5 (P2, benchmark-gated — Lens 19 batching) Coalesce small chunks before push
Each `decoder.push()` crosses the JS→backend boundary; for WASM that is an FFI call + heap write per chunk. Network-fed sessions produce many small chunks. When `queueDepth` is high and chunks are small (e.g., total ≤ 1 MiB), `Buffer.concat` the run and push once. **CLAUDE.md requires benchmark evidence for adaptive/heuristic changes** — implement behind a measurement first (use `benchmark/` harnesses); if no measurable win on the WASM backend, reject with the numbers. Do not add a tunable without data. Note the native batch backend is inert here (push is memcpy; see file header comment) so benchmark the WASM path specifically.

### D-6 (P3) Dedupe `toBuffer`
Identical helper duplicated in encode-handler.ts. If you and Agent 3 agree, request a shared `src/buffer-util.ts` at the end (cross-file change — needs approval).

### Explicitly rejected on sight (do not re-propose)
Pixel-buffer pools (transfer detaches), drain callbacks on the decoder, per-stage budget reset, `compactQueue` threshold < 64 — all in the CLAUDE.md rejection table.

---

## Agent 3 — `encode-handler.ts`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article. 

### E-1 (P1) `sidecarOffsets` assumes one sidecar == one encoder chunk
`readEncoderChunks` (line ~296) records `totalBytes` after each of the first `sidecarSizes.length` chunks. That mapping is only correct if the backend emits exactly one chunk per sidecar — an undocumented coupling that breaks the moment a backend splits or merges output chunks. Make it byte-accurate against the declared sizes:
```ts
const sizes = this.opts.sidecarSizes ?? [];
const sidecarOffsets: number[] = [];
let sidecarIdx = 0;
let nextBoundary = sizes.length > 0 ? sizes[0]! : Infinity;
// inside the for-await, after totalBytes += buffer.byteLength:
while (sidecarIdx < sizes.length && totalBytes >= nextBoundary) {
  sidecarOffsets.push(nextBoundary);
  sidecarIdx++;
  nextBoundary += sizes[sidecarIdx] ?? Infinity;
}
```
**First** verify the intended semantics: read `MsgEncodeDone.sidecarOffsets` in `@casabio/jxl-core/protocol` and its consumers (pyramid ingest / manifest writers — grep `sidecarOffsets`). If consumers expect *start* offsets instead of *end* offsets, the current code is also off-by-one-sidecar; fix to match the consumer, and add a unit test with a backend stub that splits sidecar bytes across uneven chunks.

### E-2 (P2, perf) Encode chunks are cloned, never transferred
`encode_chunk` posts the Buffer with no transfer list — every output byte is structured-clone-copied across the worker boundary; decode transfers, encode doesn't. Port decode's `postWithPixels` pattern (including the D-2 slice-for-views fix — the same whole-backing-buffer clone hazard applies here, and encoder output very plausibly comes as views into a larger native buffer):
```ts
private postChunk(msg: MsgEncodeChunk, chunk: Buffer): void {
  const ab = chunk.buffer;
  if (chunk.byteOffset === 0 && chunk.byteLength === ab.byteLength) {
    this.port.postMessage(msg, [ab]);
  } else {
    const exact = ab.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
    msg.chunk = exact as unknown as ArrayBuffer;
    this.port.postMessage(msg, [exact]);
  }
}
```
Caveat: confirm no code path reuses the Buffer after posting (here `toBuffer` output is used only for `totalBytes` before the post — safe if you read length first).

### E-3 (P2, feature) Encode emits zero metrics
Decode posts `time_to_header_ms`, `time_to_first_pixel_ms`, `time_to_final_ms`. Encode posts nothing — the scheduler/telemetry is blind to encode latency, which is the expensive direction (effort/Butteraugli — Lens 15: you cannot speed up what you cannot see; these metrics are the prerequisite for effort/distance auto-tuning). Add a `stageStartMs = performance.now()` in the constructor and post `time_to_first_byte_ms` where `firstByteEmitted` flips and `encode_total_ms` + `output_bytes` alongside `encode_done`, using the same `{ type: "metric", sessionId, metric: { name, value } }` shape as decode-handler. Confirm the host metric sink accepts encode-session metrics (grep `"metric"` handling in scheduler).

### E-4 (P3) Hardcoded `latencyMs: 0` and fixed `CHUNK_HWM`
Encode drain reports zero latency; an EMA of `pushPixels` duration (exactly the decode pattern) costs two lines and makes the drain message honest. Adaptive HWM scaling beyond that is benchmark-gated per CLAUDE.md — skip unless you have data.

### E-5 (P3) `encOpts: any` type erosion
Extend the local `NodeCodecModule.createEncoder` options interface with the optional `progressiveDc/progressiveAc/qProgressiveAc/groupOrder` fields (matching `MsgEncodeStart`) and delete the `any`. Pure hygiene, no behaviour change.

### E-6 (P3) Redundant per-chunk `state = "streaming"` write
Assigned every iteration; set it once when `firstByteEmitted` flips. Trivial.

---

## Agent 4 — `backend-selector.ts`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article. 

### B-1 (P2) ESM interop: `loadNativeBinding` under `default` is missed
`resolveCodecModule` checks `loadNativeBinding` only on the top-level namespace; the `default` fallback is only tried via `isCodecModule`. A CJS-built `@casabio/jxl-native` imported from ESM can surface `loadNativeBinding` under `default` (bundler/Node interop dependent) → native silently skipped, **permanent WASM pessimization** with zero diagnostics. Unify:
```ts
function resolveCodecModule(value: unknown): CodecModule | null {
  const candidates = [value, isRecord(value) ? value["default"] : undefined];
  for (const c of candidates) {
    if (!isRecord(c)) continue;
    if (typeof c["loadNativeBinding"] === "function") {
      try {
        const binding = (c["loadNativeBinding"] as () => unknown)();
        if (isLoadedBinding(binding) && isCodecModule(binding)) return binding;
      } catch { /* fall through to next candidate */ }
      continue;
    }
    if (isCodecModule(c)) return c;
  }
  return null;
}
```
Check how `@casabio/jxl-native/index.ts` actually exports (`packages/jxl-native`) and add a selector unit test with a `{ default: { loadNativeBinding } }` shaped stub.

### B-2 (P2, observability) Failures are swallowed with no escape hatch
Every failure mode — import error, probe false, shape mismatch — collapses to `null` and silent WASM fallback. A broken native install is invisible except as a performance cliff (this package's whole reason to exist is the native fast path). Two cheap additions:
1. `JXL_FORCE_NATIVE=1`: skip the WASM fallback; on native failure throw an error that includes the **captured** import/probe error (keep the caught `err`, don't discard it).
2. Collect a `reason` string per failed candidate and attach to the final throw / expose as `selectBackend` returning `{ backend, diagnostics }`… keep the public signature stable: simplest is an optional `onDiagnostic?: (msg: string) => void` in `BackendSelectorOptions`, which worker.ts can later wire to `worker_error`-level logging (request that wiring at the end; do not edit worker.ts yourself).

### B-3 (P3, deferred) Richer capability report
`Backend` could carry `{ threads?: number, simd?: boolean, version?: string }` from native `probe()` for scheduler tuning and `worker_ready` enrichment. Protocol + cross-package change — document the shape, request at the end, do not implement unilaterally.

---

## Agent 5 — `spawn.ts`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article. 

### S-1 (P1) Worker crash masquerades as graceful shutdown
`worker.on("exit", code !== 0)` synthesizes a `worker_shutdown_ack` to all handlers. A crashed worker (native segfault, OOM) is therefore indistinguishable from a clean shutdown: in-flight sessions get no error, the pool may "recycle" a corpse. Emit a real error first, then the ack (so a pending `shutdown()` still resolves):
```ts
worker.on("exit", (code) => {
  _terminated = true;
  if (code !== 0) {
    for (const h of messageHandlers.slice()) {
      h({ type: "worker_error", code: "WorkerCrashed",
          message: `[jxl-worker-node] worker exited with code ${code}` } as WorkerToMainMessage);
    }
    for (const h of messageHandlers.slice()) h({ type: "worker_shutdown_ack" });
  }
});
```
Verify `worker_error` message shape in `@casabio/jxl-core/protocol` (worker.ts already posts `{ type: "worker_error", code, message }` without sessionId, so the shape exists) and check how the scheduler pool reacts to `worker_error` (it should retire the handle).

### S-2 (P1) Post-ready `error` event wipes all subscribers; no ready timeout
`worker.on("error")` does `messageHandlers = []` and calls `reject` — after `worker_ready` has resolved the promise, `reject` is a no-op and the handler wipe silently disconnects every live session (deadlock: no errors delivered, all future messages dropped). Fix: if already resolved, broadcast a `worker_error` (`code: "WorkerError"`, include `err.message`) to handlers and leave the list intact; `_terminated = true` is correct either way. Additionally, if the worker hangs before posting `worker_ready` (e.g., backend import wedges), the spawn promise pends forever — add `spawnWorker(opts?: { readyTimeoutMs?: number })` (default e.g. 30 000 ms) that terminates and rejects on expiry. Keep the zero-arg call signature working.

### S-3 (P2) `shutdown()` is not idempotent
Two concurrent `shutdown()` calls stack interceptors; the ack satisfies only the inner one, the outer waits out its full timeout and calls `worker.terminate()` on a dead worker. Cache the promise (same pattern as worker.ts `handleShutdown`):
```ts
let shutdownPromise: Promise<void> | null = null;
shutdown(timeoutMs = 5000) {
  if (shutdownPromise !== null) return shutdownPromise;
  shutdownPromise = new Promise<void>((res) => { /* existing body */ });
  return shutdownPromise;
}
```

### S-4 (P3) Dead imports
`MessageChannel`, `fileURLToPath`, `resolve`, `dirname` are all unused. Delete.

### S-5 (P3, feature) Spawn options for pool tuning
No way to pass `resourceLimits` (cap native/WASM memory per worker so a runaway decode cannot OOM the host), per-worker `env` (e.g., `JXL_FORCE_WASM` for A/B), or `execArgv`. Extend the (new, from S-2) options object: `{ readyTimeoutMs?, resourceLimits?, env? }` → forwarded to `new Worker(WORKER_PATH, { resourceLimits, env: { ...process.env, ...env } })`. Also guard `send()` with `if (_terminated) return;`.

---

## Agent 6 — `index.ts`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article. 

### I-1 (P3) Export `selectBackend` for host-side preflight
The host (pool, CLI diagnostics, `jxl-capabilities` probes) cannot currently ask "what backend would a worker pick?" without spawning one. Re-export:
```ts
export { selectBackend } from "./backend-selector.js";
export type { Backend, BackendSelectorOptions, CodecModule } from "./backend-selector.js";
```
Deliberately do **not** export DecodeHandler/EncodeHandler — they are worker-internal and exporting them would invite wrong-layer use (session protocol must not leak; CLAUDE.md layer invariants). Check `package.json` `exports` map covers nothing beyond `./index.js` before assuming this is the only public gate; if there are deep-import consumers of `spawn.js`, note them. This is the entire ambit of this agent; if Agents 1–5 land first, also verify this file needs no re-export updates from their changes (e.g., new spawn options types are exported via `WorkerHandle`'s module automatically only if you add them).

---

## Cross-cutting notes (Lenses 9–22, condensed)

- **Lens 10 (film backwards):** replaying message logs in reverse exposed W-1/W-2 — every map `.add`/`.set` must have exactly one `.delete` on every path; `cancelledPendingStarts` was the one key with an unmatched add.
- **Lens 11/13 (telescopes/gaming):** budget = frame-time budget, drain coalescing = vsync pacing — already present and correct; the missing piece was encode-side telemetry (E-3), the "frame-time graph" for the expensive direction.
- **Lens 12 (LLM/ML recognition) & 14/16 (photogrammetry/AR):** these files already carry `region` + `downsample` through the protocol — the node worker is ready to serve tile/ROI requests for feature extraction and on-device model input. The genuinely useful enabler at this layer is E-3's metrics (lets an ML pipeline schedule decode work against a latency target). Planar f32 output for tensor ingestion belongs in the facade/native layer, not here — out of ambit, noted only.
- **Lens 15 (Butteraugli):** not computed in these layers; the lever here is E-2 (stop cloning encode output) and E-3 (measure, then tune effort/distance upstream).
- **Lens 21 (unlit rooms):** (1) no tests exist for the cold-start queue paths and sessionId lifecycle races (W-1/W-2 fixes must ship with them); (2) crash-path behaviour (S-1/S-2) has clearly never been exercised; (3) backend-selection observability (B-2) — the single biggest silent-failure surface in the package.

## Overview — what implementing this achieves

The headline outcome is lifecycle correctness under churn. Today the node worker is correct for the happy path — one session, clean start, clean end — but the seven sessionId-keyed maps in worker.ts drift out of sync the moment sessions are released, restarted, or overflow mid-start. W-1 and W-2 close a real session-killing bug and a chunk-loss race that would present in production as "decode occasionally hangs forever on the server," the worst class of bug to diagnose after the fact. S-1 and S-2 do the same for process-level failure: a native segfault stops looking like a polite shutdown and starts looking like what it is, so the pool can retire and respawn instead of feeding sessions to a corpse.

The second outcome is honest preemption. D-1 makes pause mean pause: under the current code a scheduler that preempts a busy node session gets an immediate ack while the worker burns through its entire queued backlog in synchronous WASM pushes — on a server-side pyramid ingest with deep queues that is potentially seconds of stolen CPU per preemption, exactly what the scheduler's priority machinery exists to prevent. Together with D-3's release_state symmetry, the node worker's contract becomes byte-for-byte the one the browser worker already advertises, which is the package's stated design goal.

Third, boundary efficiency. D-2 and E-2 remove the two remaining accidental-copy paths across the worker boundary: non-owning pixel views that structured-clone an entire backing arena, and encode output that is cloned wholesale when it could be transferred. Both are zero-risk in the owning case and strictly cheaper in the view case; on a 50 MP encode the difference is tens of megabytes of memcpy per image that simply disappears. E-1 hardens the sidecar-offset bookkeeping against backend chunking behaviour, which matters because the pyramid manifest consumes those offsets — a wrong offset there corrupts byte-range fetches for every client of that pyramid.

Finally, observability where there was none: encode metrics (E-3), backend-selection diagnostics and JXL_FORCE_NATIVE (B-2), crash-distinct error codes (S-1), and stacks in worker_error (W-4). These cost almost nothing and convert the package's failure modes from "silent performance cliff or hang" into attributable, alertable events — the precondition for the effort/distance auto-tuning and scheduler-aware ML serving sketched in the lens notes. The implementation order that minimizes risk: Agents 4 and 6 (isolated, no protocol contact), then 5, then 1, then 2 and 3 (handler contract changes, ship with the new tests).
