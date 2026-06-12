# HANDOFF — Dev-Harness Tools Lens Review
## Files: `compare.ts`, `analyze.ts`, `serve.ts`, `jxl-roundtrip.ts`, `colour-cmp.ts`, `example-wasm-usage.ts`

Date: 2026-06-12. Source: 22-lens review of the six root-level dev-harness TypeScript tools.
Six agents, one file each. Severity: **P0** broken now · **P1** real bug/major perf · **P2** worthwhile · **P3** polish.

---

## Strategic map (context all agents share)

These six files form the development harness ring around the WASM core (`src/lib.rs` → `pkg/raw_converter_wasm.js`):

| File | Role | Data in → out |
|------|------|---------------|
| `example-wasm-usage.ts` | API documentation by example | ORF bytes → RGB8/RGBA8 buffers |
| `compare.ts` | Visual baseline: ORF → PNG eyeball | ORF → `process_orf` → sharp PNG |
| `analyze.ts` | Zone statistics vs external reference JPEG | RGB8 ours + sharp-decoded ref → console report |
| `colour-cmp.ts` | Batch colour parity vs embedded camera JPEG | ORF → ours + extracted JPEG → stats + PNG pairs |
| `jxl-roundtrip.ts` | Codec fidelity: RGB → JXL → RGB | RGB8 → @jsquash/jxl encode/decode → stats |
| `serve.ts` | Bun static server + JXL crop/timings/random-ORF APIs | HTTP → files / `packages/jxl-wasm/dist/facade.js` |

Shared facts that matter:
- `process_orf(...)` takes 14 positional look-control args; all tools pass zeros + `NaN, NaN` WB overrides (= trust camera WB).
- `ProcessResult` exposes **both** `rgb()` (copying getter) and `take_rgb()` (ownership move, zero-copy). `take_rgba()` and `downscale_rgba` also exist in `pkg/raw_converter_wasm.d.ts` (verified).
- `extractLargestJpeg` and `stats()` are duplicated near-verbatim in `colour-cmp.ts` and `jxl-roundtrip.ts`.
- Luminance weights are inconsistent: `analyze.ts` uses Rec.601 (0.299/0.587/0.114); `colour-cmp.ts` and `jxl-roundtrip.ts` use Rec.709 (0.2126/0.7152/0.0722). Cross-tool numbers are therefore not comparable today.
- `CMP_W = 1200` is independently declared in three tools.
- Resampler asymmetry: "ours" is downscaled by WASM `downscale_rgb` (box-ish), references by sharp (Lanczos3). Mean stats survive this; contrast/sharpness-sensitive stats do not.
- None of the reference-JPEG decodes call sharp `.rotate()`, so EXIF orientation is **not** applied to references, while `process_orf` **does** apply orientation (`orient_ms` stage). Portrait frames are silently mis-compared.

---

## Agent 1 — `serve.ts`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Context: Bun `serve()` dev server. Serves `/web` + `/pkg` static files with COOP/COEP headers, optional `.br` precompressed siblings (P5-3), and four API routes: `/api/jxl-crop` (decode region from a JXL on disk via `createDecoder`/`createEncoder` from `packages/jxl-wasm/dist/facade.js`, re-encode, FIFO-capped Map cache), `/api/timings` (write markdown), `/api/random-orf`, `/api/random-gobabeb`.

### S1 (P1, leak) — decoder/encoder never disposed on error paths
In `handleJxlCrop`, the `error` decode event and the `pixels === null` path `return` without `decoder.dispose()`; an encoder `catch` likewise skips `encoder.dispose()`. Long-running server leaks WASM heap per failed request. Wrap both in `try/finally`:

```ts
const decoder = createDecoder({ ... });
try {
    decoder.push(sourceBytes);
    await decoder.close();
    for await (const event of decoder.events()) { ... }
} finally {
    await decoder.dispose();
}
```
Same pattern for the encoder block.

### S2 (P1, bug) — NaN `distance`/`effort` reach the encoder
`parseFloat("abc")` → NaN; `Math.max(0, Math.min(25, NaN))` → NaN. A present-but-garbage query param sends NaN into `createEncoder` and into the cache key. Guard:

