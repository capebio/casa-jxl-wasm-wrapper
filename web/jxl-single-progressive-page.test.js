import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./jxl-single-progressive.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('./jxl-single-progressive.js', import.meta.url), 'utf8');
const indexHtml = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const statsWorkerSource = readFileSync(new URL('./jxl-frame-stats-worker.js', import.meta.url), 'utf8');
const sessionPackageJson = JSON.parse(readFileSync(new URL('../packages/jxl-session/package.json', import.meta.url), 'utf8'));

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
    expect(html).toContain('value="medium" selected');
    expect(html).toContain('value="0" selected>Unthrottled');
    expect(source).toContain("DEFAULT_SIZE_PRESET = 'display'");
    expect(source).toContain("DEFAULT_QUALITY_PRESET = 'medium'");
    // Lossless maps to distance=0
    expect(source).toContain("...(lossless ? { distance: 0 } : {})");
    // Progressive DC and group order are explicit tuning controls.
    expect(html).toContain('id="progressive-dc"');
    expect(html).toContain('value="2" selected>2 · 1:32 then 1:8 preview');
    expect(source).toContain('progressiveDc: settings.progressiveDc');
    expect(source).toContain('...(progressiveDc != null ? { progressiveDc } : {})');
    expect(html).toContain('id="group-order"');
    expect(html).toContain('value="1" selected>Center-out');
    expect(source).toContain('groupOrder: settings.groupOrder');
    expect(source).toContain('groupOrderLabel');
    expect(source).toContain('...(groupOrder != null ? { groupOrder } : {})');
    // Phase C encoder knobs
    expect(html).toContain('id="progressive-ac"');
    expect(html).toContain('id="qprogressive-ac"');
    expect(html).toContain('id="decoding-speed"');
    expect(html).toContain('value="1" selected>1 · two-band split (Sneyers default)');
    expect(html).toContain('value="1" selected>1 · two-tier (Sneyers default)');
    expect(source).toContain('progressiveAc');
    expect(source).toContain('qProgressiveAc');
    expect(source).toContain('decodingSpeed');
    expect(source).toContain('progressive_ac');
    expect(source).toContain('qprogressive_ac');
    expect(source).toContain('decoding_speed');
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
    expect(source).toContain('DEFAULT_WORKER_PUSH_HWM = 64');
    expect(source).toContain('readWorkerExperimentConfig');
    expect(source).toContain('workerPushHwm');
    expect(source).toContain('workerPool');
    expect(source).toContain('workerTier');
    expect(source).toContain("DEFAULT_WORKER_TIER = 'auto'");
    expect(source).toContain('WORKER_DECODE_TIMEOUT_MS = 90_000');
    expect(source).toContain('withTimeout(');
    // Phase I: sidecar thumb toggle for fast preview decode measurement (uses unified sidecarSizes path)
    expect(html).toContain('id="emit-sidecar-thumb"');
    expect(source).toContain('encodeWithSidecarThumbnail');
    expect(source).toContain('SIDECAR_THUMB_LONG_EDGE');
    expect(html).toContain('id="m-thumb-decode"');
    expect(html).toContain('id="m-thumb-size"');
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
    expect(html).toContain('id="psnr-chart"');
    expect(html).toContain('id="psnr-chart-legend"');
    expect(html).toContain('PSNR vs pass');
    expect(source).toContain('drawPsnrChart');
    expect(source).toContain('computePsnrVsFinal');
    expect(source).toContain('computeAndDrawChartsAsync(decode.passes, targetRgba)');
    expect(source).toContain('intendedDownsamplingRatio');
    expect(source).toContain('ratioLabel');
    expect(source).toContain('intended_ratio');
    expect(source).toContain('ratio_label');
    expect(source).toContain('pass_intended_ratio');
    expect(source).toContain('analyzeFrameInWorker');
    expect(source).toContain('precomputePassStatsInWorker');
    expect(source).toContain('jxl-frame-stats-worker.js');
    expect(statsWorkerSource).toContain('analyzeProgressiveFrame');
    expect(statsWorkerSource).toContain('self.postMessage');
    expect(html).toContain('id="perceptual-cutoff"');
    expect(source).toContain('shouldStopAtPass');
    expect(source).toContain('PERCEPTUAL_CUTOFF_PSNR_DELTA_DB');
});

test('single progressive block-border overlay uses fast cached tile diff', () => {
    expect(source).toContain("new URLSearchParams(location.search).get('bordersStrict') === '1'");
    expect(source).toContain('const BBOX_STRIDE = 10;');
    expect(source).toContain('function toUint32View(u8arr)');
    expect(source).toContain('toUint32View(pass.pixels)');
    expect(source).toContain('scanChangedTileGrid');
    expect(source).toContain('readChangedBlocksCacheKey(pass, previousPass)');
    expect(source).toContain('pass._changedBlocks');
});

test('single progressive timing mode can force block borders off', () => {
    expect(source).toContain("readBoolParam('borders', null)");
    expect(source).toContain('withTimingBlockBordersOverride');
    expect(source).toContain('timingBordersOverride');
    expect(source).toContain('showBlockBordersEl.checked = false');
});

test('jxl-session has browser-only export for browser bundles', () => {
    expect(sessionPackageJson.exports['.'].browser).toBe('./dist/browser.js');
});
