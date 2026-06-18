# Task 010-contracts-012
**Finding:** WorkerRequest/WorkerReply versioned with literal v:1 but there is no version negotiation — packages/jxl-pyramid/src/worker-protocol.ts:1-27
**Status:** deferred_adr
**Tests before:** pass (114)
**Tests after:** skipped (no code change)
## Change
No code edit. ADR written to `undefined/sections/010/adr_draft/worker-protocol-version-negotiation.md`. The finding is an architectural decision: version negotiation approach is complex (requires coordinated worker-script changes), and the immediate safety gap is covered by `validateWorkerRequest` (contracts-011). Deferred until a concrete skew-caused failure or first planned protocol version bump.
## Diff
```diff
(no code diff — adr_draft only)
```
