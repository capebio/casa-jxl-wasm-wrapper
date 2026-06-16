# HANDOFF — 22-Lens Review: jxl-capabilities/index.ts · jxl-worker-browser/wasm-loader.ts · jxl-worker-browser/spawn.ts

Date: 2026-06-11
Files reviewed (no other files were modified or analyzed in depth):
1. `packages/jxl-capabilities/src/index.ts` (199 lines)
2. `packages/jxl-worker-browser/src/wasm-loader.ts` (243 lines)
3. `packages/jxl-worker-browser/src/spawn.ts` (110 lines)

---

## Strategic picture (Lens 1, 22)

These three files form the **environment-sensing and worker-bootstrap rim** of the pipeline:

```
jxl-capabilities (what can this device do?)
      │  Tier / Capabilities          ← consumed by UI, scheduler, session
      ▼
spawn.ts (create worker, typed handle) ← called by jxl-scheduler/pool.ts
      ▼
worker.ts ──► wasm-loader.ts (import facade, force tier, validate shape)
      ▼
jxl-wasm/facade.ts → bridge.cpp → libjxl
```

Data passed between them: a `Tier` string (capabilities → loader, currently via **duplicated detection code, not via import**), a worker URL + query-string tier override (spawn → loader, implicit), and `MainToWorkerMessage`/`WorkerToMainMessage` protocol objects (spawn ↔ worker). The central structural defect is that **tier selection logic exists three times with divergent rules**, and the loader's default override silently discards the multithreaded builds the project just produced. The central lifecycle defect is that **spawn.ts has no story for a worker that dies after startup or never starts** — the pool above it assumes handles are live forever.

---

## Consolidated findings

### jxl-capabilities/src/index.ts

