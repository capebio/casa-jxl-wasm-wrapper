import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./jxl-single-progressive.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('./jxl-single-progressive.js', import.meta.url), 'utf8');
const indexHtml = readFileSync(new URL('./index.html', import.meta.url), 'utf8');

test('single progressive page is discoverable and named', () => {
    expect(html).toContain('<title>Single progressive</title>');
    expect(html).toContain('<h1>Single progressive</h1>');
    expect(html).toContain('href="./jxl-single-progressive.html"');
    expect(indexHtml).toContain('href="./jxl-single-progressive.html"');
    expect(html).toContain('./jxl-single-progressive.js');
});

test('single progressive page settings put Sneyers all-pass decode behind retrieve action', () => {
    // Size + Quality preset selects replace the prior raw-KB bisection UX.
    expect(html).toContain('id="size-preset"');
    expect(html).toContain('id="quality-preset"');
    expect(html).toContain('Size preset');
    expect(html).toContain('Quality preset');
    expect(html).toContain('Very Large');
    expect(html).toContain('Lossless');
    expect(html).toContain('id="size-estimate"');
    expect(html).toContain('id="throttle-rate"');
    expect(html).toContain('All passes');
    expect(html).toContain('id="retrieve-run"');
    expect(html).toContain('id="run-rerun"');
    expect(html).toContain('Retrieve raw file');
    expect(html.indexOf('id="retrieve-run"')).toBeLessThan(html.indexOf('id="dbg-console-btn"'));
    expect(html.indexOf('id="retrieve-run"')).toBeLessThan(html.indexOf('id="run-rerun"'));
    expect(html.indexOf('id="run-rerun"')).toBeLessThan(html.indexOf('id="dbg-console-btn"'));
    expect(source).toContain("fetch('/api/random-gobabeb'");
    expect(source).toContain("const PROGRESSIVE_DETAIL = 'passes';");
    expect(source).toContain("createSneyersPreset");
    expect(source).toContain('encodeSneyersDirect');
    expect(source).toContain('runBtn');
    expect(source).toContain('rerunLoadedSource');
    expect(source).toContain('await feedThrottled(decoder, jxlBytes, throttleKbPerSec, feedState)');
    // Default targets display-scale tuning while keeping larger/source-size runs available.
    expect(html).toContain('value="display" selected');
    expect(html).toContain('Display · 1920 px');
    expect(html).toContain('value="very-large"');
    expect(html).toContain('value="very-high" selected');
    expect(html).toContain('value="0" selected>Unthrottled');
    expect(source).toContain("DEFAULT_SIZE_PRESET = 'display'");
    expect(source).toContain("DEFAULT_QUALITY_PRESET = 'very-high'");
    // Lossless maps to distance=0
    expect(source).toContain("...(lossless ? { distance: 0 } : {})");
    // Progressive DC and group order are explicit tuning controls.
    expect(html).toContain('id="progressive-dc"');
    expect(html).toContain('value="0" selected>0 · no DC progressive');
    expect(source).toContain('progressiveDc: settings.progressiveDc');
    expect(source).toContain('...(progressiveDc != null ? { progressiveDc } : {})');
    expect(html).toContain('id="group-order"');
    expect(html).toContain('value="1" selected>Center-out');
    expect(source).toContain('groupOrder: settings.groupOrder');
    expect(source).toContain('groupOrderLabel');
    expect(source).toContain('...(groupOrder != null ? { groupOrder } : {})');
    expect(html).toContain('id="show-block-borders"');
    expect(source).toContain('drawPassWithOverlay');
    expect(source).toContain('computeChangedBlocks');
    expect(source).toContain('BLOCK_BORDER_SIZE = 2');
    expect(source).toContain("BLOCK_BORDER_COLOR = '#ff2d2d'");
    // Bytes-fed tracking per pass
    expect(source).toContain('feedState');
    expect(source).toContain('FIRST_PAINT_CHUNK_RAMP');
    expect(source).toContain('STEADY_DECODE_CHUNK_BYTES');
    expect(source).toContain('bytesFed');
    expect(source).toContain('percentFed');
    expect(html).toContain('id="decode-in-worker"');
    expect(source).toContain('decodeProgressivelyViaWorker');
    expect(source).toContain('createBrowserContext');
});

test('single progressive page exposes console and measurement exports', () => {
    expect(html).toContain('id="dbg-console-mount"');
    expect(html).toContain('Copy MD');
    expect(source).toContain('initDebugConsole(consoleBtn, consoleMount)');
    expect(source).toContain('analyzeProgressiveFrame');
    expect(source).toContain('visibleProgressFrames');
    expect(source).toContain('decodeOneShotFinal');
    expect(source).toContain('oneShot_ms');
    expect(source).toContain('speedup');
    expect(html).toContain('id="m-transfer"');
    expect(source).toContain('avgTransferKbPerSec');
    expect(source).toContain('formatTransferSpeed');
    expect(source).toContain('exportMeasurementsCSV');
    expect(source).toContain('exportMeasurementsTOON');
    expect(source).toContain('exportMeasurementsJSON');
    expect(source).toContain('copyMeasurementsMarkdown');
    expect(source).toContain('showPassInLightbox');
    expect(source).toContain('passLightboxStats');
    expect(source).toContain("event.key === 'ArrowRight'");
    expect(source).toContain("event.key === 'ArrowLeft'");
    expect(html).toContain('id="pass-lightbox"');
    expect(html).toContain('id="pass-lightbox-stats"');
    expect(html).toContain('lightbox-canvas-wrap');
    expect(html).toContain('id="lightbox-zoom-out"');
    expect(html).toContain('id="lightbox-zoom-in"');
    expect(html).toContain('id="lightbox-zoom-reset"');
    expect(html).toContain('id="lightbox-zoom-level"');
    expect(html).toContain('max-width: 100%');
    expect(html).toContain('max-height: 100%');
    expect(html).toContain('transform-origin: 0 0');
    expect(source).toContain('lightboxZoomState');
    expect(source).toContain('applyLightboxZoom');
    expect(source).toContain('zoomLightboxAt');
    expect(source).toContain('panLightboxBy');
    expect(source).toContain('resetLightboxZoom');
    expect(source).toContain('showPassInLightbox(lightboxIndex + 1)');
    expect(source).toContain('pass_bytes');
    expect(source).toContain('delta_ms');
    expect(source).toContain('delta_bytes');
    expect(source).toContain('delta_kb_per_sec');
    expect(source).toContain('deltaKbPerSec');
    expect(source).toContain('group_order');
    expect(source).toContain('progressive_dc');
    expect(source).toContain('paint_ms');
    expect(source).toContain('decode_ms');
    expect(source).toContain('paintMs');
});
