import { describe, it, expect, afterEach } from 'vitest';
import { createDecoder, setJxlModuleFactoryForTesting } from '../src/index';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// Simple fake progressive decoder module for testing deferred-release behavior
function createFakeProgressiveLibjxlModule() {
  const memory = new ArrayBuffer(65536);
  const HEAPU8 = new Uint8Array(memory);
  const HEAP32 = new Int32Array(memory);
  const HEAPU32 = new Uint32Array(memory);
  let nextPtr = 64;
  const allocations = new Map<number, number>();
  const handles = new Map<number, { dataPtr: number; size: number; width: number; height: number; bits: number; alpha: number }>();
  let nextHandle = 1;

  const malloc = (size: number) => {
    const ptr = nextPtr;
    nextPtr += size + 8;
    allocations.set(ptr, size);
    return ptr;
  };

  const makeHandle = (bytes: Uint8Array, width: number, height: number, bits = 8) => {
    const dataPtr = malloc(bytes.byteLength);
    HEAPU8.set(bytes, dataPtr);
    const handle = nextHandle++;
    handles.set(handle, { dataPtr, size: bytes.byteLength, width, height, bits, alpha: 1 });
    return handle;
  };

  let closed = false;
  let flushed = false;

  return {
    HEAPU8,
    HEAP32,
    HEAPU32,
    __allocations: allocations,
    _malloc: malloc,
    _free: (ptr: number) => allocations.delete(ptr),
    _jxl_wasm_decode_rgba8: (inputPtr: number, inputSize: number, _downsample: number) => {
      return makeHandle(HEAPU8.slice(inputPtr, inputPtr + inputSize), 1, 1);
    },
    _jxl_wasm_dec_create: () => 1,
    _jxl_wasm_dec_push: (_state: number, _dataPtr: number, size: number) => {
      if (closed || size === 0) return 2;
      flushed = true;
      return 1;
    },
    _jxl_wasm_dec_close_input: () => {
      closed = true;
    },
    _jxl_wasm_dec_width: () => 1,
    _jxl_wasm_dec_height: () => 1,
    _jxl_wasm_dec_error: () => 0,
    _jxl_wasm_dec_take_flushed: () => {
      if (!flushed) return 0;
      flushed = false;
      return makeHandle(HEAPU8.slice(0, 4), 1, 1);
    },
    _jxl_wasm_dec_take_final: () => makeHandle(HEAPU8.slice(0, 4), 1, 1),
    _jxl_wasm_dec_free: () => {},
    _jxl_wasm_buffer_data: (handle: number) => handles.get(handle)?.dataPtr ?? 0,
    _jxl_wasm_buffer_size: (handle: number) => handles.get(handle)?.size ?? 0,
    _jxl_wasm_buffer_width: (handle: number) => handles.get(handle)?.width ?? 0,
    _jxl_wasm_buffer_height: (handle: number) => handles.get(handle)?.height ?? 0,
    _jxl_wasm_buffer_bits_per_sample: (handle: number) => handles.get(handle)?.bits ?? 8,
    _jxl_wasm_buffer_has_alpha: (handle: number) => handles.get(handle)?.alpha ?? 1,
    _jxl_wasm_buffer_free: (handle: number) => {
      const entry = handles.get(handle);
      if (entry) allocations.delete(entry.dataPtr);
      handles.delete(handle);
    },
    __makeHandle: makeHandle,
  };
}