```ts
const dRaw = parseFloat(p.get("distance") ?? "1.0");
const distance = Number.isFinite(dRaw) ? Math.max(0, Math.min(25, dRaw)) : 1.0;
const eRaw = parseInt(p.get("effort") ?? "4", 10);
const effort = (Number.isFinite(eRaw) ? Math.max(1, Math.min(9, eRaw)) : 4) as 1|2|3|4|5|6|7|8|9;
```

### S3 (P1, perf) — stream files instead of buffering whole files in memory
Every static hit and every random-ORF hit does `readFile` (a ~20 MB ORF is fully buffered per request). Bun supports `new Response(Bun.file(path))` — streamed, zero-copy sendfile, Range support for free. Keep the explicit header object (COOP/COEP, MIME) — pass it as the second arg. Apply to the static path, the scalar-wasm fallback route, and both random-ORF routes. `Bun.file(p).exists()` replaces `statSafe`.

### S4 (P2, bug) — crop cache is FIFO, not LRU, and unbounded by bytes
`Map` insertion order + `get()` (no recency refresh) = FIFO eviction; a hot crop can be evicted while cold ones linger. Also 50 entries × multi-MB JXL is an unbounded byte budget. Fix both:

```ts
const hit = JXL_CROP_CACHE.get(cacheKey);
if (hit) { JXL_CROP_CACHE.delete(cacheKey); JXL_CROP_CACHE.set(cacheKey, hit); ... }
// eviction: track totalBytes; evict oldest while totalBytes > JXL_CROP_CACHE_MAX_BYTES (e.g. 64 MB)
```
Note: this Map is server-local harness state, not the pipeline's `jxl-cache` — the layer rule "dedupe lives in scheduler" does not apply here.

### S5 (P2, bug) — `decodeURIComponent` can throw
Malformed `%` sequences throw `URIError` inside `fetch()` → uncontrolled 500. Wrap and return 400.

### S6 (P1, security) — `/api/jxl-crop?file=` reads arbitrary absolute paths
The static handler is traversal-protected; this endpoint is not — any local file can be fed to the decoder. Dev-only server, but cheap to restrict: accept only files under an allowlist (`ROOT`, the two RANDOM folders) after `normalize()`, else 403.

### S7 (P2, perf) — single-flight dedupe for concurrent identical crops
Two simultaneous identical requests decode+encode twice. Keep a `Map<string, Promise<Uint8Array>>` of in-flight keys; second caller awaits the first. (Server-layer concern; scheduler `DedupeRegistry` is not reachable from here and this does not violate the layer rule.)

### S8 (P2, feature) — `downsample` passthrough on `/api/jxl-crop`
`createDecoder` is hardcoded `downsample: 1`. Accept `ds` ∈ {1,2,4,8}, pass through, include in cache key. Gives multi-resolution ROI fetch — directly useful for the pyramid lightbox, AR live-view zoom, and photogrammetry patch extraction at matched scales.

### S9 (P2, perf) — prewarm codec at startup
First `/api/jxl-crop` request pays WASM instantiation/compile. After `serve()` starts, fire a fly-weight warmup (encode a 1×1 RGBA pixel, decode it back, dispose). Game-engine "load the level before the player walks in" principle; first interactive crop becomes warm-path.

### S10 (P3) — factor the two random-file routes
`/api/random-orf` and `/api/random-gobabeb` are copy-paste twins. One `randomFileResponse(folder: string)` helper; optionally cache the `readdir` listing for ~30 s.

### S11 (P3) — MIME table gaps
Add `".jxl": "image/jxl"`, `".map": "application/json"`, `".ico": "image/x-icon"`. `.jxl` matters once pyramid sidecars are served statically.

### S12 (P3) — `negotiateCompressed` does stat-then-read (TOCTOU, 2 syscalls)
Just attempt `readFile(path + ".br")` and fall back on catch; delete `statSafe` calls at those sites.

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article. 

---

