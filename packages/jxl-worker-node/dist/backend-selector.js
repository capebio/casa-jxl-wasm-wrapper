// jxl-worker-node/src/backend-selector.ts
// Selects native libjxl vs WASM at worker startup.
// Spec: Section 15.2, T-WORKER-NODE brief.
// BLOCKED: jxl-native (T-NATIVE-BIND) and jxl-wasm (T-WASM-BUILD) not yet available.
//
// Real logic:
//   1. If process.env.JXL_FORCE_WASM === '1', skip native and go to step 3.
//   2. Try require('jxl-native'). On success, return { type: 'native', module }.
//   3. Try require('@casabio/jxl-wasm'). On success, return { type: 'wasm', module }.
//   4. Throw CapabilityMissing.
export async function selectBackend() {
    const forceWasm = process.env["JXL_FORCE_WASM"] === "1";
    if (!forceWasm) {
        const native = await tryNative();
        if (native !== null)
            return native;
    }
    const wasm = await tryWasm();
    if (wasm !== null)
        return wasm;
    throw new Error("[jxl-worker-node] Neither jxl-native nor jxl-wasm is available. " +
        "Install @casabio/jxl-native or set JXL_FORCE_WASM=0.");
}
async function tryNative() {
    try {
        // T-NATIVE-BIND will publish @casabio/jxl-native. Dynamic import so
        // a missing package does not crash at startup.
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore — module does not exist until T-NATIVE-BIND lands
        const mod = await import("@casabio/jxl-native").catch(() => null);
        if (mod === null)
            return null;
        return { type: "native", module: mod };
    }
    catch {
        return null;
    }
}
async function tryWasm() {
    try {
        // T-WASM-BUILD will publish @casabio/jxl-wasm.
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore — module does not exist until T-WASM-BUILD lands
        const mod = await import("@casabio/jxl-wasm").catch(() => null);
        if (mod === null)
            return null;
        return { type: "wasm", module: mod };
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=backend-selector.js.map