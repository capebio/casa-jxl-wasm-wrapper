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

export class HttpError extends Error {
  constructor(public readonly status: number, public readonly statusText: string, url: string) {
    super(`[progressive-stream] HTTP ${status} ${statusText}: ${url}`);
    this.name = "HttpError";
  }
}

export class RangeNotSupportedError extends Error {
  constructor(url: string) {
    super(`[progressive-stream] Range not supported or Content-Range mismatch for ${url}`);
    this.name = "RangeNotSupportedError";
  }
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
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
    throw new HttpError(resp.status, resp.statusText, url);
  }
  await fromResponse(resp, session, signal);
}

/**
 * Fetch the delta for `tier` after a known `prefix` (already pushed into session by caller).
 * Issues Range: bytes=${prefixLength}-${tier.byteEnd-1}.
 * Validates 206 + Content-Range start exactly matches prefixLength (defends against
 * misbehaving proxies/CDNs that normalize/shift ranges). On mismatch or !206, cancel
 * session + throw RangeNotSupportedError so scheduler can fallback to plain fetchTier
 * (fresh session from byte 0).
 *
 * prefix may be Uint8Array | ArrayBuffer (content ignored, only length used) *or* a bare number
 * for the known prefix byte length. This allows callers that track length (e.g. from prior tier
 * persist or accum) to avoid materializing/concatenating the full prefix bytes solely for this call.
 */
export async function fetchTierWithPrefix(
  url: string,
  tier: ManifestTier,
  prefix: Uint8Array | ArrayBuffer | number,
  session: DecodeSession,
  opts: TierFetchOptions = {},
): Promise<void> {
  const { signal, headers, fetchImpl = globalThis.fetch } = opts;
  const prefixLength =
    typeof prefix === "number"
      ? prefix
      : (prefix instanceof ArrayBuffer ? prefix.byteLength : prefix.byteLength);
  throwIfAborted(signal);

  if (prefixLength >= tier.byteEnd) {
    throwIfAborted(signal);
    await session.close();
    return;
  }

  const mergedHeaders = new Headers(headers);
  const rangeEnd = tier.byteEnd - 1;
  mergedHeaders.set("Range", `bytes=${prefixLength}-${rangeEnd}`);

  const resp = await fetchImpl(url, {
    headers: mergedHeaders,
    ...(signal !== undefined && { signal }),
  });

  throwIfAborted(signal);

  if (resp.status !== 206) {
    await session.cancel("Content-Range / range request not supported for delta fetch; scheduler will fallback");
    throw new RangeNotSupportedError(url);
  }

  const cr = resp.headers.get("Content-Range");
  const m = cr === null ? null : /^bytes (\d+)-/.exec(cr);
  if (m === null || Number(m[1]) !== prefixLength) {
    await session.cancel("Content-Range mismatch for delta fetch; scheduler will fallback");
    throw new RangeNotSupportedError(url);
  }

  await fromResponse(resp, session, signal);
}
