# Progressive Decode Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut full-resolution progressive decode time from ~116 s to ~3 s by eliminating artificial per-chunk FlushImage calls, enabling multi-thread WASM decode, and defaulting the encoder to a faster-decode profile.

**Architecture:** Four independent changes attack the same bottleneck from different angles. (1) Removing per-chunk opportunistic FlushImage from bridge.cpp means libjxl emits progress only at real pass boundaries (~5 events vs 73). (2) Serving with COOP/COEP headers enables SharedArrayBuffer → simd-mt WASM tier → parallel libjxl iDCT. (3) Defaulting the encoder to `decodingSpeed=2` halves per-pass iDCT work. (4) Skipping the redundant 82 MB all-zero scan after the first non-empty flush is a free micro-win. Each change is independent and can be landed separately.

**Tech Stack:** C++ (bridge.cpp), TypeScript (facade.ts test), Node.js (dev server), HTML (UI default)

---

## Context — why this is slow

`feedThrottled` in `web/jxl-single-progressive.js` feeds 32 KB chunks one-at-a-time, yielding between each via `await sleep(0)`. This prevents chunk batching. `bridge.cpp` fires `JxlDecoderFlushImage` on every `NEED_MORE_INPUT` (one per chunk). Each flush at 5240×3912 requires a full single-threaded iDCT of all 336 image groups ≈ 1.5 s. 73 chunks × 1.5 s = 116 s. Fixes below target each multiplier: flush count, per-flush time (threads), per-flush time (decoding_speed).

---

## File Map

| File | Change |
|------|--------|
| `packages/jxl-wasm/src/bridge.cpp` | Remove non-input_closed opportunistic flush; add flush_count guard on all-zero scan |
| `packages/jxl-wasm/test/progressive-detail.test.ts` | Update test name/comment; add assertion that open-stream opportunistic flush is gone |
| `tools/dev-server.mjs` | New: static HTTP server for `web/` with COOP/COEP headers |
| `web/jxl-single-progressive.html` | Change `decoding-speed` select default from `0` to `2` |

---

## Task 1 — Remove open-stream opportunistic flush (bridge.cpp)

**Files:**
- Modify: `packages/jxl-wasm/src/bridge.cpp:2031-2059`
- Modify: `packages/jxl-wasm/src/bridge.cpp:96-136` (add `flush_count` field to struct)
- Modify: `packages/jxl-wasm/src/bridge.cpp:1915-1964` (TryFlushProgressiveImage)
- Modify: `packages/jxl-wasm/test/progressive-detail.test.ts:111-126`

**Background:** `JXL_DEC_NEED_MORE_INPUT` fires after every chunk push. Currently bridge calls `JxlDecoderFlushImage` there, triggering a full-frame iDCT snapshot per chunk. libjxl already provides `JXL_DEC_FRAME_PROGRESSION` for real pass boundaries. Open streams should rely on that. The `input_closed` branch (byte-truncated Sneyers demo) still needs one final flush — keep it untouched.

**Also in Task 1:** add `flush_count` to the struct and skip the 82 MB all-zero scan after the first successful flush (Fix 4).

- [ ] **Step 1: Write the failing test**

In `packages/jxl-wasm/test/progressive-detail.test.ts`, replace the test at line 111 (`'stateful progressive decoder opportunistically flushes once per input chunk without deduping snapshots'`):

```typescript
test('stateful progressive decoder flushes on JXL_DEC_FRAME_PROGRESSION and input_closed; open-stream per-chunk opportunistic flush removed', () => {
  // Open streams rely on libjxl FRAME_PROGRESSION events for real pass boundaries.
  // input_closed path retains one final opportunistic flush for byte-truncated (Sneyers) streams.
  expect(bridge).toContain('TryFlushProgressiveImage');
  expect(bridge).toContain('status == JXL_DEC_FRAME_PROGRESSION');
  expect(bridge).toContain('status == JXL_DEC_NEED_MORE_INPUT');
  expect(bridge).toContain('s->frame_started');
  expect(bridge).toContain('opportunistic_flush_generation != s->input_generation');
  expect(bridge).toContain('s->opportunistic_flush_generation = s->input_generation');
  expect(bridge).not.toContain('prev_flush_checksum');
  // The open-stream branch is gone: opportunistic flush no longer fires when input is open.
  expect(bridge).not.toContain('!s->input_closed && s->frame_started && !s->final_ready &&\n          s->opportunistic_flush_generation != s->input_generation &&\n          TryFlushProgressiveImage');
  // Fix 4: all-zero scan skipped after first flush.
  expect(bridge).toContain('flush_count');
  expect(bridge).toContain('s->flush_count > 0');
});
```

