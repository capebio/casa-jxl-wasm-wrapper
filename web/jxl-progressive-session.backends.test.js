import { expect, test } from 'bun:test';
import { createProgressiveSession } from './jxl-progressive-session.js';

test('defaults encode and decode backends to libjxl', () => {
    const session = createProgressiveSession({
        loadSource: async () => ({
            name: 'sample.orf',
            bytes: new Uint8Array([1, 2]),
        }),
    });

    expect(session.encodeBackend).toBe('libjxl');
    expect(session.decodeBackend).toBe('libjxl');
});

test('tracks encode and decode backends independently while reusing the same source', async () => {
    let loads = 0;
    const session = createProgressiveSession({
        initialEncodeBackend: 'jsquash',
        initialDecodeBackend: 'jsquash',
        loadSource: async () => {
            loads += 1;
            return {
                name: `sample-${loads}.orf`,
                bytes: new Uint8Array([loads, loads + 1]),
            };
        },
    });

    const first = await session.ensureSource();

    expect(session.encodeBackend).toBe('jsquash');
    expect(session.decodeBackend).toBe('jsquash');
    expect(loads).toBe(1);

    session.setEncodeBackend('libjxl');
    expect(session.encodeBackend).toBe('libjxl');
    expect(session.decodeBackend).toBe('jsquash');

    const second = await session.ensureSource();

    expect(loads).toBe(1);
    expect(second.bytes).toBe(first.bytes);

    session.setDecodeBackend('libjxl');
    expect(session.encodeBackend).toBe('libjxl');
    expect(session.decodeBackend).toBe('libjxl');
});
