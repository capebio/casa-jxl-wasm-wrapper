# Task 010-security-7
**Finding:** ensureIccProfile writes result onto an arbitrary source object via dynamic property assignment — packages/jxl-pyramid/src/decode-core.ts:416-417
**Status:** done
**Tests before:** pass (114 pass, 0 fail)
**Tests after:** pass (114 pass, 0 fail)

## Change
Replaced the `(source as any)[key] = p` property-stamp pattern with a module-level `WeakMap<object, Promise<Uint8Array | null>>` named `_iccCache`. The cache key is the source object itself; no enumerable property is added to it. Also tightened the `source` parameter type to `{ bytes: Uint8Array }` (removing the open `[k: string]: any` index signature) since the function no longer writes to the object.

## Diff
```diff
-/** Agent6-4: once-per-LevelSource lazy capture of ICC (and future metadata) using minimal header decoder + facade.getIccProfile.
- *  Caches on the source object (like bytesId). Shared reference stamped to results (no per-tile copies).
- *  Only runs if options.preserveMetadata. For JXTC the profile lives in the codestream(s); header target is cheap.
- */
+/** Agent6-4: once-per-LevelSource lazy capture of ICC (and future metadata) using minimal header decoder + facade.getIccProfile.
+ *  Caches on the source object (like bytesId). Shared reference stamped to results (no per-tile copies).
+ *  Only runs if options.preserveMetadata. For JXTC the profile lives in the codestream(s); header target is cheap.
+ */
+const _iccCache = new WeakMap<object, Promise<Uint8Array | null>>();
+
 export function ensureIccProfile(
-  source: { bytes: Uint8Array; [k: string]: any },
+  source: { bytes: Uint8Array },
   opts?: { preserveMetadata?: boolean },
 ): Promise<Uint8Array | null> {
   if (!opts?.preserveMetadata) return Promise.resolve(null);
-  const key = '_iccProfile';
-  if (key in (source as any)) return (source as any)[key];
+  const cached = _iccCache.get(source);
+  if (cached !== undefined) return cached;
   const p = (async () => {
     ...
   })();
-  (source as any)[key] = p;
+  _iccCache.set(source, p);
   return p;
 }
```