| ID | Sev | Finding |
|----|-----|---------|
| C-1 | **High (bug)** | Node path probes `await import('jxl-native')`. The monorepo package is `packages/jxl-native` — almost certainly published as `@casabio/jxl-native`. Bare `'jxl-native'` will never resolve → `nativeJxlDecoder` is always `false` on Node. Verify the `name` field in `packages/jxl-native/package.json` and import that. |
| C-2 | **High (perf)** | `getCapabilities()` is not memoized. `probeNativeJxl()` allocates a Blob and round-trips `createImageBitmap` (async, ms-scale) on **every call**. Capabilities are static per session. Memoize the whole promise. |
| C-3 | **Med (consistency)** | Tier logic is duplicated *within the file*: `detectTier()` and `selectWasmBuild()` compute the same answer with different inputs (`typeof WebAssembly` vs `wasm` boolean; cached probes vs re-run probes). `getCapabilities` should derive `selectedWasmBuild` from `detectTier()` (mapping `!wasm → "none"`), deleting `selectWasmBuild`. |
| C-4 | **Med (consistency)** | `canUseThreadedWasm(wasmThreads, sab, coi)` requires `wasmThreads`, but `selectWasmBuild`/`detectTier` deliberately ignore the threads probe (Chrome false-negative, per inline comment). The exported helper contradicts the actual policy. Align it (drop the `wasmThreads` term) or delete it if unused (grep consumers first). |
| C-5 | Low (perf/noise) | `probeRelaxedSimd`/`probeWasmSimd`/`probeWasmThreads` are pointless async wrappers around sync functions; `Promise.all` of two sync calls is noise. Call the sync probes directly. Also hoist the probe byte arrays to module-level `const Uint8Array`s so repeated probing doesn't re-allocate. |
| C-6 | Low (correctness) | `libjxlVersion: "0.10.2"` is a hardcoded placeholder. Wire to a constant exported by the jxl-wasm build (e.g. generated `version.ts` in `jxl-wasm/dist`), imported lazily/optionally; fall back to `"unknown"`, not a stale literal. |
| C-7 | **Feature (LLM/AR/photogrammetry lenses 12, 14, 16)** | `Capabilities` is the natural device registry for the biodiversity platform's on-device recognition path. Add cheap, additive fields: `webgpu` (`!!navigator.gpu`), `webnn` (`!!(navigator as any).ml`), `hardwareConcurrency`, `deviceMemory` (where exposed). Zero probe cost; lets the species-ID/AR layer pick an inference backend and the scheduler size its pool without re-sniffing. |
| C-8 | Feature (Butteraugli lens 15, optional) | These layers never run Butteraugli, but the *encode effort* they recommend determines how much perceptual search libjxl does downstream. Add `recommendedQualitySearch(): "full" | "fast" | "none"` keyed on tier (`scalar→"none"`, `simd→"fast"`, MT→"full"`) as an exported hint for encode-handler. Mark consumers as follow-up; export alone is harmless. Per CLAUDE.md, the thresholds are heuristics — note in JSDoc that tuning needs benchmark data. |
| C-9 | Low (edge) | Under strict CSP without `'wasm-unsafe-eval'`, `WebAssembly.validate` succeeds but `instantiate` fails → capabilities over-report. Document the limitation in JSDoc; do **not** add an async instantiate probe (cost > benefit). |

### jxl-worker-browser/src/wasm-loader.ts

| ID | Sev | Finding |
|----|-----|---------|
| W-1 | **P0 (perf)** | `readWorkerTierOverride()` returns `"simd"` both when the worker URL has **no query string** and when the param is unrecognized. `forceWorkerSafeTier` then calls `setForcedTier("simd")`. Net effect: **every worker spawned with the default URL is hard-pinned to single-threaded SIMD**; the freshly built `relaxed-simd-mt` / `simd-mt` artifacts are dead weight unless a caller manually appends `?jxlWorkerTier=auto`. The function name (`forceWorkerSafeTier`) hints this may have been a deliberate workaround for nested-pthread instability — **investigate before changing**: check `worker.ts`, `pool.ts`, git history for why. If no documented reason, default to `"auto"`; if there is one, keep `"simd"` but write the reason as a comment and into `docs/rejected optimizations.md`. |
| W-2 | **High (dedupe)** | `Tier`, `detectTier`, `probeSimd`, `probeRelaxedSimd` are byte-identical copies of jxl-capabilities code. Make jxl-worker-browser depend on `@casabio/jxl-capabilities` and re-export (`export { detectTier, type Tier } from "@casabio/jxl-capabilities"`). Adding the dependency edge touches `packages/jxl-worker-browser/package.json` — minimal closely-related edit, allowed; document it. |
| W-3 | Med (divergence) | Local `detectTier()` checks only `typeof SharedArrayBuffer`, **omitting the `crossOriginIsolated` check** that capabilities' version has. In browsers post-Spectre the two mostly coincide, but in Node-ish/embedded contexts SAB exists without COI → loader claims MT where capabilities says ST. Resolved automatically by W-2 (use the capabilities version, which has the COI check). |
| W-4 | Med (waste) | The 404-diagnostic probe fetches the full WASM binary (multi-MB) just to read `resp.status`. Use `fetchImpl(wasmUrl, { method: "HEAD" })`, falling back to GET+cancel only on 405. Error path only, but it's the path that runs on constrained devices. |
| W-5 | Low (API clarity) | `loadWasmModule(wasmUrl, …)` never uses `wasmUrl` to *load* anything — only for the failure diagnostic. Callers will assume it selects the binary. Rename param to `diagnosticWasmUrl` or document prominently in JSDoc. Do not change behavior. |
| W-6 | Low (robustness) | `forceWorkerSafeTier` silently no-ops when the facade lacks `setForcedTier`. One `console.warn` on the cold path makes a misbuilt facade diagnosable. |
| W-7 | Low (hygiene) | Memoize the loaded module promise (`let _modulePromise`) keyed on default path so accidental double-`loadWasmModule` within a worker can't double-import. Cheap insurance; verify `worker.ts` call count first — if provably once, skip and note. |
| W-8 | Defer | `BrowserDecodeEvent.pixels: ArrayBuffer | Uint8Array` union forces per-frame branching in consumers. Standardizing on `Uint8Array` is correct long-term but changes the facade contract (touches decode-handler/facade.ts) — **out of scope; record as proposal only**. |

### jxl-worker-browser/src/spawn.ts

| ID | Sev | Finding |
|----|-----|---------|
| S-1 | **High (lifecycle)** | Post-startup crash (`worker.onerror` after `worker_ready`) sets `_terminated` and logs, but **nothing upstream is told**. The scheduler pool keeps a dead handle; `send()` silently blackholes; sessions hang until budget timeout. Add `onCrash(handler)` registration to `WorkerHandle` (local, additive change). Wiring pool.ts to consume it is a follow-up — defer, request approval. Do **not** synthesize a fake protocol message (would require protocol type changes in another package). |
| S-2 | **High (lifecycle)** | `shutdown()` defects: (a) not idempotent — concurrent calls nest handler-array swaps; the second ack-interceptor restores `messageHandlers` to `[firstInterceptor]`, and the first promise then resolves only via its full 5s timer; (b) called on an already-crashed worker, it posts to a corpse and waits the full timeout; (c) the swap/restore wipes any `onMessage` registration made during the shutdown window. Fix: memoize a single shutdown promise; short-circuit when `_terminated`; intercept the ack in the `onmessage` router instead of swapping the handler array (see snippet in Agent 4). |
| S-3 | **Med (lifecycle)** | No startup timeout: a worker that hangs during boot (wasm fetch stall, infinite loop in init) leaves `spawnWorker`'s promise pending forever → pool slot leaks. Add `opts.startupTimeoutMs` (default ~30 000): on expiry, terminate + reject. Backwards-compatible signature: `spawnWorker(workerUrl?, opts?)`. |
| S-4 | Med (robustness) | `worker.onmessageerror` unhandled — structured-clone/deserialization failures vanish silently. Add a handler: log, and route through the same crash path as S-1 (a worker whose messages can't be read is effectively dead). |
| S-5 | Low (robustness) | Handler fan-out `for (const h of messageHandlers) h(msg)` — one throwing handler skips the rest and the exception escapes `onmessage`. Wrap each call in try/catch + `console.error`. Try/catch is near-free in modern engines; this is the file's only warm path. |
| S-6 | Low (DX, gaming lens) | Pass `{ name }` to the `Worker` constructor (e.g. `jxl-worker`) via optional `opts.name` so DevTools thread lists are readable during pool debugging. |
| S-7 | Low (hygiene) | `MsgWorkerReady` / `MsgWorkerShutdownAck` imported but unused (narrowing happens via string literals). Either use them in `satisfies` positions or drop the imports. |
| S-8 | Edge (reversal lens) | `shutdown()` before `worker_ready`: spawn promise never settles after terminate (no more messages) → leaked pending promise. Covered by combining S-2 short-circuit + S-3 timer: on shutdown, if not `_settled`, reject the spawn promise. |

### Cross-cutting (Lenses 8, 21 — gaps)

| ID | Finding |
|----|---------|
| X-1 | **Zero tests** for all three files. Highest-value cases: tier detection matrix (mock `WebAssembly.validate`/`SharedArrayBuffer`/`crossOriginIsolated`), `readWorkerTierOverride` default behavior (locks in the W-1 decision), spawn shutdown idempotency + crash-after-ready + startup timeout (mock Worker). Each agent adds tests for its own file. |
| X-2 | No telemetry of the *chosen* tier at runtime. Once W-1/W-2 land, the worker knows its effective tier; surfacing it through the existing `onMetric` channel (decoder options) is a one-line follow-up for worker handlers — record as proposal, don't implement here. |
| X-3 | Tier persistence to storage was considered and **rejected** (staleness risk after browser updates; probes are sync and ~free). Do not re-propose. |

---

## Agent handoffs

> There can be more than 5 sessions. Each agent edits ONLY its named file (plus the explicitly listed minimal companion edits, e.g. its own package.json or test file). Any other file: investigate freely, but defer edits until the end and request approval.

---

### Agent 1 — `packages/jxl-capabilities/src/index.ts` (correctness + perf)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Items: **C-1, C-2, C-3, C-4, C-5, C-9**

1. **C-1**: Read `packages/jxl-native/package.json` → use its real `name` in the dynamic import. Expected:
   ```ts
   await import('@casabio/jxl-native');
   ```
2. **C-2**: Memoize:
   ```ts
   let _capsPromise: Promise<Capabilities> | undefined;
   export function getCapabilities(): Promise<Capabilities> {
     return (_capsPromise ??= computeCapabilities());
   }
   async function computeCapabilities(): Promise<Capabilities> { /* existing body */ }
   ```
3. **C-3**: Delete `selectWasmBuild`; derive:
   ```ts
   const selectedWasmBuild: Capabilities["selectedWasmBuild"] = wasm ? detectTier() : "none";
   ```
   Confirm `detectTier()`'s COI+SAB rule matches the old `selectWasmBuild` for all input combos (it does — same predicate) before deleting.
4. **C-4**: Grep the repo for `canUseThreadedWasm`. If unused → delete. If used → reimplement as `sharedArrayBuffer && crossOriginIsolated` (drop the `wasmThreads` term) and fix call sites' expectations (call-site edits = defer + approval).
5. **C-5**: Hoist probe bytes to module consts; delete the three async wrapper functions; call `_probeSimd()`/`_probeWasmThreads()`/`_probeRelaxedSimd()` directly in `computeCapabilities`.
6. **C-9**: JSDoc note on `Capabilities.wasm` re: CSP `wasm-unsafe-eval`.
7. Tests (new file under `packages/jxl-capabilities/test/`): tier matrix per X-1.

### Agent 2 — `packages/jxl-capabilities/src/index.ts` (platform features)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Items: **C-6, C-7, C-8** (run after Agent 1)

1. **C-7**: Extend `Capabilities` (additive only):
   ```ts
   webgpu: boolean;            // !!(navigator as any)?.gpu
   webnn: boolean;             // !!(navigator as any)?.ml
   hardwareConcurrency: number; // navigator.hardwareConcurrency ?? 0
   deviceMemory: number | null; // (navigator as any).deviceMemory ?? null
   ```
   Guard every access with `typeof navigator !== "undefined"`.
2. **C-8**: Export:
   ```ts
   /** Heuristic; thresholds untuned — benchmark before relying on it (CLAUDE.md rule). */
   export function recommendedQualitySearch(): "full" | "fast" | "none" {
     const t = detectTier();
     return t === "scalar" ? "none" : t === "simd" ? "fast" : "full";
   }
   ```
3. **C-6**: Check whether `packages/jxl-wasm` build emits any version constant (grep `dist/` and `scripts/build.mjs`). If yes, import lazily with fallback `"unknown"`. If no, change the literal to `"unknown"` and leave a TODO naming the build script — generating the constant is a build-script edit (defer + approval).

### Agent 3 — `packages/jxl-worker-browser/src/wasm-loader.ts`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Items: **W-1 (P0), W-2, W-3, W-4, W-5, W-6, W-7, W-8**

1. **W-1 — investigate first, then act.** Read `packages/jxl-worker-browser/src/worker.ts`, `packages/jxl-scheduler/src/pool.ts`, and `git log -p -- packages/jxl-worker-browser/src/wasm-loader.ts` for why the no-param default is `"simd"`.
   - If no documented MT-in-worker instability: change both fallbacks in `readWorkerTierOverride` to `"auto"`:
     ```ts
     if (search === "") return "auto";
     ...
     return "auto";
     ```
   - If there IS a reason: keep `"simd"`, add the reason as a comment, and log the decision in `docs/rejected optimizations.md` so it stops resurfacing.
   - Either way, add a test locking the chosen default.
2. **W-2/W-3**: Add `"@casabio/jxl-capabilities"` to `packages/jxl-worker-browser/package.json` dependencies (minimal companion edit — document it). Replace local `Tier`, `detectTier`, `probeSimd`, `probeRelaxedSimd` with:
   ```ts
   export { detectTier, type Tier } from "@casabio/jxl-capabilities";
   ```
   Check first that the worker bundle build (`tsup`/`tsc` config) can resolve the workspace package; if bundling is a problem, copy ONLY `detectTier` (with the COI check) and leave a `// keep in sync with jxl-capabilities` marker, rejecting the dep edge with reasons.
   Note: local `detectTier` may be entirely unused after this — grep `jxl-worker-browser/src` and remove the re-export too if nothing consumes it.
3. **W-4**: HEAD probe:
   ```ts
   let resp = await fetchImpl(wasmUrl, { method: "HEAD" });
   if (resp.status === 405) { resp = await fetchImpl(wasmUrl); await resp.body?.cancel(); }
   probeStatus = resp.status;
   ```
4. **W-5**: JSDoc on `loadWasmModule`: "`wasmUrl` is used only for failure diagnostics; the module itself is resolved via `importWasm`/sibling-package import."
5. **W-6**: `console.warn("[jxl-worker-browser] facade lacks setForcedTier; tier override ignored")` in `forceWorkerSafeTier` when the function is absent and override ≠ "auto".
6. **W-7**: Confirm `worker.ts` calls `loadWasmModule` exactly once per worker. If yes, skip memoization and note it; if no, memoize the promise.
7. **W-8**: Do NOT change the `pixels` union. Append the proposal (standardize on `Uint8Array` at facade boundary) to the "Deferred proposals" section at the bottom of this document instead.

### Agent 4 — `packages/jxl-worker-browser/src/spawn.ts` (lifecycle correctness)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Items: **S-2, S-3, S-8**

Restructure shutdown + startup around explicit state, no handler-array swapping:

```ts
export interface SpawnOptions { startupTimeoutMs?: number; name?: string }

export function spawnWorker(workerUrl?: string, opts: SpawnOptions = {}): Promise<WorkerHandle> {
  return new Promise<WorkerHandle>((resolve, reject) => {
    const worker = new Worker(workerUrl ?? DEFAULT_WORKER_URL, { type: "module", name: opts.name });
    const messageHandlers: Array<(msg: WorkerToMainMessage) => void> = [];
    let _terminated = false;
    let _settled = false;
    let shutdownPromise: Promise<void> | null = null;
    let onShutdownAck: (() => void) | null = null;

    const startupTimer = setTimeout(() => {
      if (_settled) return;
      _settled = true; _terminated = true;
      worker.terminate();
      reject(new Error("[jxl-worker-browser] Worker startup timed out"));
    }, opts.startupTimeoutMs ?? 30_000);

    const handle: WorkerHandle = {
      send(msg, transfer = []) { worker.postMessage(msg, transfer); },
      onMessage(h) { messageHandlers.push(h); },
      shutdown(timeoutMs = 5000): Promise<void> {
        if (_terminated) return Promise.resolve();
        if (shutdownPromise) return shutdownPromise;
        shutdownPromise = new Promise<void>((res) => {
          const finish = () => {
            clearTimeout(timer);
            worker.terminate();
            _terminated = true;
            onShutdownAck = null;
            // S-8: a shutdown before worker_ready must not leak the spawn promise.
            if (!_settled) { _settled = true; clearTimeout(startupTimer);
              reject(new Error("[jxl-worker-browser] Worker shut down before ready")); }
            res();
          };
          const timer = setTimeout(finish, timeoutMs);
          onShutdownAck = finish;
          worker.postMessage({ type: "worker_shutdown" } satisfies MainToWorkerMessage);
        });
        return shutdownPromise;
      },
      get terminated() { return _terminated; },
    };

    worker.onmessage = (ev: MessageEvent<WorkerToMainMessage>) => {
      const msg = ev.data;
      if (msg.type === "worker_shutdown_ack") { onShutdownAck?.(); return; }
      if (msg.type === "worker_ready" && !_settled) {
        _settled = true;
        clearTimeout(startupTimer);
        resolve(handle);
        // fall through: pre-registered handlers still see worker_ready
      }
      for (const h of messageHandlers) h(msg);   // Agent 5 adds try/catch here
    };
    // onerror wiring: Agent 5 (S-1) — keep existing startup-reject behavior intact.
    ...
  });
}
```

Semantics to preserve exactly: `worker_ready` falls through to handlers; `send` stays fire-and-forget; ack still terminates the worker. Verify against pool.ts usage (read-only) that `shutdown()` resolving immediately on a dead worker is safe. Add tests per X-1 (mock Worker class).

### Agent 5 — `packages/jxl-worker-browser/src/spawn.ts` (crash visibility + robustness)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Items: **S-1, S-4, S-5, S-6, S-7** (run after Agent 4)

1. **S-1**: Extend `WorkerHandle`:
   ```ts
   /** Register a callback fired once if the worker dies after startup
    *  (uncaught error or unreadable message). The pool should recycle the slot. */
   onCrash(handler: (reason: string) => void): void;
   ```
   Implementation: `crashHandlers` array; post-startup `worker.onerror` and `onmessageerror` set `_terminated = true`, log, and fire each crash handler once (guard with `_crashed` flag). **Do not** modify pool.ts or the protocol package — wiring the scheduler to `onCrash` is a follow-up needing approval; list it under Deferred proposals.
2. **S-4**: `worker.onmessageerror = () => { /* same crash path, reason "messageerror" */ }`.
3. **S-5**: Wrap handler fan-out:
   ```ts
   for (const h of messageHandlers) {
     try { h(msg); } catch (e) { console.error("[jxl-worker-browser] message handler threw", e); }
   }
   ```
4. **S-6**: `opts.name` already plumbed by Agent 4's signature; default `"jxl-worker"`.
5. **S-7**: Remove unused `MsgWorkerReady`/`MsgWorkerShutdownAck` imports, or employ them as `satisfies` checks where the literals are compared.
6. Tests: crash-after-ready fires `onCrash` exactly once; throwing handler doesn't starve later handlers.

---

## Deferred proposals (need approval / other files)

- **W-8**: standardize on `Uint8Array` at facade boundary (BrowserDecodeEvent.pixels: ArrayBuffer | Uint8Array union and all decode-handler/facade consumers). Do not change the pixels union in wasm-loader (per spec).
- **S-1 follow-up**: pool.ts subscribes to `handle.onCrash` and recycles the slot.
- **X-2**: worker reports effective tier via `onMetric` once per session.
- **C-6 follow-up**: jxl-wasm build script emits a `version.ts` consumed by capabilities.
- **C-4 follow-up**: call-site updates if `canUseThreadedWasm` semantics change.

## Rejected during review (do not re-propose)

- Persisting detected tier to session/localStorage — probes are sync and ~free; cached values go stale across browser updates (X-3).
- Async `WebAssembly.instantiate` CSP probe in capabilities — cost and complexity exceed the value of detecting one exotic deployment (C-9 resolved by documentation).
- Synthesizing fake protocol messages for crash notification — protocol types live in jxl-core; a local `onCrash` callback achieves the same without cross-package leakage.

---

## What implementing this achieves

The single largest payoff is W-1: today, every browser worker spawned through the default path is silently pinned to the single-threaded SIMD build, which means the multithreaded `relaxed-simd-mt` and `simd-mt` artifacts — the builds that exploit SharedArrayBuffer, cross-origin isolation, and multiple cores for the heaviest libjxl decode work — are never loaded in production-shaped deployments. Resolving that one default (or documenting the genuine reason it must stay) either unlocks a multi-core speedup on the pipeline's hottest layer for free, or permanently closes a question that would otherwise keep burning investigation time. Around it, collapsing the three divergent copies of tier-detection into one canonical implementation in jxl-capabilities removes a class of "telemetry says simd, worker runs simd-mt" inconsistencies before they ever produce a confusing bug report.

The spawn.ts work converts worker lifecycle from optimistic to accountable: a worker that crashes after startup, hangs during boot, or receives overlapping shutdown requests currently produces hung sessions, leaked pool slots, and five-second drains on corpses — failure modes that surface as mysterious stalls at the scheduler layer where they're expensive to diagnose. Idempotent shutdown, a startup watchdog, ordered crash notification, and per-handler exception isolation make every worker death visible and recoverable at the layer that owns it, which is precisely the robustness a long-running field/offline biodiversity tool needs on flaky mobile hardware.

Finally, the capabilities additions point the rim of the pipeline at the platform's future: memoized, honestly-versioned capability reports that include WebGPU/WebNN and core counts give the species-recognition, AR, and photogrammetry layers a single cheap call to decide where inference and reconstruction should run, while the fixed `@casabio/jxl-native` probe restores native-decoder fast paths on Node ingest servers. None of these changes touch the hot pixel path — they make the device-sensing and bootstrap rim truthful, cheap, and observable, which is what every layer above it quietly depends on.
