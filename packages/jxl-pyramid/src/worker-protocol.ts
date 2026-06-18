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

import type { ImageRegion } from "./tiling.js";

export type { ImageRegion } from "./tiling.js";

export type WorkerRequest =
  | { v: 1; type: 'load'; bytesId: number; bytes: Uint8Array }
  | { v: 1; type: 'load'; bytesId: number; sab: SharedArrayBuffer; byteLength: number }
  | { v: 1; type: 'decode'; id: number; bytesId: number; region: ImageRegion; format: 'rgba8' | 'rgba16'; deadlineMs?: number; progressiveStage?: 'dc' | 'final'; priority?: number }
  | { v: 1; type: 'cancel'; id: number };

export type WorkerReply =
  | { v: 1; type: 'ready' }
  | { v: 1; type: 'decode-reply'; id: number; ok: true; pixels: Uint8Array; w: number; h: number }
  | { v: 1; type: 'decode-reply'; id: number; ok: false; error: { code: WorkerErrorCode; message: string; stack?: string } };

export type WorkerErrorCode = 'JXTC_PARSE' | 'BAD_REGION' | 'OOM' | 'INTERNAL' | 'TIMEOUT' | 'UNKNOWN_BYTES_ID';
