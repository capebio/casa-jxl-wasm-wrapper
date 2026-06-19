// jxl-core/src/errors.ts
// Error taxonomy: Section 18 of casabio-jxl-wrapper-construction-spec-v2.md
/**
 * All codes that can appear on the wire. Normalisation must consult this set so
 * that unknown future codes collapse to "Internal" rather than pass through raw.
 */
export const KNOWN_JXL_ERROR_CODES = new Set([
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
]);
/**
 * Normalise an untrusted wire code string to a known JxlErrorCode.
 * Unknown codes map to "Internal" so callers always receive a typed value.
 */
export function normalizeCode(code) {
    return KNOWN_JXL_ERROR_CODES.has(code)
        ? code
        : "Internal";
}
export class JxlError extends Error {
    code;
    sessionId;
    partial; // best frame so far, when applicable
    cause;
    constructor(code, message, opts) {
        super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
        this.name = "JxlError";
        this.code = code;
        if (opts?.sessionId !== undefined)
            this.sessionId = opts.sessionId;
        if (opts?.partial !== undefined)
            this.partial = opts.partial;
        if (opts?.cause !== undefined)
            this.cause = opts.cause;
    }
}
//# sourceMappingURL=errors.js.map