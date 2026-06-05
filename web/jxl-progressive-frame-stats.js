export function analyzeProgressiveFrame(pixels, width, height) {
    const data = pixels instanceof Uint8Array
        ? pixels
        : new Uint8Array(pixels?.buffer ?? pixels ?? new ArrayBuffer(0), pixels?.byteOffset ?? 0, pixels?.byteLength ?? undefined);
    const pixelCount = Math.max(0, Math.floor(Number(width) || 0) * Math.floor(Number(height) || 0));
    const expected = pixelCount * 4;
    const limit = Math.min(data.byteLength, expected);

    let alphaMin = 255;
    let alphaMax = 0;
    let alphaZeroCount = 0;
    let rgbNonzeroCount = 0;
    let lumaSum = 0;
    let lumaSqSum = 0;
    let hash = 0x811c9dc5;

    for (let i = 0; i < limit; i++) {
        hash ^= data[i];
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }

    for (let i = 0, p = 0; p < pixelCount; p++, i += 4) {
        const r = i < limit ? data[i] : 0;
        const g = i + 1 < limit ? data[i + 1] : 0;
        const b = i + 2 < limit ? data[i + 2] : 0;
        const a = i + 3 < limit ? data[i + 3] : 0;

        if (r !== 0) rgbNonzeroCount++;
        if (g !== 0) rgbNonzeroCount++;
        if (b !== 0) rgbNonzeroCount++;
        if (a < alphaMin) alphaMin = a;
        if (a > alphaMax) alphaMax = a;
        if (a === 0) alphaZeroCount++;

        const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        lumaSum += luma;
        lumaSqSum += luma * luma;
    }

    if (pixelCount === 0) {
        alphaMin = 0;
    }

    const mean = pixelCount ? lumaSum / pixelCount : 0;
    const lumaVariance = pixelCount ? Math.max(0, (lumaSqSum / pixelCount) - mean * mean) : 0;

    return {
        alphaMin,
        alphaMax,
        alphaZeroPct: pixelCount ? (alphaZeroCount / pixelCount) * 100 : 0,
        rgbNonzeroCount,
        lumaVariance,
        frameHash: hash.toString(16).padStart(8, '0'),
        pixelCount,
        byteLength: data.byteLength,
    };
}

export function formatFrameStatsLog(stats) {
    return [
        `alphaMin=${stats.alphaMin}`,
        `alphaMax=${stats.alphaMax}`,
        `alphaZeroPct=${stats.alphaZeroPct.toFixed(2)}`,
        `rgbNonzero=${stats.rgbNonzeroCount}`,
        `lumaVar=${stats.lumaVariance.toFixed(2)}`,
        `hash=${stats.frameHash}`,
    ].join(' ');
}

export function formatFrameStatsCompact(stats) {
    return [
        `a=${stats.alphaMin}-${stats.alphaMax}`,
        `a0=${stats.alphaZeroPct.toFixed(2)}%`,
        `rgbNonzero=${stats.rgbNonzeroCount}`,
        `lumaVar=${stats.lumaVariance.toFixed(2)}`,
        `hash=${stats.frameHash}`,
    ].join('|');
}
