import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./jxl-progressive-gallery.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('./jxl-progressive-gallery.html', import.meta.url), 'utf8');
const js = source;

test('progressive gallery uses the default progressive detail path', () => {
    expect(source).toContain("progressionTarget: 'final'");
    expect(source).toContain('emitEveryPass: true');
    expect(source).toContain('const chosenDetail = getGalleryProgressiveDetail();');
    expect(source).toContain("progressiveDetail: chosenDetail === 'auto' ? null : chosenDetail");
    expect(source).toContain('frame.getImageData()');
    expect(source).toContain('buildPushBatches');
    expect(source).toContain("let pushMode = 'all-chunks';");
    expect(source).toContain('const WINDOW_SIZE = 32;');
    expect(html).toContain('data-push-mode="full-file"');
    expect(html).toContain('data-push-mode="all-chunks"');
    expect(html).toContain('data-push-mode="window"');
});

test('progressive gallery wires the debug console like the other pages', () => {
    expect(source).toContain("import { initDebugConsole, dbgLog } from './jxl-debug-console.js';");
    expect(source).toContain("const dbgConsoleBtn = document.getElementById('dbg-console-btn');");
    expect(source).toContain('if (dbgConsoleBtn) initDebugConsole(dbgConsoleBtn);');
});

test('gallery markup includes row/column grid and lightbox mount points', () => {
  expect(html).toContain('data-gallery-rows');
  expect(html).toContain('data-lightbox-root');
  expect(html).toContain('ArrowLeft');
  expect(html).toContain('Ctrl+ArrowRight');
});

test('gallery script wires progressive metadata under each thumbnail', () => {
  expect(js).toContain('bytesFed');
  expect(js).toContain('elapsedMs');
  expect(js).toContain('percentFed');
  expect(js).toContain('frameIndex');
});

test('gallery keeps one decode per file and round-robin reveals progressive frames', () => {
  expect(js).toContain('createGalleryCoordinator');
  expect(js).toContain('createGalleryLightbox');
  expect(js).toContain('round-robin');
  expect(js).toContain('decoder.events()');
  expect(js).toContain('Promise.all(batch.map');
});

test('gallery accepts progressive paint handoff messages and applies pushed settings before decode', () => {
  expect(js).toContain("ev.data?.type === 'progressive-gallery-push'");
  expect(js).toContain('applyPushedGallerySettings(payload.settings)');
  expect(js).toContain('new File([payload.bytes], filename');
  expect(js).toContain('Auto-ingesting pushed progressive JXL');
  expect(js).toContain('await ctxReadyPromise;');
  expect(js).toContain("detailEl.value = settings.progressiveDetail");
  expect(js).toContain("previewEl.checked = settings.previewFirst");
  expect(js).toContain("dcEl.value = String(settings.progressiveDc)");
  expect(js).toContain("groupEl.checked = settings.groupOrder === 1");
});

test('gallery autopush has an actionable retry path and waits for decoder context', () => {
  expect(html).toContain('id="decode-pushed-btn"');
  expect(html).toContain('Decode pushed file');
  expect(js).toContain('const decodePushedBtn = document.getElementById');
  expect(js).toContain('let lastPushedPayload = null;');
  expect(js).toContain('decodePushedBtn.hidden = !lastPushedPayload;');
  // button text now dynamic for batch from paint
  expect(js).toContain('decodePushedBtn.textContent = isBatch');
  expect(js).toContain('await decodePushedGalleryPayload(lastPushedPayload);');
  expect(js).toContain('await ctxReadyPromise;');
  expect(js).toContain('Context failed to initialize');
  expect(js).toContain('no frames rendered');
  expect(js).toContain('totalFrames');
});

test('gallery push mode controls drive the chunk push pipeline', () => {
  expect(js).toContain("import { createDecoder, createEncoder, setForcedTier } from '@casabio/jxl-wasm';");
  expect(js).toContain("import { buildPushBatches } from './jxl-progressive-gallery-push.js';");
  expect(js).toContain('buildPushBatches(buffer, { mode: pushMode');
  expect(js).toContain('for (const batch of pushBatches)');
  expect(js).toContain("ev.type === 'progress' || ev.type === 'final'");
  expect(js).toContain("stage: ev.type === 'final' ? 'final' : ev.stage");
});

// REGRESSION LOCK (pass 2): protects chunked progressive feed + yield, coordinator min-frames round-robin visible,
// Sneyers baseline via preset, abort/limiter/rAF, getPushBatching + priority/attended/constancy oracles,
// pack fastpath + Lens17 hook. Update strings only on approved behavior change + re-run.
test('gallery (pass 2) centralizes on preset, wires oracles, honors preserve/priority/constancy prep', () => {
  expect(js).toContain('basePreset.encode');
  expect(js).toContain('getPushBatchingOptions(buffer.byteLength');
  expect(js).toContain('coordinator.getPriorityTargets');
  expect(js).toContain('lightbox.setConstancyParams');
  expect(js).toContain('preserveIcc: basePreset.decode.preserveIcc');
  expect(js).toContain('quality: encodeOptions?.quality ?? 82');
  expect(js).toContain('requestRender');
  // legacy getGalleryEncodeOptions removed/deprecated in pass 2
  expect(js).not.toContain('function getGalleryEncodeOptions()');
});

// REGRESSION LOCK: protects DONOTCHANGE progressive decode checkpoints, emitEveryPass, chunked-feed + yield between pushes for 'passes' detail,
// Sneyers baseline alignment, multi-asset handoff, ctxReady, round-robin coordinator, and now preset-driven + abort + limiter + rAF batching.
// Update strings only if behavior change is approved + full tests re-run.
test('gallery wires best-preset for unified progressive config + adaptive push + concurrency + abort + rAF batch render', () => {
  expect(js).toContain("from './jxl-progressive-best-preset.js';");
  expect(js).toContain('createProgressiveWebPreset');
  expect(js).toContain('getPushBatchingOptions');
  expect(js).toContain('basePreset');
  expect(js).toContain('getPushBatchingOptions(buffer.byteLength');
  expect(js).toContain('...pushOpts');
  expect(js).toContain('currentGalleryAbort');
  expect(js).toContain('signal.aborted');
  expect(js).toContain('AbortController');
  expect(js).toContain('runLimited');
  expect(js).toContain('concurrentEl?.value');
  expect(js).toContain('requestRender');
  expect(js).toContain('requestAnimationFrame');
  // still using the critical progressive emit path
  expect(js).toContain('emitEveryPass');
});
