import type { Priority } from "./types.js";
export interface QueueEntry<T> {
    priority: Priority;
    sessionId: string;
    payload: T;
}
export declare class PriorityQueue<T> {
    private readonly visible;
    private readonly near;
    private readonly background;
    private _visibleHead;
    private _nearHead;
    private _backgroundHead;
    private _size;
    enqueue(entry: QueueEntry<T>): void;
    peek(): QueueEntry<T> | null;
    dequeue(): QueueEntry<T> | null;
    remove(sessionId: string): boolean;
    private swapDelete;
    get size(): number;
    get isEmpty(): boolean;
    backgroundIds(): string[];
    private lane;
}
//# sourceMappingURL=queue.d.ts.map