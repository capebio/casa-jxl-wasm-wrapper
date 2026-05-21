import { expect, test } from 'bun:test';
import { createProgressiveSession } from './jxl-progressive-session.js';

test('keeps the same source bytes when switching backends', async () => {
    let loads = 0;
    const session = createProgressiveSession({
        initialBackend: 'jsquash',
        loadSource: async () => {
            loads += 1;
            return {
                name: 'sample.orf',
                bytes: new Uint8Array([1, 2, 3, 4]),
            };
        },
    });

    const first = await session.ensureSource();
    expect(session.backend).toBe('jsquash');
    expect(loads).toBe(1);

    session.setBackend('libjxl');
    const second = await session.ensureSource();

    expect(session.backend).toBe('libjxl');
    expect(loads).toBe(1);
    expect(second.bytes).toBe(first.bytes);
    expect(Array.from(second.bytes)).toEqual([1, 2, 3, 4]);
});

test('reloads a fresh source without changing the active backend', async () => {
    let loads = 0;
    const session = createProgressiveSession({
        initialBackend: 'jsquash',
        loadSource: async () => {
            loads += 1;
            return {
                name: `sample-${loads}.orf`,
                bytes: new Uint8Array([loads, loads + 1]),
            };
        },
    });

    const first = await session.ensureSource();
    session.setBackend('libjxl');
    const second = await session.reloadSource();

    expect(loads).toBe(2);
    expect(session.backend).toBe('libjxl');
    expect(first.bytes).not.toBe(second.bytes);
    expect(Array.from(first.bytes)).toEqual([1, 2]);
    expect(Array.from(second.bytes)).toEqual([2, 3]);
});
