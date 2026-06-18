// Deterministic serializer for StandardMultifileTest result arrays → baseline source JSON.
import { writeFileSync } from 'node:fs';

export function buildDump({ loadedFiles = [], simdResults = [], mtResults = [], telemetry = {} }) {
  const bySim = new Map(simdResults.map(r => [r.file, r]));
  const byMt = new Map(mtResults.map(r => [r.file, r]));
  const files = loadedFiles.map(f => {
    const s = bySim.get(f.file) || {};
    const m = byMt.get(f.file) || {};
    return {
      file: f.file,
      raw: {
        decompress_ms: f.rawDecompress ?? 0,
        demosaic_ms: f.rawDemosaic ?? 0,
        tonemap_ms: f.rawTonemap ?? 0,
        orient_ms: f.rawOrient ?? 0,
      },
      metrics: {
        prog_enc_ms: s.prog_enc_ms ?? 0,
        shot_dec_ms: s.shot_dec_ms ?? 0,
        photon_prog_enc_ms: s.photon_prog_enc_ms ?? 0,
        mod_prog_enc_ms: s.mod_prog_enc_ms ?? 0,
        mt_prog_enc_ms: m.prog_enc_ms ?? 0,
        mt_shot_dec_ms: m.shot_dec_ms ?? 0,
      },
    };
  });
  return { schema: 'optimize-baseline/v1', telemetry, files };
}

export function writeDump(path, payload) {
  writeFileSync(path, JSON.stringify(buildDump(payload), null, 2));
}
