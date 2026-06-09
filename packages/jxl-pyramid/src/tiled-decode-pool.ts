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
    listener: (ev: { data?: WorkerReply }) => void,
  ): void;
  removeEventListener(
    type: "message" | "error" | "messageerror",
    listener: (ev: { data?: WorkerReply }) => void,
  ): void;
  postMessage(data: { id: number; bytes: Uint8Array; region: ImageRegion; bpp?: 4 | 8 }): void;
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

interface PendingJob {
  resolve: (d: DecodedLevel) => void;
  reject: (e: unknown) => void;
  region: ImageRegion;
  bpp: 4 | 8;
  timer: ReturnType<typeof globalThis.setTimeout> | null;
}

function decodeTileWithWorker(
  h: WorkerHandle,
  bytes: Uint8Array,
  region: ImageRegion,
  bpp: 4 | 8,
  signal?: AbortSignal,
): Promise<DecodedLevel> {
  if (h.state === "dead") {
    return Promise.reject(new Error("worker is dead"));
  }
  const id = ++h.nextId;
  return new Promise<DecodedLevel>((resolve, reject) => {
    let settled = false;
    const doResolve = (d: DecodedLevel) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(d);
    };
    const doReject = (e: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(e);
    };
    const job: PendingJob = {
      resolve: doResolve,
      reject: doReject,
      region: { ...region },
      bpp,
      timer: null,
    };
    h.pending.set(id, job);

    // watchdog (G2-C)
    job.timer = globalThis.setTimeout(() => {
      if (h.pending.delete(id)) {
        h.state = "dead";
        try {
          h.worker.terminate();
        } catch {}
        doReject(new Error(`worker watchdog timeout for tile ${id}`));
      }
    }, 10_000);

    if (signal) {
      if (signal.aborted) {
        h.pending.delete(id);
        if (job.timer != null) {
          globalThis.clearTimeout(job.timer);
          job.timer = null;
        }
        h.state = "dead";
        try {
          h.worker.terminate();
        } catch {}
        doReject(new DOMException("The operation was aborted.", "AbortError"));
        return;
      }
      const onAbort = () => {
        if (h.pending.delete(id)) {
          if (job.timer != null) {
            globalThis.clearTimeout(job.timer);
            job.timer = null;
          }
          h.state = "dead";
          try {
            h.worker.terminate();
          } catch {}
          doReject(new DOMException("The operation was aborted.", "AbortError"));
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }

    // INPUT NOTE: full container cloned per tile (see L6-A in review). bpp added for G2-A 16-bit.
    h.worker.postMessage({ id, bytes, region, bpp });
  });

  function cleanup() {
    const j = h.pending.get(id);
    if (j && j.timer != null) {
      globalThis.clearTimeout(j.timer);
      j.timer = null;
    }
    h.pending.delete(id);
  }
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
  state: "idle" | "active" | "dead";
  pending: Map<number, PendingJob>;
  nextId: number;
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

  private _destroyed = false;

  get destroyed(): boolean {
    return this._destroyed;
  }

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
    if (this._destroyed) return;
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
   * G2-B: atomic shift + clear timer + state flip to prevent TOCTOU with reaper.
   */
  async acquire(count: number): Promise<WorkerHandle[]> {
    if (this._destroyed || count <= 0) return [];

    const got: WorkerHandle[] = [];

    // Drain idles (skip stale). Atomic pop+timer cancel+state set.
    while (got.length < count && this.idle.length > 0) {
      const h = this.idle.shift()!;
      this.clearIdleTimer(h);
      if (h.state !== "idle" || !this.all.has(h)) {
        this.killHandle(h, "stale on acquire");
        continue;
      }
      h.state = "active";
      this.active.add(h);
      got.push(h);
    }

    // Spawn to satisfy remaining demand (respect max).
    while (got.length < count && this.all.size < this.maxSize) {
      try {
        const h = this.spawnOne();
        h.state = "active";
        this.active.add(h);
        got.push(h);
      } catch {
        break;
      }
    }
    return got;
  }

  /** Return workers to idle (or destroy if poisoned). Arm reaper for excess over minIdle.
   * G2-D: only return once settled/aborted (callers kill on abort so state dead here).
   */
  release(handles: WorkerHandle[]): void {
    for (const h of handles) {
      this.active.delete(h);
      if (this._destroyed || h.state === "dead" || !this.all.has(h) || h.pending.size > 0) {
        this.killHandle(h, "release of dead/inflight");
        continue;
      }
      h.state = "idle";
      if (!this.idle.includes(h)) this.idle.push(h);
      this.armIdleTimer(h);
    }
  }

  // --- private ---

  private spawnOne(): WorkerHandle {
    if (this._destroyed) throw new Error("PyramidWorkerPool destroyed");
    const worker = this.factory();
    const h: WorkerHandle = {
      worker,
      idleTimer: null,
      state: "idle",
      pending: new Map(),
      nextId: 0,
    };
    this.all.add(h);
    this.handleByWorker.set(worker, h);

    // Permanent lifecycle listeners (G2-C): death rejects all pending for this handle.
    const onDeath = () => this.killHandle(h, "worker error");
    try {
      worker.addEventListener("error", onDeath);
      worker.addEventListener("messageerror", onDeath);
    } catch {
      /* ignore for test doubles */
    }

    // Single message dispatcher per worker (G2-B/G2-E): routes by id in h.pending, validates, central reject on death.
    const onMessage = (ev: { data?: WorkerReply }) => {
      const data = ev.data;
      if (!data) return;
      const job = h.pending.get(data.id);
      if (!job) return; // late reply after abort/clear
      h.pending.delete(data.id);
      if (job.timer != null) {
        globalThis.clearTimeout(job.timer);
        job.timer = null;
      }
      if (h.state === "dead") {
        job.reject(new Error("worker dead before reply"));
        return;
      }
      if (!data.ok) {
        job.reject(new Error(data.error));
        this.killHandle(h, "worker replied ok:false");
        return;
      }
      // G2-E: message verification
      const expectedW = job.region.w;
      const expectedH = job.region.h;
      const expectedLen = expectedW * expectedH * job.bpp;
      const ab: ArrayBuffer = data.pixels;
      if (data.width !== expectedW || data.height !== expectedH || ab.byteLength !== expectedLen) {
        job.reject(
          new Error(
            `worker reply validation failed: ${data.width}x${data.height} len=${ab.byteLength} vs ${expectedW}x${expectedH}*${job.bpp}`,
          ),
        );
        this.killHandle(h, "reply validation failed");
        return;
      }
      job.resolve({
        pixels: new Uint8Array(ab),
        width: data.width,
        height: data.height,
      });
    };
    try {
      worker.addEventListener("message", onMessage);
    } catch {
      /* test doubles */
    }

    return h;
  }

  private killHandle(h: WorkerHandle, reason: string): void {
    if (h.state === "dead") return;
    h.state = "dead";
    // Reject all in-flight for this worker (G2-C). Prevents hangs on caller.
    for (const [iid, job] of Array.from(h.pending.entries())) {
      h.pending.delete(iid);
      if (job.timer != null) {
        globalThis.clearTimeout(job.timer);
        job.timer = null;
      }
      try {
        job.reject(new Error(`${reason} (tile ${iid})`));
      } catch {}
    }
    this.clearIdleTimer(h);
    this.active.delete(h);
    const ii = this.idle.indexOf(h);
    if (ii >= 0) this.idle.splice(ii, 1);
    this.all.delete(h);
    try {
      h.worker.terminate();
    } catch {}
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
    this.killHandle(h, "idle reaped");
  }
}

let pool: PyramidWorkerPool | null = null;

function getOrCreatePool(factory: () => WorkerLike): PyramidWorkerPool {
  if (pool && !pool.destroyed) return pool;
  const rt = globalThis as ParallelRuntime;
  const hwc = rt.navigator?.hardwareConcurrency ?? 4;
  const maxSize = Math.min(hwc, 8); // cap: mirrors B5 audit; prevents 64-core blowup
  const p = new PyramidWorkerPool({
    factory,
    maxSize,
    idleTimeoutMs: 5000,
    minIdle: 2, // keep 2 warm indefinitely; excess reap after 5s idle
  });
  // Re-warm on first use.
  p.prewarm(2);
  pool = p;
  return p;
}

async function decodeTilesParallel(
  containerBytes: Uint8Array,
  tiles: ImageRegion[],
  handles: WorkerHandle[],
  bpp: 4 | 8,
  signal?: AbortSignal,
): Promise<{ region: ImageRegion; decoded: DecodedLevel }[]> {
  // handles from pool. Track handles (G2-B) not raw workers for state checks.
  if (handles.length === 0) {
    return [];
  }
  if (signal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }
  const results: { region: ImageRegion; decoded: DecodedLevel }[] = new Array(tiles.length);
  let next = 0;
  let failed = false;
  let firstErr: unknown = null;

  const coros = handles.map(async (h) => {
    while (true) {
      if (failed || (signal && signal.aborted)) break;
      if (h.state === "dead") {
        if (!failed) {
          failed = true;
          firstErr = new Error("worker dead mid-batch");
        }
        break;
      }
      const idx = next++;
      if (idx >= tiles.length) break;
      const region = tiles[idx]!;
      try {
        const decoded = await decodeTileWithWorker(h, containerBytes, region, bpp, signal);
        if (!failed) {
          results[idx] = { region, decoded };
        }
      } catch (e) {
        if (!failed) {
          failed = true;
          firstErr = e;
        }
        if (h.state !== "dead") {
          h.state = "dead";
          try {
            h.worker.terminate();
          } catch {}
        }
        break;
      }
    }
  });

  await Promise.all(coros);
  if (failed) {
    if (signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    throw firstErr instanceof Error ? firstErr : new Error(String(firstErr));
  }
  return results;
}

function bppFor(bits: 8 | 16): 4 | 8 { return bits === 16 ? 8 : 4; }

/**
 * Decode a tiled viewport with optional parallel per-tile workers.
 * Falls back to a single WASM ROI decode when workers unavailable.
 * G2-D: accepts signal for preemption on pan/zoom.
 */
export async function decodeTiledViewportPooled(
  containerBytes: Uint8Array,
  region: ImageRegion,
  options?: {
    parallel?: boolean;
    decodeRegion?: TileRegionDecoder;
    workerFactory?: () => WorkerLike;
    signal?: AbortSignal;
  },
): Promise<DecodedLevel> {
  const header = parseJxtcHeader(containerBytes);
  const rx = Math.min(Math.max(0, region.x), header.imageW);
  const ry = Math.min(Math.max(0, region.y), header.imageH);
  const rw = Math.min(region.w, header.imageW - rx);
  const rh = Math.min(region.h, header.imageH - ry);
  if (rw <= 0 || rh <= 0) throw new Error("empty tiled viewport");
  const viewport: ImageRegion = { x: rx, y: ry, w: rw, h: rh };

  const bits = header.bitsPerSample ?? 8;
  const bpp = bppFor(bits);
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
  const liveHandles = await p.acquire(desired);

  if (liveHandles.length === 0) {
    return decodeRegion(containerBytes, viewport);
  }

  try {
    const parts = await decodeTilesParallel(containerBytes, tiles, liveHandles, bpp, options?.signal);
    return stitch(viewport, parts, bpp);
  } finally {
    p.release(liveHandles);
  }
}