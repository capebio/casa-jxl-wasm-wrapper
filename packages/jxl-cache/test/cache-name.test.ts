import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cacheNameFor, safeCacheName } from "../src/browser.js";

describe("cacheNameFor (sync, namespaced)", () => {
  it("returns a string synchronously — not a Promise", () => {
    const n = cacheNameFor("photo-123.jxl");
    assert.equal(typeof n, "string");
    assert.ok(!(n instanceof Promise));
  });

  it("short keys land in the raw- namespace, deterministic and distinct", () => {
    assert.equal(cacheNameFor("a"), "raw-a");
    assert.equal(cacheNameFor("a"), cacheNameFor("a"));
    assert.notEqual(cacheNameFor("a"), cacheNameFor("b"));
    assert.ok(cacheNameFor("dir/x y").startsWith("raw-"));
    // still URL-safe (no slashes / spaces leak through)
    assert.equal(cacheNameFor("dir/x y"), "raw-" + safeCacheName("dir/x y"));
  });

  it("long keys hash into the hash- namespace (16 hex chars)", () => {
    const long = "k".repeat(300);
    const n = cacheNameFor(long);
    assert.match(n, /^hash-[0-9a-f]{16}$/);
    assert.equal(n, cacheNameFor(long)); // deterministic across calls
  });

  it("distinct long keys produce distinct hashes", () => {
    assert.notEqual(cacheNameFor("k".repeat(300)), cacheNameFor("k".repeat(299) + "z"));
    assert.notEqual(cacheNameFor("https://a/" + "x".repeat(250)),
                    cacheNameFor("https://b/" + "x".repeat(250)));
  });

  it("B7: a short key shaped like hash-<hex> cannot collide with a hashed long key", () => {
    const evil = "hash-" + "a".repeat(64);     // looks like a hashed filename
    const evilName = cacheNameFor(evil);       // but it's short → raw- namespace
    assert.ok(evilName.startsWith("raw-"));
    const realHash = cacheNameFor("k".repeat(400));
    assert.ok(realHash.startsWith("hash-"));
    assert.notEqual(evilName, realHash);       // namespaces never overlap
  });
});
