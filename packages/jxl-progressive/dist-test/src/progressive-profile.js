// packages/jxl-progressive/src/progressive-profile.ts
import {} from "./progressive-manifest.js";
import { meetsThreshold, psnrVsRef, ssimVsRef } from "./progressive-metrics.js";
function defaultDcThreshold(m) { return m === "butteraugli" ? 3.0 : m === "ssim" ? 0.7 : 20; }
function defaultPreviewThreshold(m) { return m === "butteraugli" ? 1.5 : m === "ssim" ? 0.9 : 30; }
/** Scores must be finite for JSON sidecar round-trip (JSON.stringify(Infinity) === "null")
 *  and pass validateManifest. An identical pass yields psnr === Infinity; cap it to a large
 *  finite sentinel. NaN / -Infinity (degenerate) → 0. */
const SCORE_MAX = 1000;
function finiteScore(v) {
    if (Number.isFinite(v))
        return v;
    return v > 0 ? SCORE_MAX : 0;
}
/** Choose dc/preview byteEnds as the earliest progression event whose score clears the
 *  tier threshold. byteEnd always comes from a real progression event (never a guessed
 *  byte count). Full tier is always the total. */
export function selectTiersByScore(events, totalBytes, metric, thresholds) {
    const tiers = [];
    const firstMeeting = (t) => events.find((e) => e.byteOffset > 0 && e.byteOffset < totalBytes && meetsThreshold(metric, e.score, t));
    const dcEvent = firstMeeting(thresholds.dc);
    if (dcEvent !== undefined) {
        tiers.push({
            name: "dc", byteStart: 0, byteEnd: dcEvent.byteOffset, progressionIndex: dcEvent.progressionIndex,
            intendedUse: "thumbnail", score: { metric, value: finiteScore(dcEvent.score), reference: "final" },
        });
    }
    const previewEvent = firstMeeting(thresholds.preview);
    if (previewEvent !== undefined && previewEvent.byteOffset > (dcEvent?.byteOffset ?? 0)) {
        tiers.push({
            name: "preview", byteStart: 0, byteEnd: previewEvent.byteOffset, progressionIndex: previewEvent.progressionIndex,
            intendedUse: "visible-card", score: { metric, value: finiteScore(previewEvent.score), reference: "final" },
        });
    }
    tiers.push({ name: "full", byteStart: 0, byteEnd: totalBytes, progressionIndex: "final", intendedUse: "zoom-export" });
    return tiers;
}
function dimsForLongestEdge(srcW, srcH, longest) {
    const edge = Math.max(srcW, srcH);
    if (longest >= edge)
        return { dw: srcW, dh: srcH };
    const scale = longest / edge;
    return { dw: Math.max(1, Math.round(srcW * scale)), dh: Math.max(1, Math.round(srcH * scale)) };
}
/** For each display size, find the earliest pass that clears the preview threshold once
 *  both pass and final are downsampled to that size; map it to the smallest covering tier.
 *  A pass insufficient at native res can be sufficient at thumbnail res, so frontier
 *  byteEnds shrink with display size. */
