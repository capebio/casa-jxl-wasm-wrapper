export type MetricName = "ssim" | "psnr" | "butteraugli";
/** A scorer compares a candidate RGBA8 frame against a reference RGBA8 frame
 *  of the same dimensions and returns a scalar. Async to allow wasm-backed scorers. */
export type MetricScorer = {
    metric: MetricName;
    score: (candidate: Uint8Array, reference: Uint8Array, w: number, h: number) => Promise<number>;
};
/** PSNR in dB of `candidate` vs `reference` (RGBA8, alpha ignored). Higher is better. */
export declare function psnrVsRef(candidate: Uint8Array, reference: Uint8Array): number;
/** Single-window global SSIM on luma of `candidate` vs `reference`. Higher is better (max 1). */
export declare function ssimVsRef(candidate: Uint8Array, reference: Uint8Array, w: number, h: number): number;
/** True when `value` is "good enough" for `metric` at `threshold`.
 *  ssim/psnr: higher is better. butteraugli: lower is better. */
export declare function meetsThreshold(metric: MetricName, value: number, threshold: number): boolean;
//# sourceMappingURL=progressive-metrics.d.ts.map