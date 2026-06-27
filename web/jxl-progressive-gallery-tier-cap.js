// web/jxl-progressive-gallery-tier-cap.js
// Decode-byte cap decision for the progressive gallery. Pure + side-effect free so it
// is unit-testable without a browser. Imports the sibling package by relative dist path
// (matching how jxl-progressive-gallery.js imports @casabio/jxl-session).
import { selectTierForDisplay } from '../packages/jxl-progressive/dist/index.js';

/**
 * Decide how many leading bytes of an encoded JXL to decode for an element of the given
 * on-screen size. Returns bufferLength unchanged when no manifest is available (today's
 * behavior — local-file gallery has no manifest). Result is clamped to bufferLength.
 *
 * @param {import("../packages/jxl-progressive/dist/index.js").ProgressiveManifest | null | undefined} manifest
 * @param {number} elementWidth  CSS px
 * @param {number} elementHeight CSS px
 * @param {number} dpr           devicePixelRatio
 * @param {number} bufferLength  total encoded bytes available
 * @returns {number} byte count to feed the decoder
 */
export function capBytesForDisplay(manifest, elementWidth, elementHeight, dpr, bufferLength) {
  if (!manifest) return bufferLength;
  const sel = selectTierForDisplay(manifest, elementWidth, elementHeight, dpr);
  const cap = sel?.byteEnd ?? bufferLength;
  return Math.min(cap, bufferLength);
}
