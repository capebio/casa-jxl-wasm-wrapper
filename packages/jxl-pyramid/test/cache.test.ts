import { expect, test, describe } from "bun:test";
import {
  createInMemoryPyramidCache,
  getLevelId,
  makeLevelCacheKey,
} from "../src/cache.js";

// ── LRU eviction order ──────────────────────────────────────────────────────

describe("LRU eviction order", () => {
  test("evicts oldest entry first when over capacity", () => {
    const cache = createInMemoryPyramidCache({ maxBytes: 30 });
    cache.set("a", new Uint8Array(10));
    cache.set("b", new Uint8Array(10));
    cache.set("c", new Uint8Array(10));
    // All fit exactly. Adding "d" (10 bytes) should evict "a" (oldest).
    cache.set("d", new Uint8Array(10));
    expect(cache.has("a")).toBe(false);
    expect(cache.has("b")).toBe(true);
    expect(cache.has("c")).toBe(true);
    expect(cache.has("d")).toBe(true);
  });

  test("get bumps recency — bumped entry survives eviction", () => {
    const cache = createInMemoryPyramidCache({ maxBytes: 20 });
    const a = new Uint8Array(10);
    const b = new Uint8Array(10);
    cache.set("a", a);
    cache.set("b", b);
    cache.get("a"); // bump "a" to most-recent
    cache.set("c", new Uint8Array(10)); // should evict "b" (now oldest)
    expect(cache.has("b")).toBe(false);
    expect(cache.has("a")).toBe(true);
    expect(cache.has("c")).toBe(true);
  });

  test("touch bumps recency without a read", () => {
    const cache = createInMemoryPyramidCache({ maxBytes: 20 });
    cache.set("a", new Uint8Array(10));
    cache.set("b", new Uint8Array(10));
    expect(cache.touch!("a")).toBe(true); // bump "a"
    cache.set("c", new Uint8Array(10)); // should evict "b"
    expect(cache.has("b")).toBe(false);
    expect(cache.has("a")).toBe(true);
  });

  test("touch on absent key returns false and allocates nothing", () => {
    const cache = createInMemoryPyramidCache({ maxBytes: 100 });
    expect(cache.touch!("missing")).toBe(false);
    expect(cache.stats!().bytesUsed).toBe(0);
  });
});

// ── Oversized set ───────────────────────────────────────────────────────────

describe("oversized set", () => {
  test("oversized entry is rejected without evicting existing entries", () => {
    const cache = createInMemoryPyramidCache({ maxBytes: 20 });
    cache.set("a", new Uint8Array(10));
    cache.set("b", new Uint8Array(10));
    cache.set("oversized", new Uint8Array(100)); // must not wipe cache
    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(true);
    expect(cache.has("oversized")).toBe(false);
    expect(cache.stats!().bytesUsed).toBe(20);
  });

  test("oversized entry deletes any existing entry under the same key", () => {
    const cache = createInMemoryPyramidCache({ maxBytes: 20 });
    cache.set("a", new Uint8Array(5));
    cache.set("a", new Uint8Array(100)); // oversized — should still delete the old "a"
    expect(cache.has("a")).toBe(false);
    expect(cache.stats!().bytesUsed).toBe(0);
  });
});

// ── Byte accounting exactness ───────────────────────────────────────────────

describe("byte accounting", () => {
  test("replace: accounting reflects new size", () => {
    const cache = createInMemoryPyramidCache({ maxBytes: 100 });
    cache.set("a", new Uint8Array(30));
    cache.set("a", new Uint8Array(50)); // replace
    expect(cache.stats!().bytesUsed).toBe(50);
    expect(cache.stats!().entryCount).toBe(1);
  });

  test("delete: bytes decrease by snapshotted length", () => {
    const cache = createInMemoryPyramidCache({ maxBytes: 100 });
    cache.set("a", new Uint8Array(40));
    cache.delete("a");
    expect(cache.stats!().bytesUsed).toBe(0);
    expect(cache.stats!().entryCount).toBe(0);
  });

  test("clear: bytes reset to 0", () => {
    const cache = createInMemoryPyramidCache({ maxBytes: 100 });
    cache.set("a", new Uint8Array(20));
    cache.set("b", new Uint8Array(30));
    cache.clear();
    expect(cache.stats!().bytesUsed).toBe(0);
    expect(cache.stats!().entryCount).toBe(0);
  });
});

// ── Hit/miss/eviction counters ───────────────────────────────────────────────

describe("stats counters", () => {
  test("hits and misses increment correctly", () => {
    const cache = createInMemoryPyramidCache({ maxBytes: 100 });
    cache.set("a", new Uint8Array(10));
    cache.get("a");   // hit
    cache.get("b");   // miss
    cache.get("a");   // hit
    const s = cache.stats!();
    expect(s.hits).toBe(2);
    expect(s.misses).toBe(1);
  });

  test("evictions count only capacity evictions, not delete/clear", () => {
    const evicted: string[] = [];
    const cache = createInMemoryPyramidCache({
      maxBytes: 20,
      onEvict: (key) => evicted.push(key),
    });
    cache.set("a", new Uint8Array(10));
    cache.set("b", new Uint8Array(10));
    cache.delete("a");    // NOT a capacity eviction (bytes → 10)
    cache.set("c", new Uint8Array(10)); // no eviction (10+10=20)
    cache.set("d", new Uint8Array(10)); // capacity eviction of "b" (20+10>20)
    expect(cache.stats!().evictions).toBe(1);
    expect(evicted).toEqual(["b"]);
  });
});

