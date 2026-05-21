import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./jxl-wrapper-lab.js', import.meta.url), 'utf8');

describe('JXL wrapper lab performance safeguards', () => {
    test('keeps batch hot paths from doing avoidable work', () => {
        expect(source).toContain('preloadJxlModule');
        expect(source).toContain('WRAPPER_FILE_LOAD_CONCURRENCY');
        expect(source).toContain('RANDOM_LOAD_CONCURRENCY');
        expect(source).toContain('STATUS_UPDATE_INTERVAL_MS');
        expect(source).toContain('TILE_CANVAS_MAX_EDGE');
        expect(source).toContain('const sourceCache = new Map');
        expect(source).toContain('function fileCacheKey');
        expect(source).toContain('async function loadFilesConcurrently');
        expect(source).toContain('function exactBuffer');
        expect(source).toContain('function sizeForMaxEdge');
        expect(source).toContain('function paintDecodedToTileCanvas');
        expect(source).toContain('function updateProgressStatus');
        expect(source).toContain('bitmap.close?.()');
        expect(source).toContain('view.byteOffset');
        expect(source).toContain('if (views.length === 1) return views[0]');
        expect(source).toContain('await encoder.dispose()');
        expect(source).toContain('await decoder.dispose()');
        expect(source).toContain('exactBuffer(source.rgba)');
        expect(source).toContain('exactBuffer(bytes)');
        expect(source).toContain('const decodeStart = performance.now()');
        expect(source).not.toContain('const events = []');
    });
});
