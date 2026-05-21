import { expect, test } from 'bun:test';
import { encodeBackendForTarget } from './jxl-progressive-policy.js';

test('routes very large jsquash encodes to libjxl to avoid encoder OOM', () => {
    expect(encodeBackendForTarget('jsquash', 5240, 3912)).toBe('libjxl');
});

test('keeps selected backend for smaller variants', () => {
    expect(encodeBackendForTarget('jsquash', 800, 597)).toBe('jsquash');
    expect(encodeBackendForTarget('libjxl', 5240, 3912)).toBe('libjxl');
});
