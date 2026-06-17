export interface CheckpointState {
    version: "1";
    batchId: string;
    startedAt: number;
    inFlight: string[];
    completed: {
        path: string;
        outcome: "written" | "skipped";
        stagedBytes?: number;
        durationMs?: number;
    }[];
    failed: {
        path: string;
        error: string;
        code?: string;
    }[];
}
export declare function readCheckpoint(outDir: string): Promise<CheckpointState | null>;
export declare function writeCheckpoint(outDir: string, state: CheckpointState): Promise<void>;
export declare function clearCheckpoint(outDir: string): Promise<void>;
//# sourceMappingURL=checkpoint.d.ts.map