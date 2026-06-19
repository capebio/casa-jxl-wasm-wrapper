// jxl-session/test/jxl-core.test.ts
// Unit tests for the jxl-core runtime surface (JxlError) and contract shape.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { JxlError, KNOWN_JXL_ERROR_CODES, normalizeCode } from "@casabio/jxl-core/errors";

describe("JxlError", () => {
  it("is an Error subclass with code", () => {
    const e = new JxlError("MalformedCodestream", "bad bytes");
    assert.ok(e instanceof Error);
    assert.equal(e.name, "JxlError");
    assert.equal(e.code, "MalformedCodestream");
    assert.equal(e.message, "bad bytes");
  });

  it("carries optional sessionId, partial, cause", () => {
    const cause = new Error("root");
    const partial = {
      stage: "pass" as const,
      info: {
        width: 1, height: 1, bitsPerSample: 8 as const,
        hasAlpha: false, hasAnimation: false, jpegReconstructionAvailable: false,
      },
      pixels: new ArrayBuffer(4),
      format: "rgba8" as const,
      pixelStride: 4,
    };
    const e = new JxlError("TruncatedStream", "cut short", {
      sessionId: "s-1",
      partial,
      cause,
    });
    assert.equal(e.sessionId, "s-1");
    assert.equal(e.partial, partial);
    assert.equal(e.cause, cause);
  });

  it("omits optional fields when not supplied", () => {
    const e = new JxlError("Internal", "x");
    assert.equal(e.sessionId, undefined);
    assert.equal(e.partial, undefined);
    assert.equal(e.cause, undefined);
  });

  it("is throw/catch-able with code discrimination", () => {
    try {
      throw new JxlError("Cancelled", "user cancelled");
    } catch (err) {
      assert.ok(err instanceof JxlError);
      assert.equal((err as JxlError).code, "Cancelled");
    }
  });
});

describe("normalizeCode", () => {
  it("every KNOWN_JXL_ERROR_CODES entry round-trips unchanged", () => {
    for (const code of KNOWN_JXL_ERROR_CODES) {
      assert.equal(normalizeCode(code), code, `expected "${code}" to pass through normalizeCode unchanged`);
    }
  });

  it("unknown wire codes collapse to 'Internal'", () => {
    assert.equal(normalizeCode("SomeNewLibjxlCode"), "Internal");
    assert.equal(normalizeCode(""), "Internal");
    assert.equal(normalizeCode("undefined"), "Internal");
  });

  it("worker codes pass through (not collapsed to Internal)", () => {
    const workerCodes = [
      "DuplicateSession",
      "UnhandledError",
      "UnhandledRejection",
      "WorkerError",
      "MessageDeserializeError",
    ] as const;
    for (const code of workerCodes) {
      assert.equal(normalizeCode(code), code, `worker code "${code}" must not be collapsed`);
    }
  });

  it("libjxl codes pass through", () => {
    const libjxlCodes = [
      "MalformedCodestream", "TruncatedStream", "UnsupportedFeature",
      "OutOfMemory", "BudgetExceeded", "Cancelled", "WorkerCrashed",
      "CapabilityMissing", "ConfigError", "QueueOverflow", "Internal",
    ] as const;
    for (const code of libjxlCodes) {
      assert.equal(normalizeCode(code), code);
    }
  });
});
