// jxl-core/src/errors.ts
// Error taxonomy: Section 18 of casabio-jxl-wrapper-construction-spec-v2.md

import type { DecodeFrameEvent } from "./types.js";

// libjxl codes (decoded from the worker codec layer)
// Worker lifecycle / protocol codes (emitted by the worker runtime, not libjxl)
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
  | "QueueOverflow"          // caller is pushing chunks faster than the worker can drain
  | "Internal"
  // Worker runtime codes — emitted by the worker process/thread, not libjxl:
  | "DuplicateSession"       // session ID already registered in this worker
  | "UnhandledError"         // uncaught Error in worker (onerror / unhandledrejection)
  | "UnhandledRejection"     // unhandled Promise rejection in worker
  | "WorkerError"            // generic worker-level fault (spawn, init, crash recovery)
  | "MessageDeserializeError"; // incoming message could not be parsed/validated

/**
 * All codes that can appear on the wire. Normalisation must consult this set so
 * that unknown future codes collapse to "Internal" rather than pass through raw.
 */
export const KNOWN_JXL_ERROR_CODES: ReadonlySet<JxlErrorCode> = new Set<JxlErrorCode>([
  "MalformedCodestream",
  "TruncatedStream",
  "UnsupportedFeature",
  "OutOfMemory",
  "BudgetExceeded",
  "Cancelled",
  "WorkerCrashed",
  "CapabilityMissing",
  "ConfigError",
  "QueueOverflow",
  "Internal",
  "DuplicateSession",
  "UnhandledError",
  "UnhandledRejection",
  "WorkerError",
  "MessageDeserializeError",
] as const);

/**
 * Normalise an untrusted wire code string to a known JxlErrorCode.
 * Unknown codes map to "Internal" so callers always receive a typed value.
 */
export function normalizeCode(code: string): JxlErrorCode {
  return KNOWN_JXL_ERROR_CODES.has(code as JxlErrorCode)
    ? (code as JxlErrorCode)
    : "Internal";
}

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
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "JxlError";
    this.code = code;
    if (opts?.sessionId !== undefined) this.sessionId = opts.sessionId;
    if (opts?.partial !== undefined) this.partial = opts.partial;
    if (opts?.cause !== undefined) this.cause = opts.cause;
  }
}
