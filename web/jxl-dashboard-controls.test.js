import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  clamp, wireSlideoutPanel, wireHelpPopovers, setGroupDisabled, bindRangeLabel, setCssVar,
} from './jxl-dashboard-ui.js';

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
    // updated: .casabio-toggle padding bumped 3px 8px → 5px 14px in b648247b (casabio button fix); see casabio.css .casabio-toggle
    expect(casabioCss).toContain('padding: 5px 14px;');
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

test('clamp basic', () => {
  expect(clamp(3, 0, 10)).toBe(3);
  expect(clamp(-2, 0, 10)).toBe(0);
  expect(clamp(99, 0, 10)).toBe(10);
});

test('setCssVar and bindRangeLabel (mocked)', () => {
  const root = { style: { setProperty: (k, v) => { root.style[k] = v; } } };
  setCssVar('--x', 123, root);
  const input = { value: '5', addEventListener: () => {} };
  const label = { textContent: '' };
  bindRangeLabel(input, label, v => `#${v}`);
  expect(label.textContent).toBe('#5');
});

test('setGroupDisabled smoke (no real DOM)', () => {
  const fakeBtn = { classList: { contains: (c) => c === 'info-btn' }, disabled: false };
  const group = {
    classList: { toggle: () => {}, add() {}, remove() {} },
    setAttribute: () => {},
    dataset: {},
    querySelectorAll: () => [fakeBtn],
  };
  setGroupDisabled(group, true, 'reason');
  // no crash = pass for smoke
});

test('wire* safe on missing inputs (return apis)', () => {
  const s = wireSlideoutPanel({ panel: null });
  expect(typeof s.isOpen).toBe('function');
  expect(s.isOpen()).toBe(false);
  const h = wireHelpPopovers(null);
  expect(typeof h.closeAll).toBe('function');
  h.closeAll();
});
