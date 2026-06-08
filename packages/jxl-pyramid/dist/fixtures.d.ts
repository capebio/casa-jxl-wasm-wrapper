export interface FixtureMetadata {
    path: string;
    format: "orf" | "dng" | "cr2" | "jpg";
    description?: string;
}
/**
 * List of approved local test fixtures with exact paths preserved as strings.
 * File existence is not checked; spelling of paths is preserved exactly.
 */
export declare const APPROVED_FIXTURES: readonly FixtureMetadata[];
//# sourceMappingURL=fixtures.d.ts.map