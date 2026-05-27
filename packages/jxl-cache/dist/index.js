import { JxlCacheBrowser } from './browser.js';
import { JxlCacheNode } from './node.js';
export * from './lru.js';
export * from './browser.js';
export * from './node.js';
export function createJxlCache(opts) {
    const isNode = typeof process !== 'undefined' && process.versions && process.versions.node;
    if (isNode) {
        return new JxlCacheNode(opts);
    }
    else {
        return new JxlCacheBrowser(opts);
    }
}
