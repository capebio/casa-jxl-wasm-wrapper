import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const progressiveHtml = readFileSync(new URL('./jxl-progressive.html', import.meta.url), 'utf8');
const progressiveJs = readFileSync(new URL('./jxl-progressive.js', import.meta.url), 'utf8');
const progressiveCss = readFileSync(new URL('./jxl-progressive.css', import.meta.url), 'utf8');
const wrapperHtml = readFileSync(new URL('./jxl-wrapper-lab.html', import.meta.url), 'utf8');
const wrapperJs = readFileSync(new URL('./jxl-wrapper-lab.js', import.meta.url), 'utf8');
const wrapperCss = readFileSync(new URL('./jxl-wrapper-lab.css', import.meta.url), 'utf8');
const dashboardCss = readFileSync(new URL('./jxl-dashboard.css', import.meta.url), 'utf8');
const baseCss = readFileSync(new URL('./style.css', import.meta.url), 'utf8');
const casabioCss = readFileSync(new URL('./casabio.css', import.meta.url), 'utf8');

test('progressive page exposes transport iterations', () => {
    expect(progressiveHtml).toContain('transport-iterations');
});

test('progressive page starts on libjxl encode/decode backends', () => {
    expect(progressiveJs).toContain("initialEncodeBackend: 'libjxl'");
    expect(progressiveJs).toContain("initialDecodeBackend: 'libjxl'");
    expect(progressiveJs).toContain("let decodeMode = 'progressive'");
    expect(progressiveJs).toContain("let previewMode = 'stream'");
    expect(progressiveJs).toContain('defaultOpen: true');
    expect(progressiveHtml).toContain('id="encode-backend-libjxl" class="toggle-btn is-active"');
    expect(progressiveHtml).toContain('id="decode-backend-libjxl" class="toggle-btn is-active"');
    expect(progressiveHtml).toContain('id="mode-progressive" class="toggle-btn is-active"');
    expect(progressiveHtml).toContain('id="preview-mode-stream" class="toggle-btn is-active"');
    expect(progressiveHtml).toContain('id="progressive-dashboard" class="dashboard" aria-hidden="false" data-open="true"');
});

test('shared chrome uses compact control sizing', () => {
    expect(dashboardCss).toContain('padding: 6px 10px;');
    expect(dashboardCss).toContain('font-size: 12px;');
    expect(progressiveCss).toContain('font-size: clamp(30px, 3.8vw, 48px);');
    expect(wrapperCss).toContain('font-size: 24px;');
    expect(baseCss).toContain('font: 14px/1.4');
    expect(baseCss).toContain('padding: 6px 10px 8px;');
    expect(casabioCss).toContain('padding: 3px 8px;');
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
    expect(progressiveJs).toContain("encode running");
    expect(progressiveJs).toContain("decode running");
    expect(progressiveJs).toContain("return parts.join('\\n');");
    expect(progressiveCss).toContain('white-space: pre-line;');
});

test('progressive replay shows a blank countdown state before decode resumes', () => {
    expect(progressiveJs).toContain("card.el.dataset.state = 'replaying';");
    expect(progressiveJs).toContain("card.notes.textContent = '1000 ms';");
    expect(progressiveJs).toContain('await nextPaint();');
    expect(progressiveCss).toContain('.card[data-state="replaying"] .preview');
    expect(progressiveCss).toContain('.card[data-state="replaying"] .notes');
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
