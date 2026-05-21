export function createProgressiveDecodeRequest({
    worker,
    sessionId,
    onProgress,
    onFinal,
    onHeader,
    onError,
    progressionTarget = 'final',
    emitEveryPass = true,
    preserveIcc = true,
    preserveMetadata = true,
    priority = 'visible',
    budgetMs = null,
    format = 'rgba8',
    region = null,
    downsample = 1,
} = {}) {
    if (!worker) {
        throw new TypeError('createProgressiveDecodeRequest requires a worker');
    }
    if (!sessionId) {
        throw new TypeError('createProgressiveDecodeRequest requires a sessionId');
    }

    let started = false;
    let closed = false;
    let settled = false;
    let resolveDone;
    let rejectDone;

    const done = new Promise((resolve, reject) => {
        resolveDone = resolve;
        rejectDone = reject;
    });

    const cleanup = () => {
        worker.removeEventListener('message', onMessage);
    };

    const finish = (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolveDone(value);
    };

    const fail = (message, code = 'DecodeFailed') => {
        if (settled) return;
        settled = true;
        cleanup();
        const error = new Error(message);
        error.code = code;
        rejectDone(error);
    };

    const onMessage = ({ data }) => {
        if (!data || data.sessionId !== sessionId) return;

        if (data.type === 'decode_header') {
            onHeader?.(normalizeFrame(data));
            return;
        }

        if (data.type === 'decode_progress') {
            onProgress?.(normalizeFrame(data));
            return;
        }

        if (data.type === 'decode_final') {
            const frame = normalizeFrame(data);
            onFinal?.(frame);
            finish(frame);
            return;
        }

        if (data.type === 'decode_error') {
            onError?.(data);
            fail(data.message || data.error || 'Decode failed', data.code || 'DecodeFailed');
            return;
        }

        if (data.type === 'decode_cancelled' || data.type === 'jxl_decoded') {
            const frame = data.type === 'jxl_decoded'
                ? normalizeLegacyFrame(data)
                : null;
            if (frame !== null) {
                onFinal?.(frame);
                finish(frame);
                return;
            }
            fail('Decode cancelled', 'DecodeCancelled');
        }
    };

    worker.addEventListener('message', onMessage);

    return {
        done,
        start() {
            if (started) return;
            started = true;
            worker.postMessage({
                type: 'decode_start',
                sessionId,
                format,
                region,
                downsample,
                progressionTarget,
                emitEveryPass,
                preserveIcc,
                preserveMetadata,
                priority,
                budgetMs,
            });
        },
        push(chunk) {
            if (settled || closed) return;
            const buffer = toTransferableArrayBuffer(chunk);
            worker.postMessage({ type: 'decode_chunk', sessionId, chunk: buffer }, [buffer]);
        },
        close() {
            if (settled || closed) return;
            closed = true;
            worker.postMessage({ type: 'decode_close', sessionId });
        },
        cancel(reason = 'cancelled') {
            if (settled) return;
            closed = true;
            worker.postMessage({ type: 'decode_cancel', sessionId, reason });
            fail(reason, 'DecodeCancelled');
        },
        dispose() {
            cleanup();
        },
    };
}

function normalizeFrame(data) {
    return {
        sessionId: data.sessionId,
        w: data.info?.width ?? data.w ?? 0,
        h: data.info?.height ?? data.h ?? 0,
        rgba: toUint8Array(data.pixels),
        info: data.info ?? null,
        stage: data.stage ?? 'final',
        format: data.format ?? 'rgba8',
        pixelStride: data.pixelStride ?? 4,
        region: data.region ?? null,
    };
}

function normalizeLegacyFrame(data) {
    return {
        sessionId: data.decodeId ?? data.sessionId,
        w: data.w ?? 0,
        h: data.h ?? 0,
        rgba: toUint8Array(data.rgba),
        info: { width: data.w ?? 0, height: data.h ?? 0 },
        stage: 'final',
        format: 'rgba8',
        pixelStride: 4,
        region: null,
    };
}

function toTransferableArrayBuffer(value) {
    if (value instanceof ArrayBuffer) return value;
    if (value instanceof Uint8Array) {
        return value.byteOffset === 0 && value.byteLength === value.buffer.byteLength
            ? value.buffer
            : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    }
    throw new TypeError('decode chunk must be an ArrayBuffer or Uint8Array');
}

function toUint8Array(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    return new Uint8Array(toTransferableArrayBuffer(value));
}
