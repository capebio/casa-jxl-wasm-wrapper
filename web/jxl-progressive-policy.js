export const JSQUASH_MAX_SAFE_ENCODE_PIXELS = 15_000_000;

export function encodeBackendForTarget(requestedBackend, width, height) {
    const pixels = width * height;
    if (requestedBackend === 'jsquash' && pixels > JSQUASH_MAX_SAFE_ENCODE_PIXELS) {
        return 'libjxl';
    }
    return requestedBackend;
}

// Expanded policy surface for decode/AR/photogram/high-res use cases (per progressive gallery orchestrator review).
// These remain pure; no side effects. recommend prefers fidelity for digital-twin / live AR paths.
export function getSafePixelLimit(backend = 'libjxl') {
    return backend === 'jsquash' ? JSQUASH_MAX_SAFE_ENCODE_PIXELS : Infinity;
}

export function recommendBackendForUseCase(requested, w, h, useCase = 'gallery') {
    if (useCase === 'ar-live' || useCase === 'photogram') {
        return 'libjxl'; // prefer no cap + full fidelity for real-time recog / SfM
    }
    return encodeBackendForTarget(requested, w, h);
}
