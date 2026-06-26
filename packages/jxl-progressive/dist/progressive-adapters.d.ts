import type { MetricScorer } from "./progressive-metrics.js";
import type { Downscaler } from "./progressive-profile.js";
/** Wrap the facade's computeButteraugli(a, b, w, h) into a MetricScorer.
 *  In production: import { computeButteraugli } from "@casabio/jxl-wasm".
 *
 *  Perf note: the profiler scores many passes against one final frame, so a ref-reuse
 *  comparator (ButteraugliComparator.create(final)) is the natural backing — pass a
 *  closure over its .compare here instead of computeButteraugli when available. */
export declare function makeButteraugliScorer(computeButteraugli: (a: Uint8Array, b: Uint8Array, w: number, h: number) => Promise<number>): MetricScorer;
/** Wrap the Rust wasm downscale_rgba(src, src_w, src_h, dst_w, dst_h) into a Downscaler.
 *  In production: import init, { downscale_rgba } from the raw-pipeline wasm pkg. */
export declare function makeWasmDownscaler(downscaleRgba: (src: Uint8Array, srcW: number, srcH: number, dstW: number, dstH: number) => Uint8Array): Downscaler;
//# sourceMappingURL=progressive-adapters.d.ts.map