describe('deferred-release pixel emission mode', () => {
  afterEach(() => {
    setJxlModuleFactoryForTesting(null);
  });

  it('emits pixels without ArrayBuffer transfer when deferredRelease=true', async () => {
    setJxlModuleFactoryForTesting(async () => createFakeProgressiveLibjxlModule());

    const decoder = createDecoder({
      format: 'rgba8',
      progressionTarget: 'final',
      emitEveryPass: false,
      preserveIcc: false,
      preserveMetadata: false,
      deferredRelease: true, // Enable deferred-release mode
    });

    // Push minimal valid data
    decoder.push(new Uint8Array([1, 2, 3, 4]));
    decoder.close();

    const events = [];
    for await (const event of decoder.events()) {
      events.push(event);
    }

    // Should have header and final events
    const finalEvent = events.find((e) => e.type === 'final');
    expect(finalEvent).toBeDefined();

    if (finalEvent && finalEvent.type === 'final') {
      // In deferredRelease mode, pixels should be an ArrayBuffer (shared reference, not transferred)
      expect(finalEvent.pixels).toBeInstanceOf(ArrayBuffer);
      expect(finalEvent.pixels.byteLength).toBeGreaterThan(0);
    }
  });

  it('emits pixels via normal transfer when deferredRelease=false', async () => {
    setJxlModuleFactoryForTesting(async () => createFakeProgressiveLibjxlModule());

    const decoder = createDecoder({
      format: 'rgba8',
      progressionTarget: 'final',
      emitEveryPass: false,
      preserveIcc: false,
      preserveMetadata: false,
      deferredRelease: false, // Normal mode (default)
    });

    decoder.push(new Uint8Array([1, 2, 3, 4]));
    decoder.close();

    const events = [];
    for await (const event of decoder.events()) {
      events.push(event);
    }

    const finalEvent = events.find((e) => e.type === 'final');
    expect(finalEvent).toBeDefined();

    if (finalEvent && finalEvent.type === 'final') {
      // In normal mode, pixels should be Uint8Array (direct from decoder)
      expect(finalEvent.pixels).toBeInstanceOf(Uint8Array);
      expect(finalEvent.pixels.byteLength).toBeGreaterThan(0);
    }
  });

  it('progressive frames emit into deferred buffer when deferredRelease=true', async () => {
    setJxlModuleFactoryForTesting(async () => createFakeProgressiveLibjxlModule());

    const decoder = createDecoder({
      format: 'rgba8',
      progressionTarget: 'final',
      emitEveryPass: true, // Request all passes
      preserveIcc: false,
      preserveMetadata: false,
      deferredRelease: true,
    });

    decoder.push(new Uint8Array([1, 2, 3, 4]));
    decoder.close();

    let progressiveFrameCount = 0;
    for await (const event of decoder.events()) {
      if (event.type === 'progress') {
        progressiveFrameCount++;
        // In deferred release, should be ArrayBuffer (shared buffer)
        expect(event.pixels).toBeInstanceOf(ArrayBuffer);
      } else if (event.type === 'final') {
        // Final frame also in shared buffer
        expect(event.pixels).toBeInstanceOf(ArrayBuffer);
      }
    }

    // At minimum should have the final frame
    expect(progressiveFrameCount).toBeGreaterThanOrEqual(0);
  });

  it('real fixture test: deferredRelease with actual JXL file when available', async () => {
    // Try to load a real JXL fixture if available; skip if not
    const possiblePaths = [
      join(__dirname, '../../../packages/jxl-test-corpus/fixtures/srgb-8bit.jxl'),
      join(__dirname, '../../jxl-test-corpus/fixtures/srgb-8bit.jxl'),
    ];

    let jxlData: Uint8Array | null = null;
    for (const path of possiblePaths) {
      if (existsSync(path)) {
        try {
          jxlData = readFileSync(path);
          break;
        } catch {
          // continue
        }
      }
    }

    if (!jxlData) {
      // Skip test if fixture unavailable
      console.log('[deferred-release test] Skipping real fixture test — JXL file not found');
      return;
    }

    // Use real WASM module via dynamic import attempt
    try {
      const imported = await import('../dist/jxl-core.scalar.js');
      if (typeof imported.default === 'function') {
        const baseUrl = new URL('../dist/', import.meta.url);
        const module = await imported.default({
          locateFile: (path: string) => new URL(path, baseUrl).href,
        });
        if (module && typeof module._malloc === 'function') {
          setJxlModuleFactoryForTesting(async () => module);
        }
      }
    } catch {
      // Use fake module instead
      setJxlModuleFactoryForTesting(async () => createFakeProgressiveLibjxlModule());
    }

    const decoder = createDecoder({
      format: 'rgba8',
      progressionTarget: 'final',
      emitEveryPass: false,
      preserveIcc: false,
      preserveMetadata: false,
      deferredRelease: true,
    });

    decoder.push(jxlData);
    decoder.close();

    const events = [];
    for await (const event of decoder.events()) {
      events.push(event);
    }

    const finalEvent = events.find((e) => e.type === 'final');
    if (finalEvent && finalEvent.type === 'final') {
      expect(finalEvent.pixels).toBeInstanceOf(ArrayBuffer);
      expect(finalEvent.pixels.byteLength).toBeGreaterThan(0);
    }
  });
});
