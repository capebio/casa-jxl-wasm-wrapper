# Web demos

Browser-facing pages and helpers for the CasaWASM JXL and RAW converter stack.

## Single progressive (`jxl-single-progressive.html`)

Lab page for encode → progressive decode → paint timing. Settings are applied on **Retrieve raw file** / **Rerun**.

### Progressive feed invariants (do not regress)

These behaviors are guarded by `web/jxl-single-progressive-page.test.js` and by comments in `jxl-single-progressive.js`. Breaking them silently collapses progressive decode back to two frames or detaches encoded bytes.

#### 1. Diagnostic `"passes"` decode must chunk-feed, even when unthrottled

`feedThrottled()` in `jxl-single-progressive.js` sets `chunkFeed = true` when `progressiveDetail === 'passes'` **or** `throttleKbPerSec > 0`.

For diagnostic **All passes**, never replace the chunk loop with a single `push(wholeFile)` — even at throttle 0. Between chunks, unthrottled runs must still `await sleep(0)` so each chunk gets its own macrotask yield.

**Why:** The stateful decoder bridge (`packages/jxl-wasm/src/bridge.cpp`) exposes at most **one** opportunistic progressive snapshot per `input_generation` on `JXL_DEC_NEED_MORE_INPUT`. One push → one generation → one non-final flush + final ≈ **two frames**. Chunked feed creates many generations so intermediate checkpoints appear while bytes arrive.

**Verify:** `progressiveDetail: "passes"`, throttle **Unthrottled**, worker decode on → pass strip should show many tiles, not two. Tests: `bun test web/jxl-single-progressive-page.test.js`, `bun test packages/jxl-wasm/test/progressive-visible-passes.test.ts`.

#### 2. Explicit `progressiveDetail` must enable WASM progressive decode

`resolveDecoderProgressiveDetail()` in `packages/jxl-wasm/src/facade.ts` must not return `0` (no progressive subscription) when the caller sets `progressiveDetail` to `lastPasses`, `passes`, or `dc` — even if `emitEveryPass` is false. Returning `0` disables libjxl progressive events entirely.

#### 3. Worker decode must copy chunks before transfer

`decodeProgressivelyViaWorker()` calls `feedThrottled(..., { copyChunks: true })`. `jxl-session` `push()` transfers the chunk `ArrayBuffer` to the worker; without a copy, the main-thread `encodeBytes` buffer detaches and later steps (`decodeOneShotFinal`, transfer summary) throw **Cannot perform Construct on a detached ArrayBuffer**.

#### 4. Product vs diagnostic decode detail

| UI setting | `emitEveryPass` | Feed at throttle 0 | Typical pass count |
|---|---|---|---|
| **Last passes** (default) | false | one push OK | few (product) |
| **All passes diagnostic** | true | must chunk + yield | many (lab) |
| **DC preview + final** | false | one push OK | DC + final |

`suppressDuplicateProgress` is opt-in (checkbox). Default off; do not tie progressive visibility to it.

### Setting impact hints (UI)

`jxl-single-progressive.html` colors controls that slow runs or risk breaking progressive visibility:

| Class | Meaning |
|---|---|
| `setting-impact-mild` (yellow) | Slightly slower — e.g. multi-band AC, charts on |
| `setting-impact-slow` (orange) | Slow — e.g. `progressiveDc=0`, Original size, main-thread decode |
| `setting-impact-severe` (red) | Very slow or risky — e.g. **All passes diagnostic**, dedup flushes on |

Hints update live via `refreshSettingImpactHints()` in `jxl-single-progressive.js`. Do not remove without updating `web/jxl-single-progressive-page.test.js`.

### Related docs

- `Agents.md` — progressive checkpoint contract (opportunistic flush, chunk yields)
- `packages/jxl-wasm/test/progressive-visible-passes.test.ts` — multi-pass decode regression
- `docs/Opus4.8ThrottleHandoff.md` — performance context (product path may prefer fewer passes)