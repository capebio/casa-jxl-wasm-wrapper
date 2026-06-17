export interface ValidationReport {
    totalImages: number;
    totalLevels: number;
    issues: ValidationIssue[];
    migrationSuggestions?: string[];
}
export type ValidationIssue = {
    kind: "manifest-parse-error";
    imageId: string;
    error: string;
} | {
    kind: "missing-level";
    imageId: string;
    contenthash: string;
} | {
    kind: "hash-mismatch";
    imageId: string;
    contenthash: string;
    actual: string;
} | {
    kind: "level-read-error";
    imageId: string;
    contenthash: string;
    error: string;
} | {
    kind: "orphan-level";
    contenthash: string;
} | {
    kind: "orphan-scan-skipped";
    reason: string;
} | {
    kind: "index-stale";
    expected: string;
    got: string;
} | {
    kind: "index-orphan";
    imageId: string;
};
export declare function validate(outDir: string, opts?: {
    verifyHash?: boolean;
    suggestMigrations?: boolean;
}): Promise<ValidationReport>;
//# sourceMappingURL=validate.d.ts.map