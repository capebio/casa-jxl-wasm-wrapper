import { createHash } from "node:crypto";
import { resolve } from "node:path";
export function contentHash16(bytes) {
    return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}
export function imageIdForPath(masterPath) {
    return createHash("sha256").update(resolve(masterPath)).digest("hex").slice(0, 16);
}
//# sourceMappingURL=hash.js.map