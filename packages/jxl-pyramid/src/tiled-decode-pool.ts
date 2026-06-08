import { decodeTileContainerRegionRgba8, decodeTileContainerRegionRgba16 } from "@casabio/jxl-wasm";
import {
  canUseParallelTileWorkers,
  parseJxtcHeader,
  tilesOverlappingRegion,
  type ImageRegion,
} from "./tiling.js";
import type { DecodedLevel } from "./decode-level.js";

type WorkerLike = {
  addEventListener(
    type: "message" | "error" | "messageerror",
    listener: (ev: any) => void,
  ): void;
  removeEventListener(
    type: "message" | "error" | "messageerror",
    listener: (ev: any) => void,
  ): void;
  postMessage(data: { id: number; bytes: Uint8Array; region: ImageRegion }): void;
  terminate(): void;
};

type ParallelRuntime = {
  Worker?: new (url: string | URL, options?: { type?: string }) => WorkerLike;
  navigator?: { hardwareConcurrency?: number };
};

export type TileRegionDecoder = (
  bytes: Uint8Array,
  region: ImageRegion,
) => Promise<DecodedLevel>;

/**
 * Fast-path stitch for stride-aligned tiles (I4 from level2 audit).
 * When a tile's decoded region is full viewport width and x-aligned (dx===0),
 * its pixels are a single contiguous block in the destination; one set() replaces
 * the per-row loop. This is common for vertical strips and full-width ROIs.
 * Falls back to row-by-row for partial-width tiles.
 */
function stitch(viewport: ImageRegion, parts: { region: ImageRegion; decoded: DecodedLevel }[], bytesPerPixel: 4 | 8 = 4): DecodedLevel {
  const pixels = new Uint8Array(viewport.w * viewport.h * bytesPerPixel);
  const dstStride = viewport.w * bytesPerPixel;
  for (const { region, decoded } of parts) {
    const dx = region.x - viewport.x;
    const dy = region.y - viewport.y;
    const srcStride = decoded.width * bytesPerPixel;
    if (decoded.width === viewport.w && dx === 0) {
      // Contiguous full-stride block: single copy, no row loop overhead.
      pixels.set(decoded.pixels, dy * dstStride);
    } else {
      for (let row = 0; row < decoded.height; row++) {
        pixels.set(
          decoded.pixels.subarray(row * srcStride, (row + 1) * srcStride),
          ((dy + row) * viewport.w + dx) * bytesPerPixel,
        );
      }
    }
  }
  return { pixels, width: viewport.w, height: viewport.h };
}

type WorkerReply =
  | { id: number; ok: true; pixels: ArrayBuffer; width: number; height: number }
  | { id: number; ok: false; error: string };

let nextWorkerId = 0;

function decodeTileWithWorker(
  worker: WorkerLike,
  bytes: Uint8Array,
  region: ImageRegion,
): Promise<DecodedLevel> {
  const id = ++nextWorkerId;
  return new Promise((resolve, reject) => {
    let settled = false;
    const onMessage = (ev: { data: WorkerReply }) => {
      if (ev.data.id !== id) return;
      cleanup();
      if (ev.data.ok) {
        // Output path: worker already transfers the backing ArrayBuffer (see
        // web/lightbox/tiled-decode-worker.js:10: postMessage(..., [out.pixels.buffer])).
        // Receiver gets a live ArrayBuffer (sender view detached, byteLength=0 on worker).
        // Wrap is zero-copy; no .slice(). Matches U1 + benchmark "transferable_postMessage ~0.05ms".
        const ab = ev.data.pixels;
        resolve({
          pixels: new Uint8Array(ab),
          width: ev.data.width,
          height: ev.data.height,
        });
      } else {
        reject(new Error(ev.data.error));
      }
    };
    const onError = (ev: any) => {
      if (settled) return;
      cleanup();
      reject(new Error(`worker error during tile ${id}: ${ev?.message || ev || "unknown"}`));
      // Pool's permanent error wiring will also see this and recycle the crashed handle.
    };
    const cleanup = () => {
      settled = true;
      worker.removeEventListener("message", onMessage);
      try {
        worker.removeEventListener("error", onError);
        worker.removeEventListener("messageerror", onError);
      } catch {
        /* best-effort */
      }
    };
    worker.addEventListener("message", onMessage);
    try {
      worker.addEventListener("error", onError);
      worker.addEventListener("messageerror", onError);
    } catch {
      /* some test doubles may not implement */
    }
    // INPUT NOTE (B1 from audit): bytes (full JXTC container) is structured-cloned here.
    // Same buffer is consumed by N tiles + must remain valid for caller after the batch.
    // Transfer would detach from main and is not safe for fan-out. SAB would eliminate
    // the clone (precondition already asserted by canUseParallelTileWorkers) but is out
    // of scope for this change.
    worker.postMessage({ id, bytes, region });
  });
}

