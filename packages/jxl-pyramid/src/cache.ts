import type { LevelSource } from "./level-source.js";
import { tileKey, type TileId } from "./decode-core.js";

export interface PyramidCache {
  /** Get a cached Uint8Array. Note: Returned arrays must be treated as immutable when zeroCopyCacheHits is active to prevent aliasing side-effects. */
  get(key: string): Uint8Array | undefined;
  set(key: string, value: Uint8Array): void;
  has(key: string): boolean;
  delete(key: string): void;
  clear(): void;
  /** Optional byte capacity; entries larger than this are rejected by set(). */
  readonly capacityBytes?: number;
  /** Optional current bytes utilized in cache. */
  readonly bytesUsed?: number;
  /** Optional current count of entries in cache. */
  readonly entryCount?: number;
}

const levelIdBySource = new WeakMap<LevelSource, string>();
const bufIdByBuffer = new WeakMap<ArrayBufferLike, string>();
let idCounter = 0;

/**
 * Key by underlying buffer + view window instead of view identity.
 * This ensures that re-derived views or subarrays of the same buffer preserve the same identity.
 * Assumption: level bytes are immutable post-ingest; in-place mutation would alias IDs.
 */
export function bytesId(view: Uint8Array): string {
  let b = bufIdByBuffer.get(view.buffer);
  if (b == null) {
    b = `B${++idCounter}`;
    bufIdByBuffer.set(view.buffer, b);
  }
  return `${b}:${view.byteOffset}:${view.byteLength}`;
}

export function getLevelId(arg: Uint8Array | LevelSource): string {
  if (arg instanceof Uint8Array) {
    return bytesId(arg);
  }
  let id = levelIdBySource.get(arg);
  if (id == null) {
    id = (arg as any).bytes instanceof Uint8Array ? bytesId((arg as any).bytes) : `L${++idCounter}`;
    levelIdBySource.set(arg, id);
  }
  return id;
}

class InMemoryPyramidCache implements PyramidCache {
  private readonly map = new Map<string, Uint8Array>();
  private bytes = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly onEvict?: (key: string, bytes: number) => void,
  ) {}

  get capacityBytes(): number { return this.maxBytes; }
  get bytesUsed(): number { return this.bytes; }
  get entryCount(): number { return this.map.size; }

  get(key: string): Uint8Array | undefined {
    const v = this.map.get(key);
    if (v) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: string, value: Uint8Array): void {
    if (value.length > this.maxBytes) return; // reject, don't flush
    if (this.map.has(key)) {
      const old = this.map.get(key)!;
      this.bytes -= old.length;
      this.map.delete(key);
    }
    this.map.set(key, value);
    this.bytes += value.length;
    while (this.bytes > this.maxBytes && this.map.size > 0) {
      const oldestKey = this.map.keys().next().value as string;
      const oldest = this.map.get(oldestKey)!;
      this.bytes -= oldest.length;
      this.map.delete(oldestKey);
      this.onEvict?.(oldestKey, oldest.length);
    }
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  delete(key: string): void {
    const v = this.map.get(key);
    if (v) {
      this.bytes -= v.length;
      this.map.delete(key);
      this.onEvict?.(key, v.length);
    }
  }

  clear(): void {
    this.map.clear();
    this.bytes = 0;
  }
}

export function createInMemoryPyramidCache(opts: { maxBytes?: number; onEvict?: (key: string, bytes: number) => void } = {}): PyramidCache {
  const max = opts.maxBytes ?? 32 * 1024 * 1024;
  return new InMemoryPyramidCache(max, opts.onEvict);
}

/** F7: canonical key for per-tile cache entries using stable TileId (no ad-hoc coord strings). */
export function makeTileCacheKey(sourceId: string, tile: TileId): string {
  return `${sourceId}:${tileKey(tile)}`;
}

// Re-export for consumers who import cache entrypoint for tile addressing.
export type { TileId };
export { tileKey };
