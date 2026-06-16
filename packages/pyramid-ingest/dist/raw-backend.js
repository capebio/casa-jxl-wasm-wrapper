import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import initRaw, { process_cr2_with_flags, process_dng_with_flags, process_orf_with_flags, } from "../../../web/pkg/raw_converter_wasm.js";
const OUT_FULL_RGB8 = 1;
const OUT_FULL_16 = 8;
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
    const flags = OUT_FULL_RGB8 | OUT_FULL_16;
    const pr = fn(bytes, flags, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NaN, NaN, 0, 0);
    try {
        // Take 16 first (before rgba) to ensure rgb16_full is populated in current wasm bindings.
        const rgb16 = pr.take_rgb16_full();
        const rgba = pr.take_rgba();
        const master = {
            rgba,
            width: pr.width,
            height: pr.height,
            orientation: "baked",
        };
        if (rgb16.length > 0)
            master.rgb16 = rgb16;
        return master;
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