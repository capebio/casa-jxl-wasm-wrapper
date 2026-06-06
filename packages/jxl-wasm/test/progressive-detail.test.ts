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

test('groupOrder (center-out) is exposed in EncoderOptions and plumbed through FFI/bridge (predator next heat)', () => {
  expect(facade).toContain('groupOrder?: 0 | 1');
  expect(bridge).toContain('JXL_ENC_FRAME_SETTING_GROUP_ORDER');
  expect(bridge).toContain('enc_group_order');
  expect(bridge).toContain('group_order');
});

test('correlation matrix (encode-space benchmark tool) treats progressiveDc + groupOrder as first-class sweep factors and forwards to createEncoder (predator continuation heat)', () => {
  const matrix = readFileSync(new URL('../../../web/jxl-correlation-matrix.js', import.meta.url), 'utf8');
  const worker = readFileSync(new URL('../../../web/jxl-correlation-worker.js', import.meta.url), 'utf8');

  // Factors + bias + N/A (UI side)
  expect(matrix).toContain('progressiveDc:');
  expect(matrix).toContain('groupOrder:');
  expect(matrix).toContain('Predator bias');
  expect(matrix).toContain('progressiveDc requires progressive');

  // Forwarding in the off-main encode worker (the actual call site for the matrix)
  expect(worker).toContain('progressiveDc: combo.progressive');
  expect(worker).toContain('groupOrder: combo.progressive');

  // Decode-side layer metrics collection (progressEvents / firstProgress*) now lives in worker so matrix surfaces
  // Prog Events + 1st Prog KB for predator sweeps (Dc x group). Matches the collection in predator-progressive-metrics.
  expect(worker).toContain('exactBuffer');
  expect(worker).toContain('createDecoder');
  expect(worker).toContain("progressiveDetail: 'passes'");
  expect(worker).toContain('for await (const ev of decoder.events())');
  expect(worker).toContain('progressEvents');
  expect(worker).toContain('firstProgressBytes');
  expect(worker).toContain('decode-side layer metrics');

  // Prefix-probe for minBytesToFirstProgress (handoff headroom: true early bytes independent of chunk feed)
  expect(worker).toContain('probeMinBytesToFirstProgress');
  expect(worker).toContain('minBytesToFirstProgress');
  expect(matrix).toContain('Min 1st KB (probe)'); // UI label in matrix table
  expect(worker).toContain('Prefix-probe helper');
});

test('progressive encoder enables responsive ordering like cjxl --progressive', () => {
  expect(bridge).toContain('JXL_ENC_FRAME_SETTING_RESPONSIVE');
  expect(bridge).toContain('ApplyProgressiveFrameSettings');
  expect(bridge).toContain('progressive_dc > 0 || progressive_ac > 0 || qprogressive_ac > 0');
});

test('encoder exposes explicit VarDCT AC/Q-progressive overrides for progressive truth matrix', () => {
  const distFacade = readFileSync(new URL('../dist/facade.js', import.meta.url), 'utf8');
  const distTypes = readFileSync(new URL('../dist/facade.d.ts', import.meta.url), 'utf8');

  expect(facade).toContain('progressiveAc?: 0 | 1 | 2');
  expect(facade).toContain('qProgressiveAc?: 0 | 1 | 2');
  expect(facade).toContain('options.progressiveAc != null');
  expect(facade).toContain('options.qProgressiveAc != null');
  expect(distFacade).toContain('options.progressiveAc != null');
  expect(distFacade).toContain('options.qProgressiveAc != null');
  expect(distTypes).toContain('progressiveAc?: 0 | 1 | 2');
  expect(distTypes).toContain('qProgressiveAc?: 0 | 1 | 2');
});

test('stateful progressive decoder releases prior input before appending stream chunks', () => {
  expect(bridge).toContain('JxlDecoderReleaseInput(s->dec)');
  expect(bridge).toContain('unprocessed tail + newly appended bytes');
  expect(bridge).toContain('memmove(s->input_buf');
  expect(bridge).toContain('JxlDecoderSetInput(s->dec, s->input_buf, s->input_size)');
});

test('stateful progressive decoder flushes on JXL_DEC_FRAME_PROGRESSION and input_closed; open-stream per-chunk opportunistic flush removed', () => {
  // Open streams rely on libjxl FRAME_PROGRESSION events for real pass boundaries (~5 per frame).
  // The input_closed path retains one opportunistic flush for byte-truncated (Sneyers) streams.
  expect(bridge).toContain('TryFlushProgressiveImage');
  expect(bridge).toContain('status == JXL_DEC_FRAME_PROGRESSION');
  expect(bridge).toContain('status == JXL_DEC_NEED_MORE_INPUT');
  expect(bridge).toContain('s->frame_started');
  expect(bridge).toContain('opportunistic_flush_generation != s->input_generation');
  expect(bridge).toContain('s->opportunistic_flush_generation = s->input_generation');
  expect(bridge).not.toContain('prev_flush_checksum');
  // All-zero scan skipped after first flush via flush_count guard.
  expect(bridge).toContain('flush_count');
  expect(bridge).toContain('s->flush_count == 0');
  // Open-stream opportunistic flush removed: the conditional that fired on !input_closed is gone.
  expect(bridge).not.toContain('!s->input_closed && s->frame_started');
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
      progressiveDc: 2,
      chunked: false,
      groupOrder: 1,
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

    // Test/measurement improvement (handoff): with progressiveDc=2 + groupOrder=1 + 'passes' + noise,
    // expect multiple distinct progress events (header + >=1 progress + final) so benchmark surfaces show layers.
    // (Total >=3 events signals the early/more passes win is live in the encode codestream.)
    expect(eventTypes.length).toBeGreaterThanOrEqual(3);
    expect(eventTypes).toContain('progress');
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
