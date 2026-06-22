import { expect, test } from 'bun:test';
import { createProgressiveDecodeRequest } from './jxl-progressive-decode.js';

test('progressive decode helper sends session messages and resolves final frame', async () => {
    const worker = new FakeWorker();
    const progress = [];
    const request = createProgressiveDecodeRequest({
        worker,
        sessionId: 'decode-1',
        detail: 'dc',
        onProgress: (frame) => progress.push(frame),
    });

    request.start();
    const chunk = new Uint8Array([1, 2, 3]).buffer;
    request.push(chunk);
    request.close();

    expect(worker.messages.map((entry) => entry.message.type)).toEqual([
        'decode_start',
        'decode_chunk',
        'decode_close',
    ]);
    expect(worker.messages[0].message).toMatchObject({
        sessionId: 'decode-1',
        progressionTarget: 'final',
        emitEveryPass: true,
    });
    expect(worker.messages[1].transfer).toEqual([chunk]);

    const pixels = new Uint8Array([9, 8, 7, 255]).buffer;
    worker.emit({
        type: 'decode_progress',
        sessionId: 'decode-1',
        stage: 'dc',
        pixels,
        info: { width: 1, height: 1 },
        format: 'rgba8',
        pixelStride: 4,
    });
    expect(progress).toHaveLength(1);
    expect(Array.from(progress[0].rgba)).toEqual([9, 8, 7, 255]);

    const finalPixels = new Uint8Array([1, 2, 3, 255]).buffer;
    worker.emit({
        type: 'decode_final',
        sessionId: 'decode-1',
        pixels: finalPixels,
        info: { width: 1, height: 1 },
        format: 'rgba8',
        pixelStride: 4,
    });

    const final = await request.done;
    expect(Array.from(final.rgba)).toEqual([1, 2, 3, 255]);
    expect(final.w).toBe(1);
    expect(final.h).toBe(1);
    expect(worker.listenerCount()).toBe(0);
});

test('decode_final still runs onFinal/finish when onFrame throws', async () => {
    const worker = new FakeWorker();
    let onFinalCalls = 0;
    const request = createProgressiveDecodeRequest({
        worker,
        sessionId: 'decode-2',
        onFrame: () => { throw new Error('consumer onFrame boom'); },
        onFinal: () => { onFinalCalls++; },
    });

    request.start();

    const finalPixels = new Uint8Array([4, 5, 6, 255]).buffer;
    worker.emit({
        type: 'decode_final',
        sessionId: 'decode-2',
        pixels: finalPixels,
        info: { width: 1, height: 1 },
        format: 'rgba8',
        pixelStride: 4,
    });

    // onFrame threw → done() rejects (failure recorded), but the terminal
    // lifecycle still runs: onFinal fires and listeners are cleaned up.
    await expect(request.done).rejects.toThrow('consumer onFrame boom');
    expect(onFinalCalls).toBe(1);
    expect(worker.listenerCount()).toBe(0);
});

class FakeWorker {
    messages = [];
    listeners = new Set();

    postMessage(message, transfer = []) {
        this.messages.push({ message, transfer });
    }

    addEventListener(type, listener) {
        if (type === 'message') this.listeners.add(listener);
    }

    removeEventListener(type, listener) {
        if (type === 'message') this.listeners.delete(listener);
    }

    emit(data) {
        for (const listener of this.listeners) {
            listener({ data });
        }
    }

    listenerCount() {
        return this.listeners.size;
    }
}
