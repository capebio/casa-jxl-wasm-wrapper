import assert from "node:assert/strict";

export function expect<T>(value: T) {
  return {
    toBe(expected: T) {
      assert.strictEqual(value, expected);
    },
    toEqual(expected: unknown) {
      assert.deepStrictEqual(value, expected);
    },
    toBeDefined() {
      assert.notStrictEqual(value, undefined);
    },
    toBeUndefined() {
      assert.strictEqual(value, undefined);
    },
    toBeGreaterThan(expected: number) {
      assert.ok((value as unknown as number) > expected);
    },
    toContain(expected: unknown) {
      assert.ok((value as unknown as Array<unknown>).includes(expected));
    },
    toHaveLength(expected: number) {
      assert.strictEqual((value as unknown as { length: number }).length, expected);
    },
    rejects: {
      async toThrow(expected?: string | RegExp) {
        if (expected === undefined) {
          await assert.rejects(value as unknown as Promise<unknown>);
          return;
        }
        await assert.rejects(value as unknown as Promise<unknown>, (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          return expected instanceof RegExp ? expected.test(message) : message.includes(expected);
        });
      },
    },
  };
}
