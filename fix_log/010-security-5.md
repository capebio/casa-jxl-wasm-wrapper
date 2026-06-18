# Task 010-security-5

**Finding:** master.name accepted as arbitrary string with no path-traversal sanitisation — packages/jxl-pyramid/src/manifest-validate.ts:57-61

**Status:** done

**Tests before:** 114 pass, 0 fail

**Tests after:** 114 pass, 0 fail

## Change

Added three validation checks to master.name:
1. Length must not be empty and not exceed 256 characters
2. Must not contain path separators (/, \, :)

These prevent path-traversal attacks if name is ever used to construct file paths, and enforce reasonable constraints on a filename metadata field.

## Diff

```diff
 function validateMasterMetadata(v: unknown, path: string): MasterMetadata {
   const o = requireObject(v, path);
   const name = requireString(o["name"], `${path}.name`);
+  if (name.length === 0) fail(`${path}.name`, "must not be empty");
+  if (name.length > 256) fail(`${path}.name`, `exceeds maximum length 256`);
+  if (/[/\\:]/.test(name)) fail(`${path}.name`, "must not contain path separators");
   const format = requireString(o["format"], `${path}.format`);
```
