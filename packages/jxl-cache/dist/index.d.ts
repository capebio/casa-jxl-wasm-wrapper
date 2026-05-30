import { JxlCacheBrowser, CacheOptions } from './browser.js';
import { JxlCacheNode } from './node.js';
export * from './lru.js';
export * from './browser.js';
export * from './node.js';
export declare function createJxlCache(opts: CacheOptions): JxlCacheBrowser | JxlCacheNode;
