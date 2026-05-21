export const JSQUASH_MAX_SAFE_ENCODE_PIXELS = 15_000_000;

export function encodeBackendForTarget(requestedBackend, width, height) {
    const pixels = width * height;
    if (requestedBackend === 'jsquash' && pixels > JSQUASH_MAX_SAFE_ENCODE_PIXELS) {
        return 'libjxl';
    }
    return requestedBackend;
}
