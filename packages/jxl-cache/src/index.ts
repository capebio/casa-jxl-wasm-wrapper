import { JxlCacheBrowser, CacheOptions } from './browser.js';
import { JxlCacheNode } from './node.js';

export * from './lru.js';
export * from './browser.js';
export * from './node.js';

export function createJxlCache(opts: CacheOptions): JxlCacheBrowser | JxlCacheNode {
  const isNode = typeof process !== 'undefined' && process.versions && process.versions.node;
  if (isNode) {
    return new JxlCacheNode(opts);
  } else {
    return new JxlCacheBrowser(opts);
  }
}
