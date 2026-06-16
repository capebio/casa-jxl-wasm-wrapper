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
    // Try visible first
    if (this.visible.length > this._visibleHead) {
      const entry = this.visible[this._visibleHead++];
      if (this._visibleHead >= this.visible.length) {
        this.visible.length = 0;
        this._visibleHead = 0;
      } else if (this._visibleHead > 64 && this._visibleHead * 2 > this.visible.length) {
        this.visible.copyWithin(0, this._visibleHead);
        this.visible.length -= this._visibleHead;
        this._visibleHead = 0;
      }
      this._size--;
      return entry ?? null;
    }
    // Then near
    if (this.near.length > this._nearHead) {
      const entry = this.near[this._nearHead++];
      if (this._nearHead >= this.near.length) {
        this.near.length = 0;
        this._nearHead = 0;
      } else if (this._nearHead > 64 && this._nearHead * 2 > this.near.length) {
        this.near.copyWithin(0, this._nearHead);
        this.near.length -= this._nearHead;
        this._nearHead = 0;
      }
      this._size--;
      return entry ?? null;
    }
    // Then background
    if (this.background.length > this._backgroundHead) {
      const entry = this.background[this._backgroundHead++];
      if (this._backgroundHead >= this.background.length) {
        this.background.length = 0;
        this._backgroundHead = 0;
      } else if (this._backgroundHead > 64 && this._backgroundHead * 2 > this.background.length) {
        this.background.copyWithin(0, this._backgroundHead);
        this.background.length -= this._backgroundHead;
        this._backgroundHead = 0;
      }
      this._size--;
      return entry ?? null;
    }
    return null;
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
