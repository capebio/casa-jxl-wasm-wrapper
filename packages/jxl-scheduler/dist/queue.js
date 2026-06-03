// jxl-scheduler/src/queue.ts
// Three-lane priority queue for pending sessions.
// Spec: Section 12.2.
//
// Invariant: visible > near > background.
// Drain order: visible first, then near, then background.
export class PriorityQueue {
    visible = [];
    near = [];
    background = [];
    _visibleHead = 0;
    _nearHead = 0;
    _backgroundHead = 0;
    _size = 0;
    enqueue(entry) {
        this.lane(entry.priority).push(entry);
        this._size++;
    }
    // Peek at the highest-priority pending entry without removing it.
    peek() {
        if (this.visible.length > this._visibleHead)
            return this.visible[this._visibleHead] ?? null;
        if (this.near.length > this._nearHead)
            return this.near[this._nearHead] ?? null;
        if (this.background.length > this._backgroundHead)
            return this.background[this._backgroundHead] ?? null;
        return null;
    }
    // Remove and return the highest-priority entry.
    dequeue() {
        // Try visible first
        if (this.visible.length > this._visibleHead) {
            const entry = this.visible[this._visibleHead++];
            if (this._visibleHead >= this.visible.length) {
                this.visible.length = 0;
                this._visibleHead = 0;
            }
            else if (this._visibleHead > 64 && this._visibleHead * 2 > this.visible.length) {
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
            }
            else if (this._nearHead > 64 && this._nearHead * 2 > this.near.length) {
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
            }
            else if (this._backgroundHead > 64 && this._backgroundHead * 2 > this.background.length) {
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
    remove(sessionId) {
        if (this.swapDelete(this.visible, this._visibleHead, sessionId)) {
            this._size--;
            return true;
        }
        if (this.swapDelete(this.near, this._nearHead, sessionId)) {
            this._size--;
            return true;
        }
        if (this.swapDelete(this.background, this._backgroundHead, sessionId)) {
            this._size--;
            return true;
        }
        return false;
    }
    swapDelete(lane, head, sessionId) {
        for (let i = head; i < lane.length; i++) {
            if (lane[i].sessionId === sessionId) {
                const last = lane.length - 1;
                if (i !== last)
                    lane[i] = lane[last];
                lane.length = last;
                return true;
            }
        }
        return false;
    }
    get size() {
        return this._size;
    }
    get isEmpty() {
        return this._size === 0;
    }
    lane(priority) {
        switch (priority) {
            case "visible": return this.visible;
            case "near": return this.near;
            case "background": return this.background;
        }
    }
}
//# sourceMappingURL=queue.js.map