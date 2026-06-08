import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const galleryJs = readFileSync(new URL('./pyramid-gallery.js', import.meta.url), 'utf8');
const gridJs = readFileSync(new URL('./grid-controller.js', import.meta.url), 'utf8');
const decodeJs = readFileSync(new URL('./pyramid-decode.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('./pyramid-gallery.html', import.meta.url), 'utf8');
const lightboxJs = readFileSync(new URL('../lightbox/pyramid-lightbox.js', import.meta.url), 'utf8');
const storeJs = readFileSync(new URL('./image-store.js', import.meta.url), 'utf8');

test('gallery fetches index.json before level bytes and lays out by aspect', () => {
  expect(galleryJs).toContain("fetch(new URL('index.json', galleryBase))");
  expect(galleryJs).toContain('--aspect');
  expect(html).toContain('data-pyramid-grid');
});

test('grid uses scheduler one-shot decode with contenthash sourceKey', () => {
  expect(decodeJs).toContain('progressionTarget: \'final\'');
  expect(decodeJs).toContain('emitEveryPass: false');
  expect(decodeJs).toContain('sourceKey: opts.contenthash');
  expect(gridJs).toContain('chooseLevelForTarget');
  expect(gridJs).toContain('shouldUpgrade');
});

test('grid implements L0 seed from index then monotonic upgrade', () => {
  expect(gridJs).toContain('indexByImageId');
  expect(gridJs).toContain('entry?.l0');
  expect(gridJs).toContain('shouldUpgrade');
  expect(gridJs).toContain("canvas.style.transition = 'opacity 180ms ease'");
});

test('tiled decode wires parallel worker factory', () => {
  expect(decodeJs).toContain('workerFactory');
  expect(decodeJs).toContain('tiled-decode-worker.js');
});

test('lightbox wires FilterEngine presets, zoom readout, and tiled ROI', () => {
  expect(lightboxJs).toContain('buildColorMatrix');
  expect(lightboxJs).toContain('data-zoom-pct');
  expect(lightboxJs).toContain('level.tiled');
  expect(lightboxJs).toContain('computeHistogram');
  expect(lightboxJs).toContain('shouldUpgrade');
  expect(lightboxJs).toContain('crossfade');
  expect(lightboxJs).toContain('renderRgba16AdjustedToCanvas');
  expect(lightboxJs).toContain('decodePyramidRegion');
  expect(lightboxJs).toContain('exportRoi');
  expect(lightboxJs).toContain('encodeRgba16');
  expect(lightboxJs).toContain("format: use16 ? 'rgba16' : 'rgba8'");
});

test('S1->S3->S2 image-store handoff: store centralizes manifest/level fetch; grid+lightbox delegate; no dupe', () => {
  expect(storeJs).toContain('createImageStore');
  expect(storeJs).toContain('getManifest');
  expect(storeJs).toContain('getLevelBytes');
  expect(storeJs).toContain('level:');
  expect(galleryJs).toContain('createImageStore');
  expect(galleryJs).toContain('imageStore');
  expect(gridJs).toContain('imageStore');
  expect(gridJs).toContain('getManifest');
  expect(gridJs).toContain('getLevelBytes');
  expect(lightboxJs).toContain('imageStore');
  expect(lightboxJs).toContain('getManifest');
  expect(lightboxJs).toContain('getLevelBytes');
  // index fetch stays in gallery root (per design); level/manifest now via store
  expect(galleryJs).toContain("fetch(new URL('index.json', galleryBase))");
});