- [ ] **Step 2: Run test to verify it fails**

```powershell
cd packages/jxl-wasm
bun test test/progressive-detail.test.ts --testNamePattern "open-stream per-chunk"
```

Expected: FAIL — `expect(bridge).not.toContain(...)` triggers on current code which still has the open-stream block.

- [ ] **Step 3: Add `flush_count` to `JxlWasmDecState` struct**

In `packages/jxl-wasm/src/bridge.cpp`, inside `struct JxlWasmDecState` after line 106 (`bool flushed_ready;`):

```cpp
  bool flushed_ready;
  uint32_t flush_count;     // number of successful TryFlushProgressiveImage calls
```

- [ ] **Step 4: Update `TryFlushProgressiveImage` to skip all-zero scan after first flush**

Replace lines 1946-1963 (the all-zero guard and footer of `TryFlushProgressiveImage`):

```cpp
  // All-zero guard: skip after the first successful flush — once real pixels have been
  // emitted, the buffer cannot regress to all-zero. Avoids scanning 82+ MB per pass.
  if (s->flush_count == 0) {
    const uint64_t* w = reinterpret_cast<const uint64_t*>(s->flushed);
    const size_t nwords = s->pixels_size / sizeof(uint64_t);
    bool any_nonzero = false;
    for (size_t i = 0; i < nwords; ++i) {
      if (w[i] != 0) { any_nonzero = true; break; }
    }
    if (!any_nonzero) {
      for (size_t i = nwords * sizeof(uint64_t); i < s->pixels_size; ++i) {
        if (s->flushed[i] != 0) { any_nonzero = true; break; }
      }
    }
    if (!any_nonzero) return false;
  }

  s->flushed_size = s->pixels_size;
  s->flushed_ready = true;
  s->flush_count++;
  return true;
```

Note: this replaces the existing block at lines 1946-1963. Lines before it (1915-1945) stay untouched.

- [ ] **Step 5: Remove the open-stream opportunistic flush block**

Replace lines 2031-2059 (the full `if (status == JXL_DEC_NEED_MORE_INPUT)` block):

```cpp
    if (status == JXL_DEC_NEED_MORE_INPUT) {
      // Open streams: return NEED_MORE so the caller can feed more chunks.
      // Intermediate progress comes from JXL_DEC_FRAME_PROGRESSION (real pass boundaries).
      // Byte-truncated streams (Sneyers demo): attempt one final flush so the consumer
      // gets the best partial image decoded from the available prefix.
      if (s->input_closed) {
        if (s->frame_started && !s->final_ready &&
            s->opportunistic_flush_generation != s->input_generation &&
            TryFlushProgressiveImage(s)) {
          s->opportunistic_flush_generation = s->input_generation;
          return JXL_DEC_RESULT_PROGRESS;
        }
        s->error_code = static_cast<int>(status);
        return JXL_DEC_RESULT_ERROR;
      }
      return JXL_DEC_RESULT_NEED_MORE;
    }
```

Also update the comment block above it (lines 2032-2040) — replace with the new inline comment above.

- [ ] **Step 6: Run test to verify it passes**

```powershell
cd packages/jxl-wasm
bun test test/progressive-detail.test.ts --testNamePattern "open-stream per-chunk"
```

Expected: PASS

- [ ] **Step 7: Run full test suite for the package (source-level — no WASM needed)**

```powershell
cd packages/jxl-wasm
bun test test/progressive-detail.test.ts
```

