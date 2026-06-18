# Task 010-contracts-002
**Finding:** ensureLoaded sends SAB load message with non-standard fields not defined in WorkerRequest type — packages/jxl-pyramid/src/tiled-decode-pool.ts:751-759
**Status:** done
**Tests before:** pass(114)
**Tests after:** pass(114)
## Change
Added a SAB variant `{ v: 1; type: 'load'; bytesId: number; sab: SharedArrayBuffer; byteLength: number }` to the `WorkerRequest` union type in worker-protocol.ts, then removed the `as any` cast from the `postMessage` call in `ensureLoaded`.
## Diff
```diff
 export type WorkerRequest =
   | { v: 1; type: 'load'; bytesId: number; bytes: Uint8Array }
+  | { v: 1; type: 'load'; bytesId: number; sab: SharedArrayBuffer; byteLength: number }
   | { v: 1; type: 'decode'; ... }
   | { v: 1; type: 'cancel'; id: number };

-  h.worker.postMessage({ v: 1, type: 'load', bytesId, sab, byteLength: bytes.byteLength } as any);
+  h.worker.postMessage({ v: 1, type: 'load', bytesId, sab, byteLength: bytes.byteLength });
```