## Agent 2 — `analyze.ts`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Context: zone-statistics tool. Runs `process_orf`, downscales to `CMP_W = 1200` via WASM `downscale_rgb`, sharp-decodes a Windows Photos reference JPEG to the same dims, then reports per-zone (shadow/midtone/highlight by luminance) per-channel mean + P10/P50/P90 and deltas, plus a shadow-lift diagnosis.

### A1 (P1, perf) — replace 6 full scans + 18 megasorts with one histogram pass
`zoneStat` is called 3× per image (6 total). Each call rescans every pixel, recomputes luminance, pushes matching channels into three `number[]`s, then **sorts** them — up to ~1 M-element JS double sorts, 18 of them. Plus `globalMeans` and `meanLuminance` are two more full passes each. Total: ~10 passes and 18 `O(n log n)` sorts where one `O(n)` pass suffices.

Replace with single-pass 256-bin histograms (values are 8-bit — counting sort is free):

```ts
// per image: hist[zone][channel] = Uint32Array(256); plus global sums
function buildStats(rgb: Uint8Array) {
    const hist = [0,1,2].map(() => [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)]);
    let rSum = 0, gSum = 0, bSum = 0, lumSum = 0;
    const n = rgb.length / 3;
    for (let i = 0, o = 0; i < n; i++, o += 3) {
        const r = rgb[o], g = rgb[o+1], b = rgb[o+2];
        rSum += r; gSum += g; bSum += b;
        const lum = 0.2126*r + 0.7152*g + 0.0722*b;   // see A5
        lumSum += lum;
        const z = lum < SHADOW_MAX ? 0 : lum > HIGHLIGHT_MIN ? 2 : 1;
        hist[z][0][r]++; hist[z][1][g]++; hist[z][2][b]++;
    }
    return { hist, global: { r: rSum/n, g: gSum/n, b: bSum/n, lum: lumSum/n }, n };
}
// mean = Σ(v·count)/N over 256 bins; percentile = walk cumulative count to ceil(p/100·N)
```
Means and percentiles per zone fall out of 256-entry walks. Expect order-of-magnitude wall-time reduction and near-zero GC pressure. Output must stay numerically equivalent (percentile definition: smallest value whose cumulative count ≥ `floor(p/100·N)+1`, matching the current index semantics closely — exactness within one bin is acceptable; state it in the report if you change definition).

### A2 (P1, correctness) — reference JPEG decoded without EXIF orientation
`sharp(REF_PATH).resize(CMP_W, cmpH, { fit: "fill" })` never calls `.rotate()`. Our buffer is orientation-corrected by the pipeline (`orient_ms`); a portrait reference gets force-stretched into landscape dims and every zone statistic compares mismatched geometry. Add `.rotate()` (EXIF auto-orient) before `.resize`, and warn if `(refW > refH) !== (fullW > fullH)` after orientation.

### A3 (P2, correctness) — same resampler for both sides
Ours: WASM `downscale_rgb`. Ref: sharp Lanczos3. Different kernels shift local contrast and zone membership at edges. Apples-to-apples: sharp-decode the ref at native size (`.raw()`, no resize), then run it through the same `downscale_rgb(refFull, refW, refH, CMP_W, cmpH)`. Mean deltas barely move; P10/P90 and zone populations become trustworthy.

### A4 (P2, feature) — `--json` output mode
Emit the full stats object as JSON (one line, stable keys) when `--json` is passed. Enables CI trend-tracking of colour parity over commits and direct consumption by LLM agents diagnosing colour drift — today they must screen-scrape a box-drawing table.

### A5 (P3) — luminance comment and cross-tool consistency
The comment "Gamma-corrected luminance mean (perceptual brightness)" is wrong — it is plain Rec.601 weighting on sRGB-encoded bytes. Also `analyze.ts` uses Rec.601 while `colour-cmp.ts`/`jxl-roundtrip.ts` use Rec.709, so "lum" is not comparable across tools. Standardize on Rec.709 here and fix the comment. (Zone boundaries shift slightly; note it in the commit message.)

### A6 (P3) — CLI flags
`CMP_W`, `SHADOW_MAX`, `HIGHLIGHT_MIN` as optional flags (`--width`, `--shadow`, `--highlight`) with current defaults.

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article. 

---

