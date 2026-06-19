import type { DecodeFrameEvent } from "./types.js";
export type JxlErrorCode = "MalformedCodestream" | "TruncatedStream" | "UnsupportedFeature" | "OutOfMemory" | "BudgetExceeded" | "Cancelled" | "WorkerCrashed" | "CapabilityMissing" | "ConfigError" | "QueueOverflow" | "Internal" | "DuplicateSession" | "UnhandledError" | "UnhandledRejection" | "WorkerError" | "MessageDeserializeError";
/**
 * All codes that can appear on the wire. Normalisation must consult this set so
 * that unknown future codes collapse to "Internal" rather than pass through raw.
 */
export declare const KNOWN_JXL_ERROR_CODES: ReadonlySet<JxlErrorCode>;
/**
 * Normalise an untrusted wire code string to a known JxlErrorCode.
 * Unknown codes map to "Internal" so callers always receive a typed value.
 */
export declare function normalizeCode(code: string): JxlErrorCode;
export declare class JxlError extends Error {
    readonly code: JxlErrorCode;
    readonly sessionId?: string;
    readonly partial?: DecodeFrameEvent;
    readonly cause?: unknown;
    constructor(code: JxlErrorCode, message: string, opts?: {
        sessionId?: string;
        partial?: DecodeFrameEvent;
        cause?: unknown;
    });
}
//# sourceMappingURL=errors.d.ts.map