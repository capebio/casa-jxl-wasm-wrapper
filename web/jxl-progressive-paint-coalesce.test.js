import { expect, test } from 'bun:test';

function makeCoalescer(onPaint) {
    let pendingItem = null;
    let rafPending = false;
    const rafQueue = [];
    const rAF = (fn) => { rafQueue.push(fn); };
    const flushRaf = () => {
        const q = rafQueue.splice(0);
        q.forEach(fn => fn());
    };

    function schedulePaint(item) {
        if (item.isFinal) {
            if (rafPending && pendingItem) {
                onPaint(pendingItem);
                pendingItem = null;
            }
            rafPending = false;
            onPaint(item);
            return;
        }
        pendingItem = item;
        if (rafPending) return;
        rafPending = true;
        rAF(() => {
            rafPending = false;
            if (!pendingItem) return;
            const i = pendingItem;
            pendingItem = null;
            onPaint(i);
        });
    }

    return { schedulePaint, flushRaf };
}

test('3 synchronous progress events coalesce to 1 paint with most-recent pixels', () => {
    const painted = [];
    const { schedulePaint, flushRaf } = makeCoalescer((item) => painted.push(item));

    schedulePaint({ passIdx: 0, isFinal: false, pixels: new Uint8Array([1]) });
    schedulePaint({ passIdx: 1, isFinal: false, pixels: new Uint8Array([2]) });
    schedulePaint({ passIdx: 2, isFinal: false, pixels: new Uint8Array([3]) });

    expect(painted).toHaveLength(0);

    flushRaf();

    expect(painted).toHaveLength(1);
    expect(painted[0].passIdx).toBe(2);
    expect(painted[0].pixels[0]).toBe(3);
});

test('final event bypasses coalescing and paints immediately', () => {
    const painted = [];
    const { schedulePaint } = makeCoalescer((item) => painted.push(item));

    schedulePaint({ passIdx: 0, isFinal: false, pixels: new Uint8Array([1]) });
    schedulePaint({ passIdx: 1, isFinal: true, pixels: new Uint8Array([2]) });

    expect(painted).toHaveLength(2);
    expect(painted[0].passIdx).toBe(0);
    expect(painted[1].passIdx).toBe(1);
    expect(painted[1].isFinal).toBe(true);
});

test('final event without prior pending paints immediately alone', () => {
    const painted = [];
    const { schedulePaint } = makeCoalescer((item) => painted.push(item));

    schedulePaint({ passIdx: 0, isFinal: true, pixels: new Uint8Array([9]) });

    expect(painted).toHaveLength(1);
    expect(painted[0].isFinal).toBe(true);
});