Expected: all tests PASS. The VarDCT round-trip test (`describe VarDCT progressive decode`) requires an actual WASM binary and will likely skip/fallback to stub — that is expected until Task 4.

- [ ] **Step 8: Commit**

```bash
git add packages/jxl-wasm/src/bridge.cpp packages/jxl-wasm/test/progressive-detail.test.ts
git commit -m "perf(bridge): remove open-stream opportunistic flush; skip all-zero scan after first flush

Per-chunk opportunistic FlushImage on JXL_DEC_NEED_MORE_INPUT forced a full-frame
iDCT snapshot for every 32 KB chunk. At 5240x3912 (82 MB buffer) single-threaded,
each flush costs ~1.5 s, producing 73 artificial passes for a 2.71 MB file (116 s
total) versus 5 real FRAME_PROGRESSION events (~8 s).

Open streams now rely solely on JXL_DEC_FRAME_PROGRESSION for progress events.
The input_closed path (byte-truncated Sneyers demo) retains its final flush.

Also: flush_count guard skips the 82 MB all-zero scan after first non-empty flush."
```

---

## Task 2 — Dev server with COOP/COEP headers (threading prerequisite)

**Files:**
- Create: `tools/dev-server.mjs`

**Background:** `SharedArrayBuffer` (required for WASM threads) is blocked without `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`. `facade.ts:408-412` detects SAB and selects `simd-mt` or `relaxed-simd-mt` tier. Without these headers, tier falls back to `simd` (single-threaded). The shipped WASM binary already includes the MT build at `packages/jxl-wasm/dist/jxl-core.simd-mt.wasm`. No rebuild needed for this task.

- [ ] **Step 1: Create `tools/dev-server.mjs`**

```javascript
#!/usr/bin/env node
// Minimal static dev server for web/ with COOP/COEP headers.
// Required for SharedArrayBuffer (WASM threads) in browser.
// Usage: node tools/dev-server.mjs [port=8080] [root=web]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.argv[2]) || 8080;
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  process.argv[3] ?? 'web',
);

const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.mjs':  'application/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.css':  'text/css',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.orf':  'application/octet-stream',
  '.dng':  'application/octet-stream',
};

http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  let filePath = path.join(root, url.pathname);

  // Directory → index.html
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }

  // Path traversal guard
  if (!filePath.startsWith(root)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  if (!fs.existsSync(filePath)) {
    res.writeHead(404); res.end('Not found'); return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] ?? 'application/octet-stream';

  res.writeHead(200, {
    'Content-Type': contentType,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'cross-origin',
  });

  fs.createReadStream(filePath).pipe(res);
}).listen(port, () => {
  console.log(`Dev server: http://localhost:${port}  (root: ${root})`);
  console.log('COOP/COEP active → SharedArrayBuffer available → simd-mt WASM tier');
});
```

- [ ] **Step 2: Verify server starts**

```powershell
node tools/dev-server.mjs 8080
```

Expected output:
```
Dev server: http://localhost:8080  (root: C:\Foo\raw-converter-wasm\web)
COOP/COEP active → SharedArrayBuffer available → simd-mt WASM tier
```

Ctrl-C to stop.

- [ ] **Step 3: Verify headers in browser**

Open `http://localhost:8080/jxl-single-progressive.html` in Chrome DevTools → Network → any response → Headers. Confirm:
- `cross-origin-opener-policy: same-origin`
- `cross-origin-embedder-policy: require-corp`

Open Console. Run:
```javascript
typeof SharedArrayBuffer
```
Expected: `"function"` (not `"undefined"`)

Also check that the WASM tier report says `simd-mt` or `relaxed-simd-mt`. If the page shows a tier label, verify it. Otherwise run in console:
```javascript
import('/packages/jxl-wasm/dist/index.js').then(m => console.log(m.detectTier()))
```
(or look for any tier log in the worker.)

- [ ] **Step 4: Commit**

```bash
git add tools/dev-server.mjs
git commit -m "feat(tools): dev server with COOP/COEP for SharedArrayBuffer/WASM threads"
```

