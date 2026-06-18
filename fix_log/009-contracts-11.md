# Task 009-contracts-11
**Finding:** profileJxlFile writes the manifest by default with undocumented writeManifest flag — side effect not in exported type — packages/jxl-progressive/src/progressive-profile.ts:195-212
**Status:** done
**Tests before:** fail(pre-existing TS errors in other files)
**Tests after:** fail(same pre-existing TS errors; no new errors)

## Change
Extracted the inline `ProfileOptions & { writeManifest?: boolean }` into a named exported interface `ProfileFileOptions` with a JSDoc comment explaining the default-write behavior. Updated profileJxlFile to accept `ProfileFileOptions` instead of the anonymous intersection type. Callers can now import `ProfileFileOptions` to discover and document the filesystem side effect.

## Diff
```diff
+/** Options for profileJxlFile, extending ProfileOptions with a filesystem side-effect flag. */
+export interface ProfileFileOptions extends ProfileOptions {
+  /**
+   * When true (default), writes the manifest as `${path}.json` beside the .jxl file.
+   * Pass false to skip the write and return the manifest only.
+   */
+  writeManifest?: boolean;
+}
+
 ...
 export async function profileJxlFile(
   path: string,
   sessionFactory: SessionFactory,
   source: { width: number; height: number; hasAlpha: boolean; orientation?: number },
-  opts: ProfileOptions & { writeManifest?: boolean } = {},
+  opts: ProfileFileOptions = {},
 ): Promise<ProgressiveManifest> {
```
