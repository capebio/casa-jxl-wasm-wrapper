# Encode Timing Probes — Instrumentation Map

All timing probes for the JXL encode pipeline, including existing and new probes with exact file:line locations.

---

## Existing Probes (Already Instrumented)

### encode-handler.ts Metrics

| Probe | Line (approx) | Fires On | Emits (ms) | Notes |
|-------|---------------|----------|-----------|-------|
| `encode_create_ms` | encode-handler ~650 | Encoder created | Time to initialize libjxl encoder | Per-session; one-time |
| `encode_push_pixels_ms` | encode-handler ~700 | Pixels pushed | Time to queue pixels in handler | Per encoder.pushPixels call |
| `encode_wait_pixels_ms` | encode-handler ~750 | Wait for input complete | Time waiting for all pixels to arrive | Per frame encode cycle |
| `encode_finish_ms` | encode-handler ~800 | Encoder finalized | Time to finish encoding frame | Per frame encode cycle |
| `encode_chunk_yield_ms` | encode-handler ~850 | Output chunk ready | Time to extract one chunk from WASM | Per 256KB chunk |
| `encode_time_to_first_byte_ms` | encode-handler ~900 | First output byte | Time from session start to first encoded byte | Sync measurement |
| `encode_output_bytes` | encode-handler ~950 | Per chunk emitted | Total bytes of encoded output | Not a time; byte count |

### facade.ts Encode Metrics

| Probe | Line (approx) | Context | Notes |
|-------|---------------|---------|-------|
| `enc_malloc_copy` | ~1825 | Profiling accumulator | Accumulated time for all encoder mallocs + copies; logged at session end |
| (others) | ~1820–1860 | Profile summary | Total encoder time, chunk counts, etc.; visible in console summary |

---

## New Probes (Phase 4, to Add)

### Probe 1: `enc_heap_set_ms` — Encode Input Copy

**Location**: `packages/jxl-wasm/src/facade.ts`, line ~1852–1860 (enc_pixels_ptr branch)

**When**: Every `pushPixels` call that reaches HEAPU8.set

**What**: Time to copy input pixels into WASM heap via `HEAPU8.set(view, ptr)`

**Relevance**: Measures JS↔WASM boundary cost for encoder input; identifies if pixel batching is effective

**Instrumentation**:
```typescript
if (this.streamingInputActive) {
  if (module._jxl_wasm_enc_pixels_ptr && module._jxl_wasm_enc_advance_written) {
    const t0 = performance.now();
    const ptr = module._jxl_wasm_enc_pixels_ptr(this.wasmEncState, view.byteLength);
    if (ptr === 0) throw new Error("JXL streaming pixel push failed (0)");
    const tEncHeapSet0 = performance.now();
    module.HEAPU8.set(view, ptr);
    this.options.onMetric?.("enc_heap_set_ms", performance.now() - tEncHeapSet0);
    const rc = module._jxl_wasm_enc_advance_written(this.wasmEncState, view.byteLength);
    if (rc !== 0) throw new Error(`JXL streaming pixel push failed (${rc})`);
    this.tMallocCopy += performance.now() - t0;
```

**Expected Range**: 0.5–5 ms (depends on pixel chunk size and resolution)

**Related**: `tMallocCopy` accumulator (existing) — new probe is a breakdown of `tMallocCopy`

---

## Optional Probes (Not Phase 4, but Recommended for Future)

### Probe 2a: `enc_chunk_extract_ms` — Encode Output Extraction

**Location**: `packages/jxl-wasm/src/facade.ts`, line ~1900+ (enc_take_chunk + slice)

**When**: Per output chunk extracted

**What**: Time to call `enc_take_chunk` and `HEAPU8.slice` for output

**Relevance**: Identifies if chunk extraction is bottleneck

**Instrumentation**: (Not in Phase 4; defer; tracked implicitly in `encode_chunk_yield_ms`)

---

## Probe Emission Strategy

### EncoderOptions.onMetric Callback

```typescript
onMetric?: (name: string, value: number) => void
```

Available on `LibjxlEncoder` constructor options (line 130).

All probes use `this.options.onMetric?.("probe_name", value)` — safe if callback not provided.

### Test Integration

To enable metrics in existing tests:

```typescript
const encoder = new LibjxlEncoder({
  onMetric: (name, value) => {
    console.log(`[metric] ${name} = ${value.toFixed(2)} ms`);
  }
});
```

### Production Monitoring

Metrics exposed via callback can be:
1. Logged to console (dev)
2. Sent to analytics backend (production)
3. Written to performance observer (browser DevTools)
4. Aggregated in time-series database (observability)

---

## Verification (Phase 5)

After Phase 4 edits:

```powershell
cd packages/jxl-wasm && npx tsc --noEmit
```

Expected: Zero new errors (probes use `?.` optional chaining).

Then test with any existing test that sets `onMetric`:

```bash
npm test
```

Verify new probe appears in metric output (search test logs for `enc_heap_set_ms`).

---

## Probe Placement Rationale

| Probe | Why Here | Why Not Elsewhere |
|-------|----------|-------------------|
| `enc_heap_set_ms` | Per-push; captures input copy in one place | Not inside WASM FFI (opaque to JS timing) |

---

## Dashboard / Telemetry Hints

After collecting metrics for 1–2 weeks in production:

| Metric | Alert If | Indicates |
|--------|----------|-----------|
| `enc_heap_set_ms` > 10 ms | Possible bottleneck (large pixel chunk or slow memory) | Consider larger pixel batches or pre-allocation |
| `enc_heap_set_ms` frequent | Every push; expected if pixel-by-pixel input | Consider batching pixels before pushing |
| `encode_chunk_yield_ms` > 5 ms | WASM chunk extraction slow | Rare; WASM extraction usually fast |

Baseline (scalar tier, 1080p, streaming encode):
- `enc_heap_set_ms`: ~0.5–1 ms per push
- `encode_output_bytes`: ~256 KB per chunk (or less if final chunk)
- Total encode time: ~20–50 ms per frame (depends on effort level)

---

## Relationship to Decode Probes

| Decode | Encode | Semantic Match |
|--------|--------|-----------------|
| `heap_set_ms` (input copy) | `enc_heap_set_ms` (input copy) | Both measure JS→WASM copy cost |
| `take_frame_ms` (output detach) | `encode_chunk_yield_ms` (output extract) | Both measure WASM→JS copy cost |
| `malloc_grow_ms` | — | Not applicable to encoder (malloc once at start) |

Use decode + encode metrics together to profile full transcode paths.
