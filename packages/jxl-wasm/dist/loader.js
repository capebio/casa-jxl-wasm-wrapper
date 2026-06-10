const nodeCache = new Map();
// P5-1: browser-side module-scope promise memo (per buildId:wasmSha).
// Avoids repeated IDB open+get per call (e.g. worker spawn, multiple handlers).
// IDB remains the persistence/cold-start layer; this is hot-path memo only.
const browserModuleCache = new Map();
export async function loadJxlModule(manifest, options = {}) {
    const cacheKey = `${manifest.buildId}:${manifest.wasmSha}`;
    if (isNode()) {
        if (!nodeCache.has(cacheKey)) {
            nodeCache.set(cacheKey, loadNodeModule(manifest, options));
        }
        return nodeCache.get(cacheKey);
    }
    if (!browserModuleCache.has(cacheKey)) {
        browserModuleCache.set(cacheKey, loadBrowserModule(manifest, options));
    }
    return browserModuleCache.get(cacheKey);
}
async function loadNodeModule(manifest, options) {
    const fs = options.nodeFs ?? (await import("node:fs/promises"));
    const wasmUrl = options.wasmUrl ?? manifest.wasmUrl;
    const bytes = await fs.readFile(await resolveNodeWasmUrl(wasmUrl ?? ""));
    return WebAssembly.compile(bytes);
}
async function loadBrowserModule(manifest, options) {
    const key = `${manifest.buildId}:${manifest.wasmSha}`;
    const cached = await readIndexedDbModule(key, options);
    if (cached) {
        return cached;
    }
    const fetchImpl = options.fetchImpl ?? fetch;
    const wasmUrl = options.wasmUrl ?? manifest.wasmUrl;
    if (!wasmUrl) {
        throw new Error("jxl-wasm loader needs wasmUrl in browser");
    }
    const response = await fetchImpl(wasmUrl);
    // P5-2: pass a refetcher so compile can re-fetch on rare streaming fallback instead of .clone() (avoids doubling 2.7 MB peak mem).
    const module = await compileFromResponse(response, () => fetchImpl(wasmUrl));
    await writeIndexedDbModule(key, module, options);
    return module;
}
async function compileFromResponse(response, getFreshResponse) {
    if ("compileStreaming" in WebAssembly && response.body) {
        try {
            // Direct use (no .clone() tee). On failure the body is spent; caller-provided refetcher gets a fresh one.
            return await WebAssembly.compileStreaming(response);
        }
        catch {
            // Rare fallback (platform rejected streaming shape): re-fetch instead of paying clone memory for the common case.
            if (getFreshResponse) {
                const fresh = await getFreshResponse();
                return WebAssembly.compile(await fresh.arrayBuffer());
            }
            // Last-ditch: original response may be partially consumed.
        }
    }
    return WebAssembly.compile(await response.arrayBuffer());
}
async function readIndexedDbModule(key, options) {
    const factory = options.idbFactory ?? globalThis.indexedDB;
    if (!factory) {
        return undefined;
    }
    const db = await openCacheDb(factory, options.cacheDbName ?? "jxl-wasm-module-cache");
    try {
        const tx = db.transaction("modules", "readonly");
        const record = await requestToPromise(tx.objectStore("modules").get(key));
        return record?.module instanceof WebAssembly.Module ? record.module : undefined;
    }
    finally {
        db.close();
    }
}
async function writeIndexedDbModule(key, module, options) {
    const factory = options.idbFactory ?? globalThis.indexedDB;
    if (!factory) {
        return;
    }
    const db = await openCacheDb(factory, options.cacheDbName ?? "jxl-wasm-module-cache");
    try {
        const tx = db.transaction("modules", "readwrite");
        await requestToPromise(tx.objectStore("modules").put({ key, module }));
        await txComplete(tx);
    }
    finally {
        db.close();
    }
}
async function openCacheDb(factory, name) {
    const request = factory.open(name, 1);
    request.onupgradeneeded = () => {
        request.result.createObjectStore("modules", { keyPath: "key" });
    };
    return requestToPromise(request);
}
function requestToPromise(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}
function txComplete(tx) {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}
function isNode() {
    return typeof process !== "undefined" && !!process.versions?.node;
}
async function resolveNodeWasmUrl(wasmUrl) {
    if (!wasmUrl) {
        throw new Error("jxl-wasm loader needs wasmUrl in Node");
    }
    if (!wasmUrl.startsWith("file://")) {
        return wasmUrl;
    }
    const { fileURLToPath } = await import("node:url");
    return fileURLToPath(wasmUrl);
}
//# sourceMappingURL=loader.js.map