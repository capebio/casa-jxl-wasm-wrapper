// packages/jxl-progressive/src/progressive-stream.ts

import { fromRangePrefix, fromResponse, type RangeNegotiation } from "@casabio/jxl-stream";
import type { DecodeSession, DecodeFrameEvent } from "@casabio/jxl-session";
import type { ManifestTier } from "./progressive-manifest.js";

export type { RangeNegotiation };

export interface TierFetchOptions {
  headers?: HeadersInit;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  onRangeNegotiated?: (info: RangeNegotiation) => void;
}

/**
 * Fetch bytes 0..tier.byteEnd of `url` via HTTP Range and push into `session`.
 * All tiers are cumulative from byte 0 (per spec §Byte Range Semantics).
 * Calls session.close() on success.
 */
export async function fetchTier(
  url: string,
  tier: ManifestTier,
  session: DecodeSession,
  opts: TierFetchOptions = {},
): Promise<void> {
  const { signal } = opts;
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  await fromRangePrefix(url, tier.byteEnd, session, opts);
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

/**
 * Async iterator over frames from an active DecodeSession.
 * Yields every DecodeFrameEvent until the session closes or is cancelled.
 */
export async function* streamTierFrames(
  session: DecodeSession,
): AsyncGenerator<DecodeFrameEvent> {
  for await (const frame of session.frames()) {
    yield frame;
  }
}

/**
 * Fetch the full resource (no Range header) and push into `session`.
 * Used as fallback when no manifest is available.
 */
export async function fetchFull(
  url: string,
  session: DecodeSession,
  opts: TierFetchOptions = {},
): Promise<void> {
  const { signal, headers, fetchImpl = globalThis.fetch } = opts;
  const mergedHeaders = new Headers(headers);
  const resp = await fetchImpl(url, { headers: mergedHeaders, ...(signal !== undefined && { signal }) });
  if (!resp.ok) {
    throw new Error(
      `[progressive-stream] HTTP ${resp.status} ${resp.statusText}: ${url}`,
    );
  }
  await fromResponse(resp, session, signal);
}