export async function buildScaleFrontier(args) {
    const { passes, finalPixels, srcW, srcH, tiers, metric, thresholds, displaySizes, downscaler } = args;
    const score = args.scorerAt ?? ((c, r, w, h) => metric === "ssim" ? ssimVsRef(c, r, w, h) : psnrVsRef(c, r));
    const tierForByteEnd = (be) => tiers.find((t) => t.byteEnd >= be) ?? tiers[tiers.length - 1];
    const out = [];
    for (const longest of displaySizes) {
        const { dw, dh } = dimsForLongestEdge(srcW, srcH, longest);
        const refDown = downscaler(finalPixels, srcW, srcH, dw, dh);
        let chosen;
        for (const p of passes) {
            const candDown = downscaler(p.pixels, srcW, srcH, dw, dh);
            const value = await score(candDown, refDown, dw, dh);
            if (meetsThreshold(metric, value, thresholds.preview)) {
                const t = tierForByteEnd(p.byteOffset);
                chosen = { byteEnd: t.byteEnd, tier: t.name, value };
                break;
            }
        }
        const fallback = tiers[tiers.length - 1];
        const e = chosen ?? { byteEnd: fallback.byteEnd, tier: fallback.name, value: thresholds.preview };
        out.push({ maxDisplayPx: longest, tier: e.tier, byteEnd: e.byteEnd, score: { metric, value: finiteScore(e.value), reference: "final" } });
    }
    return out;
}
// Yield control until all pending microtasks (including async-generator machinery)
// have drained. Needed so framesTask reads bytesPushed before pushTask advances it
// for the next chunk. setImmediate (Node) fires after all microtasks; setTimeout(0)
// (browser) fires after the current event-loop task + microtasks.
function drainMicrotasks() {
    if (typeof setImmediate === "function") {
        return new Promise((r) => setImmediate(r));
    }
    return new Promise((r) => setTimeout(r, 0));
}
async function computeSha256(buffer) {
    if (typeof globalThis.crypto !== "undefined" &&
        typeof globalThis.crypto.subtle?.digest === "function") {
        const hashBuf = await globalThis.crypto.subtle.digest("SHA-256", buffer);
        return Array.from(new Uint8Array(hashBuf))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
    }
    // Node.js fallback
    const { createHash } = await import("node:crypto");
    return createHash("sha256").update(Buffer.from(buffer)).digest("hex");
}
function selectTiers(events, totalBytes) {
    const tiers = [];
    if (events.length === 0 || totalBytes === 0) {
        tiers.push({
            name: "full",
            byteStart: 0,
            byteEnd: totalBytes,
            progressionIndex: "final",
            intendedUse: "zoom-export",
        });
        return tiers;
    }
    // DC tier: first 'dc' stage event, or first event before 25% of file.
    const dcEvent = events.find((e) => e.stage === "dc") ??
        events.find((e) => e.byteOffset < totalBytes * 0.25) ??
        events[0];
    // Only emit the dc tier if byteEnd > 0; a zero byteEnd is unusable.
    if (dcEvent !== undefined && dcEvent.byteOffset > 0) {
        tiers.push({
            name: "dc",
            byteStart: 0,
            byteEnd: dcEvent.byteOffset,
            progressionIndex: dcEvent.progressionIndex,
            intendedUse: "thumbnail",
        });
    }
    // Preview tier: last event before 70% of file, distinct from dc.
    // Use a reverse scan to avoid allocating a filtered array.
    const threshold70 = totalBytes * 0.7;
    let previewEvent;
    for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].byteOffset < threshold70) {
            previewEvent = events[i];
            break;
        }
    }
    if (previewEvent !== undefined &&
        previewEvent !== dcEvent &&
        previewEvent.byteOffset > (dcEvent?.byteOffset ?? 0)) {
        tiers.push({
            name: "preview",
            byteStart: 0,
            byteEnd: previewEvent.byteOffset,
            progressionIndex: previewEvent.progressionIndex,
            intendedUse: "visible-card",
        });
    }
    // Full tier: always the complete file.
    tiers.push({
        name: "full",
        byteStart: 0,
        byteEnd: totalBytes,
        progressionIndex: "final",
        intendedUse: "zoom-export",
    });
    return tiers;
}
/**
 * Drive a throw-away DecodeSession in small byte increments,
 * record progression events, and return a ProgressiveManifest.
 *
 * Works in both Node.js and browser environments — accepts pre-loaded bytes,
 * performs no I/O internally.
 */
