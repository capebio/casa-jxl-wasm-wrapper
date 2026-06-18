# Task 010-contracts-011
**Finding:** No runtime validation of outbound WorkerRequest messages — packages/jxl-pyramid/src/worker-protocol.ts:16-27
**Status:** done
**Tests before:** pass (114)
**Tests after:** pass (114)
## Change
Added `validateWorkerRequest(req: unknown): void` to `worker-protocol.ts`. The function is a dev-mode assertion (no-op when `_DEV` is false) that mirrors the inbound `parseWorkerReply` pattern. It validates `v===1`, checks required fields for each variant (`load` with `bytes` or SAB+`byteLength`, `decode` with `id/bytesId/region/format`, `cancel` with `id`), and throws a descriptive Error on mismatch. The SAB `load` variant — previously sent via `as any` cast and not represented in the type — is now declared as an explicit union member in `WorkerRequest`.
## Diff
```diff
--- a/packages/jxl-pyramid/src/worker-protocol.ts
+++ b/packages/jxl-pyramid/src/worker-protocol.ts
@@ -27,1 +27,37 @@
 export type WorkerErrorCode = 'JXTC_PARSE' | 'BAD_REGION' | 'OOM' | 'INTERNAL' | 'TIMEOUT' | 'UNKNOWN_BYTES_ID';
+
+const _DEV = typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production';
+
+/** Dev-mode assertion mirroring parseWorkerReply. Throws on malformed outbound requests in dev. No-op in production. */
+export function validateWorkerRequest(req: unknown): void {
+  if (!_DEV) return;
+  if (!req || typeof req !== 'object') throw new Error('[pyramid] WorkerRequest: not an object');
+  const r: any = req;
+  if (r.v !== 1) throw new Error(`[pyramid] WorkerRequest: expected v=1, got v=${r.v}`);
+  if (r.type === 'load') {
+    if (typeof r.bytesId !== 'number') throw new Error('[pyramid] WorkerRequest load: bytesId not a number');
+    if (r.sab !== undefined) {
+      if (typeof SharedArrayBuffer === 'undefined' || !(r.sab instanceof SharedArrayBuffer))
+        throw new Error('[pyramid] WorkerRequest load: sab is not a SharedArrayBuffer');
+      if (typeof r.byteLength !== 'number' || r.byteLength <= 0)
+        throw new Error('[pyramid] WorkerRequest load: byteLength must be positive number');
+    } else if (!(r.bytes instanceof Uint8Array)) {
+      throw new Error('[pyramid] WorkerRequest load: bytes must be a Uint8Array');
+    }
+  } else if (r.type === 'decode') {
+    if (typeof r.id !== 'number') throw new Error('[pyramid] WorkerRequest decode: id not a number');
+    if (typeof r.bytesId !== 'number') throw new Error('[pyramid] WorkerRequest decode: bytesId not a number');
+    if (!r.region || typeof r.region.x !== 'number' || typeof r.region.y !== 'number' ||
+        typeof r.region.w !== 'number' || typeof r.region.h !== 'number')
+      throw new Error('[pyramid] WorkerRequest decode: region must have numeric x,y,w,h');
+    if (r.format !== 'rgba8' && r.format !== 'rgba16')
+      throw new Error(`[pyramid] WorkerRequest decode: unknown format ${r.format}`);
+  } else if (r.type === 'cancel') {
+    if (typeof r.id !== 'number') throw new Error('[pyramid] WorkerRequest cancel: id not a number');
+  } else {
+    throw new Error(`[pyramid] WorkerRequest: unknown type '${r.type}'`);
+  }
+}
```