/**
 * Persistent warmed worker pool for pyramid tile decodes (I1).
 * Replaces per-frame Array.from(factory) + finally-terminate churn.
 * Mirrors jxl-scheduler/pool.ts discipline (minIdle floor, per-handle idle timers,
 * acquire/release, error-driven recycle) but scoped to the dumb tile protocol.
 * Workers are created via injected factory (URL lives in caller); first use prewarms
 * minIdle so JXL WASM compile happens off the hot pan/zoom path.
 */
type WorkerHandle = {
  worker: WorkerLike;
  idleTimer: ReturnType<typeof globalThis.setTimeout> | null;
  terminated: boolean;
  bad: boolean;
};

class PyramidWorkerPool {
  private readonly factory: () => WorkerLike;
  private readonly maxSize: number;
  private readonly idleTimeoutMs: number;
  private readonly minIdle: number;

  private readonly all = new Set<WorkerHandle>();
  private readonly idle: WorkerHandle[] = [];
  private readonly active = new Set<WorkerHandle>();
  private readonly handleByWorker = new WeakMap<WorkerLike, WorkerHandle>();

  private destroyed = false;

  constructor(opts: {
    factory: () => WorkerLike;
    maxSize: number;
    idleTimeoutMs: number;
    minIdle?: number;
  }) {
    this.factory = opts.factory;
    this.maxSize = Math.max(1, opts.maxSize);
    this.idleTimeoutMs = Math.max(0, opts.idleTimeoutMs);
    this.minIdle = Math.max(0, Math.min(opts.minIdle ?? 1, this.maxSize));
  }

  get size(): number {
    return this.all.size;
  }

  /** Eagerly create workers so their top-level preloadJxlModule() runs. */
  prewarm(count: number): void {
    if (this.destroyed) return;
    const n = Math.min(count, this.maxSize - this.all.size);
    for (let i = 0; i < n; i++) {
      const h = this.spawnOne();
      this.idle.push(h);
      this.armIdleTimer(h);
    }
  }

  /**
   * Acquire up to `count` workers for a batch.
   * Prefers idle, then spawns under cap. Returns fewer than requested if at limit.
   * Callers must release exactly the returned list (idempotent on bad handles).
   */
  async acquire(count: number): Promise<WorkerLike[]> {
    if (this.destroyed || count <= 0) return [];

    const got: WorkerLike[] = [];

    // Drain idles (skip stale).
    while (got.length < count && this.idle.length > 0) {
      const h = this.idle.shift()!;
      this.clearIdleTimer(h);
      if (h.terminated || h.bad || !this.all.has(h)) {
        this.destroyHandle(h);
        continue;
      }
      this.active.add(h);
      got.push(h.worker);
    }

    // Spawn to satisfy remaining demand (respect max).
    while (got.length < count && this.all.size < this.maxSize) {
      try {
        const h = this.spawnOne();
        this.active.add(h);
        got.push(h.worker);
      } catch {
        break;
      }
    }
    return got;
  }

  /** Return workers to idle (or destroy if poisoned). Arm reaper for excess over minIdle. */
  release(workers: WorkerLike[]): void {
    for (const w of workers) {
      const h = this.handleByWorker.get(w);
      if (!h) continue;
      this.active.delete(h);
      if (this.destroyed || h.terminated || h.bad || !this.all.has(h)) {
        this.destroyHandle(h);
        continue;
      }
      // Return to idle.
      if (!this.idle.includes(h)) this.idle.push(h);
      this.armIdleTimer(h);
    }
  }

  // --- private ---

  private spawnOne(): WorkerHandle {
    if (this.destroyed) throw new Error("PyramidWorkerPool destroyed");
    const worker = this.factory();
    const h: WorkerHandle = { worker, idleTimer: null, terminated: false, bad: false };
    this.all.add(h);
    this.handleByWorker.set(worker, h);

    // Permanent lifecycle listeners: any crash/error recycles immediately.
    const recycle = () => this.recycle(h);
    try {
      worker.addEventListener("error", recycle);
      worker.addEventListener("messageerror", recycle);
    } catch {
      /* ignore for test doubles */
    }
    return h;
  }

  private recycle(h: WorkerHandle): void {
    if (!this.all.has(h)) return;
    h.bad = true;
    const i = this.idle.indexOf(h);
    if (i >= 0) this.idle.splice(i, 1);
    this.active.delete(h);
    this.destroyHandle(h);
  }

  private armIdleTimer(h: WorkerHandle): void {
    this.clearIdleTimer(h);
    if (this.idleTimeoutMs <= 0) {
      if (this.idle.length > this.minIdle) this.reap(h);
      return;
    }
    if (this.idle.length <= this.minIdle) return; // floor stays warm forever
    h.idleTimer = globalThis.setTimeout(() => {
      if (this.idle.includes(h) && this.idle.length > this.minIdle) {
        this.reap(h);
      }
    }, this.idleTimeoutMs);
  }

  private clearIdleTimer(h: WorkerHandle): void {
    if (h.idleTimer !== null) {
      globalThis.clearTimeout(h.idleTimer);
      h.idleTimer = null;
    }
  }

