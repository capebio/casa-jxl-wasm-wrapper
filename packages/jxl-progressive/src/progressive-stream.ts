// packages/jxl-progressive/src/progressive-stream.ts

import { fromRangePrefix, fromResponse, type RangeNegotiation } from "@casabio/jxl-stream";
import type { DecodeSession, DecodeFrameEvent } from "@casabio/jxl-session";
import type { ManifestTier, ProgressiveManifest, TierName } from "./progressive-manifest.js";
import { lookupTier } from "./progressive-manifest.js";
import type { SessionFactory } from "./types.js";

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

/**
 * Fetch byte range [startByte, endByte) and push ONLY the delta into an ALREADY-OPEN
 * DecodeSession (no close()). Used by RefinementSession for incremental tier upgrades.
 * Returns bytes actually delivered (may be < requested on short/conn drop).
 * Does not call close(); caller controls session lifetime across refinements.
 */
export async function fetchDelta(
  url: string,
  startByte: number,
  endByte: number,
  session: DecodeSession,
  opts: TierFetchOptions = {},
): Promise<number> {
  if (!Number.isFinite(startByte) || !Number.isFinite(endByte) || endByte <= startByte) {
    return 0;
  }
  const { signal, headers, fetchImpl = globalThis.fetch, priority, onRangeNegotiated } = opts;
  if (signal?.aborted) {
    return 0;
  }
  const fetchToUse = createPriorityAwareFetch(priority, fetchImpl);
  const mergedHeaders = new Headers(headers);
  mergedHeaders.set("Range", `bytes=${startByte}-${endByte - 1}`);

  const resp = await fetchToUse(url, { headers: mergedHeaders, ...(signal !== undefined && { signal }) });
  if (resp.status === 416) {
    throw new RangeError(`[progressive-stream] 416 Range Not Satisfiable: ${url}`);
  }
  if (!resp.ok && resp.status !== 206 && resp.status !== 200) {
    throw new Error(`[progressive-stream] HTTP ${resp.status} ${resp.statusText}: ${url}`);
  }
  if (!resp.body) {
    throw new Error("[progressive-stream] Response has no body");
  }

  const needed = endByte - startByte;
  const honored = resp.status === 206;
  // best-effort full size (for negotiation cb only)
  const fullSize =
    parseContentRangeTotal(resp.headers.get("Content-Range")) ??
    parseNonNegativeInt(resp.headers.get("Content-Length"));

  let negotiationPosted = false;
  const postNeg = (delivered: number) => {
    if (negotiationPosted || !onRangeNegotiated) return;
    negotiationPosted = true;
    const info: RangeNegotiation = { requested: endByte, honored, delivered };
    if (fullSize !== undefined) (info as any).fullSize = fullSize;
    onRangeNegotiated(info);
  };

  const reader = resp.body.getReader();
  let delivered = 0;

  const onAbort = () => { void reader.cancel(ABORT_REASON); };
  if (signal) signal.addEventListener("abort", onAbort, { once: true });

  try {
    let pending = reader.read();
    while (true) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const { done, value } = await pending;
      if (done) break;
      const remaining = needed - delivered;
      if (remaining <= 0) {
        void reader.cancel("range satisfied");
        break;
      }
      pending = remaining > value.byteLength ? reader.read() : Promise.resolve({ done: true, value: undefined as any });
      const chunk = value.byteLength <= remaining ? value : value.subarray(0, remaining);
      delivered += chunk.byteLength;
      await session.push(chunk);
      if (delivered >= needed) {
        void reader.cancel("range satisfied");
        break;
      }
    }
    postNeg(delivered);
    if (signal?.aborted) {
      return delivered;
    }
    // NOTE: deliberately no session.close() — refinement keeps decoder alive for delta pushes
    return delivered;
  } catch (e) {
    try { await reader.cancel(String(e)); } catch {}
    throw e;
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
    try { reader.releaseLock(); } catch {}
  }
}

