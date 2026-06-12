# HANDOFF — 22-Lens Review: `packages/jxl-capabilities/src/index.ts`, `probe.ts`, `wb-probe.ts`

Date: 2026-06-12. Branch: `Parallel-Wasm-Lens`.
Scope: exactly these three files. Five Grok agent handoffs below; each agent touches **one** file only.

---

## Strategic picture (Lens 1)

`jxl-capabilities` is the **policy oracle**: every loader, worker spawner, and encoder picks its WASM build, thread count, and effort level from `detectTier()` / `getCapabilities()`. A wrong answer here silently degrades the whole pipeline (e.g. simd instead of simd-mt = no thread pool = multi-second encodes). `probe.ts` is the **end-to-end truth check**: it drives the real demo in real Chrome and is the only place where the *effective* runtime environment (COOP/COEP headers, worker spin-up, full RAW→thumb→JXL path) is observable. `wb-probe.ts` is the **colour-science ground-truth tool**: it dumps the white-balance decisions of `src/lib.rs` per ORF, feeding the trust-camera-WB pipeline rule. The three are currently unlinked: probe.ts never asks the page what tier it actually got, so a server missing COOP/COEP headers passes the probe while running 4× slower. The highest-leverage single change in this review is PR-3 (capability dump inside probe.ts), which closes that loop.

---

## Consolidated findings

| ID | Sev | File | Finding |
|----|-----|------|---------|
| CAP-1 | P1 | index.ts | Runtime-ordering bug: `isBrowser` checked before `isNode` for `nativeJxlDecoder`. Electron renderer / Bun define both browser-ish globals **and** `process.versions.node` → take the `createImageBitmap` path (Chromium: no JXL → false) even though `@casabio/jxl-native` is loadable. Check Node path first. |
| CAP-2 | P1 | index.ts | Node tier pessimized: `canDoMT = hasSab && crossOriginIsolated`, but `self`/`crossOriginIsolated` don't exist in Node, while SAB is unconditional there → Node callers get `"simd"`, `recommendedEffort()` 6 instead of 7, single-thread build selection. Waive COI when running in Node. |
| CAP-3 | P2 | index.ts | `_probeRelaxedSimd()` runs in `detectTier()` even when `!canDoMT`, and its result is then unused (no non-MT relaxed tier exists). Wasted `WebAssembly.validate` on every non-COI page — the common case. Make it lazy. |
| CAP-4 | P2 | index.ts | `selectedWasmBuild` re-spells the `Tier` union inline. Use `Tier \| "none"` — one source of truth. |
| CAP-5 | P3 | index.ts | `probeNativeJxl` trusts any bitmap. Assert `bm.width === 1 && bm.height === 1` to reject decoders that return garbage for the 1×1 fixture. |
| CAP-6 | P2 | index.ts | Feature: `ImageDecoder.isTypeSupported("image/jxl")` (WebCodecs) as fast path before the blob-decode probe — no 88-byte fixture decode, and expose new `imageDecoder: boolean` capability (enabler for progressive native decode). |
| CAP-7 | P3 | index.ts | `recommendedEffort()` / `recommendedQualitySearch()` ignore `hardwareConcurrency` / `deviceMemory` the file already collects (a 2-core phone on an MT tier gets effort 7). CLAUDE.md forbids untuned heuristics → land API shape only, thresholds behind a documented "benchmark before relying" caveat like the existing one on `recommendedQualitySearch`. Butteraugli link: `recommendedQualitySearch` is the Butteraugli throttle (Lens 15) — making it core-count-aware is the cheapest Butteraugli speedup available in this layer. |
| CAP-8 | P3 | index.ts | Feature: WASM exception-handling probe (`PROBE_EH_BYTES`) so the build pipeline can ship `-fwasm-exceptions` libjxl builds (smaller, faster than JS EH trampolines) and select them safely. |
| CAP-9 | P3 | index.ts | COI+SAB predicate duplicated between `detectTier()` (l.68-72) and `computeCapabilities()` (l.176-177). Extract one helper so the two can never drift. |
| CAP-10 | P3 | index.ts | `detectTier()` returns `"scalar"` both for "WASM present, no SIMD" and "no WASM at all"; direct callers (`recommendedEffort`) can't tell a degraded platform from an impossible one. Document, or have callers consult `selectedWasmBuild`. |
| CAP-11 | P3 | index.ts | Optional: export lazy `probeWebGpuAdapter(): Promise<boolean>` (`navigator.gpu.requestAdapter() !== null`) **separate from** `getCapabilities()` — `!!navigator.gpu` is presence, not usability. Do not put the async adapter request in the main caps object. |
| PR-1 | P1 | probe.ts | Hardcoded machine paths: ORF default `c:\995\...`, Chrome `executablePath`, screenshot dir `C:\foo\...`. No preflight: missing ORF or dead server at :8090 fails cryptically after browser launch. Env overrides + existence check + server preflight fetch. |
| PR-2 | P1 | probe.ts | Exit code always 0, even on the TIMEOUT path → CI green on failure. Set `process.exitCode = 1` on timeout and (optionally) on any `pageerror`. |
| PR-3 | P2 | probe.ts | Effective-tier blindness: probe never reads `crossOriginIsolated` / SAB / `hardwareConcurrency` from the page. A server missing COOP/COEP headers passes while silently dropping to the simd tier. Add a capability-dump `page.evaluate` right after `goto`. |
| PR-4 | P2 | probe.ts | No `page.on("worker")` / `page.on("crash")` handlers in a worker-heavy pipeline — a worker crash is invisible. Add both. |
| PR-5 | P3 | probe.ts | Quality-of-life: `+ms` timestamps on relayed console lines; `PROBE_TIMEOUT_MS` env for both 60s literals; accept multiple ORFs from argv. |
| WB-1 | P1 | wb-probe.ts | `process_orf(raw, 0,0,0,0,0,0,0,0,0,0, NaN, NaN, 0, 0)` — 15 positional magic args. A signature change in lib.rs silently misbinds. Name every arg with a commented constant block; document the `NaN, NaN` = "use camera WB" sentinel. |
| WB-2 | P2 | wb-probe.ts | Header lies: comment + column header promise "camera WB **and** auto-WB gray-world" but only one decode runs and only used values print. Either fix the header or add `--compare-auto` (second decode with WB override forcing gray-world) printing both pairs. |
| WB-3 | P2 | wb-probe.ts | No-args → header then silence; should print usage and exit 1. PowerShell doesn't expand `*.ORF` → if an arg is a directory, expand to `*.orf/*.ORF` inside it. `(e as Error).message` loses string throws from WASM → `String(e)`. |
| WB-4 | P3 | wb-probe.ts | `--json` output flag (NDJSON, one object per file) so corpus-wide WB statistics can be machine-analyzed (Lens 12). |
| WB-5 | P3 | wb-probe.ts → lib.rs (deferred) | Each WB dump runs the full RAW decode (~2.5 s/file). A metadata-only `probe_orf_wb` export in `src/lib.rs` would make batch dumps ~100× faster. **Outside ambit** — request at end. |

