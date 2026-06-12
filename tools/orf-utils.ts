export const CMP_W = 1200;

export const LUM_R = 0.2126;
export const LUM_G = 0.7152;
export const LUM_B = 0.0722;

export function extractLargestJpeg(bytes: Uint8Array): Uint8Array | null {
    const sois: number[] = [];
    let i = 0;
    while (true) {
        i = bytes.indexOf(0xFF, i);
        if (i === -1 || i > bytes.length - 3) break;
        if (bytes[i + 1] === 0xD8 && bytes[i + 2] === 0xFF) {
            sois.push(i);
            i += 2;
        } else {
            i++;
        }
    }
    
    let best: Uint8Array | null = null;
    for (let n = 0; n < sois.length; n++) {
        const start = sois[n];
        const end = n + 1 < sois.length ? sois[n + 1] : bytes.length;
        let eoi = -1;
        for (let j = end - 2; j >= start + 2; j--) {
            if (bytes[j] === 0xFF && bytes[j + 1] === 0xD9) { eoi = j; break; }
        }
        if (eoi !== -1) {
            const blob = bytes.slice(start, eoi + 2);
            if (!best || blob.length > best.length) best = blob;
        }
    }
    return best;
}

export interface Stats {
    rMean: number; gMean: number; bMean: number;
    lum: number;
    rgRatio: number;   
    bgRatio: number;   
    sat: number;       
    contrastStd: number; 
}

export function stats(rgb: Uint8Array): Stats {
    const n = rgb.length / 3;
    let r = 0, g = 0, b = 0, lumSum = 0, lumSq = 0, sat = 0;
    for (let i = 0; i < n; i++) {
        const R = rgb[i*3], G = rgb[i*3+1], B = rgb[i*3+2];
        r += R; g += G; b += B;
        const L = LUM_R * R + LUM_G * G + LUM_B * B;
        lumSum += L; 
        lumSq += L * L;
        const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
        if (mx > 0) sat += (mx - mn) / mx;
    }
    r /= n; g /= n; b /= n; 
    const lum = lumSum / n;
    sat /= n;
    const contrastStd = Math.sqrt(Math.max(0, lumSq / n - lum * lum));
    return {
        rMean: r, gMean: g, bMean: b, lum,
        rgRatio: r / Math.max(g, 1e-6),
        bgRatio: b / Math.max(g, 1e-6),
        sat,
        contrastStd,
    };
}
