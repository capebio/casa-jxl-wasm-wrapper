export interface Subscription {
    subscriberId: string;
    primarySessionId: string;
}
export declare class DedupeRegistry {
    private readonly keyToSession;
    private readonly sessionToSubscribers;
    private readonly subscriberToPrimary;
    register(sessionId: string, sourceKey: string): void;
    findPrimary(sourceKey: string): string | null;
    subscribe(subscriberId: string, primarySessionId: string): Subscription;
    cancelSubscriber(subscriberId: string): boolean;
    complete(sessionId: string): void;
    subscribers(primaryId: string): string[];
    private keyForSession;
}
//# sourceMappingURL=dedupe.d.ts.map