// ── onEvict semantics ────────────────────────────────────────────────────────

describe("onEvict", () => {
  test("fires only on capacity evictions, not delete/clear", () => {
    const fired: string[] = [];
    const cache = createInMemoryPyramidCache({
      maxBytes: 10,
      onEvict: (key) => fired.push(key),
    });
    cache.set("a", new Uint8Array(10));
    cache.delete("a");    // no onEvict
    cache.clear();        // no onEvict
    cache.set("b", new Uint8Array(10));
    cache.set("c", new Uint8Array(10)); // capacity eviction of "b"
    expect(fired).toEqual(["b"]);
  });

  test("onEvict receives the Uint8Array value", () => {
    const vals: Uint8Array[] = [];
    const cache = createInMemoryPyramidCache({
      maxBytes: 10,
      onEvict: (_, v) => vals.push(v),
    });
    const data = new Uint8Array([1, 2, 3]);
    cache.set("a", data);
    cache.set("b", new Uint8Array(10)); // capacity eviction of "a"
    expect(vals.length).toBe(1);
    expect(vals[0]).toBe(data);
  });
});

// ── setMaxBytes ──────────────────────────────────────────────────────────────

describe("setMaxBytes", () => {
  test("shrink evicts oldest entries to fit", () => {
    const evicted: string[] = [];
    const cache = createInMemoryPyramidCache({
      maxBytes: 60,
      onEvict: (key) => evicted.push(key),
    });
    cache.set("a", new Uint8Array(10));
    cache.set("b", new Uint8Array(10));
    cache.set("c", new Uint8Array(10)); // 30 bytes total
    cache.setMaxBytes!(15); // 30>15→evict a(20), 20>15→evict b(10), done
    expect(evicted).toContain("a");
    expect(evicted).toContain("b");
    expect(cache.stats!().bytesUsed).toBeLessThanOrEqual(15);
  });

  test("setMaxBytes(0) empties the cache via onEvict", () => {
    const evicted: string[] = [];
    const cache = createInMemoryPyramidCache({
      maxBytes: 100,
      onEvict: (key) => evicted.push(key),
    });
    cache.set("a", new Uint8Array(10));
    cache.set("b", new Uint8Array(10));
    cache.setMaxBytes!(0);
    expect(cache.stats!().bytesUsed).toBe(0);
    expect(evicted).toContain("a");
    expect(evicted).toContain("b");
  });
});

// ── Detach resilience ────────────────────────────────────────────────────────

describe("detach resilience (C2)", () => {
  test("get returns miss and fixes accounting when buffer is detached", () => {
    const cache = createInMemoryPyramidCache({ maxBytes: 100 });
    const buf = new Uint8Array(20);
    cache.set("a", buf);
    expect(cache.stats!().bytesUsed).toBe(20);

    // Detach the buffer
    structuredClone(buf.buffer, { transfer: [buf.buffer] });
    expect(buf.length).toBe(0); // detached

    const result = cache.get("a");
    expect(result).toBeUndefined();
    expect(cache.stats!().bytesUsed).toBe(0); // accounting healed
    expect(cache.stats!().misses).toBe(1);
  });
});

// ── getLevelId ───────────────────────────────────────────────────────────────

describe("getLevelId", () => {
  test("Uint8Array: returns B* prefix", () => {
    const v = new Uint8Array(10);
    expect(getLevelId(v)).toMatch(/^B\d+:/);
  });

  test("same buffer → same ID even via different views", () => {
    const ab = new ArrayBuffer(20);
    const v1 = new Uint8Array(ab, 0, 10);
    const v2 = new Uint8Array(ab, 0, 10);
    expect(getLevelId(v1)).toBe(getLevelId(v2));
  });

  test("different buffers → different IDs", () => {
    const v1 = new Uint8Array(10);
    const v2 = new Uint8Array(10);
    expect(getLevelId(v1)).not.toBe(getLevelId(v2));
  });

  test("LevelSource without bytes → L* prefix, stable per object", () => {
    const src = {} as any;
    const id1 = getLevelId(src);
    const id2 = getLevelId(src);
    expect(id1).toMatch(/^L\d+$/);
    expect(id1).toBe(id2);
  });

  test("distinct objects → distinct IDs", () => {
    expect(getLevelId({} as any)).not.toBe(getLevelId({} as any));
  });
});

// ── makeLevelCacheKey ────────────────────────────────────────────────────────

test("makeLevelCacheKey: stable content-addressed key", () => {
  expect(makeLevelCacheKey("abc123")).toBe("ch:abc123");
  expect(makeLevelCacheKey("abc123")).toBe(makeLevelCacheKey("abc123"));
  expect(makeLevelCacheKey("abc")).not.toBe(makeLevelCacheKey("def"));
});
