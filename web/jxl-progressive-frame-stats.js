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

    // Fused single-pass (hash + stats) + int-luma fastpath for telemetry hot kernel.
    // See docs/JxlDashboardFrameStats.md (Chapter 1). Hash/return shape identical.
    const full = limit === expected;
    let i = 0;
    for (let p = 0; p < pixelCount; p++, i += 4) {
        const r = full || i < limit ? data[i] : 0;
        const g = full || i + 1 < limit ? data[i + 1] : 0;
        const b = full || i + 2 < limit ? data[i + 2] : 0;
        const a = full || i + 3 < limit ? data[i + 3] : 0;
        hash ^= r; hash = Math.imul(hash, 0x01000193) >>> 0;
        hash ^= g; hash = Math.imul(hash, 0x01000193) >>> 0;
        hash ^= b; hash = Math.imul(hash, 0x01000193) >>> 0;
        hash ^= a; hash = Math.imul(hash, 0x01000193) >>> 0;
        rgbNonzeroCount += (r !== 0) + (g !== 0) + (b !== 0);
        if (a < alphaMin) alphaMin = a;
        if (a > alphaMax) alphaMax = a;
        if (a === 0) alphaZeroCount++;
        const lumaInt = 54 * r + 183 * g + 18 * b;
        lumaSum += lumaInt;
        lumaSqSum += lumaInt * lumaInt;
    }

    if (pixelCount === 0) {
        alphaMin = 0;
    }

    const meanInt = pixelCount ? lumaSum / pixelCount : 0;
    const lumaVariance = pixelCount
        ? Math.max(0, (lumaSqSum / pixelCount) - meanInt * meanInt) / 65536
        : 0;

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
