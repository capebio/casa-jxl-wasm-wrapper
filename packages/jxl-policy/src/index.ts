// jxl-policy/src/index.ts
// Policy presets: viewer, gallery, thumbnail, export, prefetch.
// Spec: Sections 10.3 (progression policy), 9.2 (downsample), 11.3 (effort).
//
// A policy is an overlay applied on top of caller-supplied options.
// Caller-supplied fields always win; the policy only fills gaps.

import type { DecodeOptions, EncodeOptions } from "@casabio/jxl-core";

// ---------------------------------------------------------------------------
// Decode policies
// ---------------------------------------------------------------------------

export type DecodePolicyName = "thumbnail" | "gallery" | "viewer" | "export" | "prefetch";

export interface DecodePolicy {
  progressionTarget: "header" | "dc" | "pass" | "final";
  emitEveryPass: boolean;
  priority: "visible" | "near" | "background";
  downsample?: 1 | 2 | 4 | 8;
}

// Section 10.3 progression policy table + 9.2 downsample defaults.
export const decodePolicies: Record<DecodePolicyName, DecodePolicy> = {
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
export function applyDecodePolicy(name: DecodePolicyName, base: DecodeOptions): DecodeOptions {
  const p = decodePolicies[name];
  const out: DecodeOptions = {
    ...base,
    progressionTarget: base.progressionTarget ?? p.progressionTarget,
    emitEveryPass: base.emitEveryPass ?? p.emitEveryPass,
    priority: base.priority ?? p.priority,
  };
  const downsample = base.downsample ?? p.downsample;
  if (downsample !== undefined) out.downsample = downsample;
  return out;
}

// ---------------------------------------------------------------------------
// Encode policies
// ---------------------------------------------------------------------------

export type EncodePolicyName = "thumbnail" | "viewer" | "archival";

export interface EncodePolicy {
  effort: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  progressive: boolean;
  previewFirst: boolean;
  priority: "visible" | "near" | "background";
}

// Section 11.3 effort defaults: 2 thumbnail, 4 viewer, 7 archival.
export const encodePolicies: Record<EncodePolicyName, EncodePolicy> = {
  thumbnail: { effort: 2, progressive: false, previewFirst: false, priority: "near" },
  viewer: { effort: 4, progressive: true, previewFirst: true, priority: "visible" },
  archival: { effort: 7, progressive: true, previewFirst: false, priority: "background" },
};

export function applyEncodePolicy(name: EncodePolicyName, base: EncodeOptions): EncodeOptions {
  const p = encodePolicies[name];
  return {
    ...base,
    effort: base.effort ?? p.effort,
    progressive: base.progressive ?? p.progressive,
    previewFirst: base.previewFirst ?? p.previewFirst,
    priority: base.priority ?? p.priority,
  };
}
