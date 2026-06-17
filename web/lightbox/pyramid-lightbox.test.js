import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./pyramid-lightbox.js', import.meta.url), 'utf8');

// Task 8: JXTC decode metrics capture
// Verify the timing instrumentation is present in the source.

test('Task 8: t0Decode timing variable declared before JXTC decode call', () => {
  expect(source).toContain('const t0Decode = performance.now()');
});

test('Task 8: jxtcDecodeMs assigned from t0Decode after decodeTileContainerRegionRgba8', () => {
  // Uses assignment to outer `let jxtcDecodeMs` (not re-declaration) so the value escapes the try block.
  expect(source).toContain('jxtcDecodeMs = performance.now() - t0Decode');
});

test('Task 8: jxtcDecodeMs stored on levelInfo', () => {
  expect(source).toContain('jxtcDecodeMs');
  // Must appear in the levelInfo literal
  const levelInfoBlock = source.match(/levelInfo\s*=\s*\{[^}]+\}/s)?.[0] ?? '';
  expect(levelInfoBlock).toContain('jxtcDecodeMs');
});

test('Task 8: jxtcDecodeMs logged via log helper', () => {
  // The log call must reference jxtcDecodeMs so it is visible in the lightbox console.
  expect(source).toMatch(/log\?\.\([^)]*jxtcDecodeMs/);
});

test('Task 8: via: jxtc present in the log output so callers can distinguish path', () => {
  expect(source).toContain("via: 'jxtc'");
});
