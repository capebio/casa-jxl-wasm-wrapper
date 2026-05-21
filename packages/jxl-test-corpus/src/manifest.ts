import { CorpusManifest } from './types.js';

export const manifest: CorpusManifest = {
  fixtures: [
    {
      id: 'srgb-8bit',
      filename: 'srgb-8bit.jxl',
      license: 'CC0',
      width: 100,
      height: 100,
      bitsPerSample: 8,
      colorSpace: 'srgb',
      hasAlpha: false,
      hasIcc: false,
      hasExif: false,
      hasXmp: false,
      expectedPass: true,
      tags: ['basic', 'srgb']
    },
    {
      id: 'srgb-alpha-8bit',
      filename: 'srgb-alpha-8bit.jxl',
      license: 'CC0',
      width: 100,
      height: 100,
      bitsPerSample: 8,
      colorSpace: 'srgb',
      hasAlpha: true,
      hasIcc: false,
      hasExif: false,
      hasXmp: false,
      expectedPass: true,
      tags: ['alpha']
    },
    {
      id: 'adobe-rgb-16bit',
      filename: 'adobe-rgb-16bit.jxl',
      license: 'Casabio-Internal',
      width: 100,
      height: 100,
      bitsPerSample: 16,
      colorSpace: 'adobe-rgb',
      hasAlpha: false,
      hasIcc: true,
      hasExif: true,
      hasXmp: true,
      expectedPass: true,
      tags: ['scientific', '16bit', 'icc', 'exif']
    },
    {
      id: 'truncated-header',
      filename: 'truncated-header.jxl',
      license: 'CC0',
      width: 100,
      height: 100,
      bitsPerSample: 8,
      colorSpace: 'srgb',
      hasAlpha: false,
      hasIcc: false,
      hasExif: false,
      hasXmp: false,
      expectedPass: false,
      tags: ['truncated', 'malformed']
    }
  ]
};
