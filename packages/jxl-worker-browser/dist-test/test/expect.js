import assert from "node:assert/strict";
export function expect(value) {
    return {
        toBe(expected) {
            assert.strictEqual(value, expected);
        },
        toEqual(expected) {
            assert.deepStrictEqual(value, expected);
        },
        toBeDefined() {
            assert.notStrictEqual(value, undefined);
        },
        toBeGreaterThan(expected) {
            assert.ok(value > expected);
        },
        toContain(expected) {
            assert.ok(value.includes(expected));
        },
        toHaveLength(expected) {
            assert.strictEqual(value.length, expected);
        },
        rejects: {
            async toThrow(expected) {
                if (expected === undefined) {
                    await assert.rejects(value);
                    return;
                }
                await assert.rejects(value, (err) => {
                    const message = err instanceof Error ? err.message : String(err);
                    return expected instanceof RegExp ? expected.test(message) : message.includes(expected);
                });
            },
        },
    };
}
//# sourceMappingURL=expect.js.map