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
