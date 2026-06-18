# Bug-Finding Lenses

*Portable method. Applies to any Casabio module, not just `browser.ts`.*

## The governing principle

Bugs concentrate where the model in the programmer's head differs from the model in the code. In already-defensive code (generation counters, inflight coalescing, reconciliation), you will not find "forgot an `await`." You will find **distributed-systems invariants**: places where *operation A completes physically but not logically*. The file is written but the index doesn't know. The reference is dropped but the promise still runs. That gap is the hunting ground.

## The six lenses

**1. Seams / boundaries.** At every boundary between two worlds (caller↔cache, cache↔OPFS, OPFS↔decode, worker↔main), ask one question: **Copy? Move? View? Alias?** Milliseconds and corruption both hide here. Most "slow" code is only slow at the boundary where it forgets what it's moving.

**2. Copies.** Count buffer copies on the hot path. Each copy is an allocation, GC pressure, and a transient memory spike (briefly 2× for large buffers). A memory *hit* should cost zero copies; if it doesn't, that's the bug.

**3. Ownership.** For every buffer, name the owner. Is the ownership invariant *explicit*? "The cache owns a stable SharedArrayBuffer that cannot detach" is a good explicit invariant — keep those. Implicit ownership is where use-after-free-shaped bugs live in JS (detach, transfer, concurrent overwrite).

**4. Async races.** The sharpest question in the toolkit: *what happens if A finishes physically but not logically?* Corollary: **dropping a reference is not cancelling the work.** `map.clear()` removes pointers; the promises it pointed at keep running and can still mutate disk after the "clear." Guard *before open* and *after close*, and on a stale result, **undo the physical effect** — don't just skip the bookkeeping, or you leak.

**5. Hidden state machines.** Scattered booleans — `loaded`, `cached`, `pending`, `exists` — encode a state machine nobody declared. Their combinations explode and some are nonsense. Replace with one enum (`Unknown | Stored | Loading | Resident | Evicted | Failed`) and let the compiler enumerate the cases for you.

**6. Cache invariants.** Three rules that this codebase violates somewhere:
- *Index ≠ truth.* The manifest/tracker is a belief about the substrate. The files on disk are more authoritative than the index that describes them.
- *Existence ≠ availability.* "I have evidence this existed" is not "you can read it now."
- *The substrate is authoritative.* Recovery should bend the index toward the disk, never delete disk to satisfy a stale index.

## The semantic-fracture checklist

When a function feels overloaded, it usually conflates two concepts. Name the fracture; the fix follows:

| Function smells like | It conflates |
|---|---|
| `has()` lies | existence vs **availability** |
| manifest drifts | index vs **truth** |
| string keys everywhere | identity vs **naming** |
| LRU evicts the wrong thing | value vs **age** |
| `get()` does too much | retrieval vs **materialization** |
| `set()` does too much | residency vs **persistence** |

## Triage instinct

In hardened code, rank by *invariant violated*, not by *line that looks wrong*. A one-line function (`cacheNameFor`) can carry the biggest future risk; a hundred-line function can be correct. Spend the budget where physical and logical state can diverge under concurrency or crash.
