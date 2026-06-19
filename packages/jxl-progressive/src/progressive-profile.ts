// packages/jxl-progressive/src/progressive-profile.ts

import type { SessionFactory } from "./types.js";
import {
  type ProgressiveManifest,
  type ManifestTier,
} from "./progressive-manifest.js";

export type { SessionFactory };

export interface ProfileOptions {
  /** Bytes to feed per push. Default 4096 (4 KiB). */
  chunkSize?: number;
  encoderName?: string;
  libjxlVersion?: string;
  encoderFlags?: string[];
  saliency?: ProgressiveManifest["saliency"];
  /** Called after each chunk push with (byteOffset, totalBytes). */
  onProgress?: (byteOffset: number, total: number) => void;
  signal?: AbortSignal;
}

/** Options for profileJxlFile, extending ProfileOptions with a filesystem side-effect flag. */
export interface ProfileFileOptions extends ProfileOptions {
  /**
   * When true (default), writes the manifest as `${path}.json` beside the .jxl file.
   * Pass false to skip the write and return the manifest only.
   */
  writeManifest?: boolean;
}

interface ProgressionEvent {
  byteOffset: number;
  stage: string;
  progressionIndex: number;
}

// Yield control until all pending microtasks (including async-generator machinery)
// have drained. Needed so framesTask reads bytesPushed before pushTask advances it
// for the next chunk. setImmediate (Node) fires after all microtasks; setTimeout(0)
// (browser) fires after the current event-loop task + microtasks.
function drainMicrotasks(): Promise<void> {
  if (typeof setImmediate === "function") {
    return new Promise<void>((r) => setImmediate(r));
  }
  return new Promise<void>((r) => setTimeout(r, 0));
}

async function computeSha256(buffer: ArrayBuffer): Promise<string> {
  if (
    typeof globalThis.crypto !== "undefined" &&
    typeof (globalThis.crypto as { subtle?: { digest?: unknown } }).subtle?.digest === "function"
  ) {
    const hashBuf = await globalThis.crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  // Node.js fallback
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(Buffer.from(buffer)).digest("hex");
}

function selectTiers(
  events: ProgressionEvent[],
  totalBytes: number,
): ManifestTier[] {
  const tiers: ManifestTier[] = [];

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
  const dcEvent =
    events.find((e) => e.stage === "dc") ??
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
  let previewEvent: ProgressionEvent | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    if ((events[i] as ProgressionEvent).byteOffset < threshold70) {
      previewEvent = events[i];
      break;
    }
  }

  if (
    previewEvent !== undefined &&
    previewEvent !== dcEvent &&
    previewEvent.byteOffset > (dcEvent?.byteOffset ?? 0)
  ) {
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
export async function profileJxl(
  jxlBytes: ArrayBuffer,
  sessionFactory: SessionFactory,
  source: { width: number; height: number; hasAlpha: boolean; orientation?: number },
  opts: ProfileOptions = {},
): Promise<ProgressiveManifest> {
  const {
    chunkSize = 4096,
    signal,
    onProgress,
    encoderName = "unknown",
    libjxlVersion = "unknown",
    encoderFlags = [],
    saliency,
  } = opts;

  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  const session = sessionFactory();
  const events: ProgressionEvent[] = [];
  let bytesPushed = 0;
  let progressionIdx = 0;

  // Collect frames concurrently with pushing bytes.
  // drainMicrotasks() after each push ensures framesTask reads bytesPushed before
  // pushTask advances it for the next chunk (async-generator delivery adds 2+ hops).
  const framesTask = (async () => {
    for await (const frame of session.frames()) {
      events.push({
        byteOffset: bytesPushed,
        stage: frame.stage,
        progressionIndex: progressionIdx++,
      });
    }
  })();

  const pushTask = (async () => {
    const total = jxlBytes.byteLength;
    let offset = 0;
    try {
      while (offset < total) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const end = Math.min(offset + chunkSize, total);
        bytesPushed = end;
        await session.push(jxlBytes.slice(offset, end));
        await drainMicrotasks();
        onProgress?.(end, total);
        offset = end;
      }
      await session.close();
    } catch (e) {
      // Cancel the session so framesTask's frames() generator terminates
      // rather than hanging indefinitely waiting for more frames.
      await session.cancel().catch(() => { /* ignore cancel errors */ });
      throw e;
    }
  })();

  await Promise.all([pushTask, framesTask]);

  const sha256 = await computeSha256(jxlBytes);

  const manifest: ProgressiveManifest = {
    version: 1,
    source: {
      width: source.width,
      height: source.height,
      hasAlpha: source.hasAlpha,
      orientation: source.orientation ?? 1,
    },
    jxl: { bytes: jxlBytes.byteLength, sha256 },
    encoder: { name: encoderName, libjxlVersion, flags: encoderFlags },
    tiers: selectTiers(events, jxlBytes.byteLength),
  };

  if (saliency !== undefined) {
    manifest.saliency = saliency;
  }

  return manifest;
}

/**
 * Node.js helper: read a .jxl file, profile it, and optionally write
 * the manifest as `${path}.json` beside the original file.
 */
export async function profileJxlFile(
  path: string,
  sessionFactory: SessionFactory,
  source: { width: number; height: number; hasAlpha: boolean; orientation?: number },
  opts: ProfileFileOptions = {},
): Promise<ProgressiveManifest> {
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