---

## Task 3 — Default encoder `decodingSpeed` to 2

**Files:**
- Modify: `web/jxl-single-progressive.html:191`

**Background:** `decodingSpeed` is an encoder-side flag (`JXL_ENC_FRAME_SETTING_DECODING_SPEED`) baked into the JXL bitstream. It trades minor quality for faster decoder iDCT. Default `0` = slowest decode. `2` = balanced: ~25-35% decode speedup, imperceptible quality delta at q=95. Affects every new encode on the page. Existing files are not changed.

- [ ] **Step 1: Change the HTML select default**

In `web/jxl-single-progressive.html` at line 191, change the `selected` attribute from the `value="0"` option to the `value="2"` option:

```html
        <select id="decoding-speed">
          <option value="0">0 · slowest decode / highest quality</option>
          <option value="1">1</option>
          <option value="2" selected>2 · balanced</option>
          <option value="3">3</option>
          <option value="4">4 · fastest decode / lower quality</option>
        </select>
```

- [ ] **Step 2: Verify default is picked up**

Open `http://localhost:8080/jxl-single-progressive.html`, load any ORF/PNG, run encode. Confirm the run-start log line includes `"decodingSpeed":2`.

- [ ] **Step 3: Commit**

```bash
git add web/jxl-single-progressive.html
git commit -m "perf(ui): default decodingSpeed to 2 (balanced) for ~30% faster progressive decode"
```

---

## Task 4 — WASM rebuild

**Files:**
- Build artifacts in `packages/jxl-wasm/dist/`

**Background:** Task 1 changed `bridge.cpp`. The dist binaries must be rebuilt for the changes to take effect in the browser. Build uses Emscripten (pre-installed at `C:\Users\User\emsdk`). Per `CLAUDE.md`, use `--host-toolchain` flag to call Emscripten without Docker. The forward-declaration at `bridge.cpp:575` is pre-existing and does not block the build.

- [ ] **Step 1: Build WASM with host toolchain**

```powershell
cmd /c "call C:\Users\User\emsdk\emsdk_env.bat >nul && node packages/jxl-wasm/scripts/build.mjs --host-toolchain"
```

Expected: build completes, updates `packages/jxl-wasm/dist/jxl-core.*.wasm` and `jxl-core.*.js`. A build-manifest.json update in `dist/` confirms the rebuild.

If build fails with a cmake error unrelated to this change, note the error and skip to the smoke-test with old binaries — Task 1 changes that affect behavior are in the open-stream flush path which only activates at runtime.

- [ ] **Step 2: Run full facade test suite**

```powershell
cd packages/jxl-wasm
bun test
```

Expected: all tests PASS including the VarDCT round-trip test which previously fell back to stub. If the VarDCT test still returns `>=3` events, the FRAME_PROGRESSION path is working.

- [ ] **Step 3: Commit dist**

```bash
git add packages/jxl-wasm/dist/
git commit -m "build(wasm): rebuild after removing open-stream opportunistic flush and all-zero scan guard"
```

---

## Task 5 — Smoke test progressive decode with all fixes active

**Goal:** Verify the full-res progressive run looks right in the browser with all four fixes live.

Prerequisites: dev server running (`node tools/dev-server.mjs 8080`), Task 1-4 complete.

- [ ] **Step 1: Load a full-res ORF**

Open `http://localhost:8080/jxl-single-progressive.html`. Drag-drop or select the same `P2200453.ORF` used in the benchmark. Settings: `sizePreset=original`, `quality=95`, `progressiveDc=2`, `progressiveAc=1`, `qProgressiveAc=1`, `groupOrder=1` (center-out), `decodingSpeed=2`, unthrottled.

- [ ] **Step 2: Observe pass count and timing**

Watch the pass strip. Expected:
- Pass count: 4–7 (real FRAME_PROGRESSION boundaries), not 73
- First pass (DC): visible center-out fill, arrives within ~2-3 s
- Final pass: total ≤ 15 s (single-thread) or ≤ 5 s (if simd-mt active)

Open browser console. Check for any decode errors. None expected.

