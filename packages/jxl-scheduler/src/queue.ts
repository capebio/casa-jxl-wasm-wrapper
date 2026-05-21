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

  enqueue(entry: QueueEntry<T>): void {
    this.lane(entry.priority).push(entry);
  }

  // Peek at the highest-priority pending entry without removing it.
  peek(): QueueEntry<T> | null {
    return this.visible[0] ?? this.near[0] ?? this.background[0] ?? null;
  }

  // Remove and return the highest-priority entry.
  dequeue(): QueueEntry<T> | null {
    const lane =
      this.visible.length > 0 ? this.visible :
      this.near.length > 0 ? this.near :
      this.background;

    return lane.shift() ?? null;
  }

  remove(sessionId: string): boolean {
    for (const lane of [this.visible, this.near, this.background]) {
      const idx = lane.findIndex((e) => e.sessionId === sessionId);
      if (idx !== -1) {
        lane.splice(idx, 1);
        return true;
      }
    }
    return false;
  }

  get size(): number {
    return this.visible.length + this.near.length + this.background.length;
  }

  get isEmpty(): boolean {
    return this.size === 0;
  }

  // Return all background session IDs (candidates for preemption).
  backgroundIds(): string[] {
    return this.background.map((e) => e.sessionId);
  }

  private lane(priority: Priority): QueueEntry<T>[] {
    switch (priority) {
      case "visible": return this.visible;
      case "near": return this.near;
      case "background": return this.background;
    }
  }
}
