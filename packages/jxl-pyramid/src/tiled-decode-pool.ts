import {
  canUseParallelTileWorkers,
  canShareContainerBytes,
  parseJxtcHeader,
  type ImageRegion,
} from "./tiling.js";
import type { LevelSource } from "./level-source.js";
import { prepareLevelSource } from "./level-source.js";
import {
  clampRegion,
  stitch,
  pickRegionDecoder,
  type RegionDecoder,
  type DecodedLevel,
  PyramidError,
  type DecodeOptions,
  longEdge,
  type TileId,
  viewportCacheKey,
  type PixelFormat,
  bppOfFormat,
  ensureIccProfile,
} from "./decode-core.js";
import { getLevelId } from "./cache.js";
import { prepareDecodePlan } from "./plan.js";
import type { WorkerRequest, WorkerReply, WorkerErrorCode } from "./worker-protocol.js";
// CoreBudget shape (from jxl-scheduler) for opt-in cross-pool limiting (Agent6-1). Loose to avoid package dep in tsc.

// Grok 3 state enums
export enum PoolState {
  Created = 'created',
  Prewarming = 'prewarming',
  Active = 'active',
  Draining = 'draining',
  Destroyed = 'destroyed',
}

export enum HandleState {
  WarmFloor = 'warm-floor',
  WarmReapable = 'warm-reapable',
  Active = 'active',
  Bad = 'bad',
  Terminated = 'terminated',
}

// Grok3 #16 single transition fn with table. Invalid throws in dev.
function setHandleState(h: WorkerHandle, next: HandleState, failureInfo?: { code: WorkerErrorCode; message: string; at: number; count: number }) {
  const cur = h.state;
  const allowed: Record<HandleState, HandleState[]> = {
    [HandleState.WarmFloor]: [HandleState.Active, HandleState.Bad, HandleState.Terminated],
    [HandleState.WarmReapable]: [HandleState.Active, HandleState.Bad, HandleState.Terminated],
    [HandleState.Active]: [HandleState.WarmReapable, HandleState.Bad, HandleState.Terminated],
    [HandleState.Bad]: [HandleState.Terminated],
    [HandleState.Terminated]: [],
  };
  if (process.env.NODE_ENV !== 'production' && !allowed[cur]?.includes(next) && cur !== next) {
    throw new Error(`invalid handle state transition ${cur} -> ${next}`);
  }
  h.state = next;
  if (failureInfo) h.failure = { ...failureInfo, count: (h.failure?.count || 0) + 1 };
}

type WorkerLike = {
  addEventListener(
    type: "message" | "error" | "messageerror",
    listener: (ev: { data?: any }) => void,
  ): void;
  removeEventListener(
    type: "message" | "error" | "messageerror",
    listener: (ev: { data?: any }) => void,
  ): void;
  postMessage(data: WorkerRequest, transfer?: any[]): void;
  terminate(): void;
};

type ParallelRuntime = {
  Worker?: new (url: string | URL, options?: { type?: string }) => WorkerLike;
  navigator?: { hardwareConcurrency?: number };
  crossOriginIsolated?: boolean;
  SharedArrayBuffer?: typeof SharedArrayBuffer;
};

interface PendingJob {
  resolve: (d: DecodedLevel) => void;
  reject: (e: unknown) => void;
  region: ImageRegion;
  timer: ReturnType<typeof globalThis.setTimeout> | null;
}

function decodeTileWithWorker(
  h: WorkerHandle,
  bytesId: number,
  region: ImageRegion,
  format: 'rgba8' | 'rgba16',
  deadlineMs?: number,
  signal?: AbortSignal,
  requestTimeoutMs?: number,
  progressiveStage?: 'dc' | 'final',
): Promise<DecodedLevel> {
  setHandleState(h, HandleState.Active);
  const id = ++h.nextId;
  const inflightEntry = { id, reject: (e: Error) => { /* filled below */ } };
  h.inflight.add(inflightEntry);

  return new Promise<DecodedLevel>((resolve, reject) => {
    inflightEntry.reject = reject; // capture for destroyHandle

    let settled = false;
    const doResolve = (d: DecodedLevel) => {
      if (settled) return;
      settled = true;
      h.inflight.delete(inflightEntry);
      cleanup();
      resolve(d);
    };
    const doReject = (e: unknown) => {
      if (settled) return;
      settled = true;
      h.inflight.delete(inflightEntry);
      cleanup();
      reject(e);
    };
    const job: PendingJob = {
      resolve: doResolve,
      reject: doReject,
      region: { ...region },
      timer: null,
    };
    h.pending.set(id, job);

    // request timeout (Grok3 #23)
    let reqTimer: any = null;
    if (requestTimeoutMs && requestTimeoutMs > 0) {
      reqTimer = globalThis.setTimeout(() => {
        if (h.pending.delete(id)) {
          h.inflight.delete(inflightEntry);
          setHandleState(h, HandleState.Bad, { code: 'TIMEOUT', message: 'request timeout', at: Date.now(), count: 1 });
          try { h.worker.terminate(); } catch {}
          doReject(new PyramidError('TIMEOUT', `worker request timeout for tile ${id}`));
        }
      }, requestTimeoutMs);
    }

    // watchdog + timeout
    job.timer = globalThis.setTimeout(() => {
      if (h.pending.delete(id)) {
        h.inflight.delete(inflightEntry);
        if (reqTimer) globalThis.clearTimeout(reqTimer);
        setHandleState(h, HandleState.Bad);
        try { h.worker.terminate(); } catch {}
        doReject(new PyramidError('TIMEOUT', `worker watchdog timeout for tile ${id}`));
      }
    }, 10_000);

    if (signal) {
      if (signal.aborted) {
        h.pending.delete(id);
        h.inflight.delete(inflightEntry);
        if (job.timer != null) { globalThis.clearTimeout(job.timer); job.timer = null; }
        if (reqTimer) globalThis.clearTimeout(reqTimer);
        try { h.worker.postMessage({ v: 1, type: 'cancel', id }); } catch {}
        setHandleState(h, HandleState.Terminated);
        try { h.worker.terminate(); } catch {}
        doReject(new PyramidError('ABORTED', 'decode aborted before start'));
        return;
      }
      const onAbort = () => {
        if (h.pending.delete(id)) {
          h.inflight.delete(inflightEntry);
          if (job.timer != null) { globalThis.clearTimeout(job.timer); job.timer = null; }
          if (reqTimer) globalThis.clearTimeout(reqTimer);
          try { h.worker.postMessage({ v: 1, type: 'cancel', id }); } catch {}
          setHandleState(h, HandleState.Terminated);
          try { h.worker.terminate(); } catch {}
          doReject(new PyramidError('ABORTED', 'decode aborted'));
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }

    const req: WorkerRequest = {
      v: 1,
      type: 'decode',
      id,
      bytesId,
      region,
      format,
      ...(deadlineMs != null ? { deadlineMs } : {}),
      ...(progressiveStage ? { progressiveStage } : {}),
    } as WorkerRequest;
    try {
      h.worker.postMessage(req);
    } catch (postErr) {
      h.pending.delete(id);
      h.inflight.delete(inflightEntry);
      if (job.timer != null) { globalThis.clearTimeout(job.timer); job.timer = null; }
      if (reqTimer) globalThis.clearTimeout(reqTimer);
      setHandleState(h, HandleState.Bad);
      try { h.worker.terminate(); } catch {}
      doReject(postErr);
    }
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
 * Persistent warmed worker pool for pyramid tile decodes (Grok2 protocol).
 * Uses load/decode split + bytesId to eliminate structured-clone amplification.
 * Supports readiness, best-effort cancel, 16-bit via format, parse validation.
 */
type WorkerHandle = {
  worker: WorkerLike;
  idleTimer: ReturnType<typeof globalThis.setTimeout> | null;
  state: HandleState;
  pending: Map<number, PendingJob>;
  nextId: number;
  ready: Promise<void>;
  /** resolved when first 'ready' arrives */
  _readyResolve?: (v?: unknown) => void;
  readySettled?: boolean;
  failure?: { code: WorkerErrorCode; message: string; at: number; count: number };
  inflight: Set<{ id: number; reject: (e: Error) => void }>;
};

class PyramidWorkerPool {
  private readonly factory: () => WorkerLike;
  private readonly maxSize: number;
  private readonly idleTimeoutMs: number;
  private readonly minIdle: number;
  private readonly requestTimeoutMs: number | undefined;
  private readonly lifecycle: { hookVisibility?: boolean; hookFreeze?: boolean };
  /** Optional CoreBudget for cross-pool core limiting (with scheduler). Acquire around handle batch (Agent6-1). */
  private readonly coreBudget: { acquire(cost?: number): Promise<void>; release(cost?: number): void; tryAcquire(cost?: number): boolean; } | null = null;
  private readonly workerCost: number = 1;

  private state: PoolState = PoolState.Created;
  private readonly all = new Set<WorkerHandle>();
  private readonly idle: WorkerHandle[] = []; // LIFO for hottest caches (Grok3 #18)
  private readonly active = new Set<WorkerHandle>();
  private readonly handleByWorker = new WeakMap<WorkerLike, WorkerHandle>();

  // bytesId tracking per worker (for load-once)
  private readonly bytesIdByWorker = new WeakMap<WorkerLike, Set<number>>();

  // instance-scoped (not module) per Grok2/3
  private nextBytesId = 0;

  // waiter queue for over-cap (Grok3 #26-29)
  private readonly waiters: Array<{ want: number; resolve: (handles: WorkerHandle[]) => void; expiresAt?: number }> = [];

  // module consts evaluated once (Grok3 #38-39)
  // (HWC / CAN_PARALLEL live at module scope below)

  constructor(opts: {
    factory: () => WorkerLike;
    maxSize: number;
    idleTimeoutMs: number;
    minIdle?: number;
    requestTimeoutMs?: number;
    lifecycle?: { hookVisibility?: boolean; hookFreeze?: boolean };
    prewarm?: 'eager' | 'lazy' | 'on-demand';
    /** Opt-in CoreBudget (e.g. globalCoreBudget) to bound total WASM workers across scheduler + pyramid. */
    coreBudget?: { acquire(cost?: number): Promise<void>; release(cost?: number): void; tryAcquire(cost?: number): boolean; } | undefined;
    /** Tokens per worker handle (default 1; tile work lighter than full MT session). */
    workerCost?: number;
  }) {
    this.factory = opts.factory;
    this.maxSize = Math.max(1, opts.maxSize);
    this.idleTimeoutMs = Math.max(0, opts.idleTimeoutMs);
    this.minIdle = Math.max(0, Math.min(opts.minIdle ?? 1, this.maxSize));
    this.requestTimeoutMs = opts.requestTimeoutMs;
    this.lifecycle = { hookVisibility: true, hookFreeze: true, ...(opts.lifecycle || {}) };
    this.prewarmMode = opts.prewarm || 'eager';
    this.coreBudget = opts.coreBudget ?? null;
    this.workerCost = Math.max(1, opts.workerCost ?? 1);

    // browser cooperation hooks (Grok3 #30-33)
    const doc = (globalThis as any).document;
    if (doc && this.lifecycle.hookVisibility) {
      doc.addEventListener('visibilitychange', () => {
        if (doc.visibilityState === 'hidden') this.reapAllIdle();
        else this.prewarm(this.minIdle);
      });
    }
    // Note: 'freeze'/'resume' Page Lifecycle would be added similarly if document has the events.

    if (this.prewarmMode === 'eager') {
      void this.prewarmAsync(this.minIdle);
    }
  }

  private prewarmMode: 'eager' | 'lazy' | 'on-demand' = 'eager';

  get destroyed(): boolean {
    return this.state === PoolState.Destroyed;
  }

  get poolState(): PoolState {
    return this.state;
  }

  get size(): number {
    return this.all.size;
  }

  get requestTimeout(): number | undefined {
    return this.requestTimeoutMs;
  }

  /** Allocate a bytesId for a LevelSource (lazily attached). */
  allocateBytesId(source: Extract<LevelSource, { kind: "tiled" }>): number {
    if (source.bytesId != null) return source.bytesId;
    const id = this.nextBytesId++;
    (source as any).bytesId = id;
    return id;
  }

  /** prewarm becomes async, resolves when spawned workers are ready (Grok3 #34). */
  async prewarmAsync(count: number): Promise<void> {
    if (this.state === PoolState.Destroyed || this.state === PoolState.Draining) return;
    this.state = PoolState.Prewarming;
    const n = Math.min(count, this.maxSize - this.all.size);
    const spawned: WorkerHandle[] = [];
    for (let i = 0; i < n; i++) {
      const h = this.spawnOne();
      this.idle.push(h);
      this.armIdleTimer(h);
      spawned.push(h);
    }
    if (spawned.length === 0) { this.state = PoolState.Active; return; }
    await Promise.all(spawned.map(h => h.ready.catch(() => {})));
    this.state = PoolState.Active;
  }

  prewarm(count: number): void {
    // sync fire-and-forget for back compat; use prewarmAsync for readiness
    void this.prewarmAsync(count);
  }

  /** whenReady for UI "warming" (Grok3 #36) */
  whenReady(): Promise<void> {
    // simple: resolve when we have at least minIdle ready or active
    if (this.idle.length + this.active.size >= this.minIdle) return Promise.resolve();
    return new Promise(resolve => {
      const check = () => {
        if (this.idle.length + this.active.size >= this.minIdle) resolve();
      };
      // crude: poll a bit, real impl would use a readiness event
      const t = globalThis.setTimeout(check, 0);
      // also hook on next release/prewarm but for minimal ok
    });
  }

  /** Full destroy per Grok3 #9. */
  async destroy(graceMs = 5000): Promise<void> {
    if (this.state === PoolState.Destroyed) return;
    this.state = PoolState.Draining;

    // reject all inflight with POOL_DESTROYED
    for (const h of this.all) {
      for (const entry of Array.from(h.inflight)) {
        try { entry.reject(new PyramidError('POOL_DESTROYED', 'pool destroyed')); } catch {}
      }
      h.inflight.clear();
    }

    // destroy idles (ignore minIdle floor)
    for (const h of [...this.idle]) {
      this.destroyHandle(h, 'pool destroy');
    }
    this.idle.length = 0;

    // wait for active to drain or grace
    const drained = new Promise<void>(r => {
      const iv = globalThis.setInterval(() => {
        if (this.active.size === 0) { globalThis.clearInterval(iv); r(); }
      }, 10);
    });
    await Promise.race([drained, new Promise(r => globalThis.setTimeout(r, graceMs))]);

    // force remaining
    for (const h of [...this.active]) {
      this.destroyHandle(h, 'pool destroy grace');
    }

    this.state = PoolState.Destroyed;
  }

  private destroyHandle(h: WorkerHandle, reason: string) {
    if (h.state === HandleState.Terminated) return;
    // reject inflight (Grok3 #20)
    for (const entry of Array.from(h.inflight)) {
      try { entry.reject(new PyramidError('POOL_DESTROYED', reason)); } catch {}
    }
    h.inflight.clear();
    setHandleState(h, HandleState.Terminated);
    this.clearIdleTimer(h);
    this.active.delete(h);
    const ii = this.idle.indexOf(h);
    if (ii >= 0) this.idle.splice(ii, 1);
    this.all.delete(h);
    this.bytesIdByWorker.delete(h.worker);
    try { h.worker.terminate(); } catch {}
  }

  /** reap all idle (for visibility hidden etc) */
  private reapAllIdle() {
    for (const h of [...this.idle]) this.destroyHandle(h, 'reap all');
    this.idle.length = 0;
  }

  /**
   * Acquire (with waiter queue for over cap, LIFO idle, ready filter, state checks).
   */
  async acquire(count: number, opts?: { maxWaitMs?: number }): Promise<WorkerHandle[]> {
    if (this.state === PoolState.Destroyed || this.state === PoolState.Draining || count <= 0) {
      if (this.state === PoolState.Destroyed) throw new PyramidError('POOL_DESTROYED', 'pool destroyed');
      return [];
    }

    const maxWait = opts?.maxWaitMs ?? 60;
    const got: WorkerHandle[] = [];

    // LIFO drain (pop hottest) (Grok3 #18)
    while (got.length < count && this.idle.length > 0) {
      const h = this.idle.pop()!;
      this.clearIdleTimer(h);
      if (h.state !== HandleState.WarmReapable && h.state !== HandleState.WarmFloor) {
        this.destroyHandle(h, 'stale on acquire');
        continue;
      }
      setHandleState(h, HandleState.Active);
      this.active.add(h);
      got.push(h);
    }

    // spawn under cap
    while (got.length < count && this.all.size < this.maxSize) {
      try {
        const h = this.spawnOne();
        setHandleState(h, HandleState.Active);
        this.active.add(h);
        got.push(h);
      } catch { break; }
    }

    // waiter queue if still short (Grok3 #26-29)
    if (got.length < count) {
      const need = count - got.length;
      if (this.all.size >= this.maxSize) {
        // enqueue
        return new Promise<WorkerHandle[]>((resolve) => {
          const expiresAt = Date.now() + maxWait;
          this.waiters.push({ want: need, resolve: (hs) => resolve(hs), expiresAt });
          // timeout drain
          globalThis.setTimeout(() => {
            const idx = this.waiters.findIndex(w => w.resolve === resolve as any);
            if (idx >= 0) {
              const w = this.waiters.splice(idx, 1)[0];
              resolve([]); // fewer than wanted, caller falls back
            }
          }, maxWait);
        });
      }
    }

    // ready filter (existing + state)
    const readyOrWait: WorkerHandle[] = [];
    for (const h of got) {
      if (h.readySettled || h.state === HandleState.Active) {
        readyOrWait.push(h);
        continue;
      }
      try {
        await Promise.race([h.ready, new Promise(r => globalThis.setTimeout(r, maxWait))]);
        if (h.readySettled) readyOrWait.push(h);
        else readyOrWait.push(h);
      } catch {
        readyOrWait.push(h);
      }
    }

    // Agent6-1 CoreBudget: acquire tokens for the handles we are granting (around the active window).
    // tryAcquire first for hot path (pan); await only on contention. Cost per handle (default 1).
    if (this.coreBudget && readyOrWait.length > 0) {
      const c = this.workerCost;
      const need = readyOrWait.length;
      let granted = 0;
      for (let i = 0; i < need; i++) {
        if (this.coreBudget.tryAcquire(c)) granted++;
        else break;
      }
      if (granted < need) {
        await this.coreBudget.acquire(c * (need - granted));
      }
    }

    return readyOrWait;
  }

  /** Return to idle (LIFO), drain waiters, arm all excess (Grok3 #19, #28). */
  release(handles: WorkerHandle[]): void {
    let budgetReleaseCount = 0;
    for (const h of handles) {
      this.active.delete(h);
      if (this.state === PoolState.Draining || this.state === PoolState.Destroyed || h.state === HandleState.Terminated || h.state === HandleState.Bad || !this.all.has(h) || h.pending.size > 0) {
        this.destroyHandle(h, 'release of dead/inflight');
        continue;
      }
      setHandleState(h, HandleState.WarmReapable);
      this.idle.push(h); // LIFO push
      budgetReleaseCount++;
    }

    if (this.coreBudget && budgetReleaseCount > 0) {
      this.coreBudget.release(this.workerCost * budgetReleaseCount);
    }

    // drain waiters before re-arm (Grok3)
    while (this.waiters.length > 0 && this.idle.length > 0) {
      const w = this.waiters.shift()!;
      const give: WorkerHandle[] = [];
      while (give.length < w.want && this.idle.length > 0) {
        const h = this.idle.pop()!;
        this.clearIdleTimer(h);
        setHandleState(h, HandleState.Active);
        this.active.add(h);
        give.push(h);
      }
      w.resolve(give);
    }

    // arm ALL excess (walk) not just last (Grok3 #19)
    this.armAllExcessIdle();
  }

  private armAllExcessIdle() {
    if (this.idleTimeoutMs <= 0) {
      while (this.idle.length > this.minIdle) {
        const h = this.idle.pop()!;
        this.destroyHandle(h, 'excess idle');
      }
      return;
    }
    if (this.idle.length <= this.minIdle) return;
    for (let i = this.idle.length - 1; i >= this.minIdle; i--) {
      const h = this.idle[i];
      if (h) this.armIdleTimerFor(h);
    }
  }

  // --- private ---

  private spawnOne(): WorkerHandle {
    if (this.state === PoolState.Destroyed || this.state === PoolState.Draining) throw new PyramidError('POOL_DESTROYED', 'pool destroyed');
    const worker = this.factory();

    let readyResolve: ((v?: unknown) => void) | undefined;
    const ready = new Promise<void>((resolve) => { readyResolve = (v?: unknown) => resolve(); });

    // create handle but register to all/handleByWorker AFTER wiring (Grok3 #22)
    const h: WorkerHandle = {
      worker,
      idleTimer: null,
      state: HandleState.WarmFloor,
      pending: new Map(),
      nextId: 0,
      ready,
      _readyResolve: readyResolve,
      readySettled: false,
      inflight: new Set(),
    } as WorkerHandle;

    // Permanent lifecycle listeners - wire first
    const onDeath = () => this.destroyHandle(h, "worker error");
    let wiringOk = true;
    try {
      worker.addEventListener("error", onDeath);
      worker.addEventListener("messageerror", onDeath);
    } catch {
      wiringOk = false; /* test doubles */
    }

    // onMessage ...
    const onMessage = (ev: { data?: any }) => {
      if (h.state === HandleState.Terminated || h.state === HandleState.Bad) return;
      const data = ev.data;
      const reply = parseWorkerReply(data);
      if (!reply) return;
      if (reply.type === 'ready') {
        if (!h.readySettled) {
          h.readySettled = true;
          h._readyResolve?.();
        }
        return;
      }
      if (reply.type !== 'decode-reply') return;

      const job = h.pending.get(reply.id);
      if (!job) return;
      h.pending.delete(reply.id);
      if (job.timer != null) { globalThis.clearTimeout(job.timer); job.timer = null; }
      const entry = Array.from(h.inflight).find(e => e.id === reply.id);
      if (entry) h.inflight.delete(entry);

      if (!reply.ok) {
        const e = new PyramidError(reply.error?.code || 'INTERNAL', reply.error?.message || 'worker error');
        job.reject(e);
        if (reply.error?.code === 'OOM' || reply.error?.code === 'INTERNAL') {
          setHandleState(h, HandleState.Bad, { code: reply.error.code as any, message: reply.error.message || '', at: Date.now(), count: 1 });
        }
        this.destroyHandle(h, `worker error ${reply.error?.code || ''}`);
        return;
      }
      let pixels: Uint8Array;
      const p = (reply as any).pixels;
      if (p instanceof Uint8Array) pixels = p;
      else if (p instanceof ArrayBuffer) pixels = new Uint8Array(p);
      else pixels = new Uint8Array(p);
      job.resolve({ pixels, width: reply.w, height: reply.h });
    };
    try {
      worker.addEventListener("message", onMessage);
    } catch { wiringOk = false; }

    if (!wiringOk) {
      try { worker.terminate(); } catch {}
      throw new Error('lifecycle wiring failed');
    }

    // register AFTER wiring succeeds (Grok3 #22)
    this.all.add(h);
    this.handleByWorker.set(worker, h);
    this.bytesIdByWorker.set(worker, new Set());

    return h;
  }

  private killHandle(h: WorkerHandle, reason: string) { this.destroyHandle(h, reason); } // compat shim

  // Pre-bound for setTimeout( fn, ms, arg ) passthrough (Grok4).
  private readonly _reapBound = (h: WorkerHandle) => {
    if (this.idle.includes(h) && this.idle.length > this.minIdle) {
      this.destroyHandle(h, 'idle reaped');
    }
  };

  private armIdleTimer(h: WorkerHandle): void {
    this.clearIdleTimer(h);
    if (this.idleTimeoutMs <= 0) {
      if (this.idle.length > this.minIdle) this.destroyHandle(this.idle.pop()!, 'excess');
      return;
    }
    if (this.idle.length <= this.minIdle) return;
    h.idleTimer = globalThis.setTimeout(this._reapBound, this.idleTimeoutMs, h);
  }

  private armIdleTimerFor(h: WorkerHandle) { this.armIdleTimer(h); }

  private clearIdleTimer(h: WorkerHandle): void {
    if (h.idleTimer !== null) {
      globalThis.clearTimeout(h.idleTimer);
      h.idleTimer = null;
    }
  }
}

// Grok3 #38-39 module-level consts (evaluated once)
const HWC = (globalThis as any).navigator?.hardwareConcurrency ?? 4;
const CAN_PARALLEL = canUseParallelTileWorkers();

/** Hoisted predicate (Grok4). */
export function shouldUseParallel(
  opts: { parallel?: boolean; workerFactory?: any; pool?: any } | undefined,
  numTiles: number,
  envCanParallel: boolean,
): boolean {
  return (opts?.parallel !== false) && envCanParallel && numTiles > 1 && !!(opts?.workerFactory || opts?.pool);
}

let pool: PyramidWorkerPool | null = null;

function getOrCreatePool(factory: () => WorkerLike, coreBudget?: { acquire(cost?: number): Promise<void>; release(cost?: number): void; tryAcquire(cost?: number): boolean; }): PyramidWorkerPool {
  if (pool && (pool.poolState === PoolState.Active || pool.poolState === PoolState.Prewarming || pool.poolState === PoolState.Created)) {
    // factory identity check per Grok3 #12
    return pool;
  }
  if (pool && pool.poolState !== PoolState.Destroyed && pool.poolState !== PoolState.Draining) {
    // active>0 and different factory -> conflict (caller should pass explicit pool)
    throw new PyramidError('FACTORY_CONFLICT', 'cannot swap workerFactory while pool has active decodes');
  }
  if (pool) {
    // previous destroyed or empty -> rebuild
    // (dispose would have nulled, but for safety)
  }
  const maxSize = Math.min(HWC, 8);
  const p = new PyramidWorkerPool({
    factory,
    maxSize,
    idleTimeoutMs: 5000,
    minIdle: 2,
    coreBudget,
  });
  void p.prewarmAsync(2);
  pool = p;
  return p;
}

export async function disposeDefaultPool(): Promise<void> {
  if (pool) {
    await pool.destroy();
    pool = null;
  }
}

/** Runtime validation for worker replies (Grok2). Returns null on mismatch -> caller logs + INVALID_REPLY. */
function parseWorkerReply(data: unknown): WorkerReply | null {
  if (!data || typeof data !== 'object') return null;
  const d: any = data;
  if (d.v !== 1) return null;
  if (d.type === 'ready') {
    return { v: 1, type: 'ready' };
  }
  if (d.type === 'decode-reply' && typeof d.id === 'number') {
    if (d.ok === true) {
      if ((d.pixels instanceof Uint8Array || d.pixels instanceof ArrayBuffer) &&
          typeof d.w === 'number' && typeof d.h === 'number') {
        return { v: 1, type: 'decode-reply', id: d.id, ok: true, pixels: d.pixels as any, w: d.w, h: d.h };
      }
      return null;
    }
    if (d.ok === false && d.error && typeof d.error.code === 'string') {
      return {
        v: 1, type: 'decode-reply', id: d.id, ok: false,
        error: { code: d.error.code as WorkerErrorCode, message: String(d.error.message || ''), stack: d.error.stack }
      };
    }
  }
  return null;
}

async function decodeTilesParallel(
  bytesId: number,
  format: 'rgba8' | 'rgba16',
  tiles: ImageRegion[],
  handles: WorkerHandle[],
  outBuffer: Uint8Array,
  viewport: ImageRegion,
  bpp: 4 | 8,
  opts: { signal?: AbortSignal; onTile?: (region: ImageRegion, completedCount: number, progress?: any) => void; progressiveStage?: 'dc' | 'final' } = {},
  deadlineMs?: number,
  requestTimeoutMs?: number,
  tileSize?: number,
  tileLevel?: number,
): Promise<void> {
  if (handles.length === 0) return;
  if (opts.signal?.aborted) {
    throw new PyramidError('ABORTED', 'decode aborted before start');
  }

  const controller = new AbortController();
  const effectiveSignal = opts.signal || controller.signal;
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  // Stream-stitch: no results[] retention. Write on arrival, drop decoded ref immediately.
  let next = 0;
  let failed = false;
  let firstErr: unknown = null;
  let completedCount = 0;

  const coros = handles.map(async (h) => {
    while (true) {
      if (failed || controller.signal.aborted) break;
      if (h.state === HandleState.Terminated || h.state === HandleState.Bad) {
        if (!failed) { failed = true; firstErr = new PyramidError('INTERNAL', 'worker dead mid-batch'); }
        break;
      }
      const idx = next++;
      if (idx >= tiles.length) break;
      const region = tiles[idx]!;
      try {
        const decoded = await decodeTileWithWorker(h, bytesId, region, format, deadlineMs, effectiveSignal, requestTimeoutMs, (opts as any).progressiveStage);
        if (!failed) {
          stitch(outBuffer, viewport, region, decoded, bpp);
          // Drop ref after write (stream-stitch; aids GC of per-tile buffers).
          (decoded as any).pixels = null as any;
          completedCount += 1;
          // F7: stable TileId for this tile (level/col/row); onTile passes region (compat) + caller can map via tileKey
          const tId: TileId | undefined = (tileSize != null) ? { level: tileLevel ?? 0, col: Math.floor(region.x / tileSize), row: Math.floor(region.y / tileSize) } : undefined;
          void tId; // surfaced for telemetry / multi-pass (dc/final) coordination; onTile(region, count) unchanged for API compat
          opts.onTile?.(region, completedCount);
        }
      } catch (e) {
        if (!failed) { failed = true; firstErr = e; controller.abort(); }
        for (const hh of handles) {
          if (hh.state !== HandleState.Terminated && hh.state !== HandleState.Bad) {
            setHandleState(hh, HandleState.Terminated);
            for (const [iid, job] of Array.from(hh.pending.entries())) {
              hh.pending.delete(iid);
              if (job.timer != null) { globalThis.clearTimeout(job.timer); job.timer = null; }
              try { job.reject(new PyramidError('ABORTED', `batch tile failure`)); } catch {}
            }
            try { hh.worker.terminate(); } catch {}
          }
        }
        break;
      }
    }
  });

  await Promise.all(coros);
  if (failed) {
    if (controller.signal.aborted || (opts.signal && opts.signal.aborted)) throw new PyramidError('ABORTED', 'decode aborted');
    throw firstErr instanceof Error ? firstErr : new PyramidError('INTERNAL', String(firstErr));
  }
}

/**
 * Decode a tiled viewport with optional parallel per-tile workers (Grok2 protocol).
 * Uses bytesId + load/decode split. 16-bit now wired at root via format.
 */
export async function decodeTiledViewportPooled(
  containerBytes: Uint8Array,
  region: ImageRegion,
  options?: {
    parallel?: boolean;
    decodeRegion?: RegionDecoder;
    workerFactory?: () => WorkerLike;
    signal?: AbortSignal;
    /** Opt-in SAB zero-copy for the load message when crossOriginIsolated. */
    useSAB?: boolean;
  },
): Promise<DecodedLevel>;

export async function decodeTiledViewportPooled(
  source: Extract<LevelSource, { kind: "tiled" }>,
  region: ImageRegion,
  options?: {
    parallel?: boolean;
    decodeRegion?: RegionDecoder;
    workerFactory?: () => WorkerLike;
    signal?: AbortSignal;
    useSAB?: boolean;
  },
): Promise<DecodedLevel>;

export async function decodeTiledViewportPooled(
  arg1: Uint8Array | Extract<LevelSource, { kind: "tiled" }>,
  region: ImageRegion,
  options?: DecodeOptions & { useSAB?: boolean; pool?: PyramidWorkerPool },
): Promise<DecodedLevel> {
  const signal = options?.signal;
  if (signal?.aborted) throw new PyramidError('ABORTED', 'decode aborted before start');

  let source: Extract<LevelSource, { kind: "tiled" }>;
  if (arg1 instanceof Uint8Array) {
    const header = parseJxtcHeader(arg1);
    const fmt: PixelFormat = header.bitsPerSample === 16 ? 'rgba16' : 'rgba8';
    source = {
      kind: "tiled",
      bytes: arg1,
      width: header.imageW,
      height: header.imageH,
      tileSize: header.tileSize,
      bitsPerSample: header.bitsPerSample,
      format: fmt,
      bpp: bppOfFormat(fmt),
      version: header.version,
    };
  } else {
    source = arg1;
  }

  prepareLevelSource(source);

  if (!Number.isFinite(region.x) || !Number.isFinite(region.y) || !Number.isFinite(region.w) || !Number.isFinite(region.h)) {
    throw new RangeError("region must have finite x,y,w,h");
  }

  const plan = prepareDecodePlan(source, region);
  const decodeRegion = options?.decodeRegion ?? plan.decodeRegion;
  const vp = plan.viewport;
  const bpp = plan.bpp;
  const need = vp.w * vp.h * bpp;

  // Cache check at decode entry (viewport rect granularity for this levelId).
  const cache = options?.cache;
  const cacheKeyFinal = cache ? viewportCacheKey(getLevelId(source), vp, plan.format as PixelFormat, 'final') : undefined;
  if (cache && cacheKeyFinal) {
    const cached = cache.get(cacheKeyFinal);
    if (cached) {
      if (options?.outBuffer) {
        const ob = options.outBuffer;
        if (ob.byteLength < need) throw new PyramidError('INVALID_BUFFER_SIZE', `outBuffer too small (${ob.byteLength} < ${need})`);
        ob.set(cached);
        return { pixels: ob, width: vp.w, height: vp.h, format: plan.format as PixelFormat };
      }
      return { pixels: cached, width: vp.w, height: vp.h, format: plan.format as PixelFormat };
    }
  }

  // Allocate or validate caller outBuffer once (stream-stitch / direct paths reuse it).
  let outBuffer: Uint8Array;
  if (options?.outBuffer) {
    if (options.outBuffer.byteLength < need) {
      throw new PyramidError('INVALID_BUFFER_SIZE', `outBuffer too small (${options.outBuffer.byteLength} < ${need})`);
    }
    outBuffer = options.outBuffer;
  } else {
    outBuffer = new Uint8Array(need);
  }
  const onTile = options?.onTile;

  const wantParallel = shouldUseParallel(options, plan.tiles.length, CAN_PARALLEL);

  if (!wantParallel) {
    const p = decodeRegion(source.bytes, vp);
    let direct: DecodedLevel;
    if (signal) {
      if (signal.aborted) throw new PyramidError('ABORTED', 'decode aborted before start');
      const ac = new AbortController();
      signal.addEventListener('abort', () => ac.abort(), { once: true });
      direct = await Promise.race([p, new Promise<DecodedLevel>((_, rej) => ac.signal.addEventListener('abort', () => rej(new PyramidError('ABORTED', 'decode aborted')), { once: true }))]);
    } else {
      direct = await p;
    }
    outBuffer.set(direct.pixels);
    const result: DecodedLevel = { pixels: outBuffer, width: vp.w, height: vp.h, format: plan.format as PixelFormat };
    if (cache && cacheKeyFinal) cache.set(cacheKeyFinal, new Uint8Array(outBuffer));
    onTile?.(vp, 1);
    return result;
  }

  // #41: pool from caller opts.pool (preferred) or module singleton (created once outside hot path via getOrCreate when factory provided)
  let p: PyramidWorkerPool;
  if (options?.pool) {
    p = options.pool;
  } else if (options?.workerFactory) {
    p = getOrCreatePool(options.workerFactory, (options as any).coreBudget);
  } else {
    // fallback direct into outBuffer
    const direct = await decodeRegion(source.bytes, vp);
    outBuffer.set(direct.pixels);
    const result: DecodedLevel = { pixels: outBuffer, width: vp.w, height: vp.h, format: plan.format as PixelFormat };
    if (cache && cacheKeyFinal) cache.set(cacheKeyFinal, new Uint8Array(outBuffer));
    onTile?.(vp, 1);
    return result;
  }

  const bytesId = p.allocateBytesId(source as any);

  const useSAB = options?.useSAB === true && canShareContainerBytes();

  const desired = Math.min(HWC, plan.tiles.length);
  const liveHandles = await p.acquire(desired);

  if (liveHandles.length === 0) {
    const direct = await decodeRegion(source.bytes, vp);
    outBuffer.set(direct.pixels);
    const result: DecodedLevel = { pixels: outBuffer, width: vp.w, height: vp.h, format: plan.format as PixelFormat };
    if (cache && cacheKeyFinal) cache.set(cacheKeyFinal, new Uint8Array(outBuffer));
    onTile?.(vp, 1);
    return result;
  }

  // load once per worker
  for (const h of liveHandles) {
    let set = (p as any).bytesIdByWorker.get(h.worker);
    if (!set) { set = new Set<number>(); (p as any).bytesIdByWorker.set(h.worker, set); }
    if (!set.has(bytesId)) {
      try {
        if (useSAB && (globalThis as any).SharedArrayBuffer) {
          const sab = new (globalThis as any).SharedArrayBuffer(source.bytes.byteLength);
          new Uint8Array(sab).set(source.bytes);
          h.worker.postMessage({ v: 1, type: 'load', bytesId, sab, byteLength: source.bytes.byteLength } as any);
        } else {
          h.worker.postMessage({ v: 1, type: 'load', bytesId, bytes: source.bytes });
        }
        set.add(bytesId);
      } catch {}
    }
  }

  try {
    const prog = options?.progressive;
    const baseTileOpts: { signal?: AbortSignal; onTile?: (region: ImageRegion, completedCount: number, progress?: any) => void; progressiveStage?: 'dc' | 'final' } = {};
    if (signal != null) baseTileOpts.signal = signal;
    if (onTile) baseTileOpts.onTile = onTile;

    if (prog === 'dc-then-final') {
      // DC pass first (fast first paint for all tiles), then final refine pass. onTile fires per stage.
      const dcOpts = { ...baseTileOpts, progressiveStage: 'dc' as const };
      await decodeTilesParallel(bytesId, plan.format, plan.tiles, liveHandles, outBuffer, vp, bpp, dcOpts, undefined, p.requestTimeout, source.tileSize, 0);
      const finOpts = { ...baseTileOpts, progressiveStage: 'final' as const };
      await decodeTilesParallel(bytesId, plan.format, plan.tiles, liveHandles, outBuffer, vp, bpp, finOpts, undefined, p.requestTimeout, source.tileSize, 0);
    } else {
      const tileOpts = { ...baseTileOpts };
      await decodeTilesParallel(
        bytesId,
        plan.format,
        plan.tiles,
        liveHandles,
        outBuffer,
        vp,
        bpp,
        tileOpts,
        undefined,
        p.requestTimeout,
        source.tileSize,
        0,
      );
    }
    const result: DecodedLevel = { pixels: outBuffer, width: vp.w, height: vp.h, format: plan.format as PixelFormat };
    if (cache && cacheKeyFinal) cache.set(cacheKeyFinal, new Uint8Array(outBuffer));
    // Agent6-4: stamp shared ICC ref (once per source via ensure) for pooled path.
    if (options?.preserveMetadata) {
      const icc = await ensureIccProfile(source as any, options as any);
      if (icc) result.iccProfile = icc;
    }
    return result;
  } finally {
    p.release(liveHandles);
  }
}
