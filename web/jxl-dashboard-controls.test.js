import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const progressiveHtml = readFileSync(new URL('./jxl-progressive.html', import.meta.url), 'utf8');
const progressiveJs = readFileSync(new URL('./jxl-progressive.js', import.meta.url), 'utf8');
const wrapperHtml = readFileSync(new URL('./jxl-wrapper-lab.html', import.meta.url), 'utf8');
const wrapperJs = readFileSync(new URL('./jxl-wrapper-lab.js', import.meta.url), 'utf8');

test('progressive page exposes transport iterations', () => {
    expect(progressiveHtml).toContain('transport-iterations');
});

test('progressive page tracks transport iterations in script state', () => {
    expect(progressiveJs).toContain('let transportIterations =');
});

test('progressive page feeds iterations into streaming', () => {
    expect(progressiveJs).toContain('iterations: transportIterations');
});

test('progressive page caches benchmark sources', () => {
    expect(progressiveJs).toContain('let thumbBenchSources = null');
});

test('progressive page formats expanded timing summaries', () => {
    expect(progressiveJs).toContain('function formatProgressiveTimings');
});

test('progressive page marks first paint', () => {
    expect(progressiveJs).toContain('function markFirstPaint');
});

test('progressive decode stream accepts explicit transport options', () => {
    expect(progressiveJs).toContain('streamOptions = {}');
});

test('wrapper page exposes batch thumbnail sizing', () => {
    expect(wrapperHtml).toContain('batch-thumb-size');
});

test('wrapper page records source load timing', () => {
    expect(wrapperJs).toContain('loadMs = performance.now() - started');
});

test('wrapper page exposes first-paint timing in tiles', () => {
    expect(wrapperJs).toContain('tile.timing.textContent');
});
