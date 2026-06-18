/**
 * Versioned worker protocol for jxl-pyramid tiled decode (Grok 2).
 * Shared types between main-thread pool and web/lightbox/tiled-decode-worker.js.
 * The worker references these via JSDoc @typedef imports.
 *
 * Load bytes once (post with [bytes.buffer] transfer). Decode by bytesId for multiple tiles.
 * Reply pixels: transfer [pixels.buffer] for zero-copy (Lens7/20).
 * progressiveStage + deadlineMs: use 'dc' + tight deadline for low-latency machine-rec/AR first pass (Lens12/16).
 * priority (higher = more urgent): gaming/priority queue, astro tracking, photogram select, attended AR viewport (Lens11/13/14/16).
 */
export {};
//# sourceMappingURL=worker-protocol.js.map