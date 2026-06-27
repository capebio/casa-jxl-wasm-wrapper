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
            // Surface the real failure immediately rather than installing a no-op
            // stub that defers it to first decode/encode with a generic message
            // (and whose capabilities() === {} reads as "feature absent"). Leave
            // _ctx null so a later call can retry once the misconfiguration is fixed.
            throw new Error(
                '[jxl-browser-context] Failed to create JxlContext: ' + (err?.message ?? String(err)),
                { cause: err },
            );
        }
    }
    return _ctx;
}

export async function resetContext() {
    // Capture and detach the old context BEFORE awaiting its shutdown so a
    // concurrent getContext() can never observe the mid-shutdown instance —
    // it will create a fresh one instead.
    const old = _ctx;
    _ctx = null;
    if (old?.shutdown) {
        try {
            await old.shutdown();
        } catch {}
    }
    return getContext();
}
