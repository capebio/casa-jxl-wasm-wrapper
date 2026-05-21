# @casabio/jxl-test-corpus

Test fixtures and manifest for the Casabio JXL wrapper.

## Fixtures

Fixtures are stored in `src/fixtures/` (source) or `dist/fixtures/` (build).

| ID | Description | Bits | ICC | EXIF |
|---|---|---|---|---|
| `srgb-8bit` | Standard sRGB image | 8 | No | No |
| `srgb-alpha-8bit` | sRGB with alpha | 8 | No | No |
| `adobe-rgb-16bit` | Adobe RGB wide-gamut | 16 | Yes | Yes |
| `truncated-header` | Corrupted/truncated file | 8 | No | No |

## Usage

```ts
import { loadFixture } from '@casabio/jxl-test-corpus';

const { bytes, manifest } = await loadFixture('srgb-8bit');
console.log(`Loaded ${manifest.width}x${manifest.height} image`);
```

## Large Fixtures

Large fixtures (e.g. 100MP raws) are not bundled and are loaded on demand via `fetchLargeFixture(id)`.
