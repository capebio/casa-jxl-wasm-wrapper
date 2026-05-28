import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./jxl-progressive-gallery.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('./jxl-progressive-gallery.html', import.meta.url), 'utf8');
const js = source;

test('progressive gallery uses the default progressive detail path', () => {
    expect(source).toContain("progressionTarget: 'final'");
    expect(source).toContain('emitEveryPass: true');
    expect(source).not.toContain('progressiveDetail:');
    expect(source).toContain('frame.getImageData()');
    expect(source).toContain('Push chunks');
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