## Agent 3 — `colour-cmp.ts`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Context: batch colour-parity tool. For each ORF argv: extract largest embedded JPEG (camera's own rendering = ground truth), decode via sharp, run `process_orf`, downscale both to `CMP_W = 1200`, print mean/lum/sat/contrast table + percentage deltas, write `out_<stem>_{ref,ours}.png` pairs.

### C1 (P1, perf) — kill the 1M-element `lums` array
`stats()` allocates `new Array(n)` of JS doubles (~8 MB+) per call solely to compute std-dev in a second loop. Use sum + sum-of-squares in the single loop:

```ts
let lumSum = 0, lumSq = 0;
// in loop: const L = 0.2126*R + 0.7152*G + 0.0722*B; lumSum += L; lumSq += L*L;
const mean = lumSum / n;
const contrastStd = Math.sqrt(Math.max(0, lumSq / n - mean * mean));
```
For 8-bit-range values and n ≈ 1 M, float64 cancellation error is negligible (≪ 0.01 of a code value). Two calls per file → two large allocations and two extra passes removed.

### C2 (P1, correctness) — EXIF orientation on the embedded JPEG
`sharp(jpeg)` never `.rotate()`s; ours is orientation-corrected. For portrait shots, `refH` is computed from the unrotated JPEG aspect and `downscale_rgb(ours8, ourW, ourH, CMP_W, refH)` force-distorts our image into the wrong aspect. Means survive rotation; `contrastStd`, `sat` edge behaviour, and the side-by-side PNGs do not. Add `.rotate()` and a guard:

```ts
const orientedMeta = await sharp(jpeg).rotate().metadata(); // gives post-rotation dims
if ((ourW > ourH) !== (orientedMeta.width! > orientedMeta.height!))
    console.warn(`  ⚠ orientation mismatch: ours ${ourW}×${ourH} vs ref ${orientedMeta.width}×${orientedMeta.height}`);
```

### C3 (P2, perf) — faster embedded-JPEG location
`extractLargestJpeg` walks ~20 MB byte-by-byte in JS. Two upgrades, keep brute force as fallback:
1. Skip-scan with `bytes.indexOf(0xFF, i)` (engine-native memchr) instead of per-byte loop — typically 5–10× on the SOI hunt.
2. Better: ORF is TIFF — read IFD0/IFD1 tags `0x0201`/`0x0202` (JPEGInterchangeFormat / Length) for the preview offset directly; O(IFD) instead of O(file).

### C4 (P2, feature) — CI gate mode
Optional thresholds (`--max-lum-delta 5 --max-sat-delta 10` in %); on breach print FAIL and set `process.exitCode = 1`. Turns this eyeball tool into an automated colour-parity regression gate (success-criteria automation; pairs with `analyze.ts` A4 JSON mode).

### C5 (P3) — small cleanups
`refH` computed twice (resize call and again later) — compute once. Write the two output PNGs with `Promise.all`. Same resampler note as analyze A3 applies (ref via sharp Lanczos vs ours via `downscale_rgb`) — if Agent 2 lands A3, mirror it here.

### C6 (deferred, cross-file) — shared `tools/orf-utils.ts`
`extractLargestJpeg` and `stats` are duplicated in `jxl-roundtrip.ts`. Propose extracting both (plus the Rec.709 luminance constant and `CMP_W`) into a shared module imported by both tools. **This touches a file outside your ambit — implement your in-file fixes first, then request the extraction at the end.**

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article. 

---

## Agent 4 — `jxl-roundtrip.ts`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Context: codec-fidelity tool. ORF → `process_orf` → RGB8 → `rgb_to_rgba` → **lossless** JXL encode (@jsquash/jxl, effort 5) → decode → strip alpha → downscale ours and decoded to 1200 → print stats rows (embedded JPEG ref / ours / jxl→dec). Purpose stated in header: "Confirms JXL preserves colour."

### J1 (P1, perf) — 80 MB buffer copy for nothing
```ts
const rgbaBuf = rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.byteLength);
```
`ArrayBuffer.slice` copies the whole RGBA frame (~80 MB at 20 MP). A `Uint8ClampedArray` view is zero-copy and is what `encodeJxl` needs:

