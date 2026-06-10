const levelIdBySource = new WeakMap();
const levelIdByBytes = new WeakMap();
let levelIdCounter = 0;
export function getLevelId(arg) {
    if (arg instanceof Uint8Array) {
        let id = levelIdByBytes.get(arg);
        if (id == null) {
            id = `B${++levelIdCounter}`;
            levelIdByBytes.set(arg, id);
        }
        return id;
    }
    let id = levelIdBySource.get(arg);
    if (id == null) {
        id = `L${++levelIdCounter}`;
        levelIdBySource.set(arg, id);
    }
    return id;
}
class InMemoryPyramidCache {
    maxBytes;
    map = new Map();
    bytes = 0;
    constructor(maxBytes) {
        this.maxBytes = maxBytes;
    }
    get(key) {
        const v = this.map.get(key);
        if (v) {
            this.map.delete(key);
            this.map.set(key, v);
        }
        return v;
    }
    set(key, value) {
        if (this.map.has(key)) {
            const old = this.map.get(key);
            this.bytes -= old.length;
            this.map.delete(key);
        }
        this.map.set(key, value);
        this.bytes += value.length;
        while (this.bytes > this.maxBytes && this.map.size > 0) {
            const oldestKey = this.map.keys().next().value;
            const oldest = this.map.get(oldestKey);
            this.bytes -= oldest.length;
            this.map.delete(oldestKey);
        }
    }
    has(key) {
        return this.map.has(key);
    }
    delete(key) {
        const v = this.map.get(key);
        if (v) {
            this.bytes -= v.length;
            this.map.delete(key);
        }
    }
    clear() {
        this.map.clear();
        this.bytes = 0;
    }
}
export function createInMemoryPyramidCache(opts = {}) {
    const max = opts.maxBytes ?? 32 * 1024 * 1024;
    return new InMemoryPyramidCache(max);
}
//# sourceMappingURL=cache.js.map