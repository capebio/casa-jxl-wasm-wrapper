# Section 012 — fix_log: packages/jxl-stream/src/node.ts

**Date:** 2026-06-18  
**File:** `packages/jxl-stream/src/node.ts` (167 L after edits)  
**Typecheck gate:** `npm run typecheck` EXIT 0

---

## Fixes applied

### FIX-012-1 — Abort check moved before `await pending` (L41–44)

**Finding:** L38-45 (MED) — The abort check happened AFTER `await pending` but BEFORE `session.push`.
A chunk that arrived during the await was silently discarded without being pushed or counted.

**Before:**
```ts
const { done, value } = await pending;
if (done) break;
if (signal?.aborted) break;   // chunk received but never pushed
```

**After:**
```ts
if (signal?.aborted) break;   // check before awaiting, so no chunk is silently dropped
const { done, value } = await pending;
if (done) break;
```

**Rationale:** Checking abort at the TOP of each iteration (before awaiting) is consistent with
how `fromReadableStream` (browser.ts L81) structures its abort guard. It prevents receiving a
chunk and then immediately discarding it — the `onAbort` handler will destroy the readable, so
`it.next()` will reject/return done on the NEXT iteration anyway. This fix is contract-neutral:
the abort-resolve-vs-reject semantics are unchanged (the loop still breaks and falls through to
`if (signal?.aborted) { await session.cancel(…); } return delivered;`).

---

### FIX-012-2 — `onAbort` teardown sequenced + synthetic error suppressed (L22–27 + L29–33)

**Finding:** L22-62 / L32-70 (LOW) — `onAbort` called `session.cancel()` and
`readable.destroy(new Error('Aborted'))` concurrently. The synthetic `Error('Aborted')` passed to
`readable.destroy()` could surface as an unhandled `'error'` event on the readable if no error
listener was attached at the point the abort fires.

**Before (onAbort):**
```ts
const onAbort = () => {
  void session.cancel(ABORT_REASON);
  readable.destroy(new Error('Aborted'));
};
```

**Before (pre-aborted path):**
```ts
if (signal?.aborted) {
  readable.destroy(new Error('Aborted'));
  await session.cancel(ABORT_REASON);
  return 0;
}
```

**After (onAbort):**
```ts
const onAbort = () => {
  void session.cancel(ABORT_REASON).finally(() => { readable.destroy(); });
};
```

**After (pre-aborted path):**
```ts
if (signal?.aborted) {
  await session.cancel(ABORT_REASON);
  readable.destroy();   // no error arg — intentional cutoff, not a stream fault
  return 0;
}
```

**Rationale:**
- `readable.destroy()` with no argument closes the stream without emitting an `'error'` event.
  Since this is an intentional abort (not a fault), there's no reason to emit an error.
- In `onAbort`, session cancel is sequenced first (awaited via `.finally`), then the readable is
  destroyed. This prevents the race where both operations fire simultaneously and the readable
  destruction triggers an async iterator rejection that races with the main loop's `await pending`.
- On the pre-aborted path, session cancel is awaited first (was already awaited at P1-6; we just
  moved `readable.destroy()` after it and removed the error arg).

---

### FIX-012-3 — `toNodeReadable` generator `finally` made idempotent (L90–94)

**Finding:** L27-31 (LOW) — `toNodeReadable`'s async generator `finally` block and the `'close'`
event handler both guarded on `!finished` — but the `finally` block did NOT set `finished = true`
before calling `session.cancel()`. If both fired concurrently, both could see `!finished === true`
and both call `session.cancel('stream destroyed')`.

**Before:**
```ts
} finally {
  if (!finished) void session.cancel('stream destroyed');
}
```

**After:**
```ts
} finally {
  // Guard against double-fire with the 'close' event handler below.
  // Set finished = true before the async cancel so both paths see it.
  if (!finished) { finished = true; void session.cancel('stream destroyed'); }
}
```

**Rationale:** Setting `finished = true` before the async cancel call makes the guard idempotent:
whichever of `finally` or `'close'` arrives first wins and calls cancel; the second sees
`finished === true` and no-ops. The `'close'` handler already had this correct pattern.

---

## Deferrals

### DEFERRED-012-CONTRACT — Abort resolve-vs-reject semantics not changed

**Finding:** L38-63 (HIGH) — `fromNodeReadable` RESOLVES with a byte count on mid-stream abort;
`fromReadableStream` (browser) REJECTS with AbortError. This is a public-API contract divergence.

**Action:** Appended to `QUESTIONS.md` under `### Section 012 — jxl-stream (deferred)` as
`012-contracts-abort`. The three mechanical bugs above (FIX-012-1/2/3) are correct regardless of
which contract wins and do not commit to either behavior.

---

## Typecheck result

```
$ npm run typecheck
> tsc --noEmit
(no output — exit 0)
```