```ts
const clamped = new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength);
const jxl = await encodeJxl({ data: clamped, width: w, height: h }, { lossless: true, effort: 1 });
```

### J2 (P1, correctness + perf) — lossless roundtrip deserves exact comparison, not fuzzy stats
The encode is `lossless: true`, so the decoded RGBA must be **bit-identical** to the input. The current flow (strip alpha → downscale both → compare means) is both weaker (could mask a real off-by-one channel bug that survives averaging) and slower (two `downscale_rgb` calls + stats). Compare exactly at full resolution:

```ts
const same = Buffer.compare(
    Buffer.from(decRgba.buffer, decRgba.byteOffset, decRgba.byteLength),
    Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength),
) === 0;
console.log(`  roundtrip : ${same ? "BIT-EXACT ✓" : "MISMATCH ✗"}`);
```
On mismatch only, fall back to the existing stats diff (and report first differing byte index / count) for diagnosis. Keep the embedded-JPEG reference row as-is — that comparison is legitimately fuzzy.

### J3 (P2, perf) — effort 5 → effort 1 for lossless verification
Lossless output pixels are identical at any effort; effort only trades encoder CPU vs file size. For a fidelity check, effort 1 is the honest fast path (effort 3 if you also want the size number to stay representative — prior measurements put effort 3 at the speed/size sweet spot).

### J4 (P2, strategic feature) — test the shipping codec, not just @jsquash
This tool validates @jsquash/jxl, but production decode/encode goes through `packages/jxl-wasm/dist/facade.js` (`createDecoder`/`createEncoder` — see `serve.ts` `handleJxlCrop` for exact option shapes and the chunk-concatenation pattern). Add `--facade` to run the same roundtrip through the repo's own codec; print both rows when both run. This closes the gap where the harness could pass while the shipping encoder drifts.

### J5 (P3) — usability
Empty argv → print `usage: bun jxl-roundtrip.ts <orf> [orf2 ...]` and exit 1 (currently silently does nothing). Optional: the alpha-strip loop can read via `Uint32Array` view for ~2×, but J2 removes its hot-path role.

### J6 (deferred, cross-file) — shared utils
`extractLargestJpeg` and `stats` duplicate `colour-cmp.ts`. Agent 3 carries the extraction proposal (C6); if it lands, switch imports here. Outside your ambit — request at the end.

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article. 

---

## Agent 5 — `example-wasm-usage.ts`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Context: documentation-by-example for the WASM API. This file is what humans and LLMs copy from — drift here propagates bad patterns. Authoritative API surface: `pkg/raw_converter_wasm.d.ts`.

### E1 (P0, broken) — import path does not exist
`import init, { ... } from './web/pkg/index.js'` — **verified missing** (`web/pkg/index.js` not on disk). Every sibling tool imports `./pkg/raw_converter_wasm.js`. The example is dead code as written. Fix the import (and the header comment claiming `web/pkg/`).

### E2 (P1, doc drift) — teaches the copying getter instead of the move
`result.rgb()` is the copying accessor; `take_rgb()` is the zero-copy ownership move used by every real tool (~60 MB copy avoided at 20 MP). Switch to `take_rgb()` and document the one-shot semantics ("after take_rgb() the result no longer holds the buffer"). Also surface `take_rgba()` — the `.d.ts` documents it as fusing RGB→RGBA inside WASM, avoiding the JS-side allocation of the old `take_rgb` + `rgb_to_rgba` pattern — it is the right teaching example for canvas-bound output.

### E3 (P2, correctness) — thumbnail dims ignore aspect ratio
`thumbnailWidth = 200, thumbnailHeight = 150` distorts anything not 4:3. Compute `dstH = Math.round(height * dstW / width)` and make height optional.

### E4 (P2, docs) — header advertises `apply_look` and `rotate_rgb8` with no examples
`apply_look` is a 19-positional-argument function (signature in `.d.ts` line 180) fed by `take_rgb16_lb()` — exactly the API that needs a worked example. Add minimal snippets for both, including `RotateResult.take_rgb()`.

