export interface Subscription {
    subscriberId: string;
    primarySessionId: string;
}
export declare class DedupeRegistry {
    private readonly keyToSession;
    private readonly sessionToKey;
    private readonly sessionToSubscribers;
    private readonly subscriberToPrimary;
    register(sessionId: string, sourceKey: string): void;
    findPrimary(sourceKey: string): string | null;
    subscribe(subscriberId: string, primarySessionId: string): Subscription;
    cancelSubscriber(subscriberId: string): {
        cancelWorker: boolean;
        promotedTo?: string;
    };
    complete(sessionId: string): void;
    /** @internal — prefer forEachSubscriber for zero-allocation iteration */
    subscribers(primaryId: string): string[];
    forEachSubscriber(primaryId: string, fn: (subId: string) => void): void;
}
//# sourceMappingURL=dedupe.d.ts.map