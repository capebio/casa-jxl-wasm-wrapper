# Task 005-errors-3
**Finding:** probeWebGpuAdapter has no timeout - gpu.requestAdapter() can stall indefinitely — packages/jxl-capabilities/src/index.ts:280-288
**Status:** done
**Tests before:** skipped (no `test` npm script; node:test suite needs `tsx`/`typescript`, both absent in this env — verified via `npm run typecheck` + `npm run build`, both pass)
**Tests after:** skipped (same; `npm run typecheck` and `npm run build` pass post-edit)
## Change
Wrapped `gpu.requestAdapter()` in the existing `withTimeout(..., 2000, null)` helper (added by dependency task errors-8) so a stalled WebGPU driver enumeration resolves to `null`/`false` after 2s instead of permanently blocking the memoized `_gpuAdapterPromise` for all callers. Type-safe: `withTimeout<GPUAdapter | null>` returns the same union, and `!== null` still yields `boolean`.
## Diff
```diff
       const gpu = (navigator as any)?.gpu;
       if (!gpu) return false;
-      return (await gpu.requestAdapter()) !== null;
+      // errors-3: bound requestAdapter — driver enumeration can stall for seconds on some systems,
+      // and the memoized _gpuAdapterPromise would block all callers for that duration.
+      return (await withTimeout(gpu.requestAdapter(), 2000, null)) !== null;
     } catch { return false; }
```
