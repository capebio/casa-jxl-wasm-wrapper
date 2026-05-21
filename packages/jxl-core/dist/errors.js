// jxl-core/src/errors.ts
// Error taxonomy: Section 18 of casabio-jxl-wrapper-construction-spec-v2.md
export class JxlError extends Error {
    code;
    sessionId;
    partial; // best frame so far, when applicable
    cause;
    constructor(code, message, opts) {
        super(message);
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