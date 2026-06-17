# jxl-scheduler Improvement Progress

Branch: `jxl-scheduler-20260618`

| File | Strategic | Operational | Tactical | Birds-Eye | Committed |
|------|-----------|-------------|----------|-----------|-----------|
| types.ts | ✓ | - | ✓ | ✓ | ✓ |
| budget.ts | - | - | - | - | - |
| queue.ts | - | - | - | - | - |
| dedupe.ts | - | - | - | - | - |
| pool.ts | - | - | - | - | - |
| scheduler.ts | - | - | - | - | - |
| index.ts | - | - | - | - | - |

## Findings Log

### types.ts (2026-06-18)
- [S1] AdmissionRelease type alias missing — forces callers to repeat `() => void`
- [T1] `WorkerHandle.onError/onExit` optional-chaining gap: not reflected in `WorkerHandle` interface docs clearly
- One sweep sufficient (48 lines, pure type declarations, no runtime code)
- **Implemented:** Added `AdmissionRelease` type alias; added `onError`/`onExit` to `WorkerHandle` interface explicitly (were only documented in pool.ts cast comment)
