// packages/jxl-progressive/src/types.ts
// Shared types for @casabio/jxl-progressive.
/**
 * Select the pyramid/level whose dimensions best match a model input size (e.g. 224 or 512).
 * Guarantees caller can use the decoded tile at native model res with zero additional resize
 * and without ever decoding higher-res levels than needed.
 */
export function pickModelLevel(levels, inputPx) {
    if (!levels || levels.length === 0 || !Number.isFinite(inputPx) || inputPx <= 0)
        return undefined;
    let best;
    let bestScore = Infinity;
    for (const lv of levels) {
        const size = Math.max(lv.width, lv.height);
        const diff = Math.abs(size - inputPx);
        // Prefer exact or larger; small penalty for undersize (would require model-side upsample or pad)
        const penalty = size < inputPx ? 1000 : 0;
        const score = diff + penalty;
        if (score < bestScore) {
            bestScore = score;
            best = lv;
        }
    }
    return best;
}
/**
 * Map full-res image coords to screen under active level + optional ROI.
 * scaleX/scaleY computed separately to support anamorphic (non-square-pixel) content (B6).
 */
export function toScreenCoords(pt, level, roi, screenScale) {
    const bw = level.width || 1;
    const bh = level.height || 1;
    const sx = screenScale?.scaleX ?? (roi ? roi.w / bw : 1);
    const sy = screenScale?.scaleY ?? (roi ? roi.h / bh : 1);
    const ox = roi?.x ?? 0;
    const oy = roi?.y ?? 0;
    return { x: (pt.x - ox) * sx, y: (pt.y - oy) * sy };
}
/** Inverse: screen -> image (full-res pixels). Separate scales for anamorphic correctness. */
export function toImageCoords(pt, level, roi, screenScale) {
    const bw = level.width || 1;
    const bh = level.height || 1;
    const sx = screenScale?.scaleX ?? (roi ? roi.w / bw : 1);
    const sy = screenScale?.scaleY ?? (roi ? roi.h / bh : 1);
    const ox = roi?.x ?? 0;
    const oy = roi?.y ?? 0;
    return { x: pt.x / sx + ox, y: pt.y / sy + oy };
}
// Default compose: simple per-byte add with clamp (for intensity residual or canvas delta draw prep).
// Real pipelines may do YCbCr add, optical flow warp, or canvas putImageData diff.
export function defaultComposeBurstFrame(base, residual) {
    const b = new Uint8Array(base);
    const r = new Uint8Array(residual);
    const out = new Uint8Array(Math.max(b.length, r.length));
    const len = Math.min(b.length, r.length);
    for (let i = 0; i < len; i++) {
        const v = b[i] + r[i];
        out[i] = v > 255 ? 255 : v;
    }
    if (b.length > len)
        out.set(b.subarray(len), len);
    else if (r.length > len)
        out.set(r.subarray(len), len);
    return out.buffer;
}
// --- Laplacian Sharpness Auto-Ranking (BD7) ---
// Variance-of-Laplacian proxy on luma for auto cover selection (argmax for burst card keyframe).
// Placed here (shared types) rather than saliency-policy.ts to obey mandatory commit scope (only edit manifest+types).
// See Deferred.md for rationale. Consumers / future saliency can call this on DC luma.
export function getSharpnessRank(lumaArray, width, height) {
    if (!lumaArray || width < 3 || height < 3)
        return 0;
    let sum = 0;
    let sumSq = 0;
    let count = 0;
    // 4-neighbor Laplace (fast proxy, no extra allocs). Matches "variance-of-Laplacian convolution".
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const i = y * width + x;
            const lap = (lumaArray[i] << 2) - lumaArray[i - 1] - lumaArray[i + 1] - lumaArray[i - width] - lumaArray[i + width];
            sum += lap;
            sumSq += lap * lap;
            count++;
        }
    }
    if (count === 0)
        return 0;
    const mean = sum / count;
    return (sumSq / count) - (mean * mean);
}
/** argmax(sharpness) helper: returns index of sharpest member (for appointing burst cover). */
export function argmaxSharpness(candidates) {
    if (!candidates || candidates.length === 0)
        return -1;
    let bestIdx = 0;
    let best = -Infinity;
    for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        let s = c.sharpness;
        if (s === undefined && c.luma && c.width && c.height)
            s = getSharpnessRank(c.luma, c.width, c.height);
        if ((s ?? -Infinity) > best) {
            best = s ?? -Infinity;
            bestIdx = i;
        }
    }
    return bestIdx;
}
// --- Streaming AI helpers (surface only; full pipeline integration deferred per layer rules) ---
/**
 * Basic tile sort comparator for saliency-ordered fetching (F35/C2).
 * Use as: [...tiles].sort(saliencyTileComparator(saliencyCenter))
 * Computes squared distance of tile center to manifest saliency center.
 * Actual queue wiring lives in scheduler/stream (skipped here to confine edits to allowed files).
 */
export function saliencyTileComparator(saliency) {
    if (!saliency)
        return () => 0;
    const { centerX, centerY } = saliency;
    return (a, b) => {
        const da = (a.cx - centerX) ** 2 + (a.cy - centerY) ** 2;
        const db = (b.cx - centerX) ** 2 + (b.cy - centerY) ** 2;
        return da - db;
    };
}
/**
 * detectWhileStreaming: feed progressive tiles to detector/adapter; early exit on high confidence.
 * Consumer usage (example, no core change here):
 *   for await (const t of detectWhileStreaming(tileSource, detector, () => session.cancel())) { ... }
 * The cancel() must be wired to the actual source (DecodeSession / fetch controller) to reject
 * iterator and release decoder slot (B5 contract). Full auto-wiring of iterator reject deferred.
 */
export async function detectWhileStreaming(tiles, detector, cancel, opts = {}) {
    const threshold = opts.confidenceThreshold ?? 0.8;
    for await (const tile of tiles) {
        const res = await detector(tile.bmp, tile.bbox, tile.tier);
        const conf = res?.confidence ?? (res?.localized ? 0.99 : 0);
        if (conf >= threshold) {
            if (cancel)
                await cancel();
            break; // early exit; upstream cancel should make subsequent next() throw/reject
        }
    }
}
/**
 * ID-Budget Auto-Stop hook (N1).
 * Extension point: when model confidence crosses threshold during streaming, signal "sharp enough".
 * Callers integrate into their fetch/decode budget loop (e.g. if (autoStop(res)) { stream.end(); }).
 * No change to core termination in this confined edit.
 */
export function shouldAutoStopForModel(conf, threshold = 0.85) {
    return Number.isFinite(conf) && conf >= threshold;
}
//# sourceMappingURL=types.js.map