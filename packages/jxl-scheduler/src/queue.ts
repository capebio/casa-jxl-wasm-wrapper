// jxl-scheduler/src/queue.ts
// Three-lane priority queue for pending sessions.
// Spec: Section 12.2.
//
// Invariant: visible > near > background.
// Drain order: visible first, then near, then background.

import type { Priority } from "./types.js";

export interface QueueEntry<T> {
  priority: Priority;
  sessionId: string;
  payload: T;
}

export class PriorityQueue<T> {
  private readonly visible: QueueEntry<T>[] = [];
  private readonly near: QueueEntry<T>[] = [];
  private readonly background: QueueEntry<T>[] = [];

  private _visibleHead = 0;
  private _nearHead = 0;
  private _backgroundHead = 0;
  private _size = 0;

  enqueue(entry: QueueEntry<T>): void {
    this.lane(entry.priority).push(entry);
    this._size++;
  }

  /** @internal test support */
  // Peek at the highest-priority pending entry without removing it.
  peek(): QueueEntry<T> | null {
    if (this.visible.length > this._visibleHead) return this.visible[this._visibleHead] ?? null;
    if (this.near.length > this._nearHead) return this.near[this._nearHead] ?? null;
    if (this.background.length > this._backgroundHead) return this.background[this._backgroundHead] ?? null;
    return null;
  }

  // Remove and return the highest-priority entry.
  dequeue(): QueueEntry<T> | null {
    let entry: QueueEntry<T> | null;
    if ((entry = this.popLane(this.visible, this._visibleHead)) !== null) {
      this._visibleHead = PriorityQueue.compactLane(this.visible, this._visibleHead + 1);
      this._size--;
      return entry;
    }
    if ((entry = this.popLane(this.near, this._nearHead)) !== null) {
      this._nearHead = PriorityQueue.compactLane(this.near, this._nearHead + 1);
      this._size--;
      return entry;
    }
    if ((entry = this.popLane(this.background, this._backgroundHead)) !== null) {
      this._backgroundHead = PriorityQueue.compactLane(this.background, this._backgroundHead + 1);
      this._size--;
      return entry;
    }
    return null;
  }

  // Read the front element of a lane without advancing the head.
  private popLane(lane: QueueEntry<T>[], head: number): QueueEntry<T> | null {
    return lane.length > head ? (lane[head] ?? null) : null;
  }

  // Amortised O(1) compaction: clears the array once fully consumed, or
  // copyWithin-compacts when head > 64 AND head ≥ half the array length.
  // Returns the new head index (always 0 after compaction, else unchanged).
  private static compactLane<U>(lane: U[], head: number): number {
    if (head >= lane.length) {
      lane.length = 0;
      return 0;
    }
    if (head > 64 && head * 2 > lane.length) {
      lane.copyWithin(0, head);
      lane.length -= head;
      return 0;
    }
    return head;
  }

  // Swap-delete: O(1) removal by overwriting the target with the lane tail and
  // truncating. This relaxes strict FIFO within a lane for cancelled sessions
  // only — acceptable since cancel is a rare, user-driven path.
  // Priority hint helps bypass linear scan over irrelevant lanes.
  remove(sessionId: string, priority?: Priority): boolean {
    if (priority !== undefined) {
      const head = priority === "visible" ? this._visibleHead
        : priority === "near" ? this._nearHead : this._backgroundHead;
      if (this.swapDelete(this.lane(priority), head, sessionId)) { this._size--; return true; }
      // Hint may be stale (priority escalated after enqueue) — fall through to full scan.
    }
    if (this.swapDelete(this.visible, this._visibleHead, sessionId)) { this._size--; return true; }
    if (this.swapDelete(this.near, this._nearHead, sessionId)) { this._size--; return true; }
    if (this.swapDelete(this.background, this._backgroundHead, sessionId)) { this._size--; return true; }
    return false;
  }

  private swapDelete(lane: QueueEntry<T>[], head: number, sessionId: string): boolean {
    for (let i = head; i < lane.length; i++) {
      if (lane[i]!.sessionId === sessionId) {
        const last = lane.length - 1;
        if (i !== last) lane[i] = lane[last]!;
        lane.length = last;
        return true;
      }
    }
    return false;
  }

  get size(): number {
    return this._size;
  }

  get laneSizes(): { visible: number; near: number; background: number } {
    return {
      visible: this.visible.length - this._visibleHead,
      near: this.near.length - this._nearHead,
      background: this.background.length - this._backgroundHead,
    };
  }

  get isEmpty(): boolean {
    return this._size === 0;
  }

  /** @internal test support */
  backgroundIds(): string[] {
    const ids: string[] = [];
    for (let i = this._backgroundHead; i < this.background.length; i++) {
      ids.push(this.background[i]!.sessionId);
    }
    return ids;
  }

  private lane(priority: Priority): QueueEntry<T>[] {
    switch (priority) {
      case "visible": return this.visible;
      case "near": return this.near;
      case "background": return this.background;
    }
  }
}
