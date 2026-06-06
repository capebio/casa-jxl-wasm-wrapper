import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const scripts = [
  ["test_3_progressive_effort_sweep.mjs", "test_3_progressive_effort_sweep.toon"],
  ["test_5_first_paint_streaming.mjs", "test_5_first_paint_streaming.toon"],
  ["test_6_policy_matrix_sweep.mjs", "test_6_policy_matrix_sweep.toon"],
];

test("selected Optimal-settings timing tests write compact TOON ledgers", () => {
  for (const [script, toonName] of scripts) {
    const source = readFileSync(new URL(`./${script}`, import.meta.url), "utf8");
    assert.match(source, /TIMING_OUT_DIR/);
    assert.match(source, new RegExp(toonName.replaceAll(".", "\\.")));
    assert.match(source, /\$\{record\.size\}B/);
    assert.match(source, /formatToon/);
    assert.match(source, /terminateBrowserLikeWorkers/);
  }
  const utilSource = readFileSync(new URL("./optimal-settings-timing-utils.mjs", import.meta.url), "utf8");
  assert.match(utilSource, /docs\\outputs\\timing tests/);
  assert.match(utilSource, /Agent: codex/);
  assert.match(utilSource, /runs\[\$\{records\.length\}\]\{/);
  assert.match(utilSource, /TimeBase:/);
});
