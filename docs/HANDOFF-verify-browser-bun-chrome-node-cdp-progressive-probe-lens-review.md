# HANDOFF — Lens Review: verify-browser.ts / bun-persistent-chrome-check.ts / node-cdp-check.mjs / benchmark/progressive-worker-probe-browser.js

Date: 2026-06-11. Source: 22-lens in-memory review. Files reviewed:

1. `verify-browser.ts` (238 ln) — Playwright E2E sweep of the web app: launch/CDP-connect, file ingest, thumb states, view switching, lightbox cycling, screenshots.
2. `bun-persistent-chrome-check.ts` (13 ln) — environment smoke test: can Bun+Playwright launch a persistent Chrome context on Windows.
3. `node-cdp-check.mjs` (47 ln) — environment smoke test: manual spawn of headless shell + CDP attach (the fallback path for when Playwright's own launcher hangs under Bun/Windows).
4. `benchmark/progressive-worker-probe-browser.js` (139 ln) — in-page probe: one-shot main-thread decode vs worker progressive decode with chunk-ramp feeding; exposes `window.runProbe({jxlUrl, tier})`.

Strategic picture: these four files are the **browser verification/benchmark harness layer**. They share no code today but share concerns: browser binary resolution (duplicated hardcoded path in files 1 and 3), launch strategy (three different ones), temp-profile lifecycle (all three leak directories), and structured result output (none standardized). The probe couples to the worker tier convention via the `?jxlWorkerTier=` URL param — confirmed to match `packages/jxl-worker-browser/src/wasm-loader.ts:240-243` and `packages/jxl-session/src/context-base.ts:111-113`.

Lens 15 (Butteraugli) note: not applicable in these files — they exercise decode paths only; Butteraugli lives in encode quality search. No finding invented.

Severity: P0 = correctness/validity bug, P1 = real hazard or CI blindspot, P2 = solid improvement, P3 = nice-to-have.

---

## Agent 1 — `verify-browser.ts`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Context you need: this script has two launch modes — `connectOverCDP` when `CDP_PORT`/`CDP_URL` env set (attaching to a long-lived Chrome), else `launchPersistentContext` with a fresh temp profile under `tmp/pw-*`. It then runs `testRun` twice (single-file, multi-file). All waits are Playwright `waitForFunction` against the app DOM (`.thumb` cards, `#lightbox`).

### V-1 (P0, resource leak) — CDP mode leaks a browser context every run
`launchBrowser()` does `browser.newContext()` in CDP mode and returns the *browser* as `handle`. The `finally` calls `browser.close()`, which for `connectOverCDP` only **disconnects** — the context and its pages stay alive inside the persistent Chrome. Every sweep leaves a zombie context accumulating memory in the shared browser. Fix: track the created context and close it before disconnecting.

```ts
// launchBrowser() CDP branch:
return { handle: browser, context, ownedContext: context };
// persistent branch:
return { handle: context, context, ownedContext: null }; // close() on context is the close

// finally:
} finally {
    try {
        if (launched?.ownedContext) await launched.ownedContext.close();
        if (browser) await browser.close();
    } catch (err) { ... }
}
```

### V-2 (P1, CI blindspot) — page errors never affect exit code
`pageerror` and `console.error` are logged but the process exits 0 if the sweep mechanically completes. CI cannot detect a page riddled with errors. Count them; at the end, if count > 0, log a summary and set `process.exitCode = 1` (allow opt-out via `VERIFY_ALLOW_PAGE_ERRORS=1` since some runs intentionally test error paths).

```ts
let pageErrorCount = 0;
page.on("pageerror", (err) => { pageErrorCount++; ... });
page.on("console", (m) => { if (m.type() === "error") pageErrorCount++; ... });
// after testRuns:
if (pageErrorCount > 0 && !process.env.VERIFY_ALLOW_PAGE_ERRORS) {
    mark(`FAIL: ${pageErrorCount} page errors`);
    process.exitCode = 1;
}
```

### V-3 (P1, fail-fast) — `waitForThumbs` blind to error cards
If one card enters `error` state, the predicate can never become true and the run burns the full 240 s timeout, then throws a generic TimeoutError with no card identity. Make the wait fail fast and say *which* card failed:

```ts
async function waitForThumbs(page: Page, expected: number, timeoutMs: number) {
    const result = await page.waitForFunction((n: number) => {
        const thumbs = Array.from(document.querySelectorAll(".thumb"));
        const errored = thumbs.filter((el) => el.classList.contains("error"));
        if (errored.length > 0) {
            return { error: errored.map((el) =>
                `${el.querySelector(".name")?.textContent ?? "?"}: ${el.getAttribute("data-error") ?? ""}`).join(" | ") };
        }
        const done = thumbs.length >= n && thumbs.every((el) =>
            !el.classList.contains("busy") && !el.classList.contains("encoding"));
        return done ? { ok: true } : false;  // falsy keeps polling
    }, expected, { timeout: timeoutMs });
    const value = await result.jsonValue() as { ok?: boolean; error?: string };
    if (value.error) throw new Error(`thumb error card(s): ${value.error}`);
}
```

### V-4 (P1, hygiene) — temp profiles never deleted
`tmp/pw-*` dirs accumulate forever (each contains a full Chrome profile, tens of MB). Remove in `finally` after browser close, with a short retry for Windows file-lock lag:

```ts
import { rm } from "node:fs/promises";
async function rmWithRetry(dir: string) {
    for (let i = 0; i < 3; i++) {
        try { await rm(dir, { recursive: true, force: true }); return; }
        catch { await new Promise(r => setTimeout(r, 500)); }
    }
}
```
Only for the dir this run created (never sweep others — parallel runs).

### V-5 (P2, type safety) — replace `page: any` with `Page`
`import type { Page, ConsoleMessage, Request, Response } from "playwright";` and type all helpers. Zero runtime change; restores autocomplete and catches API misuse at compile time. Remove the `(n: number)` workaround casts where inference then works.

### V-6 (P2, DRY + fewer round-trips) — dedupe lightbox-state evaluate; fuse stats+thumbs dumps
The identical lightbox-state extraction closure appears 4× (openLightboxAndReport, cycleLightboxSource, next, prev). Hoist once:

```ts
const readLightboxState = () => {
    const canvas = document.getElementById("lightbox-canvas") as HTMLCanvasElement | null;
    return {
        width: canvas?.width ?? 0, height: canvas?.height ?? 0,
        sourceLabel: document.getElementById("lb-source-label")?.textContent?.trim() ?? "",
        banner: document.getElementById("lb-source-banner")?.textContent?.trim() ?? "",
        toggle: document.querySelector(".lb-toggle-jpeg")?.textContent?.trim() ?? "",
    };
};
// usage: await page.evaluate(readLightboxState)
```
Also fuse `dumpStats` + `dumpThumbs` (called back-to-back at every checkpoint) into one `page.evaluate` returning `{stats, thumbs}` — halves CDP round-trips per checkpoint.

### V-7 (P2, diagnostics) — failure screenshot + state dump
Today the screenshot happens only on success (last line of `testRun`). Wrap each `testRun` call; on error, capture `verify-<label>-FAIL.png` + run the fused dump from V-6 before rethrowing. The most valuable artifact is the one from the failing moment.

### V-8 (P2, feature) — machine-readable summary mode
`VERIFY_JSON=1` → at end emit one JSON line: `{schemaVersion: 1, ok, pageErrorCount, runs: [{label, files, gotoMs, firstCanvasMs, allThumbsMs, views: {...}, lightbox: {...}}]}`. Collect the values already being computed for `mark()`. Enables CI regression diffing and automated (LLM) triage without log scraping. Keep human logs as-is when unset.

### V-9 (P2, ops) — global watchdog
Worst case today: sums of many generous timeouts (120 s + 240 s × 2 runs + 10 s clicks…) ≈ unbounded-feeling CI job. Add `VERIFY_DEADLINE_MS` (default e.g. 600 000): `const watchdog = setTimeout(() => { console.log("[fatal] global deadline"); process.exit(2); }, DEADLINE); watchdog.unref?.();` — `unref` so it never holds the process open.

### V-10 (P3, portability) — machine-specific defaults
`DEFAULT_FILES` are absolute paths on this one machine (`C:\995\...ORF`); `BROWSER_PATH` pins `chromium_headless_shell-1217` (breaks on every Playwright bump). Accept `FILES` env (`;`-separated) before falling back; if defaults missing on disk, fail immediately with a one-line usage message instead of a 120 s timeout. Make thumb/canvas timeouts env-tunable (`VERIFY_THUMB_TIMEOUT_MS`). Browser-path discovery is Agent 5's X-1; here just read `BROWSER_PATH` as today.

### V-11 (P3, optional features) — scale + error-path modes
(a) `VERIFY_GALLERY_N=50` mode: pass a directory, glob N RAW files, run one large ingest sweep — exercises gallery/pyramid-scale behavior (memory says RAW decode ≈ 2.5 s each; informs specimen-set ingest). (b) `VERIFY_BAD_FILE=path` mode: ingest a deliberately corrupt file and *assert* the error card renders with `data-error` text — currently only the happy path is tested. Both env-gated so default sweep stays fast.

Also fold in: timeline streaming (Owl/film-backwards lens) — optional `page.exposeFunction("__cardEvent", ...)` + a small injected MutationObserver on `.thumb` class changes, logging timestamped state transitions (busy→encoding→done/error). Catches transient flicker/regressions the checkpoint dumps miss. Gate behind `VERIFY_TRACE=1`.

---

## Agent 2 — `bun-persistent-chrome-check.ts`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Context: 13-line smoke test whose entire purpose is answering "does Playwright `launchPersistentContext` work under Bun on this Windows box, against real Chrome?" Its failure mode of interest is a *hang* — which currently hangs the check itself, defeating the purpose.

### B-1 (P1) — watchdog so a hang produces a verdict
```ts
const watchdog = setTimeout(() => {
    console.error(`FAIL: launch/close exceeded 150000ms (hang)`);
    process.exit(2);
}, 150_000);
// ... existing flow ...
clearTimeout(watchdog);
```
Exit codes: 0 = PASS, 1 = launch threw, 2 = hang. Print `PASS pages=N chrome=<version> elapsedMs=<t>` on success (one parseable line).

### B-2 (P1) — pre-flight existence check + env override
`existsSync(BROWSER)` before launch; on miss, print `FAIL: browser not found at <path>; set BROWSER_PATH` and exit 1 — instead of Playwright's cryptic ENOENT stack. Read `process.env.BROWSER_PATH ?? hardcoded` for parity with the other two scripts.

### B-3 (P2) — temp-dir hygiene
Profile dir is created in **cwd root** (`bun-chrome-*`) and never removed — repo-root litter. Create under `tmp/` (mkdir recursive first) and `rm(dir, {recursive: true, force: true})` in a `finally` (with the 3×500 ms retry pattern for Windows locks; see Agent 1 V-4 snippet).

### B-4 (P2) — report version + elapsed
`context.browser()?.version()` (may be undefined for persistent contexts on some Playwright versions — print `"?"` then) and `Date.now()` elapsed. A smoke check that reports *what* it launched and *how long* it took doubles as an environment drift detector (Owl lens: the check should sense, not just pass/fail).

Wrap the whole body in try/catch/finally — today an exception leaves the temp dir and produces a raw Bun stack with exit 1, which is acceptable but unlabeled; emit `FAIL: <message>` for log-grep consistency.

---

## Agent 3 — `node-cdp-check.mjs`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Context: spawns the Playwright headless shell manually with `--remote-debugging-port=9444`, polls `http://127.0.0.1:9444/json/version`, connects Playwright over the returned websocket, closes. It validates the manual-spawn fallback path used when the Playwright launcher hangs under Bun.

### N-1 (P1, latent hang) — stdout piped but never consumed
`stdio: ["ignore", "pipe", "pipe"]` pipes stdout, but only stderr has a `data` handler. If the child ever writes ≳64 KB to stdout, the OS pipe buffer fills and **Chrome blocks** — the check then "hangs" for a reason that has nothing to do with what it's testing. Fix: `stdio: ["ignore", "ignore", "pipe"]` (or attach a handler). One-token change, eliminates a whole false-failure class.

### N-2 (P1, parallel safety) — fixed port 9444 collides; use port 0 + `DevToolsActivePort`
Two concurrent runs (or a stale zombie) collide on 9444 — worse, `pollReady` may connect to the *other* process's endpoint and "pass" against the wrong browser. Chrome supports `--remote-debugging-port=0`: it picks a free port and writes `<userDataDir>/DevToolsActivePort` (line 1: port, line 2: ws path). Poll that file instead of HTTP — exact readiness signal, zero HTTP, no port races:

```js
import { readFile } from "node:fs/promises";
async function readDevToolsEndpoint(userDataDir, deadlineMs = 30000) {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
        try {
            const txt = await readFile(join(userDataDir, "DevToolsActivePort"), "utf8");
            const [port, wsPath] = txt.split("\n");
            if (port && wsPath) return `ws://127.0.0.1:${port.trim()}${wsPath.trim()}`;
        } catch {}
        await delay(100);
    }
    throw new Error("DevToolsActivePort not ready");
}
// spawn with "--remote-debugging-port=0", connectOverCDP(await readDevToolsEndpoint(tmp))
```
Keep the `/json/version` poll as fallback only if the file route proves flaky on this Chrome build (it should not).

### N-3 (P2, shutdown order) — graceful close before kill, verify exit, escalate
Current `finally { proc.kill(); }` races `browser.close()`. On Windows `proc.kill()` is TerminateProcess on the root; the headless shell normally takes its children down via its job object, but don't rely on it. Sequence:

```js
} finally {
    const exited = new Promise((r) => proc.once("exit", r));
    proc.kill();
    const done = await Promise.race([exited, delay(5000).then(() => "timeout")]);
    if (done === "timeout" && process.platform === "win32") {
        spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    }
}
```
(`browser.close()` already runs in the try block — fine; the escalation covers the hang case.)

### N-4 (P2, hygiene) — temp dir: relocate + remove
Same as B-3: create under `tmp/`, `rm` recursive in finally **after** confirmed process exit (profile files are locked until then), with retry.

### N-5 (P3, verdict clarity) — explicit PASS/FAIL + exit codes
On success print `PASS ws=<url> elapsedMs=<t>`; on failure `FAIL: <reason>` and `process.exitCode = 1`. Today a `pollReady` throw surfaces as an unhandled rejection — works, but unlabeled and the exit path depends on Node's unhandled-rejection policy. Wrap in try/catch.

---

## Agent 4 — `benchmark/progressive-worker-probe-browser.js`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Context: page-side probe loaded into a harness page. `window.runProbe({jxlUrl, tier})` fetches a JXL, (1) decodes it one-shot on the main thread via `createDecoder` (@casabio/jxl-wasm), (2) decodes it through the worker pipeline via `createBrowserContext` (@casabio/jxl-session) with a chunked feed: ramp 1k→16k until the first pass lands, then 32k steady. Returns per-pass timings + aggregates. The tier is requested via `?jxlWorkerTier=` on the worker URL — param name confirmed against `packages/jxl-worker-browser/src/wasm-loader.ts:240-243` and `packages/jxl-session/src/context-base.ts:111-113`.

### P-1 (P0, benchmark validity) — report the *effective* tier and environment, not just the requested tier
The loader resolves the requested tier through a fallback ladder (and per the capabilities work, absent-query workers honor a pinned default). If `tier: "mt"` silently falls back to `"simd"`, an A/B sweep measures the same code twice and reports a fake difference of zero (or noise as signal). Required:
- Extend your search: check whether the worker's ready/init message or a capability report surfaces the tier actually loaded (look in `packages/jxl-worker-browser/src/wasm-loader.ts`, `worker.ts`, and what `createBrowserContext` exposes). If a hook exists, plumb it into the result as `effectiveTier`.
- If no hook exists: still record `requestedTier`, plus environment context so results are interpretable: `navigator.hardwareConcurrency`, `navigator.deviceMemory ?? null`, `crossOriginIsolated` (MT tier requires it — SharedArrayBuffer needs COOP/COEP), `navigator.userAgent`, and `schemaVersion: 1` in the returned object. `crossOriginIsolated === false` with `tier === "mt"` is a red flag the harness must see. Do not edit the worker to add a tier-report message without approval (other-file edit — defer and request).

### P-2 (P1, benchmark validity) — warmup + iterations + order control
Single sample, fixed order (one-shot first, worker second). The first `createDecoder` call pays WASM fetch+instantiate; the worker path pays worker spawn + its own compile; page GC/JIT state differs by phase. Add options with defaults preserving current behavior:

```js
window.runProbe = async ({ jxlUrl, tier, iterations = 1, warmup = false, order = "oneshot-first" }) => { ... }
```
- `warmup: true` → run one unmeasured one-shot decode + one unmeasured worker decode first.
- `iterations: N` → repeat measured phases N times, report median (and keep all samples in `samples: []`).
- `order: "interleaved"` → A/B/A/B to decorrelate drift (thermal/background-load) from phase.
Median over ≥3 iterations should be the harness default for any number that gets compared.

### P-3 (P1, latent corruption hazard) — one-shot decode hands the file's own ArrayBuffer to the decoder
`exactBuffer(bytes)` for the full-span view returns `bytes.buffer` itself. If `decoder.push` ever transfers (postMessage transfer list or detach-on-write), the subsequent worker phase reads a detached/poisoned buffer and the benchmark silently corrupts. Today the main-thread facade copies into the WASM heap, so it works — but it's one refactor away from breaking. One line buys immunity:

```js
await decoder.push(bytes.slice().buffer);  // private copy for the one-shot phase
```
(The per-chunk `exactBuffer` slices in `feed32k` are already private copies — required, since transferring `bytes.buffer` per chunk would detach the source. Leave those.)

### P-4 (P1, hang) — sequential `await feed32k(...); await frameTask;` can deadlock on mid-feed error
If the decode errors while the feeder is parked in `await target.push(...)` under backpressure, the drain may never come: feed never resolves, `frameTask`'s rejection is never reached, `runProbe` hangs, and the harness times out with zero diagnostics. Run them concurrently so either failure unblocks:

```js
const feedTask = feed32k(session, bytes, feedState);
const results = await Promise.allSettled([feedTask, frameTask]);
await session.done();   // surfaces BudgetExceeded etc.
const failure = results.find((r) => r.status === "rejected");
if (failure) throw failure.reason;
```
(Keep the existing `finally` close/dispose. If `session.close()` reliably unblocks a parked `push`, the allSettled completes; that is the worker-shutdown contract from the spawn-lens work.)

### P-5 (P2, metrics that answer the real questions) — richer pass statistics
Current aggregates: mean/min/max of per-pass deltas (and min/max via a sort — fine, but use the sort for percentiles too). Add, computed from the one sorted array:
- `firstPassMs` (top-level; today buried as `passes[0].t_ms`) — the progressive-paint headline number.
- `medianMs`, `p95Ms` — mean hides hitching.
- `hitchCount` — deltas > 2× median (gaming frame-pacing lens: stutters matter more than averages).
- `passesUnder33msPct` — share of passes within an AR/real-time frame budget (the live-recognition vision needs exactly this number).
- `feedStallMs` — accumulate `performance.now()` around each `await target.push(...)` in `feed32k`; separates "feeder starved the decoder" from "decoder is slow". Without this, ramp-tuning conclusions are guesses.

### P-6 (P2, feature) — parameterize format and concurrency
- `format` option (default `"rgba8"`; allow `"rgba16"`/float if the facade supports it — extend search to `packages/jxl-wasm/src/facade.ts` for valid values). High-bit-depth decode cost is the number the perceptual-color/LookRenderer roadmap needs; today the probe can't measure it.
- `concurrency: N` (default 1): run N parallel `workerProgressiveDecode` sessions over the same bytes with `poolSize: N`, report aggregate decoded MB/s + per-session firstPass/final spread. Photogrammetry/digital-twin ingest is batch-shaped (hundreds of frames); single-session latency does not predict pool throughput (scheduler contention, spawn storms).

### P-7 (P2, leak canary) — memory sampling
Chrome-only, guard `if (performance.memory)`: sample `usedJSHeapSize` before fetch, after one-shot, after worker phase, after dispose; include `memory: {...}` in the result. Across `iterations` (P-2), a monotonic climb after dispose flags a leak — direct canary for the grow-only realloc buffers in bridge.cpp and for session/worker teardown regressions. Note in the result that WASM heap is not in `usedJSHeapSize`; this still catches JS-side retention (detached-buffer roots, listener leaks).

### P-8 (P3, cold-start split) — separate spawn+compile from decode
Timestamp `t0 = performance.now()` before `ctx.decode(...)`, record `sessionToFirstFrameMs` vs `pushToFirstFrameMs` (start clock at first push — current `start` is set before feeding begins, after session creation, so spawn cost currently lands *inside* neither number cleanly when pool prewarms). Report `spawnInclusive: boolean` so readers know which regime they're looking at.

### P-9 (P3, micro) — stats in one pass
Fold into P-5: one sort yields min/max/median/p95; drop the separate spread-and-sort for min/max only. (n is small; this is consistency, not speed.)

### P-10 (P3, harness safety) — re-entrancy guard + abort
`let running = false;` — reject a second `runProbe` while one is in flight (a confused harness today gets two interleaved decodes sharing `window` and garbage numbers). Optionally accept `signal` (AbortSignal) → on abort, `session.close()` + `decoder.dispose()` so a harness timeout doesn't leave a worker decoding into the void.

---

## Agent 5 — cross-file: shared launcher module (new file `tools/launch-browser.mjs`)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

You own **one new file**: `tools/launch-browser.mjs`. Do not edit the other three scripts without approval — build the module so each could adopt it in a ~5-line diff, propose those diffs at the end, and request approval before touching them.

Birds-eye rationale (Lens 22): three scripts exist because browser launch on this machine is fragile under Bun/Windows — each embodies one workaround. The hardcoded `chromium_headless_shell-1217` path is duplicated in `verify-browser.ts:10` and `node-cdp-check.mjs:7` and breaks silently on every Playwright bump. The durable fix is one module owning the strategy chain, with the two check scripts becoming thin tests *of that module*.

### X-1 — browser path resolution
```js
export async function resolveBrowserPath() {
    // 1. env override
    if (process.env.BROWSER_PATH) return process.env.BROWSER_PATH;
    // 2. playwright's own registry
    try { const { chromium } = await import("playwright");
          const p = chromium.executablePath(); if (p) return p; } catch {}
    // 3. scan ms-playwright cache for newest chromium_headless_shell-*
    //    (readdir %LOCALAPPDATA%/ms-playwright, sort by version suffix desc,
    //     join known win64 shell subpath, existsSync)
    // 4. real Chrome fallback: C:\Program Files\Google\Chrome\Application\chrome.exe
    throw new Error("no browser found; set BROWSER_PATH");
}
```
Step 3 removes the `-1217` pin forever. Log which step resolved.

### X-2 — strategy-chain `launch()`
```js
// returns { context, page?, kind, close() } — close() is total: contexts,
// CDP disconnect, child kill+escalate (taskkill /T fallback), temp-dir rm with retry.
export async function launch({ headless = true, timeoutMs = 180_000 } = {}) {
    // strategy 1: CDP_URL / CDP_PORT env → connectOverCDP; close() closes the
    //   created context THEN disconnects (fixes the V-1 leak class by construction)
    // strategy 2: SPAWN_CDP=1 (or strategy-3 failure) → manual spawn with
    //   --remote-debugging-port=0, read DevToolsActivePort (N-2 snippet),
    //   connectOverCDP; close() = browser.close → wait child exit 5s → kill → taskkill
    // strategy 3: chromium.launchPersistentContext(tmp profile) — wrapped in a
    //   watchdog (the known Bun hang); on timeout, fall back to strategy 2
    //   rather than hanging the caller
}
```
The fallback edge (3 → 2 on hang) is the piece none of the current scripts has: today a launcher hang is terminal.

### X-3 — temp-dir policy
All profiles under `<repo>/tmp/` with a common prefix (`pw-profile-`); `close()` removes this run's dir (retry-on-lock); on module load, opportunistically sweep `tmp/pw-profile-*` older than 24 h (mtime) — bounded cleanup of crash litter without touching live parallel runs.

### Acceptance
Standalone smoke entry (`node tools/launch-browser.mjs --self-test`) exercising: resolve path, launch via strategy 3, open `about:blank`, close, verify temp dir gone, exit 0. Then propose (don't apply) the adoption diffs for `verify-browser.ts`, `node-cdp-check.mjs`, `bun-persistent-chrome-check.ts`.

---

## What implementing this achieves

The verification layer stops lying by omission. Today a sweep can exit 0 while the page logged twenty errors, can burn four minutes waiting on a card that errored in the first second, and — in CDP mode — quietly fattens the shared Chrome with a leaked context per run until someone wonders why the "persistent" browser is slow. V-1/V-2/V-3 plus the bun/node check watchdogs turn every failure mode into a fast, labeled verdict with the right artifact (a failure-moment screenshot, a named card, a PASS/FAIL line with elapsed time), and the temp-profile hygiene items stop the slow disk rot that multi-worktree development multiplies by seven.

The probe graduates from a demo into an instrument. Right now it reports a tier it *requested* but cannot confirm, on a single sample, with the cold-start cost smeared into whichever phase ran first — numbers that can produce confident, wrong conclusions (an "MT vs SIMD" comparison that secretly measured SIMD twice). Effective-tier + environment capture (P-1), warmup/iterations/order control (P-2), and the feed-stall split (P-5) make every reported number attributable; the deadlock and detached-buffer fixes (P-3/P-4) make it survive the failure cases benchmarks exist to find; format and concurrency parameters (P-6) plus the AR frame-budget and hitch metrics (P-5) let the same instrument answer the questions the platform's actual roadmap is asking — 16-bit decode cost for the perceptual-color pipeline, pool throughput for photogrammetry-scale specimen ingest, and pass pacing for real-time field identification.

The launcher module (Agent 5) is the structural payoff: it collapses three divergent workarounds into one strategy chain with a fallback edge none of them has today (launcher hang → automatic manual-spawn rescue), unpins the silently-breaking browser path, and makes every future harness — sweeps, probes, pyramid benchmarks — a consumer of one tested launch path instead of a fourth copy of the workaround. The two check scripts then verify the thing the codebase actually uses, which is what a check is for.
