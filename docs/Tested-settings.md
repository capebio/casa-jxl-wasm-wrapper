# Tested Settings

Based on the execution and analysis of the benchmark scenarios (see `Timing Test Summary.md`), the following configurations represent the fastest and most reliable setups for our JXL transcoding pipeline.

These settings are locked in for all subsequent test runs to ensure we are systematically moving towards the fastest setup. Agents utilizing benchmark scripts must refer to these defaults.

## Optimal Encoding Settings

### Web-Facing Full-Size Lightbox (e.g., 1600px - 2400px)
This configuration targets maximum perceived performance by providing a rapid first-paint while maintaining web-standard visual fidelity.

```json
{
  "effort": 3,
  "quality": 85,
  "progressive": true,
  "progressiveFlavor": "ac",
  "previewFirst": false,
  "chunked": true
}
```

### Web-Facing Thumbnails / Gallery (e.g., 400px)
This configuration targets minimum encode latency while maintaining acceptable thumbnail quality.

```json
{
  "effort": 3,
  "quality": 80,
  "progressive": true,
  "progressiveFlavor": "ac",
  "previewFirst": false,
  "chunked": true
}
```

## Decoding Optimization Strategies

To pair with the optimal encode settings, clients and decoders should apply these strategies:

1. **Avoid `previewFirst`**: Benchmarks definitively show that requesting a DC-only pass (preview) adds overhead compared to simply waiting for the first standard progressive AC pass. Do **not** use `previewFirst`.
2. **Region of Interest (ROI) Decoding**: When a user zooms or pans, immediately request a decoded `region` representing the viewport (e.g., center 50%). Region extraction provides significant speedups.
3. **Downsampling for Performance Limits**: On highly constrained devices or for background generation of tiny thumbnails, `downsample: 2` provides a measurable speedup.

## Benchmark Script Overrides

If executing benchmarks that require environmental variables or overrides, agents should default to:
- `EFFORT=3`
- `QUALITY=85` (or `80` for small targets)
- `TARGET=1600` (or `400` for thumbnails)

## Completed Timing Batches

- [x] Tests 13-22 correlation-derived timing sweep (completed 2026-06-06):
  - quality ladder
  - modular mode
  - lossless ladder
  - dots plus color transform
  - photon noise ISO
  - progressive toggle
  - effort shipping window
  - target size ladder
  - source format sweep
  - modular plus lossless matrix

## Updated Presets From Tests 13-22

| Scenario | Target | Quality | Effort | Progressive | Notes |
|---|---:|---:|---:|---|---|
| Gallery thumbnails | 400 | 80 | 3 | true | ~27KB in Test_20 |
| Fast preview | 800 | 85 | 3 | true | ~128KB in Test_20 |
| Web lightbox / streaming | 1600 | 85 | 3 | true | ~466KB in Tests 13/20 |
| Local detail inspection | 2400 | 85-90 | 3 | true | ~942KB at q85 in Test_20 |
| Archival exactness | 1600+ | lossless | 3 | true | 6MB+ at 1600px; use only when exactness wins |
