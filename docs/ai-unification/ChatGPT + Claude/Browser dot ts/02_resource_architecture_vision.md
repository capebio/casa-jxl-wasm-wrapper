# Resource-Architecture Vision

*Direction, not a work order. Everything here is deferred until the Doc 4 correctness work lands. Its purpose is to make sure today's small fixes don't paint tomorrow into a corner.*

## The thesis

`JxlCacheBrowser` is a resource/representation system that hasn't admitted what it is yet. The abstractions are already present — they're just named after the habitat they evolved in. `persistentTracker` is literally named "tracker," not "store," because it tracks beliefs while the bytes live in OPFS. `inflightGets` already says what it wants to be. The work is not to *add* cleverness; it is to make the implicit structure explicit and let it grow into the size it's reaching for.

## Target anatomy

```
JxlCacheBrowser
  ├── ResourceIdentity     key → opaque id (today a string, tomorrow a hash)
  ├── MemoryResidency      the LRU of SharedArrayBuffers (rename of memoryCache)
  ├── PersistentStore      OPFS byte I/O only
  ├── PersistentIndex      tracker + manifest + reconcile (the belief layer)
  ├── RequestCoalescer     inflightGets / inflightSets
  ├── ConsistencyManager   loadManifest + reconcile + generation/epoch
  ├── EvictionPolicy       pluggable; LRU today
  └── Telemetry            counters with causes, O(1) snapshot
```

No algorithm changes are implied by this map — it is the same organs, separated and named.

## Three trajectories worth protecting

**Identity.** A key is a *serialization* of an identity, not the identity. Today `type ResourceId = string`; later a hash; eventually a structured `{ dataset, capture, timestamp, sensor, variant }`. The discipline: keep `ResourceId` **opaque**. The rest of the system must never read its structure, so the representation can change underneath it. This matters the moment one specimen has RGB, thermal, and spectral observations that need *related* identities.

**Value.** LRU treats all bytes as equal — oldest dies. For a JXL render cache that's fine. For Casabio it is dangerous: the only copy of a rare 10-year-old observation is "old," a freshly generated 50 MB thumbnail is "new," and LRU kills the wrong one. The destination is a score, not an age: `age + size + recreationCost + importance`. Don't build it now; just make `EvictionPolicy` replaceable so it *can* be built.

**Representation.** Today the cache moves "an image." Tomorrow it serves the representation actually needed: a thumbnail view shouldn't materialize full resolution; analysis may not need pixels at all; a timelapse frame is a delta on its neighbour (video-codec logic). This is where the next 10× lives — *load → which representation? → materialize on demand*, not *load → decode → display*.

## The performance frontier is the architectural frontier

This file is not slow for lack of clever algorithms. It is slow only where the code forgets what kind of thing it is moving — where it copies because it treats a resource as a raw image. Stop treating everything as "an image," start treating it as a resource moving between representations, and the performance work and the architecture work become the same work.

## Guardrail

Before any of this: **preserve the invariants already discovered in the file.** The async-safety, the SAB-ownership decision, the reconcile, the generation guard — these are good bones. The goal is to make implicit invariants explicit, never to trade a hard-won correctness property for a tidier diagram. And do not over-rotate: moving from `string` to an opaque `ResourceId` alias is one safe step; spraying a structured-metadata object through every signature is the rabbit hole to avoid.
