import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const workerSourcePath = fileURLToPath(new URL("../../src/worker.ts", import.meta.url));
const workerSource = readFileSync(workerSourcePath, "utf8");

describe("browser worker cold-start guardrails", () => {
  test("cold-start queue overflow aborts the pending start before handler creation", () => {
    assert.match(workerSource, /abortedStarts\s*=\s*new Set<string>/);
    assert.match(workerSource, /abortedStarts\.add\(sessionId\)/);
    assert.match(workerSource, /abortedStarts\.delete\(msg\.sessionId\)\s*\|\|\s*shuttingDown/);
  });

  test("cold-start queues are bounded by bytes as well as message count", () => {
    assert.match(workerSource, /MAX_QUEUED_BYTES_PER_SESSION\s*=\s*128\s*\*\s*1024\s*\*\s*1024/);
    assert.match(workerSource, /queuedDecodeBytes\s*=\s*new Map<string, number>/);
    assert.match(workerSource, /queuedEncodeBytes\s*=\s*new Map<string, number>/);
    assert.match(workerSource, /msg\.type === "decode_chunk"/);
    assert.match(workerSource, /msg\.type === "encode_pixels"/);
  });

  test("messageerror reports failed incoming message deserialization", () => {
    assert.match(workerSource, /addEventListener\("messageerror"/);
    assert.match(workerSource, /MessageDeserializeError/);
  });
});
