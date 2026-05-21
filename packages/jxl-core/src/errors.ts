// jxl-core/src/errors.ts
// Error taxonomy: Section 18 of casabio-jxl-wrapper-construction-spec-v2.md

import type { DecodeFrameEvent } from "./types.js";

export type JxlErrorCode =
  | "MalformedCodestream"
  | "TruncatedStream"
  | "UnsupportedFeature"
  | "OutOfMemory"
  | "BudgetExceeded"
  | "Cancelled"
  | "WorkerCrashed"
  | "CapabilityMissing"
  | "ConfigError"
  | "Internal";

export class JxlError extends Error {
  readonly code: JxlErrorCode;
  readonly sessionId?: string;
  readonly partial?: DecodeFrameEvent;  // best frame so far, when applicable
  readonly cause?: unknown;

  constructor(
    code: JxlErrorCode,
    message: string,
    opts?: { sessionId?: string; partial?: DecodeFrameEvent; cause?: unknown },
  ) {
    super(message);
    this.name = "JxlError";
    this.code = code;
    if (opts?.sessionId !== undefined) this.sessionId = opts.sessionId;
    if (opts?.partial !== undefined) this.partial = opts.partial;
    if (opts?.cause !== undefined) this.cause = opts.cause;
  }
}
