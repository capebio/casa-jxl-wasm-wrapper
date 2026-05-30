import { expect, test } from 'bun:test';
import { createGalleryLightbox } from './jxl-progressive-gallery-lightbox.js';

test('opens the exact clicked frame and wraps within the series on arrow keys', () => {
  const lightbox = createGalleryLightbox({
    framesByFile: new Map([
      ['a', [{ frameIndex: 0 }, { frameIndex: 1 }, { frameIndex: 2 }]],
      ['b', [{ frameIndex: 0 }, { frameIndex: 1 }]],
    ]),
  });

  lightbox.open('a', 1);
  expect(lightbox.current()).toEqual({ fileId: 'a', frameIndex: 1 });

  lightbox.handleKey({ key: 'ArrowRight', ctrlKey: false });
  expect(lightbox.current()).toEqual({ fileId: 'a', frameIndex: 2 });

  lightbox.handleKey({ key: 'ArrowRight', ctrlKey: false });
  expect(lightbox.current()).toEqual({ fileId: 'a', frameIndex: 0 });

  lightbox.handleKey({ key: 'ArrowLeft', ctrlKey: false });
  expect(lightbox.current()).toEqual({ fileId: 'a', frameIndex: 2 });
});

test('ctrl+arrow moves between photos and keeps the same roughness step when possible', () => {
  const lightbox = createGalleryLightbox({
    framesByFile: new Map([
      ['a', [{ frameIndex: 0 }, { frameIndex: 1 }, { frameIndex: 2 }]],
      ['b', [{ frameIndex: 0 }, { frameIndex: 1 }]],
    ]),
  });

  lightbox.open('a', 2);
  lightbox.handleKey({ key: 'ArrowRight', ctrlKey: true });
  expect(lightbox.current()).toEqual({ fileId: 'b', frameIndex: 1 });

  lightbox.handleKey({ key: 'ArrowRight', ctrlKey: true });
  expect(lightbox.current()).toEqual({ fileId: 'a', frameIndex: 2 });
});
