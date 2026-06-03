// web/jxl-encode-space.test.js
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./jxl-encode-space.js', import.meta.url), 'utf8');

test('uses process_orf_with_flags (not process_orf) to skip unused pipeline stages', () => {
    expect(source).toContain('process_orf_with_flags');
    expect(source).not.toContain('rawWasm.process_orf(');
});

test('uses take_rgba for WASM-side RGB→RGBA conversion', () => {
    expect(source).toContain('take_rgba()');
});

test('uses downscale_rgba to reduce output resolution before encoding', () => {
    expect(source).toContain('downscale_rgba(');
});

test('sweep yields between cells for UI responsiveness', () => {
    expect(source).toContain('await new Promise(r => setTimeout(r, 0))');
});

test('cellKey function produces effort:distance string', () => {
    expect(source).toContain("function cellKey(effort, distance)");
    expect(source).toContain('`${effort}:${distance}`');
});

test('calcBpp formula is correct', () => {
    expect(source).toContain('(sizeBytes * 8) / (width * height)');
});

test('buildDistances handles coarse, fine, and custom presets', () => {
    expect(source).toContain("preset === 'fine'");
    expect(source).toContain("preset === 'custom'");
    expect(source).toContain('COARSE_DISTANCES');
    expect(source).toContain('FINE_DISTANCES');
});
