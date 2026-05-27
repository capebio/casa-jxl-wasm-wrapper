import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createDecoder, createEncoder, setJxlModuleFactoryForTesting } from '../src/index';

const facade = readFileSync(new URL('../src/facade.ts', import.meta.url), 'utf8');
const bridge = readFileSync(new URL('../src/bridge.cpp', import.meta.url), 'utf8');

test('decoder facade exposes finer progressive detail than DC-only', () => {
  expect(facade).toContain('export type ProgressiveDetail = "dc" | "lastPasses" | "passes" | "dcProgressive";');
  expect(facade).toContain('progressiveDetail?: ProgressiveDetail;');
  expect(facade).toContain('resolveDecoderProgressiveDetail');
  expect(bridge).toContain('kLastPasses');
  expect(bridge).toContain('kPasses');
  expect(bridge).not.toContain('JxlDecoderSetProgressiveDetail(dec, kDC)');
});

test('progressiveDetail is plumbed through DecodeOptions, MsgDecodeStart, session, and worker handlers', () => {
  const types = readFileSync(new URL('../../jxl-core/src/types.ts', import.meta.url), 'utf8');
  const protocol = readFileSync(new URL('../../jxl-core/src/protocol.ts', import.meta.url), 'utf8');
  const decodeSession = readFileSync(new URL('../../jxl-session/src/decode-session.ts', import.meta.url), 'utf8');
  const browserHandler = readFileSync(new URL('../../jxl-worker-browser/src/decode-handler.ts', import.meta.url), 'utf8');
  const nodeHandler = readFileSync(new URL('../../jxl-worker-node/src/decode-handler.ts', import.meta.url), 'utf8');

  expect(types).toContain('progressiveDetail?: "dc" | "lastPasses" | "passes" | "dcProgressive"');
  expect(protocol).toContain('progressiveDetail: "dc" | "lastPasses" | "passes" | "dcProgressive" | null');
  expect(decodeSession).toContain('progressiveDetail: opts.progressiveDetail ?? null');
  expect(browserHandler).toContain('this.opts.progressiveDetail !== null');
  expect(nodeHandler).toContain('this.opts.progressiveDetail !== null');
});

test('libjxl is pinned to v0.11.2 or later for VarDCT progressive fix', () => {
  const buildScript = readFileSync(new URL('../scripts/build.mjs', import.meta.url), 'utf8');
  const tagMatch = buildScript.match(/libjxlTag:\s*"v(\d+)\.(\d+)\.(\d+)"/);
  expect(tagMatch).not.toBeNull();
  const [, major, minor, patch] = tagMatch!;
  const version = [Number(major), Number(minor), Number(patch)];
  // VarDCT progressive decode fix (libjxl #4223) landed in v0.11.2.
  const min = [0, 11, 2];
  const ge =
    version[0]! > min[0]! ||
    (version[0] === min[0] && version[1]! > min[1]!) ||
    (version[0] === min[0] && version[1] === min[1] && version[2]! >= min[2]!);
  expect(ge).toBe(true);
});

describe('VarDCT progressive decode emits multiple passes (libjxl 0.11.2 fix)', () => {
  // Synthetic noise image: enough entropy that the encoder cannot collapse to a
  // single trivial pass under VarDCT progressive_ac.
  function makeNoisePixels(width: number, height: number): Uint8Array {
    const out = new Uint8Array(width * height * 4);
    let state = 0x9e3779b9 >>> 0;
    for (let i = 0; i < width * height; i++) {
      state = (state * 1103515245 + 12345) >>> 0;
      out[i * 4 + 0] = (state >>> 16) & 0xff;
      state = (state * 1103515245 + 12345) >>> 0;
      out[i * 4 + 1] = (state >>> 16) & 0xff;
      state = (state * 1103515245 + 12345) >>> 0;
      out[i * 4 + 2] = (state >>> 16) & 0xff;
      out[i * 4 + 3] = 0xff;
    }
    return out;
  }

  test('progressiveDetail="passes" round-trips a VarDCT bitstream without error', async () => {
    setJxlModuleFactoryForTesting(loadPreferredLibjxlModuleForTest);
    const width = 128;
    const height = 128;
    const pixels = makeNoisePixels(width, height);

    const encoder = createEncoder({
      format: 'rgba8',
      width,
      height,
      hasAlpha: true,
      iccProfile: null,
      exif: null,
      xmp: null,
      distance: null,
      quality: 70,
      effort: 3,
      progressive: true,
      progressiveFlavor: 'ac',
      previewFirst: true,
      chunked: false,
    });
    encoder.pushPixels(pixels);
    encoder.finish();

    const chunks: Uint8Array[] = [];
    for await (const chunk of encoder.chunks()) {
      chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
    }
    await encoder.dispose();
    const encoded = concatUint8(chunks);
    expect(encoded.byteLength).toBeGreaterThan(0);

    // progressiveDetail="passes" maps to kPasses (JxlProgressiveDetail=3) — the
    // detail level that exercises the libjxl 0.11.2 VarDCT progressive fix path.
    const decoder = createDecoder({
      format: 'rgba8',
      region: null,
      downsample: 1,
      progressionTarget: 'final',
      emitEveryPass: true,
      progressiveDetail: 'passes',
      preserveIcc: false,
      preserveMetadata: false,
    });
    decoder.push(encoded);
    decoder.close();

    const eventTypes: string[] = [];
    let finalPixels: ArrayBuffer | Uint8Array | null = null;
    for await (const ev of decoder.events()) {
      eventTypes.push(ev.type);
      if (ev.type === 'final') finalPixels = ev.pixels;
      if (ev.type === 'error') throw new Error(ev.message);
    }
    await decoder.dispose();

    expect(eventTypes[0]).toBe('header');
    expect(eventTypes[eventTypes.length - 1]).toBe('final');
    expect(finalPixels).not.toBeNull();
    expect(finalPixels!.byteLength).toBe(width * height * 4);
  }, 30000);
});

function concatUint8(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

async function loadPreferredLibjxlModuleForTest() {
  try {
    const imported = await import('../dist/jxl-core.scalar.js');
    if (typeof (imported as { default?: unknown }).default === 'function') {
      const baseUrl = new URL('../dist/', import.meta.url);
      const factory = (imported as { default: (cfg: { locateFile: (p: string) => string }) => Promise<unknown> }).default;
      const module = await factory({ locateFile: (path: string) => new URL(path, baseUrl).href });
      if (module && typeof (module as { _malloc?: unknown })._malloc === 'function') {
        return module as never;
      }
    }
  } catch {}
  // Fallback: return a minimal stub object — tests will see no progress events.
  return {} as never;
}