- [ ] **Step 3: Verify tier**

In console on the page after WASM loads:
```javascript
// Check SharedArrayBuffer availability (proxy for thread tier)
console.log('SAB:', typeof SharedArrayBuffer !== 'undefined');
```
If `true`, the MT tier is active. If `false`, confirm COOP/COEP headers are being served (check Network tab), or check that the browser supports SAB.

- [ ] **Step 4: Record timings**

Note from the pass log:
- Total decode time (final pass `t_ms`)
- Pass count
- First-pass time

Compare to pre-fix baseline:
| Metric | Baseline | Target |
|--------|----------|--------|
| Pass count (full res) | 73 | ≤ 8 |
| Total time (single-thread) | 116 s | ≤ 15 s |
| Total time (simd-mt, 4-core) | 116 s | ≤ 5 s |

- [ ] **Step 5: Display-size regression check**

Run a second encode at `sizePreset=display` (1920 px). Expected:
- Pass count: 4–6 (fewer than the old 9, same FRAME_PROGRESSION boundary behavior)
- Total time: ≤ 2 s single-thread, ≤ 500 ms simd-mt
- First-pass time and visual quality unchanged

---

## Task 6 — Add pass-count assertion to existing benchmark (optional but recommended)

**Files:**
- Modify: `benchmark/timing-tests.mjs` (untracked, may not yet have a progressive section)

If `benchmark/timing-tests.mjs` exists and has a progressive-decode section, add an assertion that pass count ≤ 8 for a full-res file. If the file doesn't have one yet, skip this task.

- [ ] **Step 1: Check if benchmark file has a progressive section**

```powershell
Select-String -Path benchmark/timing-tests.mjs -Pattern "progressive|passCount|passes.length" -CaseSensitive:$false | Select-Object -First 5
```

- [ ] **Step 2: If yes, add the assertion**

At the end of the progressive-decode measurement block, add:

```javascript
// Regression guard: with opportunistic flush removed, pass count must reflect
// real FRAME_PROGRESSION boundaries, not one-per-chunk artifacts.
if (result.passCount > 8) {
  throw new Error(`Progressive pass count regression: got ${result.passCount}, expected <= 8`);
}
```

- [ ] **Step 3: Commit if changed**

```bash
git add benchmark/timing-tests.mjs
git commit -m "test(benchmark): assert pass count <= 8 for full-res progressive (regression guard)"
```

---

## Self-Review

### Spec coverage

| Requirement | Task |
|-------------|------|
| Remove per-chunk opportunistic flush (open streams) | Task 1 |
| Keep input_closed flush for Sneyers byte-truncated demo | Task 1 (input_closed branch kept) |
| Skip 82 MB all-zero scan after first flush | Task 1 (flush_count guard) |
| Add flush_count field to struct | Task 1 |
| Update test name/comment | Task 1 |
| COOP/COEP headers for SAB | Task 2 |
| Default decodingSpeed=2 | Task 3 |
| WASM rebuild | Task 4 |
| Smoke test with timing validation | Task 5 |

### UX delta

First-paint timing changes with opportunistic flush removed: previously first paint happened on the first 1 KB chunk (FIRST_PAINT_CHUNK_RAMP[0]). Now first paint happens when libjxl fires the first FRAME_PROGRESSION, which requires enough data for the DC pass. For a display-size 304 KB file, that's roughly the first 60-80 KB — about 2 chunks of steady-state 32 KB. At full-res (2.71 MB), DC is ~480 KB = 15 chunks. Without per-chunk FlushImage these arrive in <200 ms (NEED_MORE is near-instant without flush work). First paint timing impact: negligible in wall time but the center-of-screen fill starts at a coarser granularity. Acceptable tradeoff: clean DC-complete first paint instead of a gradual pixel trickle.

### Placeholder scan

None found. All steps contain complete code or exact commands.

### Type consistency

No new types introduced. `flush_count` field added to existing C struct — C++ zero-initializes via `calloc` at creation (`bridge.cpp:1992`), so no initializer needed in `jxl_wasm_dec_create`.
