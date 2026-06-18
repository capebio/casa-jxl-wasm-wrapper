# Task 009-concurrency-7
**Finding:** framesTask and pushTask share mutable bytesPushed with only a microtask-yield for ordering — packages/jxl-progressive/src/progressive-profile.ts:139-167
**Status:** done
**Tests before:** fail(pre-existing TS errors in other files)
**Tests after:** fail(same pre-existing TS errors; no new errors)

## Change
Moved `bytesPushed = end` to before `await session.push()` so that any frames emitted synchronously during push() see the correct byte offset. The microtask yield (await Promise.resolve()) was removed as a consequence — the ordering is now correct without it. This resolves the latent bug where a session emitting frames before push() resolves would record byteOffset=0 (or the previous chunk end) for the first frame.

## Diff
```diff
-        await session.push(jxlBytes.slice(offset, end));
-        bytesPushed = end;
-        // Yield a microtask tick so frame events triggered by this push
-        // can be picked up by the frames task with the correct bytesPushed.
-        await Promise.resolve();
+        bytesPushed = end;
+        await session.push(jxlBytes.slice(offset, end));
```
