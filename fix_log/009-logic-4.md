# Task 009-logic-4
**Finding:** DC tier byteEnd is set to the event's byteOffset, but byteOffset records bytes-pushed-after-push — packages/jxl-progressive/src/progressive-profile.ts:67-75
**Status:** done
**Tests before:** fail(pre-existing TS errors in other files)
**Tests after:** fail(same pre-existing TS errors; no new errors)

## Change
Set `bytesPushed = end` before `await session.push()` instead of after. This ensures frames emitted synchronously inside push() (before the promise resolves) see the correct chunk-end byte offset rather than the previous chunk's end, fixing the off-by-one where events could record byteOffset = 0 on the first chunk. The microtask yield (Promise.resolve()) was also removed as it is no longer needed — bytesPushed is already correct before push() is awaited.

## Diff
```diff
-        await session.push(jxlBytes.slice(offset, end));
-        bytesPushed = end;
-        // Yield a microtask tick so frame events triggered by this push
-        // can be picked up by the frames task with the correct bytesPushed.
-        await Promise.resolve();
-        onProgress?.(end, total);
+        // Set bytesPushed before push() so frames emitted synchronously inside
+        // push() (before the promise resolves) capture the correct byte offset.
+        bytesPushed = end;
+        await session.push(jxlBytes.slice(offset, end));
+        onProgress?.(end, total);
```
