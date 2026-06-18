// Build the revert manifest from the set of changes that are ACTUALLY present in the working tree.
// One isolated diff per applied production change. Config-only flipflop-validated candidates that
// were never wired into production source are listed as NOT-LANDED (no diff to revert).
import { addEntry, renderManifest } from './manifest.mjs';
import { writeFileSync } from 'node:fs';

let list = [];
list = addEntry(list, {
  id: 'OPT-01',
  layer: 'benchmark-harness (JS→WASM encode opts)',
  lens: 'rgb8/no-alpha on photon_prog_enc',
  file: 'StandardMultifileTest.mjs',
  accept_reason: 'faster',
  saved_pct: 25,
  diffPath: 'benchmark/optimize/docs/reverts/01-photon-rgb8-noalpha.diff',
});

const md = renderManifest(list);
writeFileSync('benchmark/optimize/docs/reverts/MANIFEST.md', md);
console.log(md);
