import { afterEach, expect, test } from "bun:test";
import { __testing, disposeDefaultPool } from "../src/tiled-decode-pool.js";
import type { LevelSource } from "../src/level-source.js";

type WorkerRequest =
  | { v: 1; type: "load"; bytesId: number; bytes?: Uint8Array; sab?: SharedArrayBuffer; byteLength?: number }
  | { v: 1; type: "decode"; id: number; bytesId: number; region: { x: number; y: number; w: number; h: number }; format: "rgba8" | "rgba16"; deadlineMs?: number; progressiveStage?: "dc" | "final" }
  | { v: 1; type: "cancel"; id: number };

type DecodeAction =
  | { kind: "success"; delayMs?: number; fill?: number; pixelsLength?: number }
  | { kind: "error"; delayMs?: number; code?: string; message?: string }
  | { kind: "hang" };

class FakeWorker {
  readonly loads: number[] = [];
  readonly loadPayloads: Array<{ bytesId: number; sab?: SharedArrayBuffer; byteLength?: number; bytes?: Uint8Array }> = [];
  readonly cancels: number[] = [];
  readonly decodeRequests: WorkerRequest[] = [];
  terminated = false;
  terminateCalls = 0;

  private readonly listeners = new Map<"message" | "error" | "messageerror", Set<(ev: { data?: any }) => void>>();
  private readonly decodePlan: DecodeAction[];
  private decodeCount = 0;
  private pendingDecodeId: number | null = null;

  constructor(plan: DecodeAction[] = [], readyDelayMs = 0) {
    this.decodePlan = [...plan];
    this.listeners.set("message", new Set());
    this.listeners.set("error", new Set());
    this.listeners.set("messageerror", new Set());
    globalThis.setTimeout(() => {
      if (!this.terminated) this.emit("message", { v: 1, type: "ready" });
    }, readyDelayMs);
  }

  addEventListener(type: "message" | "error" | "messageerror", listener: (ev: { data?: any }) => void): void {
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: "message" | "error" | "messageerror", listener: (ev: { data?: any }) => void): void {
    this.listeners.get(type)!.delete(listener);
  }

  postMessage(data: WorkerRequest): void {
    if (this.terminated) throw new Error("terminated");
    if (data.type === "load") {
      this.loads.push(data.bytesId);
      this.loadPayloads.push({ bytesId: data.bytesId, sab: data.sab, byteLength: data.byteLength, bytes: data.bytes });
      return;
    }
    if (data.type === "cancel") {
      this.cancels.push(data.id);
      if (this.pendingDecodeId === data.id) this.pendingDecodeId = null;
      return;
    }
    this.decodeRequests.push(data);
    const action = this.decodePlan[this.decodeCount++] ?? { kind: "success" as const };
    if (action.kind === "hang") {
      this.pendingDecodeId = data.id;
      return;
    }
    const delayMs = action.delayMs ?? 0;
    globalThis.setTimeout(() => {
      if (this.terminated || this.pendingDecodeId === null && action.kind === "hang") return;
      if (action.kind === "error") {
        this.emit("message", {
          v: 1,
          type: "decode-reply",
          id: data.id,
          ok: false,
          error: { code: action.code ?? "INTERNAL", message: action.message ?? "boom" },
        });
        return;
      }
      const fill = action.fill ?? 7;
      const pixels = new Uint8Array(action.pixelsLength ?? data.region.w * data.region.h * 4).fill(fill);
      this.emit("message", {
        v: 1,
        type: "decode-reply",
        id: data.id,
        ok: true,
        pixels,
        w: data.region.w,
        h: data.region.h,
      });
    }, delayMs);
  }

  terminate(): void {
    this.terminated = true;
    this.terminateCalls += 1;
    this.pendingDecodeId = null;
  }

  private emit(type: "message" | "error" | "messageerror", data: any): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
}

function makeTiledSource(width = 64, height = 32, tileSize = 32): Extract<LevelSource, { kind: "tiled" }> {
  const bytes = new Uint8Array(32);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x4354584a, true);
  view.setUint32(4, 1, true);
  view.setUint32(8, width, true);
  view.setUint32(12, height, true);
  view.setUint32(16, tileSize, true);
  view.setUint32(20, 2, true);
  view.setUint32(24, 1, true);
  view.setUint32(28, 0, true);
  return {
    kind: "tiled",
    bytes,
    width,
    height,
    tileSize,
    bitsPerSample: 8,
    format: "rgba8",
    bpp: 4,
    version: 1,
  };
}

