export interface AdvisoryLock {
    release(): Promise<void>;
}
declare function acquireWriteLock(outDir: string, timeoutMs?: number): Promise<AdvisoryLock>;
declare function acquireReadLock(outDir: string, timeoutMs?: number): Promise<AdvisoryLock>;
export { acquireWriteLock, acquireReadLock };
/** Full L3 per-image: write lock for mutate on specific image (rm, targeted migrate). Uses images/<id>/.lock */
export declare function acquireImageWriteLock(outDir: string, imageId: string, timeoutMs?: number): Promise<AdvisoryLock>;
/** Full L3 per-image read (for targeted validate on image). */
export declare function acquireImageReadLock(outDir: string, imageId: string, timeoutMs?: number): Promise<AdvisoryLock>;
//# sourceMappingURL=lock.d.ts.map