### E5 (P3) — `init()` environment assumption
Bare `init()` fetches the `.wasm` relative to the module — works in browsers, fails under Bun/Node. Either document "browser only" or accept optional wasm bytes like the sibling tools (`init({ module_or_path: bytes })`).

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article. 

---

## Agent 6 — `compare.ts`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Context: smallest tool — process one hardcoded ORF at all-zero controls, print stage timings, write a 1200-wide PNG baseline for eyeballing against the camera JPEG.

### B1 (P2) — accept argv
`ORF` and `OUT` are hardcoded absolute paths. Accept `process.argv[2]`/`[3]` with the current values as defaults (pattern already used in `analyze.ts`).

### B2 (P3) — unused import
`writeFileSync` is imported and never used. Remove.

### B3 (P3) — pre-shrink in WASM before sharp
sharp Lanczos-resizes the full ~20 MP RGB buffer. Downscale via WASM `downscale_rgb(rgb, r.width, r.height, 1200, h1200)` first, then PNG-encode without `.resize()`. Faster, and makes this baseline PNG share the exact resampler used by `analyze.ts`/`colour-cmp.ts` comparisons, so visual and statistical views agree.

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article. 

---

## Cross-file coordination (resolve after all per-file work)

1. **`tools/orf-utils.ts` extraction** (C6/J6): `extractLargestJpeg`, `stats`, Rec.709 luminance weights, `CMP_W`. Owner: Agent 3 proposes; Agent 4 consumes. Requires approval.
2. **Luminance standardization** (A5): Rec.709 everywhere. Agents 2/3/4 must agree; Agent 2 leads.
3. **Resampler parity** (A3/C5/B3): all comparisons should downscale both sides through `downscale_rgb`. Agents 2, 3, 6.

---

## What implementing this achieves

The harness gets honest. Two silent correctness holes — EXIF orientation never applied to reference JPEGs while the pipeline output *is* orientation-corrected, and a Lanczos-vs-box resampler asymmetry between the two sides of every comparison — mean that today's parity numbers carry a hidden geometry and sharpness bias, worst for portrait frames. Fixing both, standardizing on one luminance definition across all three measurement tools, and replacing the lossless roundtrip's fuzzy downscaled-means check with a full-resolution bit-exact comparison turns "the numbers look close" into "the numbers mean what they say." That matters disproportionately here because these tools are the instruments by which colour decisions (baselines, WB trust, JXL adoption) are judged — a biased instrument quietly steers the whole pipeline.

The harness gets fast. The analyze tool currently performs roughly ten full-image passes and eighteen million-element JavaScript sorts per run; a single-pass 256-bin histogram does the same job in one scan with near-zero allocation. The roundtrip tool copies an 80 MB buffer purely to satisfy a type signature, then runs lossless encoding at effort 5 when effort 1 yields identical pixels. colour-cmp allocates a million-element double array per image just to compute a standard deviation that two running sums provide. None of these change any reported semantics; together they shrink a multi-file batch run from coffee-break to keystroke, which changes how often the tools actually get run — and instruments that run on every commit catch drift that instruments run weekly do not.

The server stops lying about being production-shaped. The crop endpoint leaks WASM codec instances on every failed request, evicts its cache FIFO while calling it LRU, accepts NaN encoder parameters, and buffers 20 MB files into memory that Bun can stream natively. Fixing those plus single-flight dedupe and a startup codec warmup makes the dev server a faithful miniature of the production architecture — and the new `downsample` passthrough on the crop API quietly delivers a multi-resolution ROI primitive that the pyramid lightbox, AR live-identification, and photogrammetry patch-sampling can all consume from day one.

Finally, the example file — the door through which every new contributor and code-assistant enters this API — currently imports a module that does not exist and teaches the copying accessor instead of the zero-copy move the rest of the codebase uses. Repairing it, adding the missing `apply_look`/`rotate_rgb8`/`take_rgba` examples, and adding JSON output plus CI threshold gates to the measurement tools converts this loose ring of scripts into a coherent, machine-readable verification belt around the WASM core: every colour claim becomes checkable by a human eye, a CI job, or an LLM agent with equal ease.