Lens findings with no action: relaxed-SIMD probe bytes verified correct (`0xfd 0x80 0x02` = `i8x16.relaxed_swizzle`, valid two-v128 signature); `getCapabilities` promise memoization is sound (inner try/catch makes rejection unreachable); a non-MT `relaxed-simd` build tier is a build-matrix decision, not a capabilities one — noted, not proposed.

---

## Agent 1 — `packages/jxl-capabilities/src/index.ts` (correctness: CAP-1, CAP-2, CAP-3, CAP-4, CAP-5, CAP-9, CAP-10)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article. 

File: `packages/jxl-capabilities/src/index.ts` (227 lines). Existing markers C-1..C-9 are *implemented* prior findings — do not undo them. Tests live in `packages/jxl-capabilities/test/`; `_resetCache()` exists for them.

**CAP-1 + CAP-2 (one coherent change).** Introduce a shared runtime detection at top of file:

```ts
function _isNode(): boolean {
  const proc = (globalThis as { process?: { versions?: { node?: string } } }).process;
  return !!proc?.versions?.node;
}
```

In `detectTier()` replace the MT predicate:

```ts
const hasSab = typeof SharedArrayBuffer !== "undefined";
const crossOriginIsolated = typeof self !== "undefined" && !!(self as any).crossOriginIsolated;
// Node has SAB unconditionally and no COI concept; browsers need COI for SAB to be usable.
const canDoMT = hasSab && (crossOriginIsolated || _isNode());
```

