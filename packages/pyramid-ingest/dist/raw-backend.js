import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import initRaw, { process_cr2_with_flags, process_dng_with_flags, process_orf_with_flags, } from "../../../web/pkg/raw_converter_wasm.js";
const OUT_FULL_RGB8 = 1;
let initPromise = null;
function ensureInit() {
    if (!initPromise) {
        initPromise = (async () => {
            const wasmPath = fileURLToPath(new URL("../../../web/pkg/raw_converter_wasm_bg.wasm", import.meta.url));
            const bytes = await readFile(wasmPath);
            return initRaw({ module_or_path: bytes });
        })();
    }
    return initPromise;
}
function decodeWith(fn, bytes) {
    const pr = fn(bytes, OUT_FULL_RGB8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NaN, NaN, 0, 0);
    try {
        const rgba = pr.take_rgba();
        return { rgba, width: pr.width, height: pr.height, orientation: "baked" };
    }
    finally {
        pr.free();
    }
}
export function createRawBackend() {
    return {
        async decode(bytes, format) {
            await ensureInit();
            switch (format) {
                case "orf": return decodeWith(process_orf_with_flags, bytes);
                case "dng": return decodeWith(process_dng_with_flags, bytes);
                case "cr2": return decodeWith(process_cr2_with_flags, bytes);
            }
        },
    };
}
//# sourceMappingURL=raw-backend.js.map