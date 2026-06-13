import { JxlCacheBrowser } from './browser.js';
import { JxlCacheNode } from './node.js';
export * from './lru.js';
export * from './browser.js';
export * from './node.js';
const isNode = typeof process !== 'undefined' && process.versions && process.versions.node;
export function createJxlCache(opts) {
    if (isNode) {
        return new JxlCacheNode(opts);
    }
    else {
        return new JxlCacheBrowser(opts);
    }
}
