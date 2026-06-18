import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addEntry, renderManifest } from '../manifest.mjs';

test('addEntry then render produces a markdown row with verdict + diff ref', () => {
  let m = [];
  m = addEntry(m, { id: 'opt-1', layer: 'rust', lens: 'tactical', file: 'crates/raw-pipeline/src/tone.rs',
    accept_reason: 'faster', saved_pct: 33, diffPath: 'patches/opt-1.diff' });
  const md = renderManifest(m);
  assert.match(md, /opt-1/);
  assert.match(md, /tactical/);
  assert.match(md, /33/);
  assert.match(md, /patches\/opt-1\.diff/);
});

test('render is stable/idempotent for same input', () => {
  const m = [{ id: 'a', layer: 'params', lens: 'mathematical', file: 'x', accept_reason: 'leaner', saved_pct: -1, diffPath: 'p' }];
  assert.equal(renderManifest(m), renderManifest(m));
});
