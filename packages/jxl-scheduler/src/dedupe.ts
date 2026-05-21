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
  // primary sessionId → Set of subscriber session IDs
  private readonly sessionToSubscribers = new Map<string, Set<string>>();
  // subscriber sessionId → primary sessionId (for reverse lookup)
  private readonly subscriberToPrimary = new Map<string, string>();

  // Register a new primary session for a source key.
  register(sessionId: string, sourceKey: string): void {
    this.keyToSession.set(sourceKey, sessionId);
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
  cancelSubscriber(subscriberId: string): boolean {
    const primaryId = this.subscriberToPrimary.get(subscriberId) ?? subscriberId;
    const subs = this.sessionToSubscribers.get(primaryId);

    if (subs === undefined) return true; // already cleaned up

    subs.delete(subscriberId);
    this.subscriberToPrimary.delete(subscriberId);

    if (subs.size === 0) {
      // All subscribers gone: clean up and signal caller to cancel primary.
      const key = this.keyForSession(primaryId);
      if (key !== null) this.keyToSession.delete(key);
      this.sessionToSubscribers.delete(primaryId);
      return true;
    }

    return false;
  }

  // Clean up a completed or errored primary session.
  complete(sessionId: string): void {
    const key = this.keyForSession(sessionId);
    if (key !== null) this.keyToSession.delete(key);

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

  private keyForSession(sessionId: string): string | null {
    for (const [k, v] of this.keyToSession) {
      if (v === sessionId) return k;
    }
    return null;
  }
}
