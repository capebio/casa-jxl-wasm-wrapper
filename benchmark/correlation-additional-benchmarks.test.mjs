import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const cases = [
  ["test_13_quality_ladder_sweep.mjs", "quality", "test_13_quality_ladder_sweep.toon"],
  ["test_14_modular_mode_sweep.mjs", "modular", "test_14_modular_mode_sweep.toon"],
  ["test_15_lossless_ladder_sweep.mjs", "lossless", "test_15_lossless_ladder_sweep.toon"],
  ["test_16_dots_color_transform_sweep.mjs", "colorTransform", "test_16_dots_color_transform_sweep.toon"],
  ["test_17_photon_noise_iso_sweep.mjs", "photonNoiseIso", "test_17_photon_noise_iso_sweep.toon"],
  ["test_18_progressive_toggle_sweep.mjs", "progressive", "test_18_progressive_toggle_sweep.toon"],
  ["test_19_effort_shipping_window_sweep.mjs", "effort", "test_19_effort_shipping_window_sweep.toon"],
  ["test_20_target_size_ladder_sweep.mjs", "target", "test_20_target_size_ladder_sweep.toon"],
  ["test_21_source_format_sweep.mjs", "source_type", "test_21_source_format_sweep.toon"],
  ["test_22_modular_lossless_matrix.mjs", "lossless", "test_22_modular_lossless_matrix.toon"],
];

const excluded = [
  "decodingSpeed",
  "groupOrder",
  "progressiveDc",
  "epf",
  "gaborish",
  "brotliEffort",
  "resampling",
];

test("additional correlation-matrix benchmarks use allowed settings and TOON ledgers", () => {
  for (const [script, setting, toonName] of cases) {
    const source = readFileSync(new URL(`./${script}`, import.meta.url), "utf8");
    assert.match(source, new RegExp(`\\b${setting}\\b`));
    assert.match(source, /formatToon/);
    assert.match(source, /TIMING_OUT_DIR/);
    assert.match(source, new RegExp(toonName.replaceAll(".", "\\.")));
    assert.match(source, /\$\{r\.size\}B/);
    assert.match(source, /previewFirst:\s*false/);
    assert.match(source, /raw_ms/);
    assert.match(source, /rgba_ms/);
    assert.match(source, /encode_ms/);
    assert.match(source, /decode_ms/);
    assert.match(source, /total_ms/);
    for (const banned of excluded) assert.doesNotMatch(source, new RegExp(`\\b${banned}\\b`));
  }
});

test("Optimal-settings documents the five additional benchmark tests", () => {
  const docs = readFileSync(new URL("../docs/Optimal-settings.md", import.meta.url), "utf8");
  for (let id = 13; id <= 22; id++) {
    assert.match(docs, new RegExp(`Test_${id}`));
    assert.match(docs, new RegExp(`test_${id}_`));
  }
});