export async function profileJxl(jxlBytes, sessionFactory, source, opts = {}) {
    const { chunkSize = 4096, signal, onProgress, encoderName = "unknown", libjxlVersion = "unknown", encoderFlags = [], saliency, } = opts;
    if (signal?.aborted)
        throw new DOMException("Aborted", "AbortError");
    const session = sessionFactory();
    const events = [];
    let bytesPushed = 0;
    let progressionIdx = 0;
    // Collect frames concurrently with pushing bytes.
    // drainMicrotasks() after each push ensures framesTask reads bytesPushed before
    // pushTask advances it for the next chunk (async-generator delivery adds 2+ hops).
    const capturePixels = opts.scorer !== undefined;
    const framesTask = (async () => {
        for await (const frame of session.frames()) {
            let snap;
            if (capturePixels) {
                const px = frame.pixels;
                // Copy: the decoder may reuse the underlying buffer on the next pass.
                if (px !== undefined)
                    snap = Uint8Array.from(px instanceof Uint8Array ? px : new Uint8Array(px));
            }
            events.push({
                byteOffset: bytesPushed,
                stage: frame.stage,
                progressionIndex: progressionIdx++,
                pixels: snap,
            });
        }
    })();
    const pushTask = (async () => {
        const total = jxlBytes.byteLength;
        let offset = 0;
        try {
            while (offset < total) {
                if (signal?.aborted)
                    throw new DOMException("Aborted", "AbortError");
                const end = Math.min(offset + chunkSize, total);
                bytesPushed = end;
                await session.push(jxlBytes.slice(offset, end));
                await drainMicrotasks();
                onProgress?.(end, total);
                offset = end;
            }
            await session.close();
        }
        catch (e) {
            // Cancel the session so framesTask's frames() generator terminates
            // rather than hanging indefinitely waiting for more frames.
            await session.cancel().catch(() => { });
            throw e;
        }
    })();
    await Promise.all([pushTask, framesTask]);
    const sha256 = await computeSha256(jxlBytes);
    let tiers;
    if (opts.scorer !== undefined) {
        const finalEvent = [...events].reverse().find((e) => e.pixels !== undefined && e.pixels.length > 0);
        const scored = [];
        if (finalEvent?.pixels !== undefined) {
            for (const e of events) {
                if (e.pixels === undefined || e.pixels.length !== finalEvent.pixels.length)
                    continue;
                const value = await opts.scorer.score(e.pixels, finalEvent.pixels, source.width, source.height);
                scored.push({ byteOffset: e.byteOffset, progressionIndex: e.progressionIndex, score: value });
            }
        }
        tiers = scored.length > 0
            ? selectTiersByScore(scored, jxlBytes.byteLength, opts.scorer.metric, opts.thresholds ?? { dc: defaultDcThreshold(opts.scorer.metric), preview: defaultPreviewThreshold(opts.scorer.metric) })
            : selectTiers(events, jxlBytes.byteLength);
    }
    else {
        tiers = selectTiers(events, jxlBytes.byteLength);
    }
    const manifest = {
        version: 1,
        source: {
            width: source.width,
            height: source.height,
            hasAlpha: source.hasAlpha,
            orientation: source.orientation ?? 1,
        },
        jxl: { bytes: jxlBytes.byteLength, sha256 },
        encoder: { name: encoderName, libjxlVersion, flags: encoderFlags },
        tiers,
    };
    if (saliency !== undefined) {
        manifest.saliency = saliency;
    }
    if (opts.scorer !== undefined && opts.displaySizes !== undefined && opts.downscaler !== undefined) {
        const finalEvent = [...events].reverse().find((e) => e.pixels !== undefined && e.pixels.length > 0);
        if (finalEvent?.pixels !== undefined) {
            const finalPixels = finalEvent.pixels;
            const passes = events
                .filter((e) => e.pixels !== undefined && e.pixels.length === finalPixels.length)
                .map((e) => ({ byteOffset: e.byteOffset, progressionIndex: e.progressionIndex, pixels: e.pixels }));
            manifest.scaleFrontier = await buildScaleFrontier({
                passes, finalPixels, srcW: source.width, srcH: source.height,
                tiers: manifest.tiers, totalBytes: jxlBytes.byteLength, metric: opts.scorer.metric,
                thresholds: opts.thresholds ?? { dc: defaultDcThreshold(opts.scorer.metric), preview: defaultPreviewThreshold(opts.scorer.metric) },
                displaySizes: opts.displaySizes, downscaler: opts.downscaler, scorerAt: opts.scorer.score,
            });
        }
    }
    return manifest;
}
/**
 * Node.js helper: read a .jxl file, profile it, and optionally write
 * the manifest as `${path}.json` beside the original file.
 */
export async function profileJxlFile(path, sessionFactory, source, opts = {}) {
    const { readFile, writeFile } = await import("node:fs/promises");
    const buf = await readFile(path);
    // Slice to exact bytes: node Buffer.buffer is often a larger slab from the fs pool.
    // Passing the full backing ArrayBuffer causes sha256 + profile push to ingest garbage,
    // leading to hash mismatches downstream (F8).
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const manifest = await profileJxl(ab, sessionFactory, source, opts);
    if (opts.writeManifest !== false) {
        await writeFile(`${path}.json`, JSON.stringify(manifest, null, 2), "utf-8");
    }
    return manifest;
}
//# sourceMappingURL=progressive-profile.js.map