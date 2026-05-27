// jxl-scheduler/src/dedupe.ts
// Source-identity dedupe and fan-out subscription management.
// Spec: Section 12.4.
//
// When two callers request the same source (URL hash or content hash),
// the second returns a fan-out subscription to the existing session.
// Cancellation by one subscriber does NOT cancel the underlying session
// unless ALL subscribers cancel.

export interface Subscription {
  subscriberId: string;
  primarySessionId: string;
}

export class DedupeRegistry {
  // sourceKey → primary sessionId
  private readonly keyToSession = new Map<string, string>();
  // primary sessionId → sourceKey (reverse of keyToSession, avoids O(n) scan)
  private readonly sessionToKey = new Map<string, string>();
  // primary sessionId → Set of subscriber session IDs
  private readonly sessionToSubscribers = new Map<string, Set<string>>();
  // subscriber sessionId → primary sessionId (for reverse lookup)
  private readonly subscriberToPrimary = new Map<string, string>();

  // Register a new primary session for a source key.
  register(sessionId: string, sourceKey: string): void {
    this.keyToSession.set(sourceKey, sessionId);
    this.sessionToKey.set(sessionId, sourceKey);
    this.sessionToSubscribers.set(sessionId, new Set([sessionId]));
  }

  // Look up whether a source key already has an active primary session.
  findPrimary(sourceKey: string): string | null {
    return this.keyToSession.get(sourceKey) ?? null;
  }

  // Subscribe a new session to an existing primary.
  // Returns a Subscription describing the relationship.
  subscribe(subscriberId: string, primarySessionId: string): Subscription {
    const subs = this.sessionToSubscribers.get(primarySessionId);
    if (subs === undefined) {
      throw new Error(`[jxl-scheduler] DedupeRegistry: primary session ${primarySessionId} not found`);
    }
    subs.add(subscriberId);
    this.subscriberToPrimary.set(subscriberId, primarySessionId);
    return { subscriberId, primarySessionId };
  }

  // Cancel a subscriber. Returns true if all subscribers are gone and
  // the underlying primary session should be cancelled.
  //
  // When the PRIMARY session itself is cancelled (subscriberId === primaryId),
  // the source-key mapping must be torn down immediately so that future
  // register() calls for the same key do not fan-out to the dead primary,
  // regardless of whether fan-out subscribers are still alive.
  cancelSubscriber(subscriberId: string): boolean {
    const primaryId = this.subscriberToPrimary.get(subscriberId) ?? subscriberId;
    const isPrimary = primaryId === subscriberId;
    const subs = this.sessionToSubscribers.get(primaryId);

    if (subs === undefined) return true; // already cleaned up

    subs.delete(subscriberId);
    this.subscriberToPrimary.delete(subscriberId);

    // If the primary itself is being cancelled, tear down the source-key index
    // now so no future findPrimary() hit returns this dead session.
    if (isPrimary) {
      const key = this.sessionToKey.get(primaryId);
      if (key !== undefined) this.keyToSession.delete(key);
      this.sessionToKey.delete(primaryId);
    }

    if (subs.size === 0) {
      // All subscribers gone: finish cleanup and signal caller to cancel primary.
      this.sessionToSubscribers.delete(primaryId);
      return true;
    }

    // Fan-out subscribers still alive. If the primary itself was cancelled,
    // return true so the scheduler kills the underlying worker session.
    // Surviving subscribers will receive the resulting terminal message via
    // the existing fan-out path and must handle it (e.g. resubmit).
    return isPrimary;
  }

  // Clean up a completed or errored primary session.
  complete(sessionId: string): void {
    const key = this.sessionToKey.get(sessionId);
    if (key !== undefined) this.keyToSession.delete(key);
    this.sessionToKey.delete(sessionId);

    const subs = this.sessionToSubscribers.get(sessionId);
    if (subs !== undefined) {
      for (const sub of subs) {
        if (sub !== sessionId) this.subscriberToPrimary.delete(sub);
      }
      this.sessionToSubscribers.delete(sessionId);
    }
  }

  // Returns all subscriber IDs for a primary (including itself).
  subscribers(primaryId: string): string[] {
    return [...(this.sessionToSubscribers.get(primaryId) ?? [])];
  }

  // Iterates subscriber IDs without allocating an intermediate array.
  forEachSubscriber(primaryId: string, fn: (subId: string) => void): void {
    const subs = this.sessionToSubscribers.get(primaryId);
    if (subs === undefined) return;
    for (const sub of subs) fn(sub);
  }

}
