import { expect, test } from 'bun:test';
import { canRetryEffort, nextRetryEffort } from './jxl-worker-policy.js';

test('keeps retrying below effort 3 until effort 1', () => {
    expect(canRetryEffort(3)).toBe(true);
    expect(nextRetryEffort(3)).toBe(2);
    expect(canRetryEffort(2)).toBe(true);
    expect(nextRetryEffort(2)).toBe(1);
    expect(canRetryEffort(1)).toBe(false);
});