  private reap(h: WorkerHandle): void {
    const i = this.idle.indexOf(h);
    if (i >= 0) this.idle.splice(i, 1);
    this.destroyHandle(h);
  }

  private destroyHandle(h: WorkerHandle): void {
    this.clearIdleTimer(h);
    this.active.delete(h);
    this.all.delete(h);
    // WeakMap entry drops naturally.
    if (!h.terminated) {
      h.terminated = true;
      try {
        h.worker.terminate();
      } catch {
        /* ignore */
      }
    }
  }
}

let pool: PyramidWorkerPool | null = null;

function getOrCreatePool(factory: () => WorkerLike): PyramidWorkerPool {
  if (pool && !pool["destroyed"]) return pool; // private but fine for module
  const rt = globalThis as ParallelRuntime;
  const hwc = rt.navigator?.hardwareConcurrency ?? 4;
  const maxSize = Math.min(hwc, 8); // cap: mirrors B5 audit; prevents 64-core blowup
  const p = new PyramidWorkerPool({
    factory,
    maxSize,
    idleTimeoutMs: 5000,
    minIdle: 2, // keep 2 warm indefinitely; excess reap after 5s idle
  });
  // Re-warm on first use: the created workers run preloadJxlModule() in their global scope.
  p.prewarm(p["minIdle"] ?? 2);
  pool = p;
  return p;
}

async function decodeTilesParallel(
  containerBytes: Uint8Array,
  tiles: ImageRegion[],
  workers: WorkerLike[],
): Promise<{ region: ImageRegion; decoded: DecodedLevel }[]> {
  // workers provided by pool (already live, warmed). No spawn/term inside.
  if (workers.length === 0) {
    // Should be guarded by caller; return empty to keep contract.
    return [];
  }
  const results: { region: ImageRegion; decoded: DecodedLevel }[] = new Array(tiles.length);
  let next = 0;
  let failed = false;
  let firstErr: unknown = null;

  const coros = workers.map(async (worker) => {
    while (true) {
      if (failed) break;
      const idx = next++;
      if (idx >= tiles.length) break;
      const region = tiles[idx]!;
      try {
        const decoded = await decodeTileWithWorker(worker, containerBytes, region);
        if (!failed) {
          results[idx] = { region, decoded };
        }
      } catch (e) {
        if (!failed) {
          failed = true;
          firstErr = e;
        }
        break; // stop this worker's slice; others will see flag and exit promptly
      }
    }
  });

  await Promise.all(coros);
  if (failed) {
    throw firstErr instanceof Error ? firstErr : new Error(String(firstErr));
  }
  return results;
}

function bppFor(bits: 8 | 16): 4 | 8 { return bits === 16 ? 8 : 4; }

/**
 * Decode a tiled viewport with optional parallel per-tile workers.
 * Falls back to a single WASM ROI decode when workers unavailable.
 */
export async function decodeTiledViewportPooled(
  containerBytes: Uint8Array,
  region: ImageRegion,
  options?: {
    parallel?: boolean;
    decodeRegion?: TileRegionDecoder;
    workerFactory?: () => WorkerLike;
  },
): Promise<DecodedLevel> {
  const header = parseJxtcHeader(containerBytes);
  const rx = Math.min(Math.max(0, region.x), header.imageW);
  const ry = Math.min(Math.max(0, region.y), header.imageH);
  const rw = Math.min(region.w, header.imageW - rx);
  const rh = Math.min(region.h, header.imageH - ry);
  if (rw <= 0 || rh <= 0) throw new Error("empty tiled viewport");
  const viewport: ImageRegion = { x: rx, y: ry, w: rw, h: rh };

  const bits = header.bitsPerSample ?? 8; // header from parseJxtcHeader above
  const decodeRegion = options?.decodeRegion ?? (async (bytes, r) => {
    const out = bits === 16
      ? await decodeTileContainerRegionRgba16(bytes, r)
      : await decodeTileContainerRegionRgba8(bytes, r);
    return { pixels: out.pixels, width: out.width, height: out.height };
  });

  const tiles = tilesOverlappingRegion(header.imageW, header.imageH, header.tileSize, viewport);
  const wantParallel = options?.parallel !== false
    && canUseParallelTileWorkers()
    && tiles.length > 1
    && options?.workerFactory !== undefined;

  if (!wantParallel) {
    return decodeRegion(containerBytes, viewport);
  }

  const desired = Math.min(
    (globalThis as ParallelRuntime).navigator?.hardwareConcurrency ?? 4,
    tiles.length,
  );
  const p = getOrCreatePool(options!.workerFactory!);
  const liveWorkers = await p.acquire(desired);

  if (liveWorkers.length === 0) {
    // Pool at cap and busy (rare concurrent tiled ROIs) or factory failed.
    // Fallback preserves correctness; loses parallelism for this frame only.
    return decodeRegion(containerBytes, viewport);
  }

  try {
    const parts = await decodeTilesParallel(containerBytes, tiles, liveWorkers);
    return stitch(viewport, parts, bppFor(bits));
  } finally {
    p.release(liveWorkers);
  }
}