/** Wrap the facade's computeButteraugli(a, b, w, h) into a MetricScorer.
 *  In production: import { computeButteraugli } from "@casabio/jxl-wasm".
 *
 *  Perf note: the profiler scores many passes against one final frame, so a ref-reuse
 *  comparator (ButteraugliComparator.create(final)) is the natural backing — pass a
 *  closure over its .compare here instead of computeButteraugli when available. */
export function makeButteraugliScorer(computeButteraugli) {
    return { metric: "butteraugli", score: (cand, ref, w, h) => computeButteraugli(cand, ref, w, h) };
}
/** Wrap the Rust wasm downscale_rgba(src, src_w, src_h, dst_w, dst_h) into a Downscaler.
 *  In production: import init, { downscale_rgba } from the raw-pipeline wasm pkg. */
export function makeWasmDownscaler(downscaleRgba) {
    return (rgba, w, h, dw, dh) => downscaleRgba(rgba, w, h, dw, dh);
}
//# sourceMappingURL=progressive-adapters.js.map