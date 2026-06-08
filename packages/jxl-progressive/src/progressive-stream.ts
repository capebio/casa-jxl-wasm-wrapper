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
  /** Network fetch priority for visible DC tier vs background prefetch. */
  priority?: "high" | "low";
}

/**
 * TTFF timer: captures timestamp immediately before decoder session / tier fetch.
 * Used by scheduler to measure first paint after first frame emitted from streamTierFrames.
 */
export function createTtffTimer(): { start: number; getElapsed: () => number } {
  const start = typeof performance !== "undefined" ? performance.now() : Date.now();
  return {
    start,
    getElapsed: () =>
      (typeof performance !== "undefined" ? performance.now() : Date.now()) - start,
  };
}

function createPriorityAwareFetch(
  priority: "high" | "low" | undefined,
  base: typeof fetch = globalThis.fetch,
): typeof fetch {
  if (!priority) return base;
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const enhanced: any = { ...(init || {}) };
    enhanced.priority = priority;
    return base(input, enhanced);
  }) as typeof fetch;
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
  const { signal, priority } = opts;
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const fetchToUse = createPriorityAwareFetch(priority, opts.fetchImpl);
  const passOpts = { ...opts, fetchImpl: fetchToUse } as TierFetchOptions;
  await fromRangePrefix(url, tier.byteEnd, session, passOpts);
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
  const { signal, headers, fetchImpl = globalThis.fetch, priority } = opts;
  const mergedHeaders = new Headers(headers);
  const fetchToUse = createPriorityAwareFetch(priority, fetchImpl);
  const resp = await fetchToUse(url, { headers: mergedHeaders, ...(signal !== undefined && { signal }) });
  if (!resp.ok) {
    throw new Error(
      `[progressive-stream] HTTP ${resp.status} ${resp.statusText}: ${url}`,
    );
  }
  await fromResponse(resp, session, signal);
}