In `computeCapabilities()` reorder the `nativeJxlDecoder` branch — Node/Electron-renderer/Bun first, browser probe as fallback:

```ts
let nativeJxlDecoder = false;
if (isNode) {
  try {
    // C-1: real name from packages/jxl-native/package.json
    // @ts-ignore
    await import('@casabio/jxl-native');
    nativeJxlDecoder = true;
  } catch { /* fall through to browser probe if also browser-ish */ }
}
if (!nativeJxlDecoder && isBrowser) {
  nativeJxlDecoder = await probeNativeJxl();
}
```

Before claiming CAP-2 done, verify actual Node-side consumers: `rg "detectTier|selectedWasmBuild|getCapabilities" packages/jxl-worker-node packages/jxl-wasm` — if the Node loader pins build choice elsewhere, say so in your notes but the fix stands (the oracle should not lie even if today's consumer ignores it).

**CAP-3.** Make the relaxed probe lazy — it only matters on the MT path:

```ts
if (canDoMT) tier = _probeRelaxedSimd() ? "relaxed-simd-mt" : "simd-mt";
else tier = "simd";
```

(Note in passing for the reviewer: `computeCapabilities` still probes `wasmRelaxedSimd` unconditionally for the caps object — that is correct and stays.)

**CAP-4.** `selectedWasmBuild: Tier | "none";` in the `Capabilities` interface. Keep the doc comments.

**CAP-5.** In `probeNativeJxl`, replace `return true;` with:

```ts
const ok = bm.width === 1 && bm.height === 1;
bm.close();
return ok;
```

(move `bm.close()` before the return as shown — current code closes then returns, keep that ordering).

**CAP-9.** Extract the COI check used at l.69 and l.176 into one helper `_coi(): boolean` and call it from both sites. Behavior identical.

**CAP-10.** Documentation only: add to `detectTier()` JSDoc — "Returns `"scalar"` both when WASM lacks SIMD and when WebAssembly is entirely absent; consumers that must distinguish should use `getCapabilities().selectedWasmBuild` (`"none"` when no WASM)."

Verify: `cd packages/jxl-capabilities && npx tsc --noEmit && npm test` (or the repo's runner — check `package.json` scripts). Existing tests assert tier results under mocked globals; CAP-2 changes Node-environment expectations — update tests that mock a Node-like global (no `self`) and currently expect `"simd"`.

---

## Agent 2 — `packages/jxl-capabilities/src/index.ts` (features: CAP-6, CAP-7, CAP-8, CAP-11)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article. 

Run **after Agent 1** (same file). All four items are additive — new fields must not change existing field semantics.

**CAP-6 — ImageDecoder fast path + capability.** In `probeNativeJxl`, before the Blob/createImageBitmap probe:

```ts
const ID = (globalThis as any).ImageDecoder;
if (typeof ID?.isTypeSupported === "function") {
  try {
    if (await ID.isTypeSupported("image/jxl")) return true;
    // false is not authoritative for createImageBitmap paths (Safari has no
    // ImageDecoder but decodes JXL via createImageBitmap) — fall through.
  } catch { /* fall through */ }
}
```

Also add `imageDecoder: boolean` to `Capabilities` (probe: `typeof (globalThis as any).ImageDecoder !== "undefined"`), populated in `computeCapabilities`. Rationale: WebCodecs `ImageDecoder` supports incremental `tracks`/partial data — the natural native fast path for progressive JXL paints; the pipeline can't plan for it if the oracle doesn't report it.

**CAP-7 — device-aware recommendations (API shape only, heuristics gated).** CLAUDE.md: "Adaptive/heuristic changes require benchmark data." So: add an *optional* parameter rather than changing defaults:

```ts
/** Heuristic; thresholds untuned — benchmark before relying on it (CLAUDE.md rule). */
export function recommendedEffort(hwConcurrency?: number): 1|2|3|4|5|6|7|8|9 {
  const tier = detectTier();
  if (tier === "scalar") return 4;
  if (tier === "simd") return 6;
  const hwc = hwConcurrency ?? (typeof navigator !== "undefined" ? navigator.hardwareConcurrency ?? 0 : 0);
  return hwc > 0 && hwc <= 2 ? 6 : 7; // MT tier on a 2-core device: don't pay effort-7
}
```

Zero-arg behavior on desktop unchanged. If you judge even this too heuristic without data, implement the parameter plumbing but keep `return 7` unconditional and leave the hwc branch as a commented TODO with the benchmark requirement — your call, document it.

**CAP-8 — WASM exception-handling probe.** Add alongside the existing probe byte arrays:

```ts
// Legacy Wasm-EH (try/catch_all): () -> () body = try(void) catch_all end end
const PROBE_EH_BYTES = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
  0x03, 0x02, 0x01, 0x00,
  0x0a, 0x08, 0x01, 0x06, 0x00,
  0x06, 0x40, 0x19, 0x0b, 0x0b,
]);
```

**Verify these bytes before committing**: `node -e "console.log(WebAssembly.validate(new Uint8Array([...])))"` must print `true` on current Node, and the same array with `0x19` corrupted must print `false`. If validation fails, regenerate via `wat2wasm --enable-exceptions` from `(module (func (try (do) (catch_all))))`. Expose as `wasmExceptions: boolean` in `Capabilities`. Rationale: lets `packages/jxl-wasm` ship `-fwasm-exceptions` builds (no JS EH trampolines) once the build pipeline supports them — the capability must land first so loaders can select safely.

**CAP-11 — lazy WebGPU adapter probe.** New export, *not* part of `getCapabilities()` (adapter request is async + can be slow/power-relevant):

```ts
let _gpuAdapterPromise: Promise<boolean> | undefined;
/** Lazy: navigator.gpu presence (caps.webgpu) ≠ usable adapter. Memoized. */
export function probeWebGpuAdapter(): Promise<boolean> {
  return (_gpuAdapterPromise ??= (async () => {
    try {
      const gpu = (navigator as any)?.gpu;
      if (!gpu) return false;
      return (await gpu.requestAdapter()) !== null;
    } catch { return false; }
  })());
}
```

Reset it in `_resetCache()`. Verify: tsc + package tests as Agent 1.

---

## Agent 3 — `probe.ts` (reliability: PR-1, PR-2)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article. 

File: `probe.ts` (repo root, 73 lines, Playwright, run with `npx tsx probe.ts` or bun). It is a dev/CI harness — keep it dependency-light and readable.

**PR-1 — de-hardcode + preflight.** Replace the three hardcoded paths and add fail-fast checks before `chromium.launch`:

```ts
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ORF = process.env.TEST_ORF ?? String.raw`c:\995\2026-01-09 Birthday at Cederberg\P1100085.ORF`;
const URL_ = process.env.PROBE_URL ?? "http://localhost:8090/";
const CHROME = process.env.CHROME_PATH ?? String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const OUT_DIR = dirname(fileURLToPath(import.meta.url)); // screenshots beside the script, not C:\foo

if (!existsSync(ORF)) { console.error(`ORF not found: ${ORF} (set TEST_ORF)`); process.exit(2); }
try { await fetch(URL_, { method: "HEAD" }); }
catch { console.error(`No server at ${URL_} — start the demo server first (set PROBE_URL)`); process.exit(2); }
```

Screenshot paths become `join(OUT_DIR, "page-initial.png")` / `"page-after.png"`. Keep the default ORF as fallback (this is the user's machine), but everything must be overridable. If `CHROME_PATH` doesn't exist, fall back to Playwright's bundled Chromium (omit `executablePath`) with a one-line notice — Playwright-bundled vs system Chrome version drift is worth surfacing, not hiding.

**PR-2 — honest exit codes.** The TIMEOUT catch block and any `pageerror` currently leave exit code 0 — CI cannot see failure. Track and set:

```ts
let pageErrors = 0;
page.on("pageerror", (e) => { pageErrors++; console.log("[pageerror]", e.message); });
// in the timeout catch block:
process.exitCode = 1;
// after the happy path completes:
if (pageErrors > 0) { console.log(`--- ${pageErrors} pageerror(s) during run`); process.exitCode = 1; }
```

Keep `browser.close()` in `finally` — `process.exitCode` (not `process.exit()`) so the close still runs.

Verify: run once against a dead port (expect exit 2, no browser launched), once normally if the demo server is available; `npx tsc --noEmit probe.ts` if the root tsconfig covers it (check; if not, skip type-check and say so).

---

## Agent 4 — `probe.ts` (observability: PR-3, PR-4, PR-5)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article. 

Run **after Agent 3** (same file).

**PR-3 — effective-tier dump (highest-leverage item in this review).** Right after `page.goto(...)`:

```ts
const env = await page.evaluate(() => ({
  crossOriginIsolated: (self as any).crossOriginIsolated === true,
  sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
  hardwareConcurrency: navigator.hardwareConcurrency,
  deviceMemory: (navigator as any).deviceMemory ?? null,
}));
console.log("--- page environment:", JSON.stringify(env));
if (!env.crossOriginIsolated) {
  console.log("[WARN] page is NOT cross-origin isolated — COOP/COEP headers missing; " +
              "WASM will fall back to single-threaded tier (simd). Fix the dev server headers.");
}
```

This is the link between this harness and `jxl-capabilities`: today a server missing `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` passes the probe while silently running the single-threaded build. If the demo page exposes its computed tier (e.g. on `window`), also read and log it; check `web/` main.js for such a global before assuming — if none exists, log only the raw environment and note the gap (do not edit web/ — out of ambit; request at end if you think the page should expose `__jxlTier`).

**PR-4 — worker + crash visibility.** After the existing `page.on(...)` handlers:

```ts
page.on("worker", (w) => {
  console.log("[worker+]", w.url());
  w.on("close", () => console.log("[worker-]", w.url()));
});
page.on("crash", () => { console.log("[CRASH] page crashed"); process.exitCode = 1; });
```

**PR-5 — timing + config polish.**
- Hoist `const start = Date.now();` above `goto`, prefix every relayed console line: `console.log(\`[+${Date.now() - start}ms][${m.type()}]\`, m.text());` — turns the log into a timeline that correlates with the thumb/encode timings already measured.
- `const TIMEOUT = Number(process.env.PROBE_TIMEOUT_MS ?? 60000);` replacing both `60000` literals.
- Multi-file: if `process.argv.slice(2)` is non-empty, treat each arg as an ORF and run the setInputFiles→wait cycle per file sequentially (the demo appends a `.thumb` per file — wait for `.thumb:nth-child(n)` or count-based selector; inspect `web/` DOM structure read-only to pick the right selector, and if ambiguous keep single-file behavior and note why).

Verify: as Agent 3 (live run if server available; otherwise type-check + dry review, state which you did).

---

## Agent 5 — `wb-probe.ts` (WB-1..WB-5)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article. 

File: `wb-probe.ts` (repo root, 24 lines, Node + local WASM pkg). Colour-pipeline context: the project rule is *trust camera-stored WB unconditionally; gray-world only when WB absent* — this tool is the ground-truth dump backing that rule.

**WB-1 — name the 15 positional args.** Read the `process_orf` signature in `pkg/raw_converter_wasm.d.ts` (read-only, outside ambit) and replace the magic call with named constants matching the real parameter names, e.g.:

```ts
// Defaults = neutral pipeline: no exposure/contrast/saturation adjustments,
// NaN wb_r/wb_b = sentinel for "use camera-stored WB" (gray-world only if absent).
const r = process_orf(
  raw,
  /* exposure_ev   */ 0,
  /* contrast      */ 0,
  // ... one named line per parameter, names from pkg/raw_converter_wasm.d.ts ...
  /* wb_r_override */ NaN,
  /* wb_b_override */ NaN,
  // ...
);
```

Do not guess the names — read the .d.ts. If the signature in the .d.ts disagrees with the current call (arg count/order), flag it loudly in your notes: that is exactly the silent-misbinding failure this item exists to prevent.

**WB-2 — header vs behavior.** Header promises camera WB *and* gray-world auto-WB; only one decode runs. Preferred fix: `--compare-auto` flag → second `process_orf` call with the WB override args set to force gray-world (determine the forcing sentinel from the .d.ts / `src/lib.rs` read-only — likely explicit non-NaN 0 or a wb_mode arg), printing both `cam_r cam_b | auto_r auto_b`. If the forcing sentinel cannot be determined confidently from the read, do the minimal honest fix instead: correct the header/comment to describe what is actually printed (`wb_mode`, `wb_from_camera`, used multipliers), and note the gap.

**WB-3 — CLI hygiene.**

```ts
const args = process.argv.slice(2);
if (args.length === 0) { console.error("usage: tsx wb-probe.ts <file.orf|dir> [...] [--json] [--compare-auto]"); process.exit(1); }
// expand directories (PowerShell does not glob):
import { statSync, readdirSync } from "node:fs";
const files = args.filter(a => !a.startsWith("--")).flatMap(a =>
  statSync(a).isDirectory()
    ? readdirSync(a).filter(n => /\.orf$/i.test(n)).map(n => join(a, n))
    : [a]);
```

And `String(e)` instead of `(e as Error).message` in the catch (WASM panics can surface as string throws).

**WB-4 — `--json`.** NDJSON, one object per file: `{ file, wb_mode, wb_from_camera, wb_r_used, wb_b_used, color_matrix_from_mn }` — enables corpus-wide WB statistics and machine/LLM analysis of camera-WB reliability across the test corpus.

**WB-5 — deferred cross-file request.** Each dump pays the full RAW decode (~2.5 s/file measured for the pipeline). A metadata-only WB probe export in `src/lib.rs` (parse EXIF/MakerNotes WB tags, skip demosaic) would make corpus-wide dumps ~100× faster. `src/lib.rs` is **outside your ambit**: implement nothing there; at the very end of your work, write the request (proposed export name `probe_orf_wb(raw: &[u8]) -> WbProbeResult`, fields mirroring the dump columns) and ask for approval.

Verify: `npx tsx wb-probe.ts` with no args (usage + exit 1); with one known ORF if available; type-check if the root tsconfig covers the file.

---

## What implementing this achieves

The capabilities package stops lying in the three environments where it currently does: Node gets its multithreaded tier back (CAP-2), Electron and Bun get native JXL detection (CAP-1), and every non-cross-origin-isolated page stops paying for a relaxed-SIMD probe whose answer is discarded (CAP-3). Because every loader and worker spawner in the pipeline derives build selection, thread count, and encoder effort from this single oracle, these are not cosmetic fixes — a Node consumer trusting `selectedWasmBuild` today is steered to a single-threaded build on a 16-core machine. The additive probes (ImageDecoder, WASM exceptions, usable-WebGPU-adapter) extend the oracle ahead of need: progressive native decode via WebCodecs, exception-handling libjxl builds without JS trampolines, and GPU-accelerated colour transforms each become a one-line capability check instead of a research project when their time comes.

The probe harness graduates from a demo-clicker to an honest end-to-end sentinel. Today it exits 0 on timeout and never checks whether the page it tested was even cross-origin isolated — meaning the single most expensive silent regression available (losing COOP/COEP headers and dropping from `relaxed-simd-mt` to `simd`, roughly a 4× encode slowdown on an 8-core machine) passes the probe clean. After PR-2 and PR-3 it fails loudly on errors and warns on tier degradation; after PR-4 worker crashes — the likeliest failure mode of this architecture — become visible; after PR-5 every console line carries a timeline offset so performance regressions can be read straight from the log.

The white-balance probe becomes trustworthy and scalable. Naming its fifteen positional arguments removes a silent-misbinding trap that would corrupt every future WB investigation the moment `process_orf` gains a parameter; fixing the header-versus-behavior mismatch (or adding the promised camera-versus-gray-world comparison) makes the tool match the colour-pipeline rule it exists to validate; JSON output and directory expansion turn it from a single-file spot check into a corpus instrument. The deferred lib.rs metadata-only probe is the long-term payoff: white-balance ground truth across thousands of ORFs in seconds instead of hours, which is exactly the evidence base the trust-camera-WB rule — and the upcoming perceptual-constancy colour engine — will need.

Collectively the three files form the pipeline's sensory system: what the platform *can* do (capabilities), what it *actually* does end-to-end (probe), and whether the colour science it produces is *right* (wb-probe). This review's connecting thread is closing the loops between them — the probe asserting the tier the capabilities oracle promised, the WB tool feeding measurable evidence back into pipeline policy — so that regressions in speed, threading, or colour are caught by tooling rather than by a user noticing the sky went magenta or the encode took four times longer than last week.
