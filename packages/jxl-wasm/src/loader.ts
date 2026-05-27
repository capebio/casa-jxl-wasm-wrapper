export interface JxlWasmManifest {
  buildId: string;
  wasmSha: string;
  wasmUrl?: string;
}

export interface LoaderOptions {
  fetchImpl?: typeof fetch;
  idbFactory?: IDBFactory;
  nodeFs?: typeof import("node:fs/promises");
  cacheDbName?: string;
  wasmUrl?: string;
}

const nodeCache = new Map<string, Promise<WebAssembly.Module>>();

export async function loadJxlModule(manifest: JxlWasmManifest, options: LoaderOptions = {}): Promise<WebAssembly.Module> {
  const cacheKey = `${manifest.buildId}:${manifest.wasmSha}`;
  if (isNode()) {
    if (!nodeCache.has(cacheKey)) {
      nodeCache.set(cacheKey, loadNodeModule(manifest, options));
    }
    return nodeCache.get(cacheKey)!;
  }
  return loadBrowserModule(manifest, options);
}

async function loadNodeModule(manifest: JxlWasmManifest, options: LoaderOptions): Promise<WebAssembly.Module> {
  const fs = options.nodeFs ?? (await import("node:fs/promises"));
  const wasmUrl = options.wasmUrl ?? manifest.wasmUrl;
  const bytes = await fs.readFile(await resolveNodeWasmUrl(wasmUrl ?? ""));
  return WebAssembly.compile(bytes as BufferSource);
}

async function loadBrowserModule(manifest: JxlWasmManifest, options: LoaderOptions): Promise<WebAssembly.Module> {
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
  const module = await compileFromResponse(response);
  await writeIndexedDbModule(key, module, options);
  return module;
}

async function compileFromResponse(response: Response): Promise<WebAssembly.Module> {
  if ("compileStreaming" in WebAssembly && response.body) {
    try {
      return await WebAssembly.compileStreaming(response.clone());
    } catch {
      // Fall back to bytes for platforms that advertise streaming but reject the response shape.
    }
  }
  return WebAssembly.compile(await response.arrayBuffer());
}

async function readIndexedDbModule(key: string, options: LoaderOptions): Promise<WebAssembly.Module | undefined> {
  const factory = options.idbFactory ?? globalThis.indexedDB;
  if (!factory) {
    return undefined;
  }
  const db = await openCacheDb(factory, options.cacheDbName ?? "jxl-wasm-module-cache");
  try {
    const tx = db.transaction("modules", "readonly");
    const record = await requestToPromise(tx.objectStore("modules").get(key));
    return record?.module instanceof WebAssembly.Module ? record.module : undefined;
  } finally {
    db.close();
  }
}

async function writeIndexedDbModule(key: string, module: WebAssembly.Module, options: LoaderOptions): Promise<void> {
  const factory = options.idbFactory ?? globalThis.indexedDB;
  if (!factory) {
    return;
  }
  const db = await openCacheDb(factory, options.cacheDbName ?? "jxl-wasm-module-cache");
  try {
    const tx = db.transaction("modules", "readwrite");
    await requestToPromise(tx.objectStore("modules").put({ key, module }));
    await txComplete(tx);
  } finally {
    db.close();
  }
}

async function openCacheDb(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  const request = factory.open(name, 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore("modules", { keyPath: "key" });
  };
  return requestToPromise(request);
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txComplete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function isNode(): boolean {
  return typeof process !== "undefined" && !!process.versions?.node;
}

async function resolveNodeWasmUrl(wasmUrl: string): Promise<string> {
  if (!wasmUrl) {
    throw new Error("jxl-wasm loader needs wasmUrl in Node");
  }
  if (!wasmUrl.startsWith("file://")) {
    return wasmUrl;
  }
  const { fileURLToPath } = await import("node:url");
  return fileURLToPath(wasmUrl);
}
