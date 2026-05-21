// jxl-session/test/event-stream.test.ts
// Unit tests for AsyncEventStream — the push-driven AsyncIterable behind
// frames() and chunks().

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AsyncEventStream } from "../src/event-stream.js";

describe("AsyncEventStream", () => {
  it("delivers a pushed item to a waiting consumer", async () => {
    const s = new AsyncEventStream<number>();
    const it = s[Symbol.asyncIterator]();
    const pending = it.next();
    s.push(7);
    const r = await pending;
    assert.deepEqual(r, { value: 7, done: false });
  });

  it("buffers items pushed before a consumer arrives", async () => {
    const s = new AsyncEventStream<number>();
    s.push(1);
    s.push(2);
    const it = s[Symbol.asyncIterator]();
    assert.deepEqual(await it.next(), { value: 1, done: false });
    assert.deepEqual(await it.next(), { value: 2, done: false });
  });

  it("end() completes the iterator with done:true", async () => {
    const s = new AsyncEventStream<number>();
    s.end();
    const it = s[Symbol.asyncIterator]();
    const r = await it.next();
    assert.equal(r.done, true);
  });

  it("buffered items drain before end is observed", async () => {
    const s = new AsyncEventStream<number>();
    s.push(1);
    s.end();
    const it = s[Symbol.asyncIterator]();
    assert.deepEqual(await it.next(), { value: 1, done: false });
    assert.equal((await it.next()).done, true);
  });

  it("fail() rejects pending and subsequent consumers", async () => {
    const s = new AsyncEventStream<number>();
    const it = s[Symbol.asyncIterator]();
    const pending = it.next();
    const err = new Error("boom");
    s.fail(err);
    await assert.rejects(pending, /boom/);
    await assert.rejects(it.next(), /boom/);
  });

  it("for-await consumes a full sequence", async () => {
    const s = new AsyncEventStream<number>();
    s.push(1);
    s.push(2);
    s.push(3);
    s.end();
    const seen: number[] = [];
    for await (const v of s) seen.push(v);
    assert.deepEqual(seen, [1, 2, 3]);
  });
});