// local helpers duplicated (minimal) from jxl-stream to avoid cross-edit
function parseContentRangeTotal(h: string | null): number | undefined {
  if (!h) return undefined;
  const m = /\/(\d+)\s*$/.exec(h);
  return m ? parseNonNegativeInt(m[1]) : undefined;
}
function parseNonNegativeInt(s: string | null | undefined): number | undefined {
  if (s == null) return undefined;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
const ABORT_REASON = "AbortSignal triggered";

/**
 * RefinementSession retains a single DecodeSession (thus one WASM decoder + worker slot)
 * across tier upgrades. Fetches only delta bytes for the target tier and pushes them
 * into the live session (no restart from byte 0, no fresh open per tier).
 */
export class RefinementSession {
  private session: DecodeSession | null = null;
  private fetchedByteEnd = 0;
  private decodedByteEnd = 0;
  /** -1 until first successful tier; thereafter last promoted tier index (or use name) */
  private currentTier: number = -1;
  private readonly factory: SessionFactory;
  private readonly jxlUrl: string;
  private readonly manifest: ProgressiveManifest;
  private readonly fetchImpl: typeof fetch;

  constructor(
    factory: SessionFactory,
    jxlUrl: string,
    manifest: ProgressiveManifest,
    opts: { fetchImpl?: typeof fetch } = {},
  ) {
    this.factory = factory;
    this.jxlUrl = jxlUrl;
    this.manifest = manifest;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  /** Expose frames() from the retained DecodeSession (call once per lifetime). */
  frames(): AsyncIterable<DecodeFrameEvent> {
    if (!this.session) {
      return (async function* () {})();
    }
    return this.session.frames();
  }

  async cancel(reason?: string): Promise<void> {
    if (this.session) {
      try { await this.session.cancel(reason); } catch {}
      this.session = null;
    }
  }

  /**
   * Advance the retained decoder (creating on first use) by fetching+push only the
   * missing byte suffix for targetTier. Updates bookkeeping per spec (F1,F9,B1,R3,R5).
   */
  async advanceTo(targetTier: TierName, opts: TierFetchOptions & { budgetMs?: number | null } = {}): Promise<void> {
    const tier = lookupTier(this.manifest, targetTier);
    if (!tier) return;
    const end = tier.byteEnd;

    // B1: early return only when we have *decoded* exactly to this end (prevents budget-skipped promotion)
    if (this.decodedByteEnd === end) {
      this.currentTier = tierIndexFor(this.manifest, targetTier);
      return;
    }

    if (this.session === null) {
      this.session = this.factory();
    }

    const start = this.fetchedByteEnd;
    if (end <= start) {
      if (this.decodedByteEnd === end) {
        this.currentTier = tierIndexFor(this.manifest, targetTier);
      }
      return;
    }

    const fetchOpts: TierFetchOptions = {
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      fetchImpl: opts.fetchImpl ?? this.fetchImpl,
      ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
      ...(opts.headers !== undefined ? { headers: opts.headers } : {}),
      ...(opts.onRangeNegotiated !== undefined ? { onRangeNegotiated: opts.onRangeNegotiated } : {}),
    };

    let delivered = 0;
    try {
      delivered = await fetchDelta(this.jxlUrl, start, end, this.session, fetchOpts);
      this.fetchedByteEnd = start + delivered;

      if (delivered < (end - start)) {
        // R3: stream terminated early (conn drop / short read) — record what we got on net but do not promote tier
        // keep session (may resume with more bytes later if transient)
        return;
      }

      const isFull = targetTier === "full";
      if (isFull) {
        await this.session.close();
      }

      // Await done only on paths that closed (full). For intermediate tiers we promote after successful delta push
      // (frames will surface via the pump; decoder is still open for next refinement). This satisfies the
      // "retain decoder" goal while following the bookkeeping intent.
      if (isFull) {
        await this.session.done();
      }

      this.decodedByteEnd = end;
      this.currentTier = tierIndexFor(this.manifest, targetTier);
    } catch (e: any) {
      // F9 / budget: bytes were fetched (or attempted) up to end — mark to avoid re-download on retry,
      // but leave decoded/current behind so we do not silently promote a failed tier (B1).
      if (isBudgetError(e)) {
        this.fetchedByteEnd = end;
        this.session = null; // terminated, next advanceTo will open fresh if needed
        // do not update decoded/current
        throw e;
      }

      // R5: offline / net drop mid-session — if we already have a usable tier, swallow so caller
      // does not onError to blank; keep last bitmap. Only error upward if nothing decoded yet.
      if (isFetchNetworkError(e) && this.currentTier >= 0) {
        return; // quiet; current decoded bitmap remains
      }

      // other errors (incl first-tier net fail): propagate (caller will onError)
      // for partial net on non-budget: leave fetched at what we advanced (or revert?); per R3 do not promote (we didn't)
      if (isFetchNetworkError(e) && delivered > 0) {
        // partial net progress recorded; decoder (if still alive) can continue later
        this.fetchedByteEnd = start + delivered;
      }
      throw e;
    }
  }
}

function tierIndexFor(manifest: ProgressiveManifest, name: TierName): number {
  return manifest.tiers.findIndex((t) => t.name === name);
}

function isBudgetError(e: unknown): boolean {
  if (!e) return false;
  const code = (e as any)?.code;
  const msg = String((e as any)?.message || e);
  return code === "BudgetExceeded" || /BudgetExceeded/i.test(msg);
}

function isFetchNetworkError(e: unknown): boolean {
  if (!e) return false;
  if (e instanceof TypeError) {
    const m = String((e as any).message || "");
    return /fetch|Failed to fetch|network|ECONNRESET|ENOTFOUND/i.test(m);
  }
  const m = String((e as any)?.message || e);
  return /Failed to fetch|TypeError.*fetch/i.test(m);
}

