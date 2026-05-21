const OVERRIDE_FALSE = 0;
const OVERRIDE_TRUE = 1;
const LARGE_PROGRESSIVE_AC_MAX_PIXELS = 1_000_000;

export function buildIcodecJxlOptions({
    quality,
    effort,
    lossless,
    progressive,
    progressiveFlavor,
    width,
    height,
}) {
    const options = {
        quality,
        effort,
        lossless: Boolean(lossless),
    };

    if (!progressive) return options;

    const pixels = width * height;
    const useAcProgression = pixels <= LARGE_PROGRESSIVE_AC_MAX_PIXELS;
    const forceAc = progressiveFlavor === 'ac';
    const forceDc = progressiveFlavor === 'dc';
    const acEnabled = forceDc ? false : forceAc ? true : useAcProgression;
    return {
        ...options,
        progressiveDC: 1,
        progressiveAC: acEnabled ? OVERRIDE_TRUE : OVERRIDE_FALSE,
        qProgressiveAC: acEnabled ? OVERRIDE_TRUE : OVERRIDE_FALSE,
    };
}
