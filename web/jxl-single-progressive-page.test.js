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
    expect(html).toContain('Retrieve raw file');
    expect(source).toContain("fetch('/api/random-gobabeb'");
    expect(source).toContain("const PROGRESSIVE_DETAIL = 'passes';");
    expect(source).toContain("createSneyersPreset");
    expect(source).toContain('encodeSneyersDirect');
    expect(source).toContain('await feedThrottled(decoder, jxlBytes, throttleKbPerSec, feedState)');
    // Defaults: Very Large 2160 + High q90 per spec
    expect(html).toContain('value="very-large" selected');
    expect(html).toContain('value="high" selected');
    expect(source).toContain("DEFAULT_SIZE_PRESET = 'very-large'");
    expect(source).toContain("DEFAULT_QUALITY_PRESET = 'high'");
    // Lossless maps to distance=0
    expect(source).toContain("...(lossless ? { distance: 0 } : {})");
    // Progressive DC toggle (default 1 = single 1:8 DC for earlier first paint)
    expect(html).toContain('id="progressive-dc"');
    expect(html).toContain('value="1" selected');
    expect(source).toContain('progressiveDc: settings.progressiveDc');
    expect(source).toContain('...(progressiveDc != null ? { progressiveDc } : {})');
    // Bytes-fed tracking per pass
    expect(source).toContain('feedState');
    expect(source).toContain('bytesFed');
    expect(source).toContain('percentFed');
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
    expect(source).toContain('exportMeasurementsCSV');
    expect(source).toContain('exportMeasurementsTOON');
    expect(source).toContain('exportMeasurementsJSON');
    expect(source).toContain('copyMeasurementsMarkdown');
});
