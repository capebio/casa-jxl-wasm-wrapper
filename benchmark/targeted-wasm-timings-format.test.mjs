import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(new URL("./targeted-wasm-timings.mjs", import.meta.url), "utf8");

test("summary output reports raw wall time instead of zero-valued raw stage sum", () => {
  assert.match(source, /rawWall \$\{fmtMs\(row\.rawWallMs\)\}/);
  assert.match(source, /const rawMs = row\.rawWallMs;/);
  assert.doesNotMatch(source, /raw \$\{fmtMs\(extra\.rawStageMs\)\}/);
});
