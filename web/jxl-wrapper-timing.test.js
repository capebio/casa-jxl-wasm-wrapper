import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./jxl-wrapper-lab.js', import.meta.url), 'utf8');

test('wrapper timing improvements are wired through the lab', () => {
    expect(source).toContain('function fmtTiming');
    expect(source).toContain('function summarizeTiming');
    expect(source).toContain('source.loadMs = performance.now() - started');
    expect(source).toContain('firstPieceMs: encoded.firstChunkMs ?? null');
    expect(source).toContain('firstPaintMs = performance.now() - startedAt');
    expect(source).toContain('tile.timing.textContent');
    expect(source).toContain('paintDelta');
    expect(source).toContain('tile._timings = {');
    expect(source).toContain('load avg');
    expect(source).toContain('first paint avg');
});
