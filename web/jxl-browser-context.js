// Lazy singleton JxlContext for browser callers. Import with:
//   import { getContext } from './jxl-browser-context.js';
// The context is created on first call; subsequent calls return the same instance.
// Requires the @casabio/jxl-session import map entry to be active.

import { createBrowserContext } from '@casabio/jxl-session';

let _ctx = null;

export function getContext() {
    if (_ctx === null) {
        try {
            _ctx = createBrowserContext();
        } catch (err) {
            console.error('[jxl-browser-context] Failed to create JxlContext:', err);
            // No-op context so callers don't hard-crash on import map misconfiguration.
            _ctx = {
                decode() { throw new Error('[jxl-browser-context] Context unavailable'); },
                encode() { throw new Error('[jxl-browser-context] Context unavailable'); },
                capabilities() { return {}; },
                async shutdown() {},
            };
        }
    }
    return _ctx;
}

export async function resetContext() {
    if (_ctx?.shutdown) {
        try {
            await _ctx.shutdown();
        } catch {}
    }
    _ctx = null;
    return getContext();
}
