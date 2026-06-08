import { type LadderResult } from "./ladder.js";
import { type GalleryIndex, type LevelEntry } from "./manifest.js";
import type { JxlBackend, MasterFormat, RawBackend } from "./backends.js";
export interface Backends {
    raw: RawBackend;
    jxl: JxlBackend;
}
export interface IngestOptions {
    outDir: string;
    proxy?: number;
    force?: boolean;
}
export type IngestOutcome = "written" | "skipped";
export interface BatchResult {
    written: number;
    skipped: number;
    failed: {
        path: string;
        error: string;
    }[];
}
export declare function formatFromPath(p: string): MasterFormat | null;
export declare function writeLevelFiles(outDir: string, levels: LadderResult["levels"], masterW: number, masterH: number): Promise<LevelEntry[]>;
export declare function ingestImage(masterPath: string, backends: Backends, opts: IngestOptions): Promise<IngestOutcome>;
export declare function ingestBatch(files: readonly string[], backends: Backends, opts: IngestOptions & {
    concurrency?: number;
}): Promise<BatchResult>;
export declare function rebuildIndex(outDir: string): Promise<GalleryIndex>;
//# sourceMappingURL=ingest.d.ts.map