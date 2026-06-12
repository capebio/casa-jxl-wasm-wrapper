// jxl-policy/src/index.ts
// Policy presets: viewer, gallery, thumbnail, export, prefetch, mlInference.
// Spec: Sections 10.3 (progression policy), 9.2 (downsample), 11.3 (effort).
//
// A policy is an overlay applied on top of caller-supplied options.
// Caller-supplied fields always win; the policy only fills gaps.
// Section 10.3 progression policy table + 9.2 downsample defaults.
export const decodePolicies = Object.freeze({
    // Thumbnail list: one useful preview, then stop. Downsample 8 (Section 9.2/9.3).
    thumbnail: { progressionTarget: "dc", emitEveryPass: false, priority: "near", downsample: 8 },
    // Gallery near-viewport: DC only; promote to viewer on tap.
    gallery: { progressionTarget: "dc", emitEveryPass: false, priority: "near", downsample: 4 },
    // Viewer (visible): refine while visible.
    viewer: { progressionTarget: "final", emitEveryPass: true, priority: "visible" },
    // Export: no intermediates needed.
    export: { progressionTarget: "final", emitEveryPass: false, priority: "visible" },
    // Background prefetch: lowest priority, easily preempted.
    prefetch: { progressionTarget: "dc", emitEveryPass: false, priority: "background", downsample: 4 },
    // ML inference: final-quality pixels, small, off the interactive path.
    mlInference: { progressionTarget: "final", emitEveryPass: false, priority: "background", downsample: 4 },
});
export function isDecodePolicyName(s) {
    return Object.prototype.hasOwnProperty.call(decodePolicies, s);
}
// Apply a decode policy as defaults under caller-supplied options.
export function applyDecodePolicy(name, base) {
    const p = decodePolicies[name];
    if (!p) {
        throw new RangeError(`Unknown decode policy "${name}" (valid: ${Object.keys(decodePolicies).join(", ")})`);
    }
    const out = {
        ...base,
        progressionTarget: base.progressionTarget ?? p.progressionTarget,
        emitEveryPass: base.emitEveryPass ?? p.emitEveryPass,
        priority: base.priority ?? p.priority,
    };
    const downsample = base.downsample ?? p.downsample;
    if (downsample !== undefined) {
        out.downsample = downsample;
    }
    else {
        delete out.downsample; // spread may have copied an explicit-undefined key from base
    }
    return out;
}
// Section 11.3 effort defaults: 2 thumbnail, 3 viewer (optimized), 7 archival.
export const encodePolicies = Object.freeze({
    thumbnail: { effort: 2, progressive: false, previewFirst: false, priority: "near" },
    viewer: { effort: 3, progressive: true, previewFirst: true, priority: "visible", groupOrder: 1 },
    archival: { effort: 7, progressive: true, previewFirst: false, priority: "background" },
});
export function isEncodePolicyName(s) {
    return Object.prototype.hasOwnProperty.call(encodePolicies, s);
}
export function applyEncodePolicy(name, base) {
    const p = encodePolicies[name];
    if (!p) {
        throw new RangeError(`Unknown encode policy "${name}" (valid: ${Object.keys(encodePolicies).join(", ")})`);
    }
    const out = {
        ...base,
        effort: base.effort ?? p.effort,
        progressive: base.progressive ?? p.progressive,
        previewFirst: base.previewFirst ?? p.previewFirst,
        priority: base.priority ?? p.priority,
    };
    const groupOrder = base.groupOrder ?? p.groupOrder;
    if (groupOrder !== undefined) {
        out.groupOrder = groupOrder;
    }
    else {
        delete out.groupOrder;
    }
    return out;
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * Largest power-of-two downsample (1|2|4|8) whose result still covers
 * containerW×containerH (CSS px × devicePixelRatio if you want crisp output).
 * Section 9.2: thumbnail downsample "4 or 8 depending on container size".
 */
export function downsampleForContainer(imageW, imageH, containerW, containerH) {
    if (imageW <= 0 || imageH <= 0 || containerW <= 0 || containerH <= 0)
        return 1;
    const ratio = Math.min(imageW / containerW, imageH / containerH);
    if (ratio < 2)
        return 1;
    // floor(log2(ratio)) via clz32 — ratio >= 2 here so (ratio|0) >= 2
    const log2 = 31 - Math.clz32(ratio | 0);
    return (1 << Math.min(log2, 3));
}
//# sourceMappingURL=index.js.map