function makeTiledSource16(width = 64, height = 32, tileSize = 32): Extract<LevelSource, { kind: "tiled" }> {
  const source = makeTiledSource(width, height, tileSize);
  new DataView(source.bytes.buffer).setUint32(28, 2, true);
  return {
    ...source,
    bitsPerSample: 16,
    format: "rgba16",
    bpp: 8,
  };
}

function makeCache(capacityBytes?: number) {
  const map = new Map<string, Uint8Array>();
  return {
    capacityBytes,
    get(key: string) {
      return map.get(key);
    },
    set(key: string, value: Uint8Array) {
      map.set(key, value);
    },
    has(key: string) {
      return map.has(key);
    },
    delete(key: string) {
      map.delete(key);
    },
    clear() {
      map.clear();
    },
    entries: map,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

afterEach(async () => {
  await disposeDefaultPool();
});

test("acquire returns partial handles on timeout without stranding them", async () => {
  const mod = await import("../src/tiled-decode-pool.js");
  const Pool = (mod as any).PyramidWorkerPool;
  const pool = new Pool({
    factory: () => new FakeWorker(),
    maxSize: 1,
    idleTimeoutMs: 0,
    minIdle: 0,
    prewarm: "on-demand",
  });

  const handles = await pool.acquire(2, { maxWaitMs: 20 });
  expect(handles).toHaveLength(1);
  pool.release(handles);
  expect(pool.activeCount).toBe(0);

  const again = await pool.acquire(1, { maxWaitMs: 20 });
  expect(again).toHaveLength(1);
  pool.release(again);
  await pool.destroy();
});

test("destroy drains queued waiters", async () => {
  const mod = await import("../src/tiled-decode-pool.js");
  const Pool = (mod as any).PyramidWorkerPool;
  const pool = new Pool({
    factory: () => new FakeWorker([{ kind: "hang" }]),
    maxSize: 1,
    idleTimeoutMs: 0,
    minIdle: 0,
    prewarm: "on-demand",
  });

  const held = await pool.acquire(1);
  const waiting = pool.acquire(1, { maxWaitMs: 1_000 });
  await delay(10);
  await pool.destroy(10);
  const resolved = await waiting;
  expect(resolved).toEqual([]);
  expect(pool.destroyed).toBe(true);
  pool.release(held);
});

test("whenReady resolves after worker ready", async () => {
  const mod = await import("../src/tiled-decode-pool.js");
  const Pool = (mod as any).PyramidWorkerPool;
  const pool = new Pool({
    factory: () => new FakeWorker([], 25),
    maxSize: 1,
    idleTimeoutMs: 1000,
    minIdle: 1,
    prewarm: "eager",
  });

  await Promise.race([
    pool.whenReady(),
    delay(200).then(() => { throw new Error("whenReady timeout"); }),
  ]);

  await pool.destroy();
});

test("abort keeps worker alive for reuse", async () => {
  const mod = await import("../src/tiled-decode-pool.js");
  const Pool = (mod as any).PyramidWorkerPool;
  const workers: FakeWorker[] = [];
  const pool = new Pool({
    factory: () => {
      const worker = new FakeWorker([{ kind: "hang" }, { kind: "success", fill: 9 }]);
      workers.push(worker);
      return worker;
    },
    maxSize: 1,
    idleTimeoutMs: 1000,
    minIdle: 0,
    prewarm: "on-demand",
  });
  const ac = new AbortController();
  const handles = await pool.acquire(1, { maxWaitMs: 20 });
  const out = new Uint8Array(64 * 32 * 4);

  const pending = __testing.decodeTilesParallel(
    0,
    "rgba8",
    [{ x: 0, y: 0, w: 64, h: 32 }],
    handles,
    out,
    { x: 0, y: 0, w: 64, h: 32 },
    4,
    { signal: ac.signal },
    undefined,
    500,
  );
  await delay(10);
  ac.abort();
  await expect(pending).rejects.toThrow(/ABORTED|aborted/);
  pool.release(handles);

  const again = await pool.acquire(1, { maxWaitMs: 20 });
  const out2 = new Uint8Array(64 * 32 * 4);
  await __testing.decodeTilesParallel(
    0,
    "rgba8",
    [{ x: 0, y: 0, w: 64, h: 32 }],
    again,
    out2,
    { x: 0, y: 0, w: 64, h: 32 },
    4,
    {},
    undefined,
    500,
  );
  pool.release(again);
  expect(out2[0]).toBe(9);
  expect(workers).toHaveLength(1);
  expect(workers[0]!.terminateCalls).toBe(0);

  await pool.destroy();
});

test("default singleton rejects conflicting workerFactory while active", async () => {
  const workerFactoryA = () => new FakeWorker([{ kind: "hang" }]);
  const workerFactoryB = () => new FakeWorker([{ kind: "success" }]);
  const poolA = __testing.getOrCreatePool(workerFactoryA);
  const held = await poolA.acquire(1, { maxWaitMs: 20 });
  expect(() => __testing.getOrCreatePool(workerFactoryB)).toThrow(/FACTORY_CONFLICT|cannot swap workerFactory/);
  poolA.release(held);
});

test("bytes ids are scoped per pool", async () => {
  const mod = await import("../src/tiled-decode-pool.js");
  const Pool = (mod as any).PyramidWorkerPool;
  const poolA = new Pool({
    factory: () => new FakeWorker(),
    maxSize: 1,
    idleTimeoutMs: 0,
    minIdle: 0,
    prewarm: "on-demand",
  });
  const poolB = new Pool({
    factory: () => new FakeWorker(),
    maxSize: 1,
    idleTimeoutMs: 0,
    minIdle: 0,
    prewarm: "on-demand",
  });

  const sourceA = makeTiledSource();
  const sourceB = makeTiledSource(96, 32, 32);
  expect(poolA.allocateBytesId(sourceA)).toBe(0);
  expect(poolB.allocateBytesId(sourceB)).toBe(0);
  expect(poolB.allocateBytesId(sourceA)).toBe(1);
  expect((sourceA as any).bytesId).toBeUndefined();

  await poolA.destroy();
  await poolB.destroy();
});

test("destroy removes visibilitychange listener", async () => {
  const mod = await import("../src/tiled-decode-pool.js");
  const Pool = (mod as any).PyramidWorkerPool;
  const added: Array<(ev?: unknown) => void> = [];
  const removed: Array<(ev?: unknown) => void> = [];
  const prevDocument = (globalThis as any).document;
  (globalThis as any).document = {
    visibilityState: "visible",
    addEventListener(type: string, listener: (ev?: unknown) => void) {
      if (type === "visibilitychange") added.push(listener);
    },
    removeEventListener(type: string, listener: (ev?: unknown) => void) {
      if (type === "visibilitychange") removed.push(listener);
    },
  };

  try {
    const pool = new Pool({
      factory: () => new FakeWorker(),
      maxSize: 1,
      idleTimeoutMs: 0,
      minIdle: 0,
      prewarm: "on-demand",
    });
    expect(added).toHaveLength(1);
    await pool.destroy();
    expect(removed).toEqual(added);
  } finally {
    (globalThis as any).document = prevDocument;
  }
});

test("pooled cache hit clones by default and shares keys across source overloads", async () => {
  const { decodeTiledViewportPooled } = await import("../src/tiled-decode-pool.js");
  const source = makeTiledSource(96, 64, 32);
  const region = { x: 0, y: 0, w: 32, h: 32 };
  const cache = makeCache();
  let calls = 0;
  const decodeRegion = async (_bytes: Uint8Array, r: typeof region) => {
    calls += 1;
    return { pixels: new Uint8Array(r.w * r.h * 4).fill(17), width: r.w, height: r.h, format: "rgba8" as const };
  };

  const first = await decodeTiledViewportPooled(source, region, { parallel: false, decodeRegion, cache });
  const second = await decodeTiledViewportPooled(source.bytes, region, { parallel: false, decodeRegion, cache });

  expect(calls).toBe(1);
  expect(second.pixels).toEqual(first.pixels);
  expect(second.pixels).not.toBe(first.pixels);

  const zeroCopy = await decodeTiledViewportPooled(source.bytes, region, { parallel: false, decodeRegion, cache, zeroCopyCacheHits: true });
  expect(zeroCopy.pixels).toBe(cache.entries.values().next().value);
});

test("pooled cache stores only viewport bytes from oversized outBuffer", async () => {
  const { decodeTiledViewportPooled } = await import("../src/tiled-decode-pool.js");
  const source = makeTiledSource(96, 64, 32);
  const region = { x: 0, y: 0, w: 32, h: 32 };
  const cache = makeCache();
  const outBuffer = new Uint8Array(32 * 32 * 4 + 19).fill(99);
  const decodeRegion = async (_bytes: Uint8Array, r: typeof region) => ({
    pixels: new Uint8Array(r.w * r.h * 4).fill(5),
    width: r.w,
    height: r.h,
    format: "rgba8" as const,
  });

  await decodeTiledViewportPooled(source, region, { parallel: false, decodeRegion, cache, outBuffer });

  const cached = cache.entries.values().next().value as Uint8Array;
  expect(cached.byteLength).toBe(32 * 32 * 4);
  expect(cached[cached.byteLength - 1]).toBe(5);
});

test("pooled path guards caller outBuffer reuse and 16-bit alignment", async () => {
  const { decodeTiledViewportPooled } = await import("../src/tiled-decode-pool.js");
  const source = makeTiledSource(64, 32, 32);
  const region = { x: 0, y: 0, w: 32, h: 32 };
  const busy = new Uint8Array(32 * 32 * 4);
  const blocked = decodeTiledViewportPooled(source, region, {
    parallel: false,
    outBuffer: busy,
    decodeRegion: async () => {
      await delay(50);
      return { pixels: new Uint8Array(32 * 32 * 4), width: 32, height: 32, format: "rgba8" as const };
    },
  });
  await expect(
    decodeTiledViewportPooled(source, region, {
      parallel: false,
      outBuffer: busy,
      decodeRegion: async () => ({ pixels: new Uint8Array(32 * 32 * 4), width: 32, height: 32, format: "rgba8" as const }),
    }),
  ).rejects.toMatchObject({ code: "BUFFER_IN_USE" });
  await blocked;

  const source16 = makeTiledSource16(64, 32, 32);
  const unaligned = new Uint8Array(new ArrayBuffer(32 * 32 * 8 + 1), 1);
  await expect(
    decodeTiledViewportPooled(source16, region, {
      parallel: false,
      outBuffer: unaligned,
      decodeRegion: async () => ({ pixels: new Uint8Array(32 * 32 * 8), width: 32, height: 32, format: "rgba16" as const }),
    }),
  ).rejects.toMatchObject({ code: "INVALID_BUFFER_ALIGNMENT" });
});

test("pooled worker loads one shared SAB across handles and forwards one absolute deadline to both stages", async () => {
  const { decodeTiledViewportPooled, PyramidWorkerPool } = await import("../src/tiled-decode-pool.js");
  const workers: FakeWorker[] = [];
  const factory = () => {
    const worker = new FakeWorker([{ kind: "success", fill: 3 }, { kind: "success", fill: 4 }]);
    workers.push(worker);
    return worker;
  };
  const pool = new PyramidWorkerPool({ factory, maxSize: 2, idleTimeoutMs: 0, minIdle: 0, prewarm: "on-demand" });
  const source = makeTiledSource(64, 32, 32);
  const region = { x: 0, y: 0, w: 64, h: 32 };

  try {
    await decodeTiledViewportPooled(source, region, {
      parallel: true,
      pool,
      useSAB: true,
      budgetMs: 25,
      progressive: "dc-then-final",
    });

    const loadedWorkers = workers.filter((worker) => worker.loadPayloads.length > 0);
    expect(loadedWorkers.length).toBeGreaterThanOrEqual(2);
    expect(loadedWorkers[0]!.loadPayloads[0]!.sab).toBeInstanceOf(SharedArrayBuffer);
    expect(loadedWorkers[0]!.loadPayloads[0]!.sab).toBe(loadedWorkers[1]!.loadPayloads[0]!.sab);
    const deadlines = loadedWorkers.flatMap((worker) =>
      worker.decodeRequests
        .filter((req): req is Extract<WorkerRequest, { type: "decode" }> => req.type === "decode")
        .map((req) => req.deadlineMs),
    );
    expect(deadlines.length).toBeGreaterThan(0);
    const uniq = new Set(deadlines);
    expect(uniq.size).toBe(1);
    expect([...uniq][0]).toBeNumber();
    expect(loadedWorkers.some((worker) => worker.decodeRequests.some((req: any) => req.progressiveStage === "dc"))).toBe(true);
    expect(loadedWorkers.some((worker) => worker.decodeRequests.some((req: any) => req.progressiveStage === "final"))).toBe(true);
  } finally {
    await pool.destroy();
  }
});

test("pooled onTile emits TileProgress for dc and final passes", async () => {
  const { decodeTiledViewportPooled, PyramidWorkerPool } = await import("../src/tiled-decode-pool.js");
  const pool = new PyramidWorkerPool({
    factory: () => new FakeWorker([{ kind: "success", fill: 1 }, { kind: "success", fill: 2 }]),
    maxSize: 2,
    idleTimeoutMs: 0,
    minIdle: 0,
    prewarm: "on-demand",
  });
  const source = makeTiledSource(64, 32, 32);
  const seen: Array<any> = [];

  try {
    await decodeTiledViewportPooled(source, { x: 0, y: 0, w: 64, h: 32 }, {
      parallel: true,
      pool,
      progressive: "dc-then-final",
      onTile: (_region, _completed, progress) => {
        seen.push(progress);
      },
    });

    expect(seen).toHaveLength(4);
    expect(seen[0]).toMatchObject({ key: "L0-C0-R0", stage: "dc", completed: 1, total: 4 });
    expect(seen[1]).toMatchObject({ key: "L0-C1-R0", stage: "dc", completed: 2, total: 4 });
    expect(seen[2]).toMatchObject({ key: "L0-C0-R0", stage: "final", completed: 3, total: 4 });
    expect(seen[3]).toMatchObject({ key: "L0-C1-R0", stage: "final", completed: 4, total: 4 });
  } finally {
    await pool.destroy();
  }
});

test("short worker reply is rejected as INVALID_REPLY", async () => {
  const mod = await import("../src/tiled-decode-pool.js");
  const Pool = (mod as any).PyramidWorkerPool;
  const pool = new Pool({
    factory: () => new FakeWorker([{ kind: "success", pixelsLength: 7 }]),
    maxSize: 1,
    idleTimeoutMs: 0,
    minIdle: 0,
    prewarm: "on-demand",
  });
  const handles = await pool.acquire(1, { maxWaitMs: 20 });

  await expect(
    __testing.decodeTilesParallel(
      0,
      "rgba8",
      [{ x: 0, y: 0, w: 2, h: 1 }],
      handles,
      new Uint8Array(8),
      { x: 0, y: 0, w: 2, h: 1 },
      4,
      {},
      undefined,
      500,
      32,
      0,
    ),
  ).rejects.toMatchObject({ code: "INVALID_REPLY" });

  pool.release(handles);
  await pool.destroy();
});

test("failed tile retries once on a surviving handle", async () => {
  const mod = await import("../src/tiled-decode-pool.js");
  const Pool = (mod as any).PyramidWorkerPool;
  const workers: FakeWorker[] = [];
  const plans: DecodeAction[][] = [
    [{ kind: "error", code: "UNKNOWN_BYTES_ID", message: "transient" }],
    [{ kind: "success", fill: 9 }, { kind: "success", fill: 4 }],
  ];
  const pool = new Pool({
    factory: () => {
      const worker = new FakeWorker(plans[workers.length] ?? []);
      workers.push(worker);
      return worker;
    },
    maxSize: 2,
    idleTimeoutMs: 0,
    minIdle: 0,
    prewarm: "on-demand",
  });
  const handles = await pool.acquire(2, { maxWaitMs: 20 });
  const out = new Uint8Array(64 * 32 * 4);

  await __testing.decodeTilesParallel(
    0,
    "rgba8",
    [{ x: 0, y: 0, w: 32, h: 32 }, { x: 32, y: 0, w: 32, h: 32 }],
    handles,
    out,
    { x: 0, y: 0, w: 64, h: 32 },
    4,
    {},
    undefined,
    500,
    32,
    0,
  );

  pool.release(handles);
  expect(out[0]).toBe(4);
  expect(out[32 * 4]).toBe(9);
  await pool.destroy();
});

test("decodeTilesParallel removes outer and per-tile abort listeners after settle", async () => {
  const mod = await import("../src/tiled-decode-pool.js");
  const Pool = (mod as any).PyramidWorkerPool;
  const pool = new Pool({
    factory: () => new FakeWorker([{ kind: "success", fill: 8 }]),
    maxSize: 1,
    idleTimeoutMs: 0,
    minIdle: 0,
    prewarm: "on-demand",
  });
  const handles = await pool.acquire(1, { maxWaitMs: 20 });
  const listeners = new Set<() => void>();
  const signal = {
    aborted: false,
    addEventListener(_type: string, listener: () => void) {
      listeners.add(listener);
    },
    removeEventListener(_type: string, listener: () => void) {
      listeners.delete(listener);
    },
  } as any;

  await __testing.decodeTilesParallel(
    0,
    "rgba8",
    [{ x: 0, y: 0, w: 32, h: 32 }],
    handles,
    new Uint8Array(32 * 32 * 4),
    { x: 0, y: 0, w: 32, h: 32 },
    4,
    { signal },
    undefined,
    500,
    32,
    0,
  );

  expect(listeners.size).toBe(0);
  pool.release(handles);
  await pool.destroy();
});
