const DB_NAME = 'jxl-source-folder';
const STORE_NAME = 'handles';
const HANDLE_KEY = 'folder';

let dbPromise = null;

function openDatabase() {
    if (typeof indexedDB === 'undefined') return Promise.resolve(null);
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
            request.result.createObjectStore(STORE_NAME);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('Failed to open folder store'));
    });

    return dbPromise;
}

async function withStore(mode, fn) {
    const db = await openDatabase();
    if (!db) return null;

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode);
        const store = tx.objectStore(STORE_NAME);
        let result;

        try {
            result = fn(store);
        } catch (err) {
            reject(err);
            return;
        }

        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error ?? new Error('Folder store transaction failed'));
        tx.onabort = () => reject(tx.error ?? new Error('Folder store transaction aborted'));
    });
}

export async function loadSavedFolderHandle() {
    try {
        return await withStore('readonly', (store) => new Promise((resolve, reject) => {
            const request = store.get(HANDLE_KEY);
            request.onsuccess = () => resolve(request.result ?? null);
            request.onerror = () => reject(request.error ?? new Error('Failed to load saved folder handle'));
        }));
    } catch (err) {
        console.warn('Saved folder handle unavailable', err);
        return null;
    }
}

export async function saveFolderHandle(handle) {
    if (!handle) return;
    try {
        await withStore('readwrite', (store) => {
            store.put(handle, HANDLE_KEY);
        });
    } catch (err) {
        console.warn('Failed to persist folder handle', err);
    }
}

export async function clearSavedFolderHandle() {
    try {
        await withStore('readwrite', (store) => {
            store.delete(HANDLE_KEY);
        });
    } catch (err) {
        console.warn('Failed to clear saved folder handle', err);
    }
}

export async function getFolderPermissionState(handle) {
    if (!handle || typeof handle.queryPermission !== 'function') return 'granted';
    try {
        return await handle.queryPermission({ mode: 'read' });
    } catch {
        return 'prompt';
    }
}

export async function ensureFolderPermission(handle) {
    if (!handle) return 'denied';
    const current = await getFolderPermissionState(handle);
    if (current === 'granted') return current;
    if (typeof handle.requestPermission !== 'function') return current;
    try {
        return await handle.requestPermission({ mode: 'read' });
    } catch {
        return 'denied';
    }
}

export async function pickFolderHandle() {
    if (typeof showDirectoryPicker !== 'function') {
        throw new Error('Folder picker is not supported in this browser');
    }
    const handle = await showDirectoryPicker({ mode: 'read' });
    await saveFolderHandle(handle);
    return handle;
}

async function collectFilesFromHandle(handle, files) {
    for await (const entry of handle.values()) {
        if (entry.kind === 'file') {
            if (/\.orf$/i.test(entry.name)) {
                files.push(await entry.getFile());
            }
            continue;
        }
        if (entry.kind === 'directory') {
            await collectFilesFromHandle(entry, files);
        }
    }
}

export async function readOrfFilesFromHandle(handle) {
    const files = [];
    if (!handle || typeof handle.values !== 'function') return files;
    await collectFilesFromHandle(handle, files);
    files.sort((a, b) => a.name.localeCompare(b.name));
    return files;
}
