import { decodeTileContainerRegionRgba8, preloadJxlModule } from '../../packages/jxl-wasm/dist/index.js';

try { preloadJxlModule(); } catch { /* optional */ }

self.onmessage = async (ev) => {
  const { id, bytes, region } = ev.data;
  try {
    const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const out = await decodeTileContainerRegionRgba8(buf, region);
    self.postMessage({ id, ok: true, pixels: out.pixels, width: out.width, height: out.height }, [out.pixels.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err) });
  }
};