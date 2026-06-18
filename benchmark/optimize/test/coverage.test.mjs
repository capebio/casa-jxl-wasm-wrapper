import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyLedger, recordSweep, gaps, saturated, underVisited, matrix } from '../coverage.mjs';

test('recordSweep bumps visits for every examined file, even zero-finding', () => {
  let L = emptyLedger();
  L = recordSweep(L, { run: 'r1', lens: 'seam', examined: ['a.ts', 'b.ts'], findingsByFile: { 'a.ts': 2 } });
  assert.equal(L.files['a.ts'].seam.visits, 1);
  assert.equal(L.files['a.ts'].seam.lastFindings, 2);
  assert.equal(L.files['b.ts'].seam.visits, 1);
  assert.equal(L.files['b.ts'].seam.lastFindings, 0);   // examined but clean → still counted
  assert.deepEqual(L.runs, ['r1']);
});

test('second sweep accumulates totalFindings + bumps visits', () => {
  let L = emptyLedger();
  L = recordSweep(L, { run: 'r1', lens: 'seam', examined: ['a.ts'], findingsByFile: { 'a.ts': 2 } });
  L = recordSweep(L, { run: 'r2', lens: 'seam', examined: ['a.ts'], findingsByFile: { 'a.ts': 1 } });
  assert.equal(L.files['a.ts'].seam.visits, 2);
  assert.equal(L.files['a.ts'].seam.totalFindings, 3);
  assert.equal(L.files['a.ts'].seam.lastFindings, 1);
});

test('gaps lists (file,lens) pairs never visited', () => {
  let L = emptyLedger();
  L = recordSweep(L, { run: 'r1', lens: 'seam', examined: ['a.ts'], findingsByFile: {} });
  const g = gaps(L, ['a.ts', 'b.ts'], ['seam', 'tactical']);
  // a.ts/seam covered; missing: a.ts/tactical, b.ts/seam, b.ts/tactical
  assert.equal(g.length, 3);
  assert.ok(g.some(x => x.file === 'b.ts' && x.lens === 'seam'));
  assert.ok(g.some(x => x.file === 'a.ts' && x.lens === 'tactical'));
});

test('saturated: visited >= minVisits with last sweep 0 findings', () => {
  let L = emptyLedger();
  L = recordSweep(L, { run: 'r1', lens: 'seam', examined: ['a.ts'], findingsByFile: { 'a.ts': 1 } });
  L = recordSweep(L, { run: 'r2', lens: 'seam', examined: ['a.ts'], findingsByFile: {} }); // dry
  const s = saturated(L, 2);
  assert.equal(s.length, 1);
  assert.equal(s[0].file, 'a.ts');
});

test('underVisited: pairs below minVisits', () => {
  let L = emptyLedger();
  L = recordSweep(L, { run: 'r1', lens: 'seam', examined: ['a.ts'], findingsByFile: {} });
  const u = underVisited(L, ['a.ts'], ['seam'], 2);
  assert.equal(u.length, 1);
  assert.equal(u[0].visits, 1);
});

test('matrix renders file x lens visit counts', () => {
  let L = emptyLedger();
  L = recordSweep(L, { run: 'r1', lens: 'seam', examined: ['a.ts'], findingsByFile: { 'a.ts': 1 } });
  const m = matrix(L, ['a.ts'], ['seam', 'tactical']);
  const row = m.find(r => r.file === 'a.ts');
  assert.equal(row.seam, 1);
  assert.equal(row.tactical, 0);
});
