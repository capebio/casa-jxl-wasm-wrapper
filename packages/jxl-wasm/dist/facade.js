export class CapabilityMissing extends Error {
    code = "CapabilityMissing";
    cause;
    constructor(message, cause) {
        super(message);
        this.name = "CapabilityMissing";
        if (cause !== undefined) {
            this.cause = cause;
        }
    }
}
export function createDecoder(_options) {
    return new UnavailableDecoder();
}
export function createEncoder(_options) {
    return new UnavailableEncoder();
}
function missingCodec() {
    return new CapabilityMissing("jxl-wasm codec facade is present, but generated libjxl WASM glue is not installed");
}
class UnavailableDecoder {
    cancelled = false;
    push(_chunk) { }
    close() { }
    async *events() {
        if (this.cancelled)
            return;
        const error = missingCodec();
        yield {
            type: "error",
            code: error.code,
            message: error.message,
        };
    }
    cancel(_reason) {
        this.cancelled = true;
    }
    dispose() { }
}
class UnavailableEncoder {
    pushPixels(_chunk, _region) { }
    finish() { }
    async *chunks() {
        throw missingCodec();
    }
    cancel(_reason) { }
    dispose() { }
}
//# sourceMappingURL=facade.js.map