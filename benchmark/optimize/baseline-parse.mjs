// Dump (harness-dump/v1) → flat baseline rows the workflow agents read.

const RAW_SUBSTAGES = ['decompress', 'demosaic', 'tonemap', 'orient'];

// Which metric is dominated by the libjxl codec kernel (gates Phase 3 C++).
const CODEC_KERNEL = new Set(['photon_prog_enc', 'mod_prog_enc', 'prog_enc', 'shot_dec']);

export function parseBaseline(dump) {
  const throttle = parseFloat(dump?.telemetry?.cpuThrottlingPct ?? '100');
  const trust = throttle < 95 ? 'low' : 'high';
  const rows = [];
  for (const f of dump.files || []) {
    // RAW decode: one row, dominant substage = max of the four.
    let domStage = RAW_SUBSTAGES[0], domVal = -1, rawTotal = 0;
    for (const s of RAW_SUBSTAGES) {
      const v = f.raw?.[`${s}_ms`] ?? 0;
      rawTotal += v;
      if (v > domVal) { domVal = v; domStage = s; }
    }
    rows.push({
      file: f.file, metric: 'raw_decode', median_ms: rawTotal,
      dominant_substage: domStage, bound_class: 'pipeline', trust,
    });
    // Encode/decode metrics from results.
    const map = {
      photon_prog_enc: f.metrics?.photon_prog_enc_ms ?? 0,
      mod_prog_enc: f.metrics?.mod_prog_enc_ms ?? 0,
      prog_enc: f.metrics?.prog_enc_ms ?? 0,
      shot_dec: f.metrics?.shot_dec_ms ?? 0,
    };
    for (const [metric, median_ms] of Object.entries(map)) {
      rows.push({
        file: f.file, metric, median_ms,
        dominant_substage: null,
        bound_class: CODEC_KERNEL.has(metric) ? 'codec-kernel' : 'marshalling',
        trust,
      });
    }
  }
  return rows;
}
