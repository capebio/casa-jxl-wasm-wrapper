export declare function expect<T>(value: T): {
    toBe(expected: T): void;
    toEqual(expected: unknown): void;
    toBeDefined(): void;
    toBeGreaterThan(expected: number): void;
    toContain(expected: unknown): void;
    toHaveLength(expected: number): void;
    rejects: {
        toThrow(expected?: string | RegExp): Promise<void>;
    };
};
//# sourceMappingURL=expect.d.ts.map