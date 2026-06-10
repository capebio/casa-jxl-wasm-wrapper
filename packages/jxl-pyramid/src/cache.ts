import type { LevelSource } from "./level-source.js";
import { tileKey, type TileId } from "./decode-core.js";

export interface PyramidCache {
  get(key: string): Uint8Array | undefined;
  set(key: string, value: Uint8Array): void;
  has(key: string): boolean;
  delete(key: string): void;
  clear(): void;
}

const levelIdBySource = new WeakMap<LevelSource, string>();
const levelIdByBytes = new WeakMap<Uint8Array, string>();
let levelIdCounter = 0;

export function getLevelId(arg: Uint8Array | LevelSource): string {
  if (arg instanceof Uint8Array) {
    let id = levelIdByBytes.get(arg);
    if (id == null) {
      id = `B${++levelIdCounter}`;
      levelIdByBytes.set(arg, id);
    }
    return id;
  }
  let id = levelIdBySource.get(arg);
  if (id == null) {
    id = `L${++levelIdCounter}`;
    levelIdBySource.set(arg, id);
  }
  return id;
}

class InMemoryPyramidCache implements PyramidCache {
  private readonly map = new Map<string, Uint8Array>();
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  get(key: string): Uint8Array | undefined {
    const v = this.map.get(key);
    if (v) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: string, value: Uint8Array): void {
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
    }
  }

  clear(): void {
    this.map.clear();
    this.bytes = 0;
  }
}

export function createInMemoryPyramidCache(opts: { maxBytes?: number } = {}): PyramidCache {
  const max = opts.maxBytes ?? 32 * 1024 * 1024;
  return new InMemoryPyramidCache(max);
}

/** F7: canonical key for per-tile cache entries using stable TileId (no ad-hoc coord strings). */
export function makeTileCacheKey(sourceId: string, tile: TileId): string {
  return `${sourceId}:${tileKey(tile)}`;
}

// Re-export for consumers who import cache entrypoint for tile addressing.
export type { TileId };
export { tileKey };
