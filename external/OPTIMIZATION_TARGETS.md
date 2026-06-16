# LibJXL Optimization Targets

Source: `external/libjxl/` at commit `332feb17d17311c748445f7ee75c4fb55cc38530`

## Core Encoder (VarDCT + Modular)

- **lib/jxl/encode.cc** — Main encoder entry point & pipeline
- **lib/jxl/ans_common.cc** — Adaptive Numbering System entropy coding (hot path)
- **lib/jxl/ac_strategy.cc** — Adaptive coefficient strategy selection
- **lib/jxl/coeff_order.cc** — Coefficient ordering for entropy context
- **lib/jxl/compressed_dc.cc** — DC component compression
- **lib/jxl/modular/encoding/** — Modular mode (lossless/near-lossless)

## Core Decoder

- **lib/jxl/decode.cc** — Main decoder entry point & pipeline
- **lib/jxl/box_content_decoder.cc** — Box/container format parsing
- **lib/jxl/modular/** — Modular decoding (inverse transform, prediction)
- **lib/jxl/render_pipeline/** — Final pixel output stage (color space, tone mapping)

## Perceptual Metrics (Butteraugli)

- **lib/jxl/butteraugli/butteraugli.cc** — Distance metric (memory-bound, SIMD headroom)
- Used for quality tuning & perceptual heuristics in encoder

## Memory/Allocation

- **lib/jxl/base/memory_manager.cc** — Allocator hooks (bridged via `bridge.cpp`)
- **lib/jxl/base/** — Base utilities (arena allocators, fast paths)

## Known Bottlenecks (from CLAUDE.md project notes)

1. **Butteraugli on large images** — Memory-bound, ~2× SIMD headroom available
2. **ANS entropy coding loops** — Hot path in encoder (tight inner loops)
3. **VarDCT DCT-II transforms** — Inverse transforms in decoder
4. **Modular context modeling** — Prediction + arithmetic coding

## Quick Build After Edits

```powershell
# After editing .cc files in external/libjxl/
.\build-parallel-wasm.ps1 -Features parallel-wasm
```

The build script will:
1. Copy external/libjxl/ into Docker container (or use local Emscripten)
2. Recompile with your modifications
3. Output new jxl-core.*.wasm & .js to packages/jxl-wasm/dist/
4. Rebuild TS package wrapper

## Verification

After rebuild, test with:
```bash
cd C:\Foo\raw-converter-wasm
npm test -w packages/jxl-wasm
node StandardMultifileTest.mjs
```

Benchmark output (.toon file) will show timing deltas vs baseline.
