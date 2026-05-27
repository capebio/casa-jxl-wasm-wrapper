// jxl-policy/src/index.ts
// Policy presets: viewer, gallery, thumbnail, export, prefetch.
// Spec: Sections 10.3 (progression policy), 9.2 (downsample), 11.3 (effort).
//
// A policy is an overlay applied on top of caller-supplied options.
// Caller-supplied fields always win; the policy only fills gaps.
// Section 10.3 progression policy table + 9.2 downsample defaults.
export const decodePolicies = {
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
};
// Apply a decode policy as defaults under caller-supplied options.
export function applyDecodePolicy(name, base) {
    const p = decodePolicies[name];
    const out = {
        ...base,
        progressionTarget: base.progressionTarget ?? p.progressionTarget,
        emitEveryPass: base.emitEveryPass ?? p.emitEveryPass,
        priority: base.priority ?? p.priority,
    };
    const downsample = base.downsample ?? p.downsample;
    if (downsample !== undefined)
        out.downsample = downsample;
    return out;
}
// Section 11.3 effort defaults: 2 thumbnail, 4 viewer, 7 archival.
export const encodePolicies = {
    thumbnail: { effort: 2, progressive: false, previewFirst: false, priority: "near" },
    viewer: { effort: 4, progressive: true, previewFirst: true, priority: "visible" },
    archival: { effort: 7, progressive: true, previewFirst: false, priority: "background" },
};
export function applyEncodePolicy(name, base) {
    const p = encodePolicies[name];
    return {
        ...base,
        effort: base.effort ?? p.effort,
        progressive: base.progressive ?? p.progressive,
        previewFirst: base.previewFirst ?? p.previewFirst,
        priority: base.priority ?? p.priority,
    };
}
//# sourceMappingURL=index.js.map