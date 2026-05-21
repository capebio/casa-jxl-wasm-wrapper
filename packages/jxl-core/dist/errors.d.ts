import type { DecodeFrameEvent } from "./types.js";
export type JxlErrorCode = "MalformedCodestream" | "TruncatedStream" | "UnsupportedFeature" | "OutOfMemory" | "BudgetExceeded" | "Cancelled" | "WorkerCrashed" | "CapabilityMissing" | "ConfigError" | "Internal";
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