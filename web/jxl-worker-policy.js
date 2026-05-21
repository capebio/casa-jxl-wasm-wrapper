export const MIN_RETRY_EFFORT = 1;

export function canRetryEffort(effort) {
    return Number.isFinite(effort) && effort > MIN_RETRY_EFFORT;
}

export function nextRetryEffort(effort) {
    return Math.max(MIN_RETRY_EFFORT, Math.floor(effort) - 